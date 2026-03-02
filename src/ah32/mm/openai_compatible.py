from __future__ import annotations

import asyncio
import base64
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass

from .provider import AnalysisResult, GeneratedImage, MultimodalProvider

logger = logging.getLogger(__name__)


def _normalize_base_url(base_url: str) -> str:
    b = str(base_url or "").strip().rstrip("/")
    return b


def _b64_data_url(image_bytes: bytes, mime: str) -> str:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    m = str(mime or "application/octet-stream").split(";")[0].strip()
    return f"data:{m};base64,{b64}"


def _post_json_sync(
    url: str,
    *,
    headers: dict[str, str],
    payload: dict,
    timeout_s: float = 180.0,
) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in (headers or {}).items():
        if not k or not v:
            continue
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read()
            try:
                return json.loads(body.decode("utf-8", errors="replace"))
            except Exception as e:
                raise RuntimeError(f"invalid json response: {e} body={body[:200]!r}") from e
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
            detail = body.decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(f"http_{e.code}: {detail[:500]}") from e
    except Exception as e:
        raise RuntimeError(f"request failed: {e}") from e


def _get_bytes_sync(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout_s: float = 180.0,
) -> tuple[bytes, str]:
    req = urllib.request.Request(url, method="GET")
    for k, v in (headers or {}).items():
        if not k or not v:
            continue
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read()
            mime = str(resp.headers.get("Content-Type") or "").split(";")[0].strip()
            return body, mime
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
            detail = body.decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise RuntimeError(f"http_{e.code}: {detail[:500]}") from e
    except Exception as e:
        raise RuntimeError(f"download failed: {e}") from e


@dataclass(frozen=True)
class OpenAICompatibleConfig:
    name: str
    base_url: str
    api_key: str
    vision_model: str
    image_model: str


class OpenAICompatibleMultimodalProvider(MultimodalProvider):
    def __init__(self, cfg: OpenAICompatibleConfig) -> None:
        self.name = str(cfg.name or "openai-compatible")
        self._base = _normalize_base_url(cfg.base_url)
        self._api_key = str(cfg.api_key or "").strip()
        self._vision_model = str(cfg.vision_model or "").strip()
        self._image_model = str(cfg.image_model or "").strip()

        if not self._base:
            raise ValueError("base_url is required")
        if not self._api_key:
            raise ValueError("api_key is required")

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def analyze_image(self, *, prompt: str, image_bytes: bytes, mime: str) -> AnalysisResult:
        if not self._vision_model:
            raise ValueError("vision_model is not configured")

        data_url = _b64_data_url(image_bytes, mime)
        payload = {
            "model": self._vision_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": str(prompt or "").strip()},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "temperature": 0,
        }

        url = f"{self._base}/chat/completions"
        t0 = asyncio.get_running_loop().time()
        obj = await asyncio.to_thread(
            _post_json_sync,
            url,
            headers=self._headers(),
            payload=payload,
        )
        dt_ms = int((asyncio.get_running_loop().time() - t0) * 1000)

        try:
            text = (
                obj.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
        except Exception:
            text = ""
        text = str(text or "").strip()
        if not text:
            raise RuntimeError("empty model response (vision)")
        logger.info(
            "[mm] analyze_image provider=%s model=%s ms=%s bytes=%s",
            self.name,
            self._vision_model,
            dt_ms,
            len(image_bytes),
        )
        return AnalysisResult(text=text, provider=self.name, model=self._vision_model)

    async def generate_image(
        self,
        *,
        prompt: str,
        size: str | None = None,
        style: str | None = None,
    ) -> GeneratedImage:
        if not self._image_model:
            raise ValueError("image_model is not configured")

        payload: dict = {
            "model": self._image_model,
            "prompt": str(prompt or "").strip(),
            "size": str(size or "1024x1024"),
            "response_format": "b64_json",
        }
        if style:
            payload["style"] = str(style).strip()

        url = f"{self._base}/images/generations"
        t0 = asyncio.get_running_loop().time()
        obj = await asyncio.to_thread(
            _post_json_sync,
            url,
            headers=self._headers(),
            payload=payload,
        )
        dt_ms = int((asyncio.get_running_loop().time() - t0) * 1000)

        data0 = None
        try:
            data_list = obj.get("data") if isinstance(obj.get("data"), list) else []
            data0 = data_list[0] if data_list else None
        except Exception:
            data0 = None

        b64_json = data0.get("b64_json") if isinstance(data0, dict) else None
        if isinstance(b64_json, str) and b64_json:
            b64 = str(b64_json or "")
            try:
                img = base64.b64decode(b64, validate=False)
            except Exception as e:
                raise RuntimeError(f"invalid b64_json: {e}") from e
            mime = "image/png"
            logger.info(
                "[mm] generate_image provider=%s model=%s ms=%s bytes=%s",
                self.name,
                self._image_model,
                dt_ms,
                len(img),
            )
            return GeneratedImage(
                image_bytes=img,
                mime=mime,
                provider=self.name,
                model=self._image_model,
            )

        if isinstance(data0, dict) and isinstance(data0.get("url"), str) and data0.get("url"):
            img_url = str(data0.get("url") or "").strip()
            if not img_url:
                raise RuntimeError("empty image url")
            img, mime = await asyncio.to_thread(_get_bytes_sync, img_url)
            if not mime:
                mime = "application/octet-stream"
            logger.info(
                "[mm] generate_image(url) provider=%s model=%s ms=%s bytes=%s",
                self.name,
                self._image_model,
                dt_ms,
                len(img),
            )
            return GeneratedImage(
                image_bytes=img,
                mime=mime,
                provider=self.name,
                model=self._image_model,
            )

        raise RuntimeError("unsupported image generation response format")
