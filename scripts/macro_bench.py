"""
End-to-end-ish Plan JSON benchmark harness.

What it does (no WPS required):
- Calls backend LLM endpoint to generate Plan JSON (ah32.plan.v1) via streaming API.
- Collects basic stats: success rate, attempt_count (internal retries), latency, op distribution.

This is NOT a full WPS execution test (we can't invoke WPS JSAPI here). It is a practical
regression harness for the highest-frequency failure class: invalid/empty Plan output.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


@dataclass(frozen=True)
class Case:
    name: str
    host_app: str  # wps|et|wpp
    query: str


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_sse_lines(resp: requests.Response) -> Iterable[str]:
    buf = ""
    for chunk in resp.iter_content(chunk_size=4096, decode_unicode=True):
        if not chunk:
            continue
        buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            yield line.rstrip("\r")
    if buf:
        yield buf.rstrip("\r")


def call_vibe_stream(
    api_base: str,
    api_key: str,
    *,
    user_query: str,
    session_id: str,
    document_name: str,
    host_app: str,
    capabilities: Optional[Dict[str, Any]] = None,
    timeout_s: int = 1800,
) -> Tuple[bool, Optional[Dict[str, Any]], Dict[str, Any]]:
    url = f"{api_base.rstrip('/')}/agentic/js-plan/vibe-coding/stream"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    payload = {
        "user_query": user_query,
        "session_id": session_id,
        "document_name": document_name,
        "host_app": host_app,
        "capabilities": capabilities or {},
    }

    t0 = time.perf_counter()
    resp = requests.post(url, headers=headers, data=json.dumps(payload), stream=True, timeout=timeout_s)
    resp.raise_for_status()

    final: Dict[str, Any] = {}
    stream_error: str = ""
    for line in _read_sse_lines(resp):
        if not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            ev = json.loads(data)
        except Exception:
            continue
        if ev.get("type") == "error":
            stream_error = str(ev.get("error") or stream_error or "stream error")
        if ev.get("type") == "final_result":
            final = ev.get("result") or {}

    dt_ms = int((time.perf_counter() - t0) * 1000)
    plan = final.get("plan") if isinstance(final, dict) else None
    ok = bool(final.get("success")) and isinstance(plan, dict)
    err = ""
    if not ok:
        err_obj = final.get("error") if isinstance(final, dict) else None
        if isinstance(err_obj, dict):
            err = str(err_obj.get("message") or err_obj.get("type") or "")
        if not err:
            err = stream_error or str(final.get("error") or "generate failed")

    meta = {
        "duration_ms": dt_ms,
        "attempt_count": int(final.get("attempt_count") or 0) if isinstance(final, dict) else 0,
        "error": err,
    }
    return ok, plan if isinstance(plan, dict) else None, meta


def _collect_ops(actions: Any) -> List[str]:
    ops: List[str] = []
    if not isinstance(actions, list):
        return ops
    for a in actions:
        if not isinstance(a, dict):
            continue
        op = str(a.get("op") or "").strip()
        if op:
            ops.append(op)
        if op == "upsert_block":
            ops.extend(_collect_ops(a.get("actions")))
    return ops


def bench_one_case(
    api_base: str,
    api_key: str,
    case: Case,
    document_name: str,
    include_plan: bool = False,
) -> Dict[str, Any]:
    session_id = f"bench_{case.host_app}_{_now_ms()}"
    capabilities = {"host_app": case.host_app, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    out: Dict[str, Any] = {"case": case.__dict__, "session_id": session_id, "events": []}

    ok, plan, meta = call_vibe_stream(
        api_base,
        api_key,
        user_query=case.query,
        session_id=session_id,
        document_name=document_name,
        host_app=case.host_app,
        capabilities=capabilities,
    )
    ops = _collect_ops(plan.get("actions") if isinstance(plan, dict) else None)
    out["events"].append(
        {
            "type": "plan_generate",
            "ok": ok,
            "meta": meta,
            "plan_len": len(json.dumps(plan, ensure_ascii=False, default=str)) if isinstance(plan, dict) else 0,
            "ops": ops[:24],
            "ops_count": len(ops),
        }
    )
    out["final_ok"] = bool(ok)
    out["final_attempt_count"] = meta.get("attempt_count")
    out["final_plan_len"] = out["events"][-1].get("plan_len")
    out["final_ops_count"] = len(ops)
    if include_plan and isinstance(plan, dict):
        out["final_plan"] = plan
    return out


def default_cases() -> List[Case]:
    return [
        Case(
            name="writer_table_3x5",
            host_app="wps",
            query="在当前光标处插入一个 3 行 5 列的表格，并填入表头：序号/名称/数量/单价/小计；再填入两行示例数据。",
        ),
        Case(
            name="writer_wordart_title",
            host_app="wps",
            query="在当前光标处插入一个醒目的艺术字标题：本周工作周报，并在其下方另起一段写三条要点。",
        ),
        Case(
            name="writer_99_table",
            host_app="wps",
            query="生成 9x9 乘法表（不要生成第二份；重复执行要覆盖原产物），并写入到文档末尾。",
        ),
        Case(
            name="et_sheet_table_and_chart",
            host_app="et",
            query="创建一张名为“月度趋势”的产物工作表，写入两列数据：月份(1-6月) 和 活跃用户(万)：45/52/60/65/70/68，然后基于该数据生成折线图。",
        ),
        Case(
            name="wpp_title_slide",
            host_app="wpp",
            query="生成一页标题页：标题“项目周报”，副标题“第4周”，并在页面下方插入三条要点。",
        ),
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default=os.getenv("AH32_API_BASE", "http://127.0.0.1:5123"))
    ap.add_argument("--api-key", default=os.getenv("AH32_API_KEY", "test-key"))
    ap.add_argument("--document-name", default="bench.doc")
    ap.add_argument("--only-host", choices=["wps", "et", "wpp"], default=None)
    ap.add_argument("--json-out", default="")
    ap.add_argument("--include-plan", action="store_true", help="Include full plan JSON in output (can be large).")
    args = ap.parse_args()

    cases = default_cases()
    if args.only_host:
        cases = [c for c in cases if c.host_app == args.only_host]

    results: List[Dict[str, Any]] = []
    for c in cases:
        print(f"[bench] case={c.name} host={c.host_app}")
        r = bench_one_case(
            args.api_base,
            args.api_key,
            c,
            document_name=args.document_name,
            include_plan=bool(args.include_plan),
        )
        results.append(r)
        ok = bool(r.get("final_ok"))
        print(
            f"[bench]   session_id={r.get('session_id')} final_ok={ok} attempt_count={r.get('final_attempt_count')} ops={r.get('final_ops_count')}"
        )

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

    failed = [r for r in results if not r.get("final_ok")]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

