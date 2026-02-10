from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


def _to_json(v: Any) -> str:
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return json.dumps({"_error": "json_serialize_failed"}, ensure_ascii=False)


@dataclass
class SQLiteTelemetrySink:
    name: str = "sqlite"

    def __init__(self, *, path: Path, retention_days: int = 7) -> None:
        self.path = Path(path)
        self.retention_days = max(1, int(retention_days))
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self) -> None:
        cur = self._conn.cursor()
        try:
            cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("PRAGMA synchronous=NORMAL;")
            cur.execute("PRAGMA temp_store=MEMORY;")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS telemetry_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ts REAL NOT NULL,
                  schema_version TEXT NOT NULL,
                  event_name TEXT NOT NULL,
                  run_id TEXT,
                  mode TEXT,
                  host_app TEXT,
                  doc_id TEXT,
                  doc_key TEXT,
                  session_id TEXT,
                  story_id TEXT,
                  turn_id TEXT,
                  case_id TEXT,
                  task_id TEXT,
                  message_id TEXT,
                  block_id TEXT,
                  client_id TEXT,
                  payload_json TEXT
                );
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_ts ON telemetry_events(ts);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_event ON telemetry_events(event_name);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_run ON telemetry_events(run_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_host ON telemetry_events(host_app);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_doc ON telemetry_events(doc_key);")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_te_session ON telemetry_events(session_id);"
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_block ON telemetry_events(block_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_te_client ON telemetry_events(client_id);")
            self._conn.commit()
        finally:
            cur.close()

    def write_many(self, events: List[Dict[str, Any]]) -> None:
        if not events:
            return
        cur = self._conn.cursor()
        try:
            rows = []
            for e in events:
                if not isinstance(e, dict):
                    continue
                payload = e.get("payload") if isinstance(e.get("payload"), dict) else {}
                rows.append(
                    (
                        float(e.get("ts") or time.time()),
                        str(e.get("schema_version") or "ah32.telemetry.v1"),
                        str(e.get("event_name") or ""),
                        str(e.get("run_id") or ""),
                        str(e.get("mode") or ""),
                        str(e.get("host_app") or ""),
                        str(e.get("doc_id") or ""),
                        str(e.get("doc_key") or ""),
                        str(e.get("session_id") or ""),
                        str(e.get("story_id") or ""),
                        str(e.get("turn_id") or ""),
                        str(e.get("case_id") or ""),
                        str(e.get("task_id") or ""),
                        str(e.get("message_id") or ""),
                        str(e.get("block_id") or ""),
                        str(e.get("client_id") or ""),
                        _to_json(payload),
                    )
                )
            if not rows:
                return
            cur.executemany(
                """
                INSERT INTO telemetry_events(
                  ts, schema_version, event_name, run_id, mode, host_app, doc_id, doc_key, session_id,
                  story_id, turn_id, case_id, task_id, message_id, block_id, client_id, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """,
                rows,
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()

    def query(
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
        limit_i = max(1, min(5000, int(limit)))
        clauses = []
        params: List[Any] = []
        if since_ts is not None:
            clauses.append("ts >= ?")
            params.append(float(since_ts))
        if event_name:
            clauses.append("event_name = ?")
            params.append(str(event_name))
        if run_id:
            clauses.append("run_id = ?")
            params.append(str(run_id))
        if host_app:
            clauses.append("host_app = ?")
            params.append(str(host_app))
        if doc_key:
            clauses.append("doc_key = ?")
            params.append(str(doc_key))
        if session_id:
            clauses.append("session_id = ?")
            params.append(str(session_id))
        if block_id:
            clauses.append("block_id = ?")
            params.append(str(block_id))
        if client_id:
            clauses.append("client_id = ?")
            params.append(str(client_id))

        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"""
          SELECT *
          FROM telemetry_events
          {where}
          ORDER BY ts DESC
          LIMIT {limit_i}
        """
        cur = self._conn.cursor()
        try:
            out: List[Dict[str, Any]] = []
            for row in cur.execute(sql, params).fetchall():
                d = dict(row)
                try:
                    d["payload"] = json.loads(d.get("payload_json") or "{}")
                except Exception:
                    d["payload"] = {}
                d.pop("payload_json", None)
                out.append(d)
            return out
        finally:
            cur.close()

    def cleanup(self) -> None:
        """Delete old events by retention window."""
        cutoff = time.time() - float(self.retention_days) * 86400.0
        cur = self._conn.cursor()
        try:
            cur.execute("DELETE FROM telemetry_events WHERE ts < ?", (cutoff,))
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            logger.error("[telemetry/sqlite] close failed", exc_info=True)
