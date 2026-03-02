from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException, Request

from ah32.config import settings
from ah32.security.jwt_hs256 import JwtError, decode_hs256
from ah32.security.keyring import get_tenant_keyring
from ah32.tenancy.context import RequestTenancy, tenancy_context
from ah32.tenancy.user_registry import get_tenant_user_registry

logger = logging.getLogger(__name__)

_TENANT_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}$")
_USER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-:.]{0,127}$")


def _h(req: Request, name: str) -> str:
    try:
        return str(req.headers.get(name) or "").strip()
    except Exception:
        return ""


def _normalize_tenant_id(raw: str) -> str:
    t = str(raw or "").strip()
    if not t:
        return ""
    if not _TENANT_RE.match(t):
        raise HTTPException(status_code=400, detail="invalid tenant_id")
    return t


def _normalize_user_id(raw: str) -> str:
    u = str(raw or "").strip()
    if not u:
        return ""
    if not _USER_RE.match(u):
        raise HTTPException(status_code=400, detail="invalid user_id")
    return u


@dataclass(frozen=True)
class ResolvedAuth:
    ok: bool
    kind: str  # jwt|api_key|anonymous
    claims: Optional[Dict[str, Any]] = None


def _parse_bearer(authz: str) -> str:
    s = str(authz or "").strip()
    if not s:
        return ""
    if s.lower().startswith("bearer "):
        return s.split(" ", 1)[1].strip()
    return ""


def _decode_bearer_claims(req: Request) -> Dict[str, Any]:
    token = _parse_bearer(_h(req, "Authorization"))
    if not token:
        return {}
    secret = str(getattr(settings, "jwt_secret", "") or "").strip()
    if not secret:
        raise HTTPException(status_code=500, detail="jwt_secret not configured")
    try:
        return decode_hs256(token=token, secret=secret, leeway_sec=30, require_exp=True)
    except JwtError as e:
        raise HTTPException(status_code=401, detail=f"invalid jwt: {e}") from e


