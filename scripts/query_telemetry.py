"""
Query local telemetry events from the SQLite sink (ah32.telemetry.v1).

Default path matches the backend default: storage/telemetry/telemetry.sqlite3.

Usage:
  python scripts/query_telemetry.py --limit 50
  python scripts/query_telemetry.py --event macro.exec_done --limit 200
  python scripts/query_telemetry.py --session <session_id>
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _env_first(name: str) -> str:
    v = (os.getenv(name) or "").strip()
    if v:
        return v
    return (os.getenv(f"AH32_{name}") or "").strip()


def _open_ro(path: Path) -> sqlite3.Connection:
    # Read-only open is more robust when backend is writing (WAL).
    uri = f"file:{path.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _build_where(args: argparse.Namespace) -> Tuple[str, List[Any]]:
    clauses: List[str] = []
    params: List[Any] = []

    def add_eq(col: str, value: str) -> None:
        v = (value or "").strip()
        if not v:
            return
        clauses.append(f"{col} = ?")
        params.append(v)

    def add_ge(col: str, value: float | None) -> None:
        if value is None:
            return
        clauses.append(f"{col} >= ?")
        params.append(float(value))

    add_ge("ts", args.since_ts)
    add_eq("event_name", args.event)
    add_eq("run_id", args.run_id)
    add_eq("host_app", args.host)
    add_eq("doc_key", args.doc_key)
    add_eq("session_id", args.session)
    add_eq("block_id", args.block)
    add_eq("client_id", args.client)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--path",
        default=_env_first("TELEMETRY_SQLITE_PATH") or str(Path("storage") / "telemetry" / "telemetry.sqlite3"),
    )
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--since-ts", type=float, default=None)
    ap.add_argument("--event", default="")
    ap.add_argument("--run-id", default="")
    ap.add_argument("--host", default="")
    ap.add_argument("--doc-key", default="")
    ap.add_argument("--session", default="")
    ap.add_argument("--block", default="")
    ap.add_argument("--client", default="")
    args = ap.parse_args()

    path = Path(str(args.path))
    if not path.exists():
        print(json.dumps({"ok": False, "error": "sqlite_not_found", "path": str(path)}, ensure_ascii=False, indent=2))
        return 2

    limit = max(1, min(5000, int(args.limit)))
    where, params = _build_where(args)
    sql = f"""
      SELECT *
      FROM telemetry_events
      {where}
      ORDER BY ts DESC
      LIMIT {limit}
    """

    conn: sqlite3.Connection | None = None
    try:
        conn = _open_ro(path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            try:
                d["payload"] = json.loads(d.get("payload_json") or "{}")
            except Exception:
                d["payload"] = {}
            d.pop("payload_json", None)
            out.append(d)
        print(json.dumps({"ok": True, "path": str(path), "events": out}, ensure_ascii=False, indent=2))
        return 0
    except sqlite3.OperationalError as e:
        print(json.dumps({"ok": False, "error": "sqlite_operational_error", "message": str(e)}, ensure_ascii=False, indent=2))
        return 3
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

