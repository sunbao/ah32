"""Playwright browser pool (singleton + reference counting)."""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from .errors import BrowserUnavailableError

logger = logging.getLogger(__name__)


def _truthy(v: str | None, *, default: bool = False) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")


def _load_playwright_sync() -> Any:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except Exception as e:
        raise BrowserUnavailableError(
            "playwright is not installed. Install with: pip install playwright; "
            "then run: playwright install"
        ) from e
    return sync_playwright


@dataclass
class BrowserHandle:
    pool: "BrowserPool"
    acquired_at: float

    def __enter__(self) -> "BrowserHandle":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.pool.release()

    @property
    def browser(self) -> Any:
        return self.pool._browser  # noqa: SLF001


class BrowserPool:
    _instance: Optional["BrowserPool"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._playwright = None
        self._browser = None
        self._ref_count = 0
        self._last_restart_at = 0.0

    @classmethod
    def instance(cls) -> "BrowserPool":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def acquire(self) -> BrowserHandle:
        with self._lock:
            self._ensure_browser()
            self._ref_count += 1
            return BrowserHandle(pool=self, acquired_at=time.time())

    def release(self) -> None:
        with self._lock:
            self._ref_count = max(0, int(self._ref_count) - 1)
            auto_close = _truthy(os.getenv("AH32_BROWSER_AUTO_CLOSE"), default=False)
            if auto_close and self._ref_count == 0:
                self.close()

    def close(self) -> None:
        with self._lock:
            try:
                if self._browser is not None:
                    self._browser.close()
            except Exception:
                logger.warning("[browser-pool] browser close failed", exc_info=True)
            self._browser = None

            try:
                if self._playwright is not None:
                    self._playwright.stop()
            except Exception:
                logger.warning("[browser-pool] playwright stop failed", exc_info=True)
            self._playwright = None

    def restart(self) -> None:
        with self._lock:
            # Avoid hot-loop restarts.
            now = time.time()
            if now - self._last_restart_at < 1.0:
                time.sleep(0.2)
            self._last_restart_at = time.time()
            self.close()
            self._ensure_browser()

    def health_check(self) -> bool:
        with self._lock:
            try:
                if self._browser is None:
                    return False
                return bool(self._browser.is_connected())
            except Exception:
                return False

    def _ensure_browser(self) -> None:
        if self._browser is not None:
            try:
                if self._browser.is_connected():
                    return
            except Exception:
                pass
            # Disconnected/stale browser: cleanup before re-launch.
            try:
                self.close()
            except Exception:
                logger.warning("[browser-pool] cleanup stale browser failed", exc_info=True)

        sync_playwright = _load_playwright_sync()
        self._playwright = sync_playwright().start()

        browser_type = str(os.getenv("AH32_BROWSER_TYPE") or "chromium").strip().lower()
        headless = _truthy(os.getenv("AH32_BROWSER_HEADLESS"), default=True)
        slow_mo = int(os.getenv("AH32_BROWSER_SLOW_MO_MS") or "0")
        chromium_sandbox_env = str(os.getenv("AH32_BROWSER_CHROMIUM_SANDBOX") or "").strip()
        chromium_sandbox: Optional[bool] = None
        if chromium_sandbox_env:
            chromium_sandbox = _truthy(chromium_sandbox_env, default=False)

        bt = getattr(self._playwright, browser_type, None)
        if bt is None:
            raise BrowserUnavailableError(f"unsupported browser type: {browser_type}")

        args = []
        raw_args = str(os.getenv("AH32_BROWSER_ARGS") or "").strip()
        if raw_args:
            args.extend([a for a in raw_args.split(" ") if a])

        try:
            launch_kwargs: dict[str, Any] = {
                "headless": headless,
                "slow_mo": slow_mo or None,
                "args": args or None,
            }
            if browser_type == "chromium" and chromium_sandbox is not None:
                launch_kwargs["chromium_sandbox"] = chromium_sandbox
            self._browser = bt.launch(**launch_kwargs)
        except Exception as e:
            # Stop playwright to avoid leaving a half-started driver around.
            try:
                if self._playwright is not None:
                    self._playwright.stop()
            except Exception:
                logger.warning("[browser-pool] cleanup after launch failure failed", exc_info=True)
            self._playwright = None
            self._browser = None
            raise BrowserUnavailableError(
                "failed to launch browser. Ensure Playwright browsers are installed: playwright install"
            ) from e
