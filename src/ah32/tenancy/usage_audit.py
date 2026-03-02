from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import queue
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from ah32.config import settings
from ah32.tenancy.context import get_tenant_id, get_trace_id, get_user_id

logger = logging.getLogger(__name__)

_Q_MAX = 20_000
_Q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=_Q_MAX)
_THREAD: threading.Thread | None = None
_STOP = threading.Event()
_DROP_LOG = {"at": 0.0, "count": 0}


def _tenant_audit_dir(tenant_id: str) -> Path:
    tid = str(tenant_id or "").strip() or str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
    return Path(settings.storage_root) / "tenants" / tid / "audit"


def _cap_str(v: Any, n: int) -> str:
    s = str(v or "")
    if len(s) <= n:
        return s
    return s[: max(0, n - 12)] + "...(trunc)"


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return int(default)


def _hash_text(v: str) -> str:
    try:
        return hashlib.sha256(str(v or "").encode("utf-8", errors="ignore")).hexdigest()
    except Exception:
        return ""


def _url_meta(url: str) -> Dict[str, Any]:
    u = str(url or "").strip()
    if not u:
        return {}
    try:
        p = urlparse(u)
        host = str(p.hostname or "").strip()
        port = int(p.port) if p.port else None
        scheme = str(p.scheme or "").strip().lower()
        return {
            "url_scheme": scheme,
            "url_host": host,
            "url_port": port,
            # Avoid storing full URL (may contain tokens/query). Keep a hash for correlation.
            "url_sha256": _hash_text(u),
        }
    except Exception:
        return {"url_sha256": _hash_text(u)}


