"""Backend multimodal tools for LLM tool-calls."""

from __future__ import annotations

import asyncio
import io
import json
import logging
from typing import Any, Dict

from ah32.assets import get_asset_store
from ah32.config import settings
from ah32.mm import get_multimodal_provider

logger = logging.getLogger(__name__)


def _parse_json_args(tool_input: Any) -> Dict[str, Any]:
    if isinstance(tool_input, dict):
        return dict(tool_input)
    if tool_input is None:
        return {}
    if isinstance(tool_input, str):
        s = tool_input.strip()
        if not s:
            return {}
        try:
            obj = json.loads(s)
        except Exception:
            return {"_raw": s}
        if isinstance(obj, dict):
            return obj
        return {"_raw": obj}
    return {"_raw": str(tool_input)}


class MmGenerateImageTool:
    name: str = "mm_generate_image"
    description: str = "生成图片并保存为后端临时资源（返回 asset://<id>）。输入为JSON参数。"

    def run(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        prompt = str(args.get("prompt") or "").strip()
        size = str(args.get("size") or "").strip() or None
        style = str(args.get("style") or "").strip() or None
        ttl_sec = args.get("ttl_sec")

        if not prompt:
            return json.dumps({"ok": False, "error": "missing prompt"}, ensure_ascii=False)

        provider = None
        try:
            provider = get_multimodal_provider(settings)
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
        if provider is None:
            return json.dumps({"ok": False, "error": "multimodal provider is disabled"}, ensure_ascii=False)

        async def _do() -> Dict[str, Any]:
            gen = await provider.generate_image(prompt=prompt, size=size, style=style)
            store = get_asset_store()
            init = store.init_asset(
                kind="image",
                mime=str(getattr(gen, "mime", "") or "image/png"),
                suggested_name="generated.png",
                ttl_sec=int(ttl_sec) if ttl_sec is not None else None,
                replace_previous=False,
                scope=None,
            )
            meta = store.put_content(
                init.asset_id,
                content_type=str(getattr(gen, "mime", "") or "image/png"),
                data_stream=io.BytesIO(getattr(gen, "image_bytes", b"") or b""),
            )
            return {
                "ok": True,
                "provider": getattr(gen, "provider", ""),
                "model": getattr(gen, "model", ""),
                "asset_id": init.asset_id,
                "asset_path": f"asset://{init.asset_id}",
                "mime": meta.get("mime"),
                "bytes": meta.get("bytes"),
                "expires_at": meta.get("expires_at"),
            }

        try:
            obj = asyncio.run(_do()) if not asyncio.get_event_loop().is_running() else None
        except RuntimeError:
            obj = None

        if obj is None:
            # We're in an event loop (most likely). Run in thread via arun.
            return json.dumps({"ok": False, "error": "use arun for async context"}, ensure_ascii=False)

        return json.dumps(obj, ensure_ascii=False, default=str)

    async def arun(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        prompt = str(args.get("prompt") or "").strip()
        size = str(args.get("size") or "").strip() or None
        style = str(args.get("style") or "").strip() or None
        ttl_sec = args.get("ttl_sec")

        if not prompt:
            return json.dumps({"ok": False, "error": "missing prompt"}, ensure_ascii=False)

        try:
            provider = get_multimodal_provider(settings)
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
        if provider is None:
            return json.dumps({"ok": False, "error": "multimodal provider is disabled"}, ensure_ascii=False)

        try:
            gen = await provider.generate_image(prompt=prompt, size=size, style=style)
            store = get_asset_store()
            init = store.init_asset(
                kind="image",
                mime=str(getattr(gen, "mime", "") or "image/png"),
                suggested_name="generated.png",
                ttl_sec=int(ttl_sec) if ttl_sec is not None else None,
                replace_previous=False,
                scope=None,
            )
            meta = store.put_content(
                init.asset_id,
                content_type=str(getattr(gen, "mime", "") or "image/png"),
                data_stream=io.BytesIO(getattr(gen, "image_bytes", b"") or b""),
            )
            return json.dumps(
                {
                    "ok": True,
                    "provider": getattr(gen, "provider", ""),
                    "model": getattr(gen, "model", ""),
                    "asset_id": init.asset_id,
                    "asset_path": f"asset://{init.asset_id}",
                    "mime": meta.get("mime"),
                    "bytes": meta.get("bytes"),
                    "expires_at": meta.get("expires_at"),
                },
                ensure_ascii=False,
                default=str,
            )
        except Exception as e:
            logger.error("[mm_generate_image] failed: %s", e, exc_info=True)
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

