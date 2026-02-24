"""Browser control APIs used by skill tools.

Design goals:
- Best-effort and observable (logs + screenshot/trace paths).
- Safe imports when Playwright isn't installed.
- Minimal, stable contracts for higher-level scrapers/tools.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, TypedDict

from ah32.config import settings

from .errors import BrowserUnavailableError
from .cache import BrowserCache
from .pool import BrowserPool
from .selectors import SelectorKind, normalize_selector

logger = logging.getLogger(__name__)


DEFAULT_TIMEOUT_MS = int(os.getenv("AH32_BROWSER_TIMEOUT_MS") or "30000")
DEFAULT_WAIT_UNTIL = str(os.getenv("AH32_BROWSER_WAIT_UNTIL") or "networkidle").strip() or "networkidle"


class BrowserErrorPayload(TypedDict, total=False):
    code: str
    message: str
    details: Dict[str, Any]


class BrowserMeta(TypedDict, total=False):
    trace_id: str
    elapsed_ms: int
    url: str
    selector: str
    step: str
    screenshot_path: str
    trace_path: str


class BrowserOperationResult(TypedDict, total=False):
    ok: bool
    data: Dict[str, Any]
    error: BrowserErrorPayload
    meta: BrowserMeta


def _new_trace_id() -> str:
    return f"br_{uuid.uuid4().hex[:12]}"


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _cleanup_dir_by_age(root: Path, *, max_days: int) -> None:
    if max_days <= 0:
        return
    now = time.time()
    cutoff = now - (max_days * 86400)
    for p in root.rglob("*"):
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except Exception:
            logger.debug("[browser] retention cleanup failed: %s", p, exc_info=True)


def _trace_dirs() -> tuple[Path, Path]:
    trace_dir = settings.storage_root / "browser_traces"
    screenshot_dir = settings.storage_root / "browser_traces" / "screenshots"
    _ensure_dir(trace_dir)
    _ensure_dir(screenshot_dir)
    # Retention: traces 7 days, screenshots 30 days (configurable).
    _cleanup_dir_by_age(trace_dir, max_days=int(os.getenv("AH32_BROWSER_TRACE_RETENTION_DAYS") or "7"))
    _cleanup_dir_by_age(
        screenshot_dir, max_days=int(os.getenv("AH32_BROWSER_SCREENSHOT_RETENTION_DAYS") or "30")
    )
    return trace_dir, screenshot_dir


def _classify_wait_until(value: str | None) -> str:
    v = str(value or "").strip().lower()
    if v in ("load", "domcontentloaded", "networkidle", "commit"):
        return v
    return DEFAULT_WAIT_UNTIL


def _ok(*, data: Dict[str, Any], meta: BrowserMeta) -> BrowserOperationResult:
    return {"ok": True, "data": data, "meta": meta}


def _err(*, code: str, message: str, meta: BrowserMeta, details: Optional[Dict[str, Any]] = None) -> BrowserOperationResult:
    payload: BrowserErrorPayload = {"code": str(code), "message": str(message)}
    if details:
        payload["details"] = details
    return {"ok": False, "error": payload, "meta": meta}


@dataclass(frozen=True)
class BrowserContextConfig:
    extra_headers: Optional[Dict[str, str]] = None
    cookies: Optional[List[Dict[str, Any]]] = None
    user_agent: str | None = None


@dataclass(frozen=True)
class BrowserSessionConfig:
    context: BrowserContextConfig = BrowserContextConfig()
    record_trace: bool = False
    trace_id: str | None = None


@dataclass
class BrowserSession:
    trace_id: str
    context: Any
    page: Any
    trace_dir: Path
    screenshot_dir: Path
    record_trace: bool
    trace_active: bool = False


_CACHE_SINGLETON: BrowserCache | None = None


def _get_cache() -> BrowserCache:
    global _CACHE_SINGLETON
    if _CACHE_SINGLETON is None:
        _CACHE_SINGLETON = BrowserCache()
    return _CACHE_SINGLETON


def _capture_screenshot(session: BrowserSession, *, step: str) -> str | None:
    try:
        path = session.screenshot_dir / f"{session.trace_id}_{step}_{int(time.time())}.png"
        session.page.screenshot(path=str(path), full_page=True)
        return str(path)
    except Exception:
        logger.debug("[browser] screenshot failed trace_id=%s step=%s", session.trace_id, step, exc_info=True)
        return None


def _save_trace(session: BrowserSession, *, step: str) -> str | None:
    if not session.record_trace or not session.trace_active:
        return None
    try:
        path = session.trace_dir / f"{session.trace_id}_{step}_{int(time.time())}.zip"
        session.context.tracing.stop(path=str(path))
        session.trace_active = False
        return str(path)
    except Exception:
        logger.debug("[browser] trace save failed trace_id=%s step=%s", session.trace_id, step, exc_info=True)
        return None


@contextmanager
def open_browser_session(config: BrowserSessionConfig | None = None) -> Iterator[BrowserSession]:
    cfg = config or BrowserSessionConfig()
    trace_id = str(cfg.trace_id or _new_trace_id())
    trace_dir, screenshot_dir = _trace_dirs()

    with BrowserPool.instance().acquire() as handle:
        context = None
        page = None
        session: BrowserSession | None = None
        try:
            context_args: Dict[str, Any] = {}
            if cfg.context.user_agent:
                context_args["user_agent"] = str(cfg.context.user_agent)
            if cfg.context.extra_headers:
                context_args["extra_http_headers"] = dict(cfg.context.extra_headers)

            context = handle.browser.new_context(**context_args)
            try:
                if cfg.context.cookies:
                    context.add_cookies(list(cfg.context.cookies))
            except Exception:
                logger.warning("[browser] add_cookies failed trace_id=%s", trace_id, exc_info=True)

            session = BrowserSession(
                trace_id=trace_id,
                context=context,
                page=None,
                trace_dir=trace_dir,
                screenshot_dir=screenshot_dir,
                record_trace=bool(cfg.record_trace),
                trace_active=False,
            )

            if session.record_trace:
                try:
                    context.tracing.start(screenshots=True, snapshots=True, sources=False)
                    session.trace_active = True
                except Exception:
                    logger.warning("[browser] tracing.start failed trace_id=%s", trace_id, exc_info=True)
                    session.record_trace = False
                    session.trace_active = False

            page = context.new_page()
            session.page = page
            yield session
        finally:
            # Always save trace on exit when enabled and still active.
            try:
                if session is not None:
                    _save_trace(session, step="session_end")
            except Exception:
                logger.debug("[browser] trace final save failed trace_id=%s", trace_id, exc_info=True)

            # Close page/context best-effort.
            try:
                if page is not None:
                    page.close()
            except Exception:
                logger.debug("[browser] page close failed trace_id=%s", trace_id, exc_info=True)
            try:
                if context is not None:
                    context.close()
            except Exception:
                logger.debug("[browser] context close failed trace_id=%s", trace_id, exc_info=True)


def navigate_to(
    session: BrowserSession,
    *,
    url: str,
    wait_until: str | None = None,
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "navigate_to"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS
    wait = _classify_wait_until(wait_until)

    try:
        session.page.goto(str(url), wait_until=wait, timeout=timeout)
        title = ""
        try:
            title = session.page.title() or ""
        except Exception:
            title = ""
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"title": title, "final_url": str(getattr(session.page, "url", url))},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "url": str(url), "step": step},
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] navigate_to failed trace_id=%s url=%s err=%s", session.trace_id, url, e, exc_info=True)
        return _err(
            code="E_NAVIGATION_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "url": str(url),
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def click_element(
    session: BrowserSession,
    *,
    selector: str,
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "click_element"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS
    try:
        sel, kind = normalize_selector(selector)
        session.page.click(sel, timeout=timeout)
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"clicked": True, "selector_kind": str(kind)},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "selector": str(selector), "step": step},
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning(
            "[browser] click_element failed trace_id=%s selector=%s err=%s",
            session.trace_id,
            selector,
            e,
            exc_info=True,
        )
        return _err(
            code="E_CLICK_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": str(selector),
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def hover_element(
    session: BrowserSession,
    *,
    selector: str,
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "hover_element"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS
    try:
        sel, kind = normalize_selector(selector)
        session.page.hover(sel, timeout=timeout)
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"hovered": True, "selector_kind": str(kind)},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "selector": str(selector), "step": step},
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning(
            "[browser] hover_element failed trace_id=%s selector=%s err=%s",
            session.trace_id,
            selector,
            e,
            exc_info=True,
        )
        return _err(
            code="E_HOVER_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": str(selector),
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def fill_form(
    session: BrowserSession,
    *,
    fields: Dict[str, str],
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "fill_form"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS

    filled = 0
    try:
        for raw_selector, value in (fields or {}).items():
            sel, _ = normalize_selector(raw_selector)
            session.page.fill(sel, str(value or ""), timeout=timeout)
            filled += 1
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(data={"filled": filled}, meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step})
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] fill_form failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_FILL_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def take_snapshot(session: BrowserSession) -> BrowserOperationResult:
    step = "take_snapshot"
    start = time.time()
    try:
        text = session.page.inner_text("body")
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"text": text},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step},
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] take_snapshot failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_SNAPSHOT_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def extract_table(
    session: BrowserSession,
    *,
    table_selector: str,
    columns: Dict[str, int | str],
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    """Extract a HTML table into structured rows.

    columns maps output_field -> column_index (0-based) OR a CSS selector within row.
    """
    step = "extract_table"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS

    try:
        table_sel, _ = normalize_selector(table_selector)
        table = session.page.wait_for_selector(table_sel, timeout=timeout)
        rows = table.query_selector_all("tr")
        out: List[Dict[str, Any]] = []
        for r in rows:
            cells = r.query_selector_all("th,td")
            if not cells:
                continue
            row: Dict[str, Any] = {}
            for field, spec in (columns or {}).items():
                if isinstance(spec, int):
                    idx = spec
                    if 0 <= idx < len(cells):
                        row[field] = (cells[idx].inner_text() or "").strip()
                    else:
                        row[field] = ""
                else:
                    q = str(spec or "").strip()
                    if not q:
                        row[field] = ""
                        continue
                    el = r.query_selector(q)
                    row[field] = (el.inner_text() or "").strip() if el else ""
            if any(v for v in row.values()):
                out.append(row)

        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"rows": out, "row_count": len(out)},
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": str(table_selector),
                "step": step,
            },
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] extract_table failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_EXTRACT_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": str(table_selector),
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def extract_data(
    session: BrowserSession,
    *,
    schema: Dict[str, str],
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    """Extract structured fields by selector mapping.

    schema maps field_name -> selector (CSS/XPath/text; see normalize_selector()).
    """
    step = "extract_data"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS
    out: Dict[str, Any] = {}
    try:
        for field, raw_selector in (schema or {}).items():
            sel, _ = normalize_selector(raw_selector)
            try:
                el = session.page.wait_for_selector(sel, timeout=timeout)
                out[field] = (el.inner_text() or "").strip() if el else ""
            except Exception:
                out[field] = ""
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"fields": out},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step},
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] extract_data failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_EXTRACT_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def _playwright_timeout_error() -> type[Exception]:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError  # type: ignore

        return PlaywrightTimeoutError
    except Exception:
        return TimeoutError


def wait_for_element(
    session: BrowserSession,
    *,
    selector: str,
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "wait_for_element"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS

    try:
        sel, kind = normalize_selector(selector)
        session.page.wait_for_selector(sel, timeout=timeout)
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"found": True, "selector_kind": str(kind)},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "selector": selector, "step": step},
        )
    except _playwright_timeout_error() as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning(
            "[browser] wait_for_element timeout trace_id=%s selector=%s err=%s",
            session.trace_id,
            selector,
            e,
            exc_info=True,
        )
        return _err(
            code="E_WAIT_TIMEOUT",
            message=f"timeout waiting for element: {selector}",
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": selector,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] wait_for_element failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_WAIT_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "selector": selector,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def wait_for_text(
    session: BrowserSession,
    *,
    text: str,
    timeout_ms: int | None = None,
) -> BrowserOperationResult:
    step = "wait_for_text"
    start = time.time()
    timeout = int(timeout_ms) if timeout_ms is not None else DEFAULT_TIMEOUT_MS
    target = str(text or "").strip()
    if not target:
        return _err(
            code="E_INVALID_ARGUMENT",
            message="text is empty",
            meta={"trace_id": session.trace_id, "elapsed_ms": 0, "step": step},
        )

    try:
        session.page.wait_for_selector(f"text={target}", timeout=timeout)
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(data={"found": True}, meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step})
    except _playwright_timeout_error() as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] wait_for_text timeout trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_WAIT_TIMEOUT",
            message=f"timeout waiting for text: {target}",
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )
    except Exception as e:
        screenshot = _capture_screenshot(session, step=step)
        trace_path = _save_trace(session, step=step)
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] wait_for_text failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_WAIT_FAILED",
            message=str(e),
            meta={
                "trace_id": session.trace_id,
                "elapsed_ms": elapsed_ms,
                "step": step,
                "screenshot_path": screenshot or "",
                "trace_path": trace_path or "",
            },
        )


def detect_captcha(session: BrowserSession) -> BrowserOperationResult:
    """Heuristic captcha detector (best-effort)."""
    step = "detect_captcha"
    start = time.time()
    try:
        body_text = ""
        try:
            body_text = (session.page.inner_text("body") or "").lower()
        except Exception:
            body_text = ""

        keywords = ("验证码", "captcha", "verify", "滑块", "请完成验证", "安全验证")
        hit_text = any(k.lower() in body_text for k in keywords)

        hit_dom = False
        try:
            candidates = session.page.query_selector_all(
                "[id*='captcha'],[class*='captcha'],[id*='verify'],[class*='verify']"
            )
            hit_dom = bool(candidates)
        except Exception:
            hit_dom = False

        detected = bool(hit_text or hit_dom)
        kind = "unknown"
        if detected:
            if "滑块" in body_text or "slider" in body_text:
                kind = "slider"
            elif "图形" in body_text or "图片" in body_text:
                kind = "image"

        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(
            data={"detected": detected, "kind": kind},
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step},
        )
    except Exception as e:
        elapsed_ms = int((time.time() - start) * 1000)
        logger.warning("[browser] detect_captcha failed trace_id=%s err=%s", session.trace_id, e, exc_info=True)
        return _err(
            code="E_CAPTCHA_DETECT_FAILED",
            message=str(e),
            meta={"trace_id": session.trace_id, "elapsed_ms": elapsed_ms, "step": step},
        )


def cache_write(*, key: str, data: Any, ttl_seconds: int | None = None) -> BrowserOperationResult:
    """Cache arbitrary JSON-serializable data (memory + file)."""
    step = "cache_write"
    start = time.time()
    try:
        _get_cache().put(str(key), data, ttl_seconds=ttl_seconds)
        elapsed_ms = int((time.time() - start) * 1000)
        return _ok(data={"cached": True}, meta={"trace_id": _new_trace_id(), "elapsed_ms": elapsed_ms, "step": step})
    except Exception as e:
        logger.warning("[browser] cache_write failed key=%s err=%s", key, e, exc_info=True)
        elapsed_ms = int((time.time() - start) * 1000)
        return _err(
            code="E_CACHE_WRITE_FAILED",
            message=str(e),
            meta={"trace_id": _new_trace_id(), "elapsed_ms": elapsed_ms, "step": step},
        )


def cache_retrieve(*, key: str) -> BrowserOperationResult:
    """Retrieve cached data by key."""
    step = "cache_retrieve"
    start = time.time()
    try:
        value = _get_cache().get(str(key))
        elapsed_ms = int((time.time() - start) * 1000)
        if value is None:
            return _ok(
                data={"hit": False, "value": None},
                meta={"trace_id": _new_trace_id(), "elapsed_ms": elapsed_ms, "step": step},
            )
        return _ok(
            data={"hit": True, "value": value},
            meta={"trace_id": _new_trace_id(), "elapsed_ms": elapsed_ms, "step": step},
        )
    except Exception as e:
        logger.warning("[browser] cache_retrieve failed key=%s err=%s", key, e, exc_info=True)
        elapsed_ms = int((time.time() - start) * 1000)
        return _err(
            code="E_CACHE_READ_FAILED",
            message=str(e),
            meta={"trace_id": _new_trace_id(), "elapsed_ms": elapsed_ms, "step": step},
        )


def require_playwright() -> None:
    """Raise BrowserUnavailableError if Playwright is not available."""
    try:
        # Ensure we can import the sync api.
        from playwright.sync_api import sync_playwright  # type: ignore  # noqa: F401
    except Exception as e:
        raise BrowserUnavailableError(
            "playwright is not installed. Install with: pip install playwright; then run: playwright install"
        ) from e
