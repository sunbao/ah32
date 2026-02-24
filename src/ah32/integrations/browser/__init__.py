"""Playwright-based browser control layer (best-effort).

This package is designed to be imported by skill tool scripts. It must:
- Import safely even when Playwright isn't installed.
- Provide traceable errors (no silent failures).
"""

from .api import (
    BrowserContextConfig,
    BrowserOperationResult,
    BrowserSession,
    BrowserSessionConfig,
    cache_retrieve,
    cache_write,
    click_element,
    detect_captcha,
    extract_data,
    extract_table,
    fill_form,
    hover_element,
    navigate_to,
    open_browser_session,
    require_playwright,
    take_snapshot,
    wait_for_element,
    wait_for_text,
)
from .cache import BrowserCache, make_cache_key
from .errors import BrowserCaptchaError, BrowserError, BrowserNavigationError, BrowserUnavailableError

__all__ = [
    "BrowserCache",
    "BrowserCaptchaError",
    "BrowserContextConfig",
    "BrowserError",
    "BrowserNavigationError",
    "BrowserOperationResult",
    "BrowserSession",
    "BrowserSessionConfig",
    "BrowserUnavailableError",
    "click_element",
    "cache_retrieve",
    "cache_write",
    "detect_captcha",
    "extract_data",
    "extract_table",
    "fill_form",
    "hover_element",
    "make_cache_key",
    "navigate_to",
    "open_browser_session",
    "require_playwright",
    "take_snapshot",
    "wait_for_element",
    "wait_for_text",
]
