"""Browser control layer errors."""

from __future__ import annotations


class BrowserError(RuntimeError):
    """Base error for browser-control-layer."""


class BrowserUnavailableError(BrowserError):
    """Playwright/browser is not available in current environment."""


class BrowserNavigationError(BrowserError):
    """Navigation (goto/wait_until) failed."""


class BrowserInteractionError(BrowserError):
    """User interaction (click/fill/hover) failed."""


class BrowserCaptchaError(BrowserError):
    """A captcha is detected; caller should degrade to manual handling."""

