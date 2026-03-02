"""Agentic Asset API (v1).

Assets are ephemeral blobs (images) referenced by `asset://<id>` inside Plan JSON.

Privacy rules:
- Never write asset bytes into logs.
- Delete assets immediately after writeback (frontend should call DELETE),
  and also via TTL cleanup as crash-safety.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ah32.assets import get_asset_store
from ah32.tenancy.usage_audit import usage_span

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agentic/assets", tags=["agentic", "assets"])

AssetKind = Literal["image"]


def _auth_or_401(api_key: Optional[str]) -> None:
    # Auth is enforced centrally for /agentic/* in server middleware.
    _ = api_key
    return


class AssetInitRequest(BaseModel):
    kind: AssetKind = "image"
    mime: str = "image/png"
    suggested_name: str | None = None
    ttl_sec: int = 600
    replace_previous: bool = True
    scope: Dict[str, Any] | None = Field(default_factory=dict)


class AssetInitResponse(BaseModel):
    asset_id: str
    replaced_asset_id: str | None = None
    created_at: str
    expires_in_sec: int
    upload_url: str
    status_url: str
    delete_url: str


@router.post("/init", response_model=AssetInitResponse)
async def init_asset(
    request: AssetInitRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_asset_store()
    with usage_span(
        event="api_call",
        component="asset",
        action="init",
        extra={"kind": request.kind, "mime": str(request.mime or "")[:80]},
    ) as span:
        try:
            res = store.init_asset(
                kind=request.kind,
                mime=request.mime,
                suggested_name=request.suggested_name,
                ttl_sec=request.ttl_sec,
                replace_previous=bool(request.replace_previous),
                scope=request.scope,
            )
            span.set_status_code(200)
            return AssetInitResponse(
                asset_id=res.asset_id,
                replaced_asset_id=res.replaced_asset_id,
                created_at=datetime.utcfromtimestamp(res.created_at).isoformat() + "Z",
                expires_in_sec=res.expires_in_sec,
                upload_url=f"/agentic/assets/{res.asset_id}/content",
                status_url=f"/agentic/assets/{res.asset_id}/status",
                delete_url=f"/agentic/assets/{res.asset_id}",
            )
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[asset] init failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))


class AssetUploadResponse(BaseModel):
    ok: bool = True
    asset_id: str
    bytes: int = 0
    sha256: str | None = None
    mime: str | None = None


@router.put("/{asset_id}/content", response_model=AssetUploadResponse)
async def upload_asset_content(
    asset_id: str,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
    file: UploadFile = File(...),
):
    _auth_or_401(api_key)
    store = get_asset_store()
    with usage_span(
        event="api_call",
        component="asset",
        action="upload",
        extra={"asset_id": str(asset_id or "")[:32], "content_type": str(file.content_type or "")[:80]},
    ) as span:
        try:
            # Stream upload to disk via a sync wrapper to avoid buffering the whole file.
            class _UploadStream:
                def __init__(self, f: UploadFile):
                    self._f = f

                def read(self, size: int = -1) -> bytes:
                    try:
                        return self._f.file.read(size)
                    except Exception:
                        return b""

            meta = store.put_content(
                asset_id,
                content_type=str(file.content_type or ""),
                data_stream=_UploadStream(file),
            )
            span.set_status_code(200)
            return AssetUploadResponse(
                ok=True,
                asset_id=asset_id,
                bytes=int(meta.get("bytes") or 0),
                sha256=str(meta.get("sha256") or "") or None,
                mime=str(meta.get("mime") or "") or None,
            )
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="asset not found")
        except ValueError as e:
            try:
                span.set_status_code(400)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[asset] upload failed asset_id=%s err=%s", asset_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/{asset_id}/content")
async def download_asset_content(
    asset_id: str,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_asset_store()
    with usage_span(event="api_call", component="asset", action="download", extra={"asset_id": str(asset_id or "")[:32]}) as span:
        try:
            meta = store.status(asset_id)
            p = store.get_content_path(asset_id)
            if not p:
                raise HTTPException(status_code=404, detail="asset content not found")
            mime = str(meta.get("mime") or "application/octet-stream")
            filename = str(meta.get("suggested_name") or f"{asset_id}.bin")
            span.set_status_code(200)
            # NOTE: we intentionally serve from disk to avoid copying large blobs into memory.
            return FileResponse(
                path=str(p),
                media_type=mime,
                filename=filename,
            )
        except HTTPException as e:
            try:
                span.set_status_code(int(getattr(e, "status_code", 500) or 500))
                span.fail(error_type="HTTPException", error_message=str(getattr(e, "detail", str(e)) or str(e)))
            except Exception:
                pass
            raise
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="asset not found")
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[asset] download failed asset_id=%s err=%s", asset_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/{asset_id}/status")
async def asset_status(asset_id: str, api_key: Optional[str] = Header(None, alias="X-API-Key")):
    _auth_or_401(api_key)
    store = get_asset_store()
    with usage_span(event="api_call", component="asset", action="status", extra={"asset_id": str(asset_id or "")[:32]}) as span:
        try:
            obj = {"ok": True, "asset": store.status(asset_id)}
            span.set_status_code(200)
            return obj
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="asset not found")
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[asset] status failed asset_id=%s err=%s", asset_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{asset_id}")
async def delete_asset(asset_id: str, api_key: Optional[str] = Header(None, alias="X-API-Key")):
    _auth_or_401(api_key)
    store = get_asset_store()
    with usage_span(event="api_call", component="asset", action="delete", extra={"asset_id": str(asset_id or "")[:32]}) as span:
        try:
            ok = store.delete(asset_id, reason="api_delete")
            span.set_status_code(200)
            return {"ok": True, "deleted": bool(ok)}
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[asset] delete failed asset_id=%s err=%s", asset_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))
