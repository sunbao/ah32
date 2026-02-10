from __future__ import annotations

import logging
import threading
import time
from copy import deepcopy
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_MAX_ENTRIES = 200
_TTL_SECONDS = 3600
_MAX_STRING = 20000
_MAX_LIST = 200
_MAX_DICT = 200

_lock = threading.Lock()
_store: Dict[str, Dict[str, Any]] = {}


def _now_ts() -> float:
    return time.time()


def _trim_value(value: Any) -> Any:
    if isinstance(value, str):
        if len(value) <= _MAX_STRING:
            return value
        return value[:_MAX_STRING] + f"... [truncated {len(value) - _MAX_STRING} chars]"
    if isinstance(value, list):
        out = []
        for i, item in enumerate(value):
            if i >= _MAX_LIST:
                out.append(f"... [truncated {len(value) - _MAX_LIST} items]")
                break
            out.append(_trim_value(item))
        return out
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= _MAX_DICT:
                out["..."] = f"[truncated {len(value) - _MAX_DICT} keys]"
                break
            out[str(k)] = _trim_value(v)
        return out
    return value


def _prune_locked() -> None:
    now = _now_ts()
    expired = [k for k, v in _store.items() if now - float(v.get("updated_at", now)) > _TTL_SECONDS]
    for k in expired:
        _store.pop(k, None)
    if len(_store) <= _MAX_ENTRIES:
        return
    ordered = sorted(_store.items(), key=lambda kv: float(kv[1].get("updated_at", 0.0)))
    for k, _ in ordered[: max(0, len(_store) - _MAX_ENTRIES)]:
        _store.pop(k, None)


def record_failure_context(
    *,
    session_id: str,
    kind: str,
    data: Dict[str, Any],
    run_id: str = "",
) -> None:
    sid = (session_id or "").strip()
    if not sid:
        return
    k = (kind or "").strip() or "unknown"
    payload = _trim_value(data)
    with _lock:
        entry = _store.get(sid)
        if not entry:
            entry = {
                "session_id": sid,
                "run_id": run_id or "",
                "created_at": _now_ts(),
                "updated_at": _now_ts(),
                "context": {},
            }
            _store[sid] = entry
        entry["updated_at"] = _now_ts()
        if run_id:
            entry["run_id"] = run_id
        ctx = entry.setdefault("context", {})
        existing = ctx.get(k)
        if isinstance(existing, dict) and isinstance(payload, dict):
            existing.update(payload)
            ctx[k] = existing
        else:
            ctx[k] = payload
        _prune_locked()


def get_failure_context(session_id: str, run_id: str = "") -> Dict[str, Any]:
    sid = (session_id or "").strip()
    if not sid:
        return {}
    with _lock:
        entry = _store.get(sid)
        if not entry:
            return {}
        # If run_id mismatches, still return but keep it explicit.
        out = deepcopy(entry)
        if run_id and out.get("run_id") and out.get("run_id") != run_id:
            out.setdefault("warnings", []).append("run_id_mismatch")
        return out

