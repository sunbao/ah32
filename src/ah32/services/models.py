"""Utilities to build language models used by the pipeline."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.llms import LLM
from langchain_openai import ChatOpenAI

from ah32.config import Ah32Settings

logger = logging.getLogger(__name__)

DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com"

# Try importing langchain-deepseek (optional).
try:
    from langchain_deepseek import ChatDeepSeek

    HAS_DEEPSEEK_PACKAGE = True
    logger.info("已加载 langchain-deepseek 包，支持 reasoning_content")
except ImportError:
    HAS_DEEPSEEK_PACKAGE = False
    ChatDeepSeek = None
    logger.info("未安装 langchain-deepseek，将使用 ChatOpenAI")


def _truthy_env(name: str, *, default: bool = False) -> bool:
    s = str(os.getenv(name, "") or "").strip().lower()
    if not s:
        return bool(default)
    return s in ("1", "true", "yes", "y", "on")


def _llm_strict_mode() -> bool:
    # Default: strict (do not silently downgrade providers).
    return _truthy_env("AH32_LLM_STRICT", default=True)


def _resolve_provider_base_url(model: str) -> tuple[str, str | None]:
    provider = (os.getenv("AH32_LLM_PROVIDER") or "").strip().lower()
    base_url = (os.getenv("AH32_LLM_BASE_URL") or "").strip() or None
    if base_url:
        # Explicit base_url wins; assume OpenAI-compatible unless provider is explicitly set.
        return (provider or "openai-compatible", base_url)
    if provider in ("deepseek", "deepseek-openai", "deepseek_compatible"):
        return ("deepseek", DEEPSEEK_DEFAULT_BASE_URL)
    if "deepseek" in (model or "").lower():
        return ("deepseek", DEEPSEEK_DEFAULT_BASE_URL)
    return (provider or "openai", None)


def _resolve_api_key(settings: Ah32Settings, provider: str) -> str:
    # IMPORTANT:
    # - Only use project-local keys (.env): AH32_OPENAI_API_KEY / DEEPSEEK_API_KEY.
    # - Do NOT fall back to global OPENAI_API_KEY, to avoid being polluted by host env vars.
    openai_key = (settings.OPENAI_API_KEY or os.getenv("AH32_OPENAI_API_KEY") or "").strip()
    deepseek_key = (os.getenv("DEEPSEEK_API_KEY") or "").strip()

    if provider == "deepseek":
        api_key = deepseek_key or openai_key
        if api_key:
            return api_key
        raise ValueError("缺少API密钥：请在 .env 中设置 DEEPSEEK_API_KEY（推荐）或 AH32_OPENAI_API_KEY")

    api_key = openai_key or deepseek_key
    if api_key:
        return api_key
    raise ValueError("缺少API密钥：请在 .env 中设置 AH32_OPENAI_API_KEY（推荐）或 DEEPSEEK_API_KEY")


class EchoLLM(LLM):
    """Fallback LLM that simply echoes the prompt."""

    @property
    def _llm_type(self) -> str:
        return "echo"

    def _call(
        self,
        prompt: str,
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
    ) -> str:
        suffix = prompt[-2000:]
        return f"[EchoLLM placeholder]\n{suffix}"

    @property
    def _identifying_params(self) -> Dict[str, Any]:
        return {}


class LLMManager:
    """LLM统一管理器 - 单例模式"""

    _instance: Optional["LLMManager"] = None
    _llm_instance: Optional[ChatOpenAI] = None
    _llm_cache: Dict[tuple[str, float], ChatOpenAI] = {}

    def __new__(cls) -> "LLMManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def get_llm(self, settings: Ah32Settings) -> ChatOpenAI:
        if self._llm_instance is None:
            self._llm_instance = self._create_llm(settings)
        return self._llm_instance

    def get_llm_custom(self, settings: Ah32Settings, model: str, temperature: float) -> ChatOpenAI:
        m = str(model or "").strip()
        if not m:
            raise ValueError("model is required")
        try:
            t = float(temperature)
        except Exception as exc:
            raise ValueError(f"temperature must be a number, got: {temperature!r}") from exc

        key = (m, t)
        if key not in self._llm_cache:
            self._llm_cache[key] = self._create_llm_custom(settings, model=m, temperature=t)
        return self._llm_cache[key]

    def _create_llm_custom(self, settings: Ah32Settings, model: str, temperature: float) -> ChatOpenAI:
        provider, base_url = _resolve_provider_base_url(model)
        api_key = _resolve_api_key(settings, provider=provider)
        is_deepseek = provider == "deepseek"
        strict = _llm_strict_mode()

        logger.info(
            "Creating LLM (override): model=%s provider=%s base_url=%s temperature=%s",
            model,
            provider,
            base_url,
            temperature,
        )

        # Prefer langchain-deepseek for DeepSeek models (native reasoning_content support).
        # NOTE: ChatDeepSeek does not accept a custom base_url in older versions; only use it for default endpoint.
        if is_deepseek and strict:
            if not HAS_DEEPSEEK_PACKAGE or ChatDeepSeek is None:
                raise ValueError("缺少依赖：请安装 langchain-deepseek（strict 模式不允许降级到 ChatOpenAI）")
            if base_url and base_url != DEEPSEEK_DEFAULT_BASE_URL:
                raise ValueError(
                    "DeepSeek strict 模式不支持自定义 base_url（请移除 AH32_LLM_BASE_URL 或关闭 AH32_LLM_STRICT）"
                )
            logger.info("Using ChatDeepSeek (override, strict)")
            return ChatDeepSeek(
                model=model,
                temperature=temperature,
                api_key=api_key,
                request_timeout=1800,
                max_retries=3,
            )

        if (
            is_deepseek
            and (not base_url or base_url == DEEPSEEK_DEFAULT_BASE_URL)
            and HAS_DEEPSEEK_PACKAGE
            and ChatDeepSeek is not None
        ):
            logger.info("Using ChatDeepSeek (override)")
            return ChatDeepSeek(
                model=model,
                temperature=temperature,
                api_key=api_key,
                request_timeout=1800,
                max_retries=3,
            )

        return ChatOpenAI(
            model=model,
            temperature=temperature,
            api_key=api_key,
            base_url=base_url,
            request_timeout=1800,
            max_retries=3,
        )

    def _create_llm(self, settings: Ah32Settings) -> ChatOpenAI:
        model = (settings.llm_model or os.getenv("AH32_LLM_MODEL") or "").strip()
        if not model:
            raise ValueError("未在环境变量中找到模型配置！请检查 .env 文件中的 AH32_LLM_MODEL")

        # 温度参数从环境变量读取（必须配置）
        temperature_str = os.getenv("AH32_LLM_TEMPERATURE")
        if not temperature_str:
            raise ValueError("未在环境变量中找到温度配置！请检查 .env 文件中的 AH32_LLM_TEMPERATURE")

        try:
            temperature = float(temperature_str)
        except ValueError:
            raise ValueError(f"AH32_LLM_TEMPERATURE 必须是数字，当前值: {temperature_str}")

        provider, base_url = _resolve_provider_base_url(model)
        api_key = _resolve_api_key(settings, provider=provider)
        is_deepseek = provider == "deepseek"
        strict = _llm_strict_mode()

        logger.info(
            "创建LLM实例: model=%s provider=%s base_url=%s temperature=%s",
            model,
            provider,
            base_url,
            temperature,
        )

        try:
            # 优先使用 langchain-deepseek 包（原生支持 reasoning_content）
            if is_deepseek and strict:
                if not HAS_DEEPSEEK_PACKAGE or ChatDeepSeek is None:
                    raise ValueError("缺少依赖：请安装 langchain-deepseek（strict 模式不允许降级到 ChatOpenAI）")
                if base_url and base_url != DEEPSEEK_DEFAULT_BASE_URL:
                    raise ValueError(
                        "DeepSeek strict 模式不支持自定义 base_url（请移除 AH32_LLM_BASE_URL 或关闭 AH32_LLM_STRICT）"
                    )
                logger.info("使用 ChatDeepSeek（strict，原生支持 reasoning_content）")
                return ChatDeepSeek(
                    model=model,
                    temperature=temperature,
                    api_key=api_key,
                    request_timeout=1800,
                    max_retries=3,
                )

            if (
                is_deepseek
                and (not base_url or base_url == DEEPSEEK_DEFAULT_BASE_URL)
                and HAS_DEEPSEEK_PACKAGE
                and ChatDeepSeek is not None
            ):
                logger.info("使用 ChatDeepSeek（原生支持 reasoning_content）")
                return ChatDeepSeek(
                    model=model,
                    temperature=temperature,
                    api_key=api_key,
                    request_timeout=1800,
                    max_retries=3,
                )

            return ChatOpenAI(
                model=model,
                temperature=temperature,
                api_key=api_key,
                base_url=base_url,
                request_timeout=1800,
                max_retries=3,
            )
        except Exception as exc:
            logger.error("创建ChatOpenAI失败: %s", exc, exc_info=True)
            raise

    def reload_llm(self, settings: Ah32Settings) -> ChatOpenAI:
        logger.info("重新加载LLM实例...")
        self._llm_instance = None
        return self.get_llm(settings)

    def get_llm_info(self) -> Dict[str, Any]:
        if self._llm_instance is None:
            return {"status": "not_initialized"}

        return {
            "status": "initialized",
            "model": getattr(self._llm_instance, "model_name", "unknown"),
            "type": type(self._llm_instance).__name__,
            "has_api_key": getattr(self._llm_instance, "openai_api_key", None) is not None,
        }


_llm_manager = LLMManager()


def load_llm(settings: Ah32Settings) -> ChatOpenAI:
    return _llm_manager.get_llm(settings)


def load_llm_custom(settings: Ah32Settings, model: str, temperature: float) -> ChatOpenAI:
    return _llm_manager.get_llm_custom(settings=settings, model=model, temperature=temperature)


def resolve_plan_llm_config(settings: Ah32Settings) -> tuple[str, float]:
    """Resolve the model/temperature used by deterministic Plan generation paths."""
    plan_model = (os.getenv("AH32_PLAN_MODEL") or "").strip()
    if not plan_model:
        base_model = str(getattr(settings, "llm_model", "") or os.getenv("AH32_LLM_MODEL") or "").strip()
        plan_model = "deepseek-chat" if "deepseek-reasoner" in base_model.lower() else (base_model or "deepseek-chat")

    plan_temp_raw = (os.getenv("AH32_PLAN_TEMPERATURE") or "").strip()
    plan_temp = float(plan_temp_raw) if plan_temp_raw else 0.1
    return plan_model, plan_temp


def load_plan_llm(settings: Ah32Settings) -> tuple[ChatOpenAI, str, float]:
    """Load the dedicated LLM used by Plan-generate / Plan-repair paths."""
    plan_model, plan_temp = resolve_plan_llm_config(settings)
    return load_llm_custom(settings=settings, model=plan_model, temperature=plan_temp), plan_model, plan_temp


def get_llm_manager() -> LLMManager:
    return _llm_manager
