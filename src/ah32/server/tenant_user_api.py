from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ah32.config import settings
from ah32.security.keyring import get_tenant_keyring
from ah32.tenancy.user_registry import TenantUserRecord, get_tenant_user_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agentic/tenants", tags=["agentic", "tenants"])


def _require_tenant_api_key(*, tenant_id: str, api_key: str) -> None:
    if not bool(getattr(settings, "enable_auth", False)):
        return
    default_tid = str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
    if tenant_id == default_tid:
        # default tenant is for experience users; allow bootstrap without api-key
        return
    kr = get_tenant_keyring()
    if not api_key or not kr.verify(tenant_id=tenant_id, api_key=api_key):
        raise HTTPException(status_code=401, detail="invalid api key")


def _extract_api_key(
    *,
    api_key: Optional[str],
    legacy_api_key: Optional[str],
) -> str:
    key = str(api_key or "").strip()
    if key:
        return key
    if bool(getattr(settings, "auth_accept_legacy_x_api_key", True)):
        return str(legacy_api_key or "").strip()
    return ""


class TenantUserSummary(BaseModel):
    user_id: str
    enabled: bool = True
    created_at: int = 0
    updated_at: int = 0
    note: str = ""


class ListUsersResponse(BaseModel):
    ok: bool = True
    tenant_id: str
    updated_at: str | None = None
    users: List[TenantUserSummary] = Field(default_factory=list)
    enforcement: str = "off"  # off | on


class UpsertUserRequest(BaseModel):
    user_id: str
    enabled: bool = True
    note: str = ""


class UpsertUserResponse(BaseModel):
    ok: bool = True
    tenant_id: str
    user: TenantUserSummary


class SetEnabledRequest(BaseModel):
    enabled: bool = True


class DeleteUserResponse(BaseModel):
    ok: bool = True
    tenant_id: str
    user_id: str
    deleted: bool = False


def _to_summary(rec: TenantUserRecord) -> TenantUserSummary:
    return TenantUserSummary(
        user_id=rec.user_id,
        enabled=bool(rec.enabled),
        created_at=int(rec.created_at or 0),
        updated_at=int(rec.updated_at or 0),
        note=str(rec.note or ""),
    )


@router.get("/{tenant_id}/users", response_model=ListUsersResponse)
async def list_tenant_users(
    req: Request,
    tenant_id: str,
    api_key: Optional[str] = Header(None, alias="X-AH32-Api-Key"),
    legacy_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    key = _extract_api_key(api_key=api_key, legacy_api_key=legacy_api_key)
    _require_tenant_api_key(tenant_id=tenant_id, api_key=key)
    reg = get_tenant_user_registry()
    try:
        users = reg.list_users(tenant_id)
        enforcement = "on" if reg.policy_exists(tenant_id) else "off"
        updated_at = None
        try:
            p = reg.policy_path(tenant_id)
            if p.exists():
                updated_at = datetime.utcfromtimestamp(p.stat().st_mtime).isoformat() + "Z"
        except Exception:
            updated_at = None
        return ListUsersResponse(
            tenant_id=str(tenant_id),
            updated_at=updated_at,
            users=[_to_summary(u) for u in users],
            enforcement=enforcement,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[tenant_users] list failed tenant_id=%s err=%s", tenant_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{tenant_id}/users", response_model=UpsertUserResponse)
async def upsert_tenant_user(
    req: Request,
    tenant_id: str,
    body: UpsertUserRequest,
    api_key: Optional[str] = Header(None, alias="X-AH32-Api-Key"),
    legacy_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    key = _extract_api_key(api_key=api_key, legacy_api_key=legacy_api_key)
    _require_tenant_api_key(tenant_id=tenant_id, api_key=key)
    reg = get_tenant_user_registry()
    try:
        rec = reg.upsert_user(tenant_id, body.user_id, enabled=bool(body.enabled), note=str(body.note or ""))
        return UpsertUserResponse(tenant_id=str(tenant_id), user=_to_summary(rec))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[tenant_users] upsert failed tenant_id=%s err=%s", tenant_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{tenant_id}/users/{user_id}", response_model=UpsertUserResponse)
async def set_tenant_user_enabled(
    req: Request,
    tenant_id: str,
    user_id: str,
    body: SetEnabledRequest,
    api_key: Optional[str] = Header(None, alias="X-AH32-Api-Key"),
    legacy_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    key = _extract_api_key(api_key=api_key, legacy_api_key=legacy_api_key)
    _require_tenant_api_key(tenant_id=tenant_id, api_key=key)
    reg = get_tenant_user_registry()
    try:
        rec = reg.set_enabled(tenant_id, user_id, enabled=bool(body.enabled))
        return UpsertUserResponse(tenant_id=str(tenant_id), user=_to_summary(rec))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "[tenant_users] set_enabled failed tenant_id=%s user_id=%s err=%s",
            tenant_id,
            user_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{tenant_id}/users/{user_id}", response_model=DeleteUserResponse)
async def delete_tenant_user(
    req: Request,
    tenant_id: str,
    user_id: str,
    api_key: Optional[str] = Header(None, alias="X-AH32-Api-Key"),
    legacy_api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    key = _extract_api_key(api_key=api_key, legacy_api_key=legacy_api_key)
    _require_tenant_api_key(tenant_id=tenant_id, api_key=key)
    reg = get_tenant_user_registry()
    try:
        ok = reg.delete_user(tenant_id, user_id)
        return DeleteUserResponse(tenant_id=str(tenant_id), user_id=str(user_id), deleted=bool(ok))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "[tenant_users] delete failed tenant_id=%s user_id=%s err=%s",
            tenant_id,
            user_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))
