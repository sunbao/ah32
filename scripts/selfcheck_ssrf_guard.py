from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path

from ah32.config import settings
from ah32.security.ssrf_guard import check_url


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(msg)


def main() -> None:
    ap = argparse.ArgumentParser(description="Self-check: ssrf_guard allow-by-default + tenant blacklist + audit.")
    ap.add_argument("--tenant-id", default="demo-a")
    ap.add_argument("--trace-id", default="")
    args = ap.parse_args()

    tenant_id = str(args.tenant_id).strip() or "demo-a"
    trace_id = str(args.trace_id).strip() or f"selfcheck_{uuid.uuid4().hex[:12]}"

    policy_dir = Path(settings.storage_root) / "tenants" / tenant_id / "policy"
    policy_dir.mkdir(parents=True, exist_ok=True)
    bl_path = policy_dir / "ssrf_blacklist.json"
    audit_path = Path(settings.storage_root) / "tenants" / tenant_id / "audit" / "ssrf.jsonl"

    blacklist = {
        "schema_version": "ah32.ssrf_blacklist.v1",
        "updated_at": int(time.time()),
        "blocked_hosts": ["localhost", "metadata.google.internal", "*.internal"],
        "blocked_ips": [
            "127.0.0.1/32",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
        ],
        "blocked_url_prefixes": [],
    }
    bl_path.write_text(json.dumps(blacklist, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    before = 0
    try:
        if audit_path.exists():
            before = len(audit_path.read_text(encoding="utf-8", errors="ignore").splitlines())
    except Exception:
        before = 0

    allow = check_url(url="https://example.com", tenant_id=tenant_id, trace_id=trace_id, tool="selfcheck")
    deny = check_url(url="http://localhost", tenant_id=tenant_id, trace_id=trace_id, tool="selfcheck")

    _assert(allow.ok is True and allow.decision == "allow", f"expected allow, got: {allow}")
    _assert(deny.ok is False and deny.decision == "deny", f"expected deny, got: {deny}")

    after = 0
    try:
        if audit_path.exists():
            after = len(audit_path.read_text(encoding="utf-8", errors="ignore").splitlines())
    except Exception:
        after = before

    _assert(after >= before + 2, f"audit should record allow+deny (>=2 new lines); before={before} after={after}")
    print("OK: ssrf_guard selfcheck passed")


if __name__ == "__main__":
    main()

