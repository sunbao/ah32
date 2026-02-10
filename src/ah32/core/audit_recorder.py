from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class AuditEvent:
    ts: float
    session_id: str
    host_app: str
    mode: str
    block_id: str
    ops: List[str]
    success: bool
    error_type: str = ""
    error_message: str = ""
    extra: Optional[Dict[str, Any]] = None


class AuditRecorder:
    def __init__(self, max_events: int = 2000):
        self._lock = threading.Lock()
        self._events: List[AuditEvent] = []
        self._max_events = int(max_events)

    def record(
        self,
        *,
        session_id: str,
        host_app: str,
        mode: str,
        block_id: str = "",
        ops: Optional[List[str]] = None,
        success: bool,
        error_type: str = "",
        error_message: str = "",
        extra: Optional[Dict[str, Any]] = None,
        ts: Optional[float] = None,
    ) -> None:
        event = AuditEvent(
            ts=float(ts if ts is not None else time.time()),
            session_id=str(session_id or ""),
            host_app=str(host_app or "unknown"),
            mode=str(mode or ""),
            block_id=str(block_id or ""),
            ops=list(ops or []),
            success=bool(success),
            error_type=str(error_type or ""),
            error_message=str(error_message or ""),
            extra=extra if isinstance(extra, dict) else None,
        )
        with self._lock:
            self._events.append(event)
            if len(self._events) > self._max_events:
                self._events = self._events[-self._max_events :]

    def events(self, limit: int = 200) -> List[Dict[str, Any]]:
        lim = max(1, min(int(limit), self._max_events))
        with self._lock:
            selected = list(self._events[-lim:])
        return [
            {
                "ts": e.ts,
                "session_id": e.session_id,
                "host_app": e.host_app,
                "mode": e.mode,
                "block_id": e.block_id,
                "ops": e.ops,
                "success": e.success,
                "error_type": e.error_type,
                "error_message": e.error_message,
                "extra": e.extra or {},
            }
            for e in selected
        ]

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            events = list(self._events)
        by_mode: Dict[str, int] = {}
        by_host: Dict[str, int] = {}
        by_error_type: Dict[str, int] = {}
        for e in events:
            by_mode[e.mode] = by_mode.get(e.mode, 0) + 1
            by_host[e.host_app] = by_host.get(e.host_app, 0) + 1
            if not e.success:
                k = e.error_type or "unknown"
                by_error_type[k] = by_error_type.get(k, 0) + 1
        return {
            "total": len(events),
            "by_mode": by_mode,
            "by_host": by_host,
            "by_error_type": by_error_type,
        }

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


audit_recorder = AuditRecorder()

