"""Network-related backend tools for LLM tool-calls.

These tools are executed on the backend (server-side) and are intended to be exposed
to the LLM via the tool allowlist.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.request
import urllib.error
from urllib.parse import urljoin
from dataclasses import dataclass
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _safe_int(v: Any, default: int, *, min_v: int, max_v: int) -> int:
    try:
        n = int(v)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


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


def _guess_charset(content_type: str) -> str:
    ct = str(content_type or "")
    m = re.search(r"charset=([a-zA-Z0-9._\\-]+)", ct, flags=re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return "utf-8"


def _decode_bytes(data: bytes, *, charset: str) -> str:
    try:
        return data.decode(charset, errors="replace")
    except Exception:
        return data.decode("utf-8", errors="replace")


def _strip_html_to_text(html: str, *, max_chars: int) -> str:
    s = str(html or "")
    s = re.sub(r"(?is)<script.*?>.*?</script>", " ", s)
    s = re.sub(r"(?is)<style.*?>.*?</style>", " ", s)
    s = re.sub(r"(?is)<!--.*?-->", " ", s)
    s = re.sub(r"(?is)<[^>]+>", " ", s)
    s = re.sub(r"[ \\t\\r\\f\\v]+", " ", s)
    s = re.sub(r"\\n\\s*\\n+", "\\n\\n", s)
    s = s.strip()
    if len(s) > max_chars:
        return s[: max_chars - 20] + "\\n...(truncated)"
    return s


@dataclass(frozen=True)
class WebFetchResult:
    ok: bool
    url: str
    final_url: str
    status: int
    content_type: str
    bytes: int
    text: str
    truncated: bool
    error: str = ""

    def to_json(self) -> str:
        return json.dumps(
            {
                "ok": self.ok,
                "url": self.url,
                "final_url": self.final_url,
                "status": self.status,
                "content_type": self.content_type,
                "bytes": self.bytes,
                "truncated": self.truncated,
                "text": self.text,
                "error": self.error,
            },
            ensure_ascii=False,
            default=str,
        )


def _web_fetch_sync(
    *,
    url: str,
    timeout_sec: int,
    max_bytes: int,
    mode: str,
    user_agent: str,
) -> WebFetchResult:
    t0 = time.perf_counter()
    u = str(url or "").strip()
    if not u:
        return WebFetchResult(
            ok=False,
            url="",
            final_url="",
            status=0,
            content_type="",
            bytes=0,
            text="",
            truncated=False,
            error="missing url",
        )
    # SSRF guard (tenant-scoped, allow-by-default + blacklist deny).
    try:
        from ah32.tenancy.usage_audit import record_usage
        from ah32.tenancy.context import get_tenant_id, get_trace_id
        from ah32.security.ssrf_guard import check_url

        tid = str(get_tenant_id() or "").strip() or "public"
        tr = str(get_trace_id() or "").strip()
        decision = check_url(url=u, tenant_id=tid, trace_id=tr, tool="web_fetch")
        if not decision.ok:
            record_usage(
                event="tool_call",
                ok=False,
                component="network",
                action="web_fetch",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                tenant_id=tid,
                trace_id=tr,
                url=u,
                extra={"reason": decision.reason},
            )
            return WebFetchResult(
                ok=False,
                url=u,
                final_url="",
                status=0,
                content_type="",
                bytes=0,
                text="",
                truncated=False,
                error=f"ssrf_denied: {decision.reason}",
            )
    except Exception as e:
        logger.error("[web_fetch] ssrf_guard failed: %s", e, exc_info=True)
        try:
            from ah32.tenancy.usage_audit import record_usage
            from ah32.tenancy.context import get_tenant_id, get_trace_id

            tid = str(get_tenant_id() or "").strip() or "public"
            tr = str(get_trace_id() or "").strip()
            record_usage(
                event="tool_call",
                ok=False,
                component="network",
                action="web_fetch",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                tenant_id=tid,
                trace_id=tr,
                url=u,
                extra={"error": f"ssrf_guard_error: {e}"},
            )
        except Exception:
            pass
        return WebFetchResult(
            ok=False,
            url=u,
            final_url="",
            status=0,
            content_type="",
            bytes=0,
            text="",
            truncated=False,
            error=f"ssrf_guard_error: {e}",
        )

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
            return None

    opener = urllib.request.build_opener(_NoRedirect())
    try:
        current = u
        max_hops = 5
        raw = b""
        status = 0
        content_type = ""
        final_url = u

        for hop in range(max_hops + 1):
            # Re-validate each hop (redirect chain).
            try:
                from ah32.tenancy.context import get_tenant_id, get_trace_id
                from ah32.security.ssrf_guard import check_url

                tid = str(get_tenant_id() or "").strip() or "public"
                tr = str(get_trace_id() or "").strip()
                decision = check_url(url=current, tenant_id=tid, trace_id=tr, tool="web_fetch")
                if not decision.ok:
                    return WebFetchResult(
                        ok=False,
                        url=u,
                        final_url=final_url,
                        status=0,
                        content_type="",
                        bytes=0,
                        text="",
                        truncated=False,
                        error=f"ssrf_denied: {decision.reason}",
                    )
            except Exception as e:
                logger.error("[web_fetch] ssrf_guard redirect-hop failed: %s", e, exc_info=True)
                return WebFetchResult(
                    ok=False,
                    url=u,
                    final_url=final_url,
                    status=0,
                    content_type="",
                    bytes=0,
                    text="",
                    truncated=False,
                    error=f"ssrf_guard_error: {e}",
                )

            req = urllib.request.Request(
                current,
                headers={
                    "User-Agent": str(user_agent or "AH32/1.0"),
                    "Accept": "*/*",
                },
                method="GET",
            )
            try:
                with opener.open(req, timeout=float(timeout_sec)) as resp:
                    status = int(getattr(resp, "status", 200) or 200)
                    final_url = str(getattr(resp, "url", current) or current)
                    content_type = str(resp.headers.get("Content-Type") or "")
                    if 300 <= status < 400:
                        loc = str(resp.headers.get("Location") or "").strip()
                        if loc and hop < max_hops:
                            current = urljoin(current, loc)
                            continue
                    raw = resp.read(max_bytes + 1)
                    break
            except urllib.error.HTTPError as e:
                status = int(getattr(e, "code", 0) or 0)
                final_url = current
                try:
                    content_type = str(getattr(e, "headers", {}).get("Content-Type") or "")
                except Exception:
                    content_type = ""
                if 300 <= status < 400:
                    try:
                        loc = str(getattr(e, "headers", {}).get("Location") or "").strip()
                    except Exception:
                        loc = ""
                    if loc and hop < max_hops:
                        current = urljoin(current, loc)
                        continue
                raise
    except Exception as e:
        logger.warning("[web_fetch] failed url=%s err=%s", u, e, exc_info=True)
        try:
            from ah32.tenancy.usage_audit import record_usage
            from ah32.tenancy.context import get_tenant_id, get_trace_id

            tid = str(get_tenant_id() or "").strip() or "public"
            tr = str(get_trace_id() or "").strip()
            record_usage(
                event="tool_call",
                ok=False,
                component="network",
                action="web_fetch",
                elapsed_ms=int((time.perf_counter() - t0) * 1000),
                tenant_id=tid,
                trace_id=tr,
                url=u,
                extra={"error": str(e)},
            )
        except Exception:
            pass
        return WebFetchResult(
            ok=False,
            url=u,
            final_url="",
            status=0,
            content_type="",
            bytes=0,
            text="",
            truncated=False,
            error=str(e),
        )

    truncated = len(raw) > max_bytes
    if truncated:
        raw = raw[:max_bytes]

    charset = _guess_charset(content_type)
    decoded = _decode_bytes(raw, charset=charset)

    max_chars = 200_000
    if mode == "text":
        text = _strip_html_to_text(decoded, max_chars=max_chars)
        truncated = truncated or ("...(truncated)" in text)
    else:
        # raw
        if len(decoded) > max_chars:
            decoded = decoded[: max_chars - 20] + "\n...(truncated)"
            truncated = True
        text = decoded

    res = WebFetchResult(
        ok=True,
        url=u,
        final_url=final_url,
        status=status,
        content_type=content_type,
        bytes=len(raw),
        text=text,
        truncated=truncated,
        error="",
    )
    try:
        from ah32.tenancy.usage_audit import record_usage
        from ah32.tenancy.context import get_tenant_id, get_trace_id

        tid = str(get_tenant_id() or "").strip() or "public"
        tr = str(get_trace_id() or "").strip()
        record_usage(
            event="tool_call",
            ok=bool(res.ok),
            component="network",
            action="web_fetch",
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
            status_code=int(res.status or 0),
            tenant_id=tid,
            trace_id=tr,
            url=str(res.final_url or res.url or u),
            extra={"bytes": int(res.bytes), "truncated": bool(res.truncated)},
        )
    except Exception:
        pass
    return res


class WebFetchTool:
    """Fetch a URL over HTTP(S) and return decoded text."""

    name: str = "web_fetch"
    description: str = "抓取网页内容（HTTP/HTTPS），返回文本（可选：原始/抽取）。输入为JSON参数。"

    def run(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        url = str(args.get("url") or "").strip()
        timeout_sec = _safe_int(args.get("timeout_sec"), 20, min_v=1, max_v=120)
        max_bytes = _safe_int(args.get("max_bytes"), 1_000_000, min_v=1_000, max_v=5_000_000)
        mode = str(args.get("mode") or "text").strip().lower()
        if mode not in ("text", "raw"):
            mode = "text"
        user_agent = str(args.get("user_agent") or "AH32/1.0").strip()

        res = _web_fetch_sync(
            url=url,
            timeout_sec=timeout_sec,
            max_bytes=max_bytes,
            mode=mode,
            user_agent=user_agent,
        )
        return res.to_json()

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)


class BrowserSnapshotTool:
    """Use Playwright to navigate and snapshot visible body text."""

    name: str = "browser_snapshot"
    description: str = "用浏览器(Playwright)打开网页并抓取页面正文文本（适合动态站点）。输入为JSON参数。"

    def run(self, tool_input: Any) -> str:
        t0 = time.perf_counter()
        args = _parse_json_args(tool_input)
        url = str(args.get("url") or "").strip()
        timeout_ms = _safe_int(args.get("timeout_ms"), 30_000, min_v=1_000, max_v=180_000)
        wait_until = str(args.get("wait_until") or "domcontentloaded").strip()
        max_chars = _safe_int(args.get("max_chars"), 200_000, min_v=1_000, max_v=800_000)

        if not url:
            return json.dumps({"ok": False, "error": "missing url"}, ensure_ascii=False)

        # SSRF guard (tenant-scoped, allow-by-default + blacklist deny).
        try:
            from ah32.tenancy.usage_audit import record_usage
            from ah32.tenancy.context import get_tenant_id, get_trace_id
            from ah32.security.ssrf_guard import check_url

            tid = str(get_tenant_id() or "").strip() or "public"
            tr = str(get_trace_id() or "").strip()
            decision = check_url(url=url, tenant_id=tid, trace_id=tr, tool="browser_snapshot")
            if not decision.ok:
                record_usage(
                    event="tool_call",
                    ok=False,
                    component="network",
                    action="browser_snapshot",
                    elapsed_ms=int((time.perf_counter() - t0) * 1000),
                    tenant_id=tid,
                    trace_id=tr,
                    url=url,
                    extra={"reason": decision.reason},
                )
                return json.dumps(
                    {"ok": False, "error": f"ssrf_denied: {decision.reason}", "url": url},
                    ensure_ascii=False,
                )
        except Exception as e:
            logger.error("[browser_snapshot] ssrf_guard failed: %s", e, exc_info=True)
            try:
                from ah32.tenancy.usage_audit import record_usage
                from ah32.tenancy.context import get_tenant_id, get_trace_id

                tid = str(get_tenant_id() or "").strip() or "public"
                tr = str(get_trace_id() or "").strip()
                record_usage(
                    event="tool_call",
                    ok=False,
                    component="network",
                    action="browser_snapshot",
                    elapsed_ms=int((time.perf_counter() - t0) * 1000),
                    tenant_id=tid,
                    trace_id=tr,
                    url=url,
                    extra={"error": f"ssrf_guard_error: {e}"},
                )
            except Exception:
                pass
            return json.dumps(
                {"ok": False, "error": f"ssrf_guard_error: {e}", "url": url},
                ensure_ascii=False,
            )

        try:
            from ah32.integrations.browser.api import (
                open_browser_session,
                navigate_to,
                take_snapshot,
                require_playwright,
            )

            require_playwright()
        except Exception as e:
            return json.dumps(
                {"ok": False, "error": f"playwright unavailable: {e}"},
                ensure_ascii=False,
            )

        try:
            with open_browser_session() as session:
                nav = navigate_to(session, url=url, wait_until=wait_until, timeout_ms=timeout_ms)
                snap = take_snapshot(session)
                text = ""
                title = ""
                final_url = url
                trace_id = ""
                meta: Dict[str, Any] = {}
                try:
                    meta = (snap.get("meta") if isinstance(snap, dict) else None) or {}
                except Exception:
                    meta = {}
                try:
                    trace_id = str(meta.get("trace_id") or "")
                except Exception:
                    trace_id = ""
                try:
                    if isinstance(nav, dict):
                        data = nav.get("data") or {}
                        if isinstance(data, dict):
                            title = str(data.get("title") or "")
                            final_url = str(data.get("final_url") or url)
                except Exception:
                    pass
                try:
                    if isinstance(snap, dict):
                        data = snap.get("data") or {}
                        if isinstance(data, dict):
                            text = str(data.get("text") or "")
                except Exception:
                    text = ""

                truncated = False
                if len(text) > max_chars:
                    text = text[: max_chars - 20] + "\n...(truncated)"
                    truncated = True

                ok = bool((nav or {}).get("ok")) and bool((snap or {}).get("ok"))
                try:
                    from ah32.tenancy.usage_audit import record_usage
                    from ah32.tenancy.context import get_tenant_id, get_trace_id

                    tid = str(get_tenant_id() or "").strip() or "public"
                    tr = str(get_trace_id() or "").strip()
                    record_usage(
                        event="tool_call",
                        ok=bool(ok),
                        component="network",
                        action="browser_snapshot",
                        elapsed_ms=int((time.perf_counter() - t0) * 1000),
                        tenant_id=tid,
                        trace_id=tr,
                        url=final_url or url,
                        extra={"truncated": bool(truncated), "timeout_ms": int(timeout_ms), "wait_until": wait_until},
                    )
                except Exception:
                    pass
                return json.dumps(
                    {
                        "ok": ok,
                        "url": url,
                        "final_url": final_url,
                        "title": title,
                        "trace_id": trace_id,
                        "truncated": truncated,
                        "text": text,
                        "nav": nav,
                        "snapshot": snap,
                    },
                    ensure_ascii=False,
                    default=str,
                )
        except Exception as e:
            logger.warning("[browser_snapshot] failed url=%s err=%s", url, e, exc_info=True)
            try:
                from ah32.tenancy.usage_audit import record_usage
                from ah32.tenancy.context import get_tenant_id, get_trace_id

                tid = str(get_tenant_id() or "").strip() or "public"
                tr = str(get_trace_id() or "").strip()
                record_usage(
                    event="tool_call",
                    ok=False,
                    component="network",
                    action="browser_snapshot",
                    elapsed_ms=int((time.perf_counter() - t0) * 1000),
                    tenant_id=tid,
                    trace_id=tr,
                    url=url,
                    extra={"error": str(e)},
                )
            except Exception:
                pass
            return json.dumps({"ok": False, "url": url, "error": str(e)}, ensure_ascii=False)

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)
