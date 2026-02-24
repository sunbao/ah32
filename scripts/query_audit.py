"""
Query backend audit events for plan/js execution.

Usage:
  python scripts/query_audit.py --limit 50
  python scripts/query_audit.py --summary
  python scripts/query_audit.py --reset
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Any, Dict

import requests


def _headers(api_key: str) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["X-API-Key"] = api_key
    return h


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default=os.getenv("AH32_API_BASE", "http://127.0.0.1:5123"))
    ap.add_argument("--api-key", default=os.getenv("AH32_API_KEY", ""))
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    api_base = str(args.api_base).rstrip("/")
    api_key = str(args.api_key or "")

    if args.reset:
        resp = requests.post(
            f"{api_base}/agentic/audit/reset",
            headers=_headers(api_key),
            data=json.dumps({}),
            timeout=20,
        )
        resp.raise_for_status()
        print(json.dumps(resp.json(), ensure_ascii=False, indent=2))
        return 0

    if args.summary:
        resp = requests.get(f"{api_base}/agentic/audit/summary", headers=_headers(api_key), timeout=20)
        resp.raise_for_status()
        print(json.dumps(resp.json(), ensure_ascii=False, indent=2))
        return 0

    limit = max(1, min(2000, int(args.limit)))
    resp = requests.get(
        f"{api_base}/agentic/audit/events",
        params={"limit": limit},
        headers=_headers(api_key),
        timeout=20,
    )
    resp.raise_for_status()
    data: Dict[str, Any] = resp.json()
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

