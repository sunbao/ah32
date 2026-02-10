from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Protocol

from ah32.telemetry.run_context import RunContext

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TelemetryCapabilities:
    mode: str
    retention_days: int
    sqlite_path: str
    remote_endpoint: str
    flush_interval_ms: int
    batch_size: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "retention_days": self.retention_days,
            "sqlite_path": self.sqlite_path,
            "remote_endpoint": self.remote_endpoint,
            "flush_interval_ms": self.flush_interval_ms,
            "batch_size": self.batch_size,
        }


class TelemetrySink(Protocol):
    name: str

    def write_many(self, events: List[Dict[str, Any]]) -> None: ...
    def close(self) -> None: ...


def _env_first(name: str) -> str:
    """Return unprefixed env var first, then AH32_-prefixed."""
    v = (os.getenv(name) or "").strip()
    if v:
        return v
    return (os.getenv(f"AH32_{name}") or "").strip()


def _normalize_mode(v: str) -> str:
    m = (v or "").strip().lower()
    if m in ("", "local", "remote", "both", "off", "disabled", "false", "0"):
        return "off" if m in ("off", "disabled", "false", "0") else (m or "local")
    # Be permissive; treat unknown as local.
    return "local"


class TelemetryService:
    """In-process telemetry queue + background flusher (SQLite and/or remote forward)."""

    def __init__(
        self,
        *,
        mode: str,
        sqlite_path: Path,
        retention_days: int = 7,
        flush_interval_ms: int = 1000,
        batch_size: int = 200,
        remote_endpoint: str = "",
    ) -> None:
        self._mode = _normalize_mode(mode)
        self._sqlite_path = Path(sqlite_path)
        self._retention_days = max(1, int(retention_days))
        self._flush_interval_ms = max(50, int(flush_interval_ms))
        self._batch_size = max(1, int(batch_size))
        self._remote_endpoint = str(remote_endpoint or "").strip()

        self._queue: Deque[Dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._sinks: List[TelemetrySink] = []
        self._sqlite_sink: Any = None

        self._init_sinks()

    @classmethod
    def from_settings(cls, settings: Any) -> "TelemetryService":
        # Allow unprefixed env overrides to keep private deployments simple.
        mode = _env_first("TELEMETRY_MODE") or getattr(settings, "telemetry_mode", "local")
        sqlite_path = _env_first("TELEMETRY_SQLITE_PATH") or str(getattr(settings, "telemetry_sqlite_path", ""))
        retention_days = _env_first("TELEMETRY_RETENTION_DAYS") or str(getattr(settings, "telemetry_retention_days", 7))
        flush_interval_ms = _env_first("TELEMETRY_FLUSH_INTERVAL_MS") or str(
            getattr(settings, "telemetry_flush_interval_ms", 1000)
        )
        batch_size = _env_first("TELEMETRY_BATCH_SIZE") or str(getattr(settings, "telemetry_batch_size", 200))
        remote_endpoint = _env_first("TELEMETRY_REMOTE_ENDPOINT") or str(getattr(settings, "telemetry_remote_endpoint", ""))

        return cls(
            mode=str(mode or "local"),
            sqlite_path=Path(sqlite_path) if sqlite_path else Path("storage/telemetry/telemetry.sqlite3"),
            retention_days=int(retention_days or 7),
            flush_interval_ms=int(flush_interval_ms or 1000),
            batch_size=int(batch_size or 200),
            remote_endpoint=str(remote_endpoint or ""),
        )

    def _init_sinks(self) -> None:
        mode = self._mode
        if mode == "off":
            logger.info("[telemetry] disabled (mode=off)")
            return

        if mode in ("local", "both"):
            try:
                from ah32._internal.telemetry_sinks.sqlite_sink import SQLiteTelemetrySink

                self._sqlite_path.parent.mkdir(parents=True, exist_ok=True)
                self._sqlite_sink = SQLiteTelemetrySink(
                    path=self._sqlite_path,
                    retention_days=self._retention_days,
                )
                self._sinks.append(self._sqlite_sink)
                logger.info("[telemetry] sqlite sink enabled path=%s", str(self._sqlite_path))
            except Exception as e:
                logger.error("[telemetry] sqlite sink init failed: %s", e, exc_info=True)

        if mode in ("remote", "both"):
            if not self._remote_endpoint:
                logger.warning("[telemetry] remote mode enabled but TELEMETRY_REMOTE_ENDPOINT is empty")
            else:
                try:
                    from ah32._internal.telemetry_sinks.remote_sink import HttpForwardTelemetrySink

                    self._sinks.append(HttpForwardTelemetrySink(endpoint=self._remote_endpoint))
                    logger.info("[telemetry] remote sink enabled endpoint=%s", self._remote_endpoint)
                except Exception as e:
                    logger.error("[telemetry] remote sink init failed: %s", e, exc_info=True)

    def capabilities(self) -> TelemetryCapabilities:
        return TelemetryCapabilities(
            mode=self._mode,
            retention_days=self._retention_days,
            sqlite_path=str(self._sqlite_path),
            remote_endpoint=self._remote_endpoint,
            flush_interval_ms=self._flush_interval_ms,
            batch_size=self._batch_size,
        )

    def start(self) -> None:
        if self._mode == "off":
            return
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="telemetry-flusher", daemon=True)
        self._thread.start()

    def stop(self, *, timeout_s: float = 2.0) -> None:
        try:
            self._stop.set()
            t = self._thread
            if t and t.is_alive():
                t.join(timeout=max(0.1, float(timeout_s)))
        finally:
            self._thread = None
            try:
                self.flush_now()
            except Exception:
                logger.error("[telemetry] flush_now on stop failed", exc_info=True)
            for s in list(self._sinks):
                try:
                    s.close()
                except Exception:
                    logger.error("[telemetry] sink close failed: %s", getattr(s, "name", "unknown"), exc_info=True)

    def emit(self, event_name: str, payload: Dict[str, Any] | None = None, *, ctx: Any = None) -> None:
        """Fast, non-blocking enqueue."""
        if self._mode == "off":
            return
        name = str(event_name or "").strip()
        if not name:
            return
        try:
            rc = RunContext.from_any(ctx)
            ev: Dict[str, Any] = {
                "schema_version": "ah32.telemetry.v1",
                "event_name": name,
                "ts": time.time(),
                **rc.to_dict(),
                "payload": dict(payload or {}),
            }
            with self._lock:
                self._queue.append(ev)
        except Exception:
            logger.error("[telemetry] emit failed: %s", event_name, exc_info=True)

    def ingest(self, events: Iterable[Dict[str, Any]]) -> int:
        """Accept client-reported events. Best-effort validation + enqueue."""
        if self._mode == "off":
            return 0
        accepted = 0
        try:
            now = time.time()
            with self._lock:
                for raw in events:
                    if not isinstance(raw, dict):
                        continue
                    name = str(raw.get("event_name") or raw.get("event") or raw.get("name") or "").strip()
                    if not name:
                        continue
                    ts = raw.get("ts")
                    try:
                        ts_f = float(ts) if ts is not None else now
                    except Exception:
                        ts_f = now

                    # Normalize fields to our canonical names.
                    rc = RunContext.from_any(raw)
                    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
                    ev: Dict[str, Any] = {
                        "schema_version": str(raw.get("schema_version") or "ah32.telemetry.v1"),
                        "event_name": name,
                        "ts": ts_f,
                        **rc.to_dict(),
                        "payload": dict(payload),
                    }
                    self._queue.append(ev)
                    accepted += 1
        except Exception:
            logger.error("[telemetry] ingest failed", exc_info=True)
        return accepted

    def flush_now(self) -> int:
        if self._mode == "off":
            return 0
        batch: List[Dict[str, Any]] = []
        with self._lock:
            while self._queue:
                batch.append(self._queue.popleft())
        if not batch:
            return 0
        self._write_to_sinks(batch)
        return len(batch)

    def query_events(
        self,
        *,
        limit: int = 200,
        since_ts: float | None = None,
        event_name: str | None = None,
        run_id: str | None = None,
        host_app: str | None = None,
        doc_key: str | None = None,
        session_id: str | None = None,
        block_id: str | None = None,
        client_id: str | None = None,
    ) -> List[Dict[str, Any]]:
        """Query local SQLite events (if available)."""
        if not self._sqlite_sink:
            return []
        try:
            return self._sqlite_sink.query(
                limit=limit,
                since_ts=since_ts,
                event_name=event_name,
                run_id=run_id,
                host_app=host_app,
                doc_key=doc_key,
                session_id=session_id,
                block_id=block_id,
                client_id=client_id,
            )
        except Exception:
            logger.error("[telemetry] query_events failed", exc_info=True)
            return []

    def _run(self) -> None:
        last_cleanup = 0.0
        while not self._stop.is_set():
            try:
                time.sleep(self._flush_interval_ms / 1000.0)
                batch: List[Dict[str, Any]] = []
                with self._lock:
                    while self._queue and len(batch) < self._batch_size:
                        batch.append(self._queue.popleft())
                if batch:
                    self._write_to_sinks(batch)

                # Periodic retention cleanup (once/min).
                if self._sqlite_sink and (time.time() - last_cleanup) > 60:
                    last_cleanup = time.time()
                    try:
                        self._sqlite_sink.cleanup()
                    except Exception:
                        logger.error("[telemetry] sqlite cleanup failed", exc_info=True)
            except Exception:
                logger.error("[telemetry] flush loop crashed", exc_info=True)

    def _write_to_sinks(self, batch: List[Dict[str, Any]]) -> None:
        if not batch:
            return
        if not self._sinks:
            return
        for s in list(self._sinks):
            try:
                s.write_many(batch)
            except Exception as e:
                logger.error("[telemetry] sink write failed: %s err=%s", getattr(s, "name", "unknown"), e, exc_info=True)


_global_telemetry: Optional[TelemetryService] = None


def set_telemetry(service: TelemetryService | None) -> None:
    global _global_telemetry
    _global_telemetry = service


def get_telemetry() -> TelemetryService | None:
    return _global_telemetry
