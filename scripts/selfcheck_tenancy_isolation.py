from __future__ import annotations

import argparse
import json
import time
import uuid

import httpx


def _h(*, tenant_id: str, user_id: str) -> dict[str, str]:
    return {
        "X-AH32-Tenant-Id": tenant_id,
        "X-AH32-User-Id": user_id,
        "X-AH32-Client-Id": user_id,
        "X-AH32-Trace-Id": f"selfcheck_{uuid.uuid4().hex[:12]}",
    }


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(msg)


def _wait_rag_task(client: httpx.Client, *, base_url: str, headers: dict[str, str], task_id: str, timeout_sec: int) -> dict:
    deadline = time.time() + float(timeout_sec)
    last = None
    while time.time() < deadline:
        r = client.get(f"{base_url}/agentic/rag/tasks/{task_id}", headers=headers, timeout=30.0)
        if r.status_code == 404:
            time.sleep(0.3)
            continue
        r.raise_for_status()
        obj = r.json()
        data = obj.get("data") if isinstance(obj, dict) else None
        if isinstance(data, dict):
            last = data
            status = str(data.get("status") or "").strip().lower()
            if status in ("completed", "failed", "cancelled"):
                return data
        time.sleep(0.5)
    raise SystemExit(f"[rag] task timeout: {task_id}; last={last}")


def check_assets(client: httpx.Client, *, base_url: str, tenant_a: str, tenant_b: str, user_id: str) -> None:
    ha = _h(tenant_id=tenant_a, user_id=user_id)
    hb = _h(tenant_id=tenant_b, user_id=user_id)

    r = client.post(
        f"{base_url}/agentic/assets/init",
        headers=ha,
        json={
            "kind": "image",
            "mime": "image/png",
            "suggested_name": "selfcheck.png",
            "ttl_sec": 600,
            "replace_previous": False,
            "scope": {"client_id": "selfcheck", "session_id": "selfcheck", "host_app": "unknown", "doc_id": "selfcheck"},
        },
        timeout=30.0,
    )
    r.raise_for_status()
    asset_id = str(r.json().get("asset_id") or "").strip()
    _assert(bool(asset_id), "[assets] missing asset_id")

    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    r = client.put(
        f"{base_url}/agentic/assets/{asset_id}/content",
        headers=ha,
        files={"file": ("selfcheck.png", png, "image/png")},
        timeout=30.0,
    )
    r.raise_for_status()

    r = client.get(f"{base_url}/agentic/assets/{asset_id}/status", headers=ha, timeout=30.0)
    r.raise_for_status()

    r = client.get(f"{base_url}/agentic/assets/{asset_id}/status", headers=hb, timeout=30.0)
    _assert(r.status_code in (403, 404), f"[assets] cross-tenant status should be 403/404, got {r.status_code}: {r.text[:200]}")

    r = client.get(f"{base_url}/agentic/assets/{asset_id}/content", headers=hb, timeout=30.0)
    _assert(r.status_code in (403, 404), f"[assets] cross-tenant content should be 403/404, got {r.status_code}: {r.text[:200]}")