def record_usage(
    *,
    event: str,
    ok: bool,
    component: str,
    action: str,
    elapsed_ms: int | None = None,
    status_code: int | None = None,
    tenant_id: str | None = None,
    user_id: str | None = None,
    trace_id: str | None = None,
    url: str | None = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Best-effort per-tenant usage audit.

    Writes JSONL to: storage/tenants/<tenant_id>/audit/usage.jsonl

    Privacy rules:
    - Do NOT store document text, query text, base64 bytes, or uploaded file bytes.
    - For URLs, store host/scheme + sha256 only (no full URL).
    """
    try:
        ensure_started()
        tid = (str(tenant_id or "").strip() or str(get_tenant_id() or "").strip() or str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public")
        uid = str(user_id or "").strip() or str(get_user_id() or "").strip() or ""
        tr = str(trace_id or "").strip() or str(get_trace_id() or "").strip() or ""

        payload: Dict[str, Any] = {
            "ts": time.time(),
            "tenant_id": tid,
            "user_id": uid,
            "trace_id": tr,
            "event": _cap_str(event, 120),
            "component": _cap_str(component, 80),
            "action": _cap_str(action, 80),
            "ok": bool(ok),
        }
        if elapsed_ms is not None:
            payload["elapsed_ms"] = _safe_int(elapsed_ms, 0)
        if status_code is not None:
            payload["status_code"] = _safe_int(status_code, 0)
        if url:
            payload.update(_url_meta(url))
        if isinstance(extra, dict) and extra:
            safe_extra: Dict[str, Any] = {}
            for k, v in list(extra.items())[:60]:
                kk = _cap_str(k, 60)
                if kk.lower() in ("doc_text", "text", "query", "content", "base64", "data_url", "dataurl"):
                    continue
                if isinstance(v, (str, int, float, bool)) or v is None:
                    safe_extra[kk] = _cap_str(v, 240) if isinstance(v, str) else v
                else:
                    safe_extra[kk] = _cap_str(v, 240)
            if safe_extra:
                payload["extra"] = safe_extra

        try:
            _Q.put_nowait(payload)
        except queue.Full:
            now = time.time()
            try:
                _DROP_LOG["count"] += 1
                if now - float(_DROP_LOG.get("at") or 0.0) > 30.0:
                    _DROP_LOG["at"] = now
                    logger.warning(
                        "[usage_audit] queue full; dropping events (count=%s max=%s)",
                        int(_DROP_LOG.get("count") or 0),
                        _Q_MAX,
                    )
            except Exception:
                pass
    except Exception as e:
        logger.warning("[usage_audit] record failed: %s", e, exc_info=True)


def ensure_started() -> None:
    global _THREAD
    if _THREAD is not None and _THREAD.is_alive():
        return
    with contextlib.suppress(Exception):
        _STOP.clear()
    t = threading.Thread(target=_writer_loop, name="ah32-usage-audit-writer", daemon=True)
    _THREAD = t
    t.start()


def stop(*, flush_timeout_sec: float = 1.5) -> None:
    try:
        _STOP.set()
    except Exception:
        return
    t = _THREAD
    if t is None:
        return
    try:
        t.join(timeout=max(0.0, float(flush_timeout_sec)))
    except Exception:
        return


def _writer_loop() -> None:
    batch: list[Dict[str, Any]] = []
    last_flush = time.time()
    flush_interval = 0.5
    max_batch = 200
    while True:
        if _STOP.is_set():
            try:
                _drain(batch, max_items=5000)
            except Exception:
                pass
            _flush(batch)
            return

        try:
            item = _Q.get(timeout=0.25)
            if isinstance(item, dict):
                batch.append(item)
        except queue.Empty:
            pass
        except Exception:
            continue

        now = time.time()
        if len(batch) >= max_batch or (batch and now - last_flush >= flush_interval):
            _flush(batch)
            last_flush = now


def _drain(batch: list[Dict[str, Any]], *, max_items: int) -> None:
    for _ in range(max(0, int(max_items))):
        try:
            item = _Q.get_nowait()
        except queue.Empty:
            return
        except Exception:
            return
        if isinstance(item, dict):
            batch.append(item)


def _flush(batch: list[Dict[str, Any]]) -> None:
    if not batch:
        return
    by_tenant: dict[str, list[str]] = {}
    try:
        for payload in batch:
            tid = str(payload.get("tenant_id") or "").strip() or "public"
            line = json.dumps(payload, ensure_ascii=False, default=str)
            by_tenant.setdefault(tid, []).append(line)
    except Exception:
        by_tenant = {}

    batch.clear()

    for tid, lines in by_tenant.items():
        try:
            out_dir = _tenant_audit_dir(tid)
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / "usage.jsonl"
            with out_path.open("a", encoding="utf-8") as f:
                for line in lines:
                    f.write(line + "\n")
        except Exception as e:
            logger.warning("[usage_audit] flush failed tenant=%s err=%s", tid, e, exc_info=True)


class UsageSpan:
    def __init__(
        self,
        *,
        event: str,
        component: str,
        action: str,
        tenant_id: str | None = None,
        user_id: str | None = None,
        trace_id: str | None = None,
        url: str | None = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._event = event
        self._component = component
        self._action = action
        self._tenant_id = tenant_id
        self._user_id = user_id
        self._trace_id = trace_id
        self._url = url
        self._extra = extra if isinstance(extra, dict) else None
        self._t0 = time.perf_counter()
        self.ok: bool = True
        self.error_type: str = ""
        self.error_message: str = ""
        self.status_code: int | None = None

    def set_status_code(self, status_code: int | None) -> None:
        try:
            self.status_code = int(status_code) if status_code is not None else None
        except Exception:
            self.status_code = None

    def fail(self, *, error_type: str, error_message: str) -> None:
        self.ok = False
        self.error_type = _cap_str(error_type, 120)
        self.error_message = _cap_str(error_message, 400)

    def close(self) -> None:
        elapsed_ms = int((time.perf_counter() - self._t0) * 1000)
        extra = dict(self._extra or {})
        if not self.ok:
            extra.setdefault("error_type", self.error_type)
            extra.setdefault("error_message", self.error_message)
        record_usage(
            event=self._event,
            ok=self.ok,
            component=self._component,
            action=self._action,
            elapsed_ms=elapsed_ms,
            status_code=self.status_code,
            tenant_id=self._tenant_id,
            user_id=self._user_id,
            trace_id=self._trace_id,
            url=self._url,
            extra=extra or None,
        )


@contextlib.contextmanager
def usage_span(
    *,
    event: str,
    component: str,
    action: str,
    tenant_id: str | None = None,
    user_id: str | None = None,
    trace_id: str | None = None,
    url: str | None = None,
    extra: Optional[Dict[str, Any]] = None,
):
    span = UsageSpan(
        event=event,
        component=component,
        action=action,
        tenant_id=tenant_id,
        user_id=user_id,
        trace_id=trace_id,
        url=url,
        extra=extra,
    )
    try:
        yield span
    except Exception as e:
        try:
            span.fail(error_type=type(e).__name__, error_message=str(e))
        except Exception:
            pass
        raise
    finally:
        try:
            span.close()
        except Exception:
            pass