def resolve_request_tenancy(req: Request, *, trace_id: str) -> Tuple[RequestTenancy, ResolvedAuth]:
    """Resolve tenant/user/trace for this request and validate auth.

    Policy (R&D stage):
    - Always bind an effective tenant_id. If missing, use default_tenant_id.
    - For the default tenant (trial/experience users), allow fully anonymous requests:
      - Missing tenant_id/user_id/JWT/api-key is allowed.
      - Missing user_id is defaulted to "anon".
    - For non-default tenants, user_id is required (header or JWT sub).
    """
    default_tid = (
        str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
    )
    allow_default_anonymous = bool(getattr(settings, "auth_allow_default_tenant_anonymous", False))

    raw_tenant = _h(req, "X-AH32-Tenant-Id")
    raw_user = _h(req, "X-AH32-User-Id")
    api_key = _h(req, "X-AH32-Api-Key")
    if not api_key and bool(getattr(settings, "auth_accept_legacy_x_api_key", True)):
        api_key = _h(req, "X-API-Key")

    # If a JWT is present, we may infer tenant/user from its claims when headers are omitted.
    jwt_claims = _decode_bearer_claims(req)

    # Tenant precedence: header > jwt tid > default.
    header_tid = _normalize_tenant_id(raw_tenant) if raw_tenant else ""
    jwt_tid = str(jwt_claims.get("tid") or jwt_claims.get("tenant_id") or "").strip()
    jwt_tid = _normalize_tenant_id(jwt_tid) if jwt_tid else ""
    tenant_id = header_tid or jwt_tid or _normalize_tenant_id(default_tid)

    # User precedence: header > jwt sub > empty (maybe filled for default tenant).
    header_uid = _normalize_user_id(raw_user) if raw_user else ""
    jwt_uid = str(jwt_claims.get("sub") or jwt_claims.get("user_id") or "").strip()
    jwt_uid = _normalize_user_id(jwt_uid) if jwt_uid else ""
    user_id = header_uid or jwt_uid

    # Allow fully-anonymous default tenant.
    allow_default_anonymous = bool(getattr(settings, "auth_allow_default_tenant_anonymous", False))
    if tenant_id == default_tid and not user_id:
        user_id = "anon"

    if tenant_id != default_tid and not user_id:
        raise HTTPException(status_code=400, detail="user_id required (X-AH32-User-Id)")

    # Auth resolution (progressive onboarding):
    # - JWT (when present) is authoritative; it may imply tenant/user identity.
    # - For default tenant, anonymous access is allowed when configured.
    token_present = bool(_parse_bearer(_h(req, "Authorization")))
    if token_present:
        tid_claim = str(jwt_claims.get("tid") or jwt_claims.get("tenant_id") or "").strip()
        sub_claim = str(jwt_claims.get("sub") or jwt_claims.get("user_id") or "").strip()
        if tid_claim and tid_claim != tenant_id:
            raise HTTPException(status_code=401, detail="jwt tenant mismatch")
        if sub_claim and sub_claim != user_id:
            raise HTTPException(status_code=401, detail="jwt user mismatch")
        auth = ResolvedAuth(ok=True, kind="jwt", claims=jwt_claims)
    else:
        if not bool(getattr(settings, "enable_auth", False)):
            auth = ResolvedAuth(ok=True, kind="anonymous", claims=None)
        elif api_key:
            kr = get_tenant_keyring()
            if not kr.verify(tenant_id=tenant_id, api_key=api_key):
                raise HTTPException(status_code=401, detail="invalid api key")
            auth = ResolvedAuth(ok=True, kind="api_key", claims=None)
        elif allow_default_anonymous and tenant_id == default_tid:
            auth = ResolvedAuth(ok=True, kind="anonymous", claims=None)
        else:
            raise HTTPException(status_code=401, detail="missing auth (api key or bearer jwt)")

    # Optional per-tenant allowlist enforcement (minimal; for R&D/testing).
    # - Only enforce for non-default tenants.
    # - Only enforce when the tenant policy file exists.
    # - Allow tenant admin endpoints to bypass via api-key to avoid lock-out.
    try:
        path = str(getattr(req.url, "path", "") or "")
    except Exception:
        path = ""
    if tenant_id != default_tid:
        bypass = False
        try:
            if auth.kind == "api_key" and path.startswith("/agentic/tenants/") and "/users" in path:
                bypass = True
        except Exception:
            bypass = False
        if not bypass:
            reg = get_tenant_user_registry()
            decision = reg.is_allowed(tenant_id, user_id)
            if decision is False:
                logger.warning(
                    "[auth] user not allowed by tenant policy tenant_id=%s user_id=%s trace_id=%s path=%s",
                    tenant_id,
                    user_id,
                    trace_id,
                    path,
                )
                raise HTTPException(status_code=403, detail="user not allowed for tenant")

    tenancy = RequestTenancy(
        tenant_id=tenant_id,
        user_id=user_id,
        trace_id=trace_id,
        auth_kind=auth.kind,
    )
    return tenancy, auth


def bind_tenancy_for_request(req: Request, *, trace_id: str):
    """FastAPI dependency/middleware helper: bind contextvars and stash on request.state."""
    tenancy, auth = resolve_request_tenancy(req, trace_id=trace_id)
    # stash for handlers
    try:
        setattr(req.state, "tenant_id", tenancy.tenant_id)
        setattr(req.state, "user_id", tenancy.user_id)
        setattr(req.state, "trace_id", tenancy.trace_id)
        setattr(req.state, "auth_kind", tenancy.auth_kind)
        if auth.claims is not None:
            setattr(req.state, "jwt_claims", auth.claims)
    except Exception:
        logger.debug("[auth] stash request.state failed (ignored)", exc_info=True)

    return tenancy_context(
        tenant_id=tenancy.tenant_id,
        user_id=tenancy.user_id,
        trace_id=tenancy.trace_id,
        auth_kind=tenancy.auth_kind,
    )