def check_doc_snapshots(client: httpx.Client, *, base_url: str, tenant_a: str, tenant_b: str, user_id: str) -> None:
    ha = _h(tenant_id=tenant_a, user_id=user_id)
    hb = _h(tenant_id=tenant_b, user_id=user_id)

    r = client.post(
        f"{base_url}/agentic/doc-snapshots/init",
        headers=ha,
        json={
            "client_id": "selfcheck",
            "host_app": "unknown",
            "doc_id": f"selfcheck_{uuid.uuid4().hex[:8]}",
            "doc_name": "selfcheck",
            "replace_previous": False,
            "source": {"mode": "http_upload_bytes"},
        },
        timeout=30.0,
    )
    r.raise_for_status()
    snapshot_id = str(r.json().get("snapshot_id") or "").strip()
    _assert(bool(snapshot_id), "[doc_snapshot] missing snapshot_id")

    manifest = {
        "schema_version": "ah32.doc_snapshot_manifest.v1",
        "host_app": "unknown",
        "client_id": "selfcheck",
        "doc_id": "selfcheck",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    files = {
        "manifest": (None, json.dumps(manifest, ensure_ascii=False), "application/json"),
        "extracted_text": (None, f"selfcheck extracted_text {uuid.uuid4().hex}", "text/plain; charset=utf-8"),
    }
    r = client.put(
        f"{base_url}/agentic/doc-snapshots/{snapshot_id}/parts",
        headers=ha,
        files=files,
        timeout=60.0,
    )
    r.raise_for_status()

    r = client.post(
        f"{base_url}/agentic/doc-snapshots/{snapshot_id}/finalize",
        headers=ha,
        json={},
        timeout=30.0,
    )
    r.raise_for_status()

    r = client.get(f"{base_url}/agentic/doc-snapshots/{snapshot_id}/status", headers=ha, timeout=30.0)
    r.raise_for_status()

    r = client.get(f"{base_url}/agentic/doc-snapshots/{snapshot_id}/status", headers=hb, timeout=30.0)
    _assert(
        r.status_code in (403, 404),
        f"[doc_snapshot] cross-tenant status should be 403/404, got {r.status_code}: {r.text[:200]}",
    )


def check_rag_isolation(client: httpx.Client, *, base_url: str, tenant_a: str, tenant_b: str, user_id: str, timeout_sec: int) -> None:
    ha = _h(tenant_id=tenant_a, user_id=user_id)
    hb = _h(tenant_id=tenant_b, user_id=user_id)

    token = f"TENANCY_SELFTEST_{uuid.uuid4().hex}"
    payload = {
        "items": [
            {
                "name": "selfcheck_tenancy.txt",
                "text": f"tenant isolation selfcheck token={token}\n",
                "importMethod": "upload-text",
                "scope": "global",
            }
        ]
    }
    r = client.post(f"{base_url}/agentic/rag/documents/upload-text", headers=ha, json=payload, timeout=30.0)
    r.raise_for_status()
    obj = r.json()
    task_id = str(((obj.get("data") or {}) if isinstance(obj, dict) else {}).get("taskId") or "").strip()
    _assert(bool(task_id), f"[rag] missing taskId: {obj}")

    state = _wait_rag_task(client, base_url=base_url, headers=ha, task_id=task_id, timeout_sec=timeout_sec)
    _assert(str(state.get("status") or "").strip().lower() == "completed", f"[rag] task not completed: {state}")

    r = client.get(f"{base_url}/agentic/rag/search", headers=ha, params={"query": token, "limit": 5}, timeout=30.0)
    r.raise_for_status()
    res_a = r.json()
    items_a = res_a.get("data") if isinstance(res_a, dict) else None
    _assert(bool(items_a), f"[rag] tenant A should find token, got: {res_a}")

    r = client.get(f"{base_url}/agentic/rag/search", headers=hb, params={"query": token, "limit": 5}, timeout=30.0)
    r.raise_for_status()
    res_b = r.json()
    items_b = res_b.get("data") if isinstance(res_b, dict) else None
    _assert(not items_b, f"[rag] tenant B should NOT find token, got: {res_b}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Self-check: tenant isolation for assets/doc snapshots (+ optional RAG).")
    ap.add_argument("--base-url", default="http://127.0.0.1:5123")
    ap.add_argument("--tenant-a", default="demo-a")
    ap.add_argument("--tenant-b", default="demo-b")
    ap.add_argument("--user-id", default="user1")
    ap.add_argument("--check-rag", action="store_true", help="Also check RAG isolation via upload-text + search (slower).")
    ap.add_argument("--rag-timeout-sec", type=int, default=120, help="Max seconds to wait for RAG ingest task.")
    args = ap.parse_args()

    base_url = str(args.base_url).rstrip("/")
    tenant_a = str(args.tenant_a).strip() or "demo-a"
    tenant_b = str(args.tenant_b).strip() or "demo-b"
    user_id = str(args.user_id).strip() or "user1"

    with httpx.Client() as client:
        check_assets(client, base_url=base_url, tenant_a=tenant_a, tenant_b=tenant_b, user_id=user_id)
        check_doc_snapshots(client, base_url=base_url, tenant_a=tenant_a, tenant_b=tenant_b, user_id=user_id)
        if bool(args.check_rag):
            check_rag_isolation(
                client,
                base_url=base_url,
                tenant_a=tenant_a,
                tenant_b=tenant_b,
                user_id=user_id,
                timeout_sec=int(args.rag_timeout_sec or 120),
            )

    print("OK: tenant isolation selfcheck passed")


if __name__ == "__main__":
    main()

