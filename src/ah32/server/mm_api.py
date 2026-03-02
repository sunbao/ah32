"""Agentic Multimodal API (v1).

This provides thin HTTP wrappers around the configured multimodal provider.

Rules:
- Prefer `asset_id` inputs/outputs to avoid huge JSON payloads.
- Generated images are stored in the ephemeral Asset store and referenced via `asset://<id>`.
"""

from __future__ import annotations

import base64
import logging
import os
import sys
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ah32.assets import get_asset_store
from ah32.config import settings
from ah32.mm import get_multimodal_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agentic/mm", tags=["agentic", "multimodal"])


def _auth_or_401(api_key: Optional[str]) -> None:
    # Auth is enforced centrally for /agentic/* in server middleware.
    _ = api_key
    return


def _data_url_to_bytes(data_url: str, *, max_bytes: int) -> tuple[bytes, str]:
    s = str(data_url or "").strip()
    if not s.startswith("data:"):
        raise ValueError("invalid data_url")
    try:
        header, b64 = s.split(",", 1)
    except ValueError as e:
        raise ValueError("invalid data_url format") from e
    mime = header[5:].split(";")[0].strip() if header.startswith("data:") else ""
    if ";base64" not in header.lower():
        raise ValueError("data_url must be base64")
    raw = base64.b64decode(b64, validate=False)
    if len(raw) > max_bytes:
        raise ValueError(f"image too large (>{max_bytes} bytes)")
    return raw, mime or "application/octet-stream"


class AnalyzeImageInput(BaseModel):
    asset_id: str | None = None
    data_url: str | None = None
    mime: str | None = None


class AnalyzeImageRequest(BaseModel):
    prompt: str
    image: AnalyzeImageInput


class AnalyzeImageResponse(BaseModel):
    ok: bool
    text: str
    provider: str
    model: str


@router.post("/analyze-image", response_model=AnalyzeImageResponse)
async def analyze_image(
    request: AnalyzeImageRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    provider = get_multimodal_provider(settings)
    if provider is None:
        raise HTTPException(status_code=400, detail="multimodal provider is disabled")

    # Prefer asset_id.
    image_bytes: bytes = b""
    mime: str = "application/octet-stream"

    if request.image.asset_id:
        store = get_asset_store()
        try:
            meta = store.status(request.image.asset_id)
            p = store.get_content_path(request.image.asset_id)
            if not p:
                raise HTTPException(status_code=404, detail="asset content not found")
            image_bytes = p.read_bytes()
            mime = str(meta.get("mime") or request.image.mime or "application/octet-stream")
        except HTTPException:
            raise
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="asset not found")
        except Exception as e:
            logger.error(
                "[mm] read asset failed asset_id=%s err=%s",
                request.image.asset_id,
                e,
                exc_info=True,
            )
            raise HTTPException(status_code=500, detail=str(e))
    elif request.image.data_url:
        try:
            image_bytes, mime2 = _data_url_to_bytes(request.image.data_url, max_bytes=2_500_000)
            mime = str(request.image.mime or mime2 or "application/octet-stream")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail="image.asset_id or image.data_url is required")

    try:
        res = await provider.analyze_image(
            prompt=request.prompt,
            image_bytes=image_bytes,
            mime=mime,
        )
        return AnalyzeImageResponse(ok=True, text=res.text, provider=res.provider, model=res.model)
    except Exception as e:
        logger.error("[mm] analyze_image failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class GenerateImageRequest(BaseModel):
    prompt: str
    size: str | None = "1024x1024"
    style: str | None = None
    ttl_sec: int = 600
    scope: Dict[str, Any] | None = Field(default_factory=dict)


class GenerateImageResponse(BaseModel):
    ok: bool
    asset_id: str
    mime: str
    bytes: int
    provider: str
    model: str


@router.post("/generate-image", response_model=GenerateImageResponse)
async def generate_image(
    request: GenerateImageRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    provider = get_multimodal_provider(settings)
    if provider is None:
        raise HTTPException(status_code=400, detail="multimodal provider is disabled")

    try:
        gen = await provider.generate_image(
            prompt=request.prompt,
            size=request.size,
            style=request.style,
        )
    except Exception as e:
        logger.error("[mm] generate_image failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    store = get_asset_store()
    try:
        asset_id = ""
        init = store.init_asset(
            kind="image",
            mime=gen.mime,
            suggested_name="generated.png",
            ttl_sec=request.ttl_sec,
            replace_previous=True,
            scope=request.scope,
        )
        asset_id = init.asset_id
        import io

        store.put_content(
            asset_id,
            content_type=gen.mime,
            data_stream=io.BytesIO(gen.image_bytes),
        )
        return GenerateImageResponse(
            ok=True,
            asset_id=asset_id,
            mime=gen.mime,
            bytes=len(gen.image_bytes),
            provider=gen.provider,
            model=gen.model,
        )
    except Exception as e:
        # If we fail to store the bytes, do not leak partial artifacts.
        try:
            if asset_id:
                store.delete(asset_id, reason="store_failed")
        except Exception:
            logger.debug("[mm] cleanup stored asset failed (ignored)", exc_info=True)
        logger.error("[mm] store generated image failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
