from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from ah32.config import settings
from ah32.security.jwt_hs256 import encode_hs256
from ah32.security.keyring import get_tenant_keyring

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agentic/auth", tags=["auth"])


class TokenResponse(BaseModel):
    ok: bool = True
    tenant_id: str
    user_id: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    issued_at: int


@router.post("/token", response_model=TokenResponse)
async def issue_token(
    req: Request,
    tenant_id: Optional[str] = Header(None, alias="X-AH32-Tenant-Id"),
    user_id: Optional[str] = Header(None, alias="X-AH32-User-Id"),
    api_key: Optional[str] = Header(None, alias="X-AH32-Api-Key"),
    legacy_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """Issue a short-lived JWT.

    v1 policy:
    - When enable_auth=true:
        - default_tenant_id: allow issuing token without api-key
          (trial users; progressive onboarding).
        - non-default tenants: require correct tenant api-key.
    - When enable_auth=false: allow issuing token without api-key (local/dev convenience).
    """
    default_tid = (
        str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
    )
    tid = str(tenant_id or "").strip() or default_tid
    uid = str(user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id required (X-AH32-User-Id)")

    key = str(api_key or "").strip() or (
        str(legacy_api_key or "").strip()
        if getattr(settings, "auth_accept_legacy_x_api_key", True)
        else ""
    )

    if bool(getattr(settings, "enable_auth", False)):
        if tid != default_tid:
            kr = get_tenant_keyring()
            if not key or not kr.verify(tenant_id=tid, api_key=key):
                raise HTTPException(status_code=401, detail="invalid api key")
        else:
            if not key:
                logger.info(
                    "[auth] issuing token for default tenant without api-key "
                    "tenant_id=%s user_id=%s",
                    tid,
                    uid,
                )
    else:
        if not key:
            logger.info(
                "[auth] issuing token without api-key (enable_auth=false) tenant_id=%s user_id=%s",
                tid,
                uid,
            )

    secret = str(getattr(settings, "jwt_secret", "") or "").strip()
    if not secret:
        raise HTTPException(status_code=500, detail="jwt_secret not configured")

    now = int(time.time())
    ttl = int(getattr(settings, "jwt_access_token_ttl_sec", 3600) or 3600)
    exp = now + max(60, ttl)

    payload = {
        "iss": str(getattr(settings, "jwt_issuer", "ah32") or "ah32"),
        "aud": str(getattr(settings, "jwt_audience", "ah32") or "ah32"),
        "iat": now,
        "exp": exp,
        "tid": tid,
        "sub": uid,
    }
    try:
        token = encode_hs256(payload=payload, secret=secret)
    except Exception as e:
        logger.error("[auth] issue token failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="token issue failed")

    return TokenResponse(
        tenant_id=tid,
        user_id=uid,
        access_token=token,
        expires_in=exp - now,
        issued_at=now,
    )
