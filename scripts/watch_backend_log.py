"""
Tail logs/backend.log and print lines that look related to writeback execution.

Usage:
  python scripts/watch_backend_log.py --seconds 180

This is a lightweight helper for reproducing "writeback failed" issues while WPS is running.
Keep ASCII-only (use simple substring matches) to avoid Windows console encoding problems.
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path


DEFAULT_PATTERNS = [
    "MacroQueue",
    "PlanExecutor",
    "plan_generate",
    "plan_repair",
    "[audit]",
    "/agentic/audit/record",
    "/agentic/plan/generate",
    "/agentic/plan/repair",
    "/agentic/js-plan/vibe-coding/stream",
    "/telemetry/",
    "[telemetry]",
    "document_context_missing",
    "document_not_active_or_closed",
    "document_activate_failed",
    "selection range not available",
    "document/selection not available",
    "host_app mismatch",
    "upsert_block markers missing",
    "writeback",
    "js_msg_",
    "SyntaxError",
    "Invalid regular expression",
]


def _iter_new_lines(path: Path, *, start_at_end: bool = True):
    # Simple tail -f implementation that survives file truncation/rotation.
    pos = 0
    buf = b""
    last_inode = None

    while True:
        try:
            st = path.stat()
        except FileNotFoundError:
            time.sleep(0.25)
            continue

        inode = getattr(st, "st_ino", None)
        if last_inode is None:
            last_inode = inode

        # Reopen on rotation or truncation.
        if inode is not None and last_inode is not None and inode != last_inode:
            pos = 0
            buf = b""
            last_inode = inode
        if st.st_size < pos:
            pos = 0
            buf = b""

        with path.open("rb") as f:
            if start_at_end and pos == 0:
                pos = st.st_size
            f.seek(pos)
            chunk = f.read()
            if chunk:
                pos = f.tell()
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    yield line.decode("utf-8", errors="replace")

        time.sleep(0.25)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default=str(Path("logs") / "backend.log"))
    ap.add_argument("--seconds", type=int, default=180)
    ap.add_argument("--all", action="store_true", help="Print all new lines (not just filtered patterns).")
    ap.add_argument("--pattern", action="append", default=[], help="Extra substring pattern to include.")
    args = ap.parse_args()

    path = Path(args.path)
    patterns = DEFAULT_PATTERNS + [p for p in (args.pattern or []) if p]

    deadline = time.time() + max(1, int(args.seconds))
    print(f"[watch] path={path} seconds={args.seconds} patterns={len(patterns)}", flush=True)

    for line in _iter_new_lines(path, start_at_end=True):
        if time.time() >= deadline:
            break

        s = (line or "").rstrip("\r\n")
        if not s:
            continue
        if args.all or any(p in s for p in patterns):
            print(s, flush=True)

    print("[watch] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
