from __future__ import annotations

import logging

from ah32.config import Ah32Settings

from .openai_compatible import OpenAICompatibleConfig, OpenAICompatibleMultimodalProvider
from .provider import MultimodalProvider

logger = logging.getLogger(__name__)

BAILIAN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def get_multimodal_provider(settings: Ah32Settings) -> MultimodalProvider | None:
    """Resolve multimodal provider from settings (strict-by-default)."""
    provider = str(getattr(settings, "mm_provider", "") or "").strip().lower() or "disabled"
    strict = bool(getattr(settings, "mm_strict", True))

    if provider in ("disabled", "off", "none", "false", "0"):
        logger.info("[mm] provider=disabled")
        return None

    if provider == "bailian":
        api_key = str(getattr(settings, "bailian_api_key", "") or "").strip()
        base_url = (
            str(getattr(settings, "bailian_base_url", "") or "").strip()
            or BAILIAN_DEFAULT_BASE_URL
        )
        vision_model = str(getattr(settings, "bailian_vision_model", "") or "").strip()
        image_model = str(getattr(settings, "bailian_image_model", "") or "").strip()

        missing = []
        if not api_key:
            missing.append("AH32_BAILIAN_API_KEY")
        if not vision_model:
            missing.append("AH32_BAILIAN_VISION_MODEL")
        if not image_model:
            missing.append("AH32_BAILIAN_IMAGE_MODEL")
        if missing and strict:
            raise ValueError(f"multimodal provider=bailian missing config: {', '.join(missing)}")

        logger.info(
            "[mm] provider=bailian base_url=%s vision_model=%s image_model=%s strict=%s",
            base_url,
            vision_model,
            image_model,
            strict,
        )
        return OpenAICompatibleMultimodalProvider(
            OpenAICompatibleConfig(
                name="bailian",
                base_url=base_url,
                api_key=api_key,
                vision_model=vision_model,
                image_model=image_model,
            )
        )

    if provider in ("openai-compatible", "openai_compatible", "oai-compatible", "oai"):
        api_key = str(getattr(settings, "mm_api_key", "") or "").strip()
        base_url = str(getattr(settings, "mm_base_url", "") or "").strip()
        vision_model = str(getattr(settings, "mm_vision_model", "") or "").strip()
        image_model = str(getattr(settings, "mm_image_model", "") or "").strip()

        missing = []
        if not api_key:
            missing.append("AH32_MM_API_KEY")
        if not base_url:
            missing.append("AH32_MM_BASE_URL")
        if not vision_model:
            missing.append("AH32_MM_VISION_MODEL")
        if not image_model:
            missing.append("AH32_MM_IMAGE_MODEL")
        if missing and strict:
            raise ValueError(
                "multimodal provider=openai-compatible missing config: "
                + ", ".join(missing)
            )

        logger.info(
            "[mm] provider=openai-compatible base_url=%s vision_model=%s image_model=%s strict=%s",
            base_url,
            vision_model,
            image_model,
            strict,
        )
        return OpenAICompatibleMultimodalProvider(
            OpenAICompatibleConfig(
                name="openai-compatible",
                base_url=base_url,
                api_key=api_key,
                vision_model=vision_model,
                image_model=image_model,
            )
        )

    raise ValueError(f"unsupported multimodal provider: {provider}")
