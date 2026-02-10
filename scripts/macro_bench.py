"""
End-to-end-ish JS macro benchmark harness.

What it does (no WPS required):
- Calls backend LLM endpoints to generate / repair JS macros (same APIs used by the frontend).
- Runs a fast syntax check using Node's `new Function(...)` as a proxy for WPS taskpane parsing failures.
- Reports failures to `/agentic/error/report` to seed code-quality memory (Top-K rules).

This is NOT a full WPS execution test (we can't invoke WPS JSAPI here). It is a practical
regression harness for the highest-frequency failure class: SyntaxError / invalid tokens.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
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
) -> Tuple[bool, str, Dict[str, Any]]:
    url = f"{api_base.rstrip('/')}/agentic/js-macro/vibe-coding/stream"
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
        if ev.get("type") == "final_result":
            final = ev.get("result") or {}

    dt_ms = int((time.perf_counter() - t0) * 1000)
    code = str(final.get("code") or "")
    ok = bool(final.get("success")) and bool(code.strip())
    meta = {"duration_ms": dt_ms, "attempt_count": final.get("attempt_count"), "raw": final}
    return ok, code, meta


def call_repair(
    api_base: str,
    api_key: str,
    *,
    code: str,
    session_id: str,
    document_name: str,
    host_app: str,
    attempt: int,
    error_type: str,
    error_message: str,
    capabilities: Optional[Dict[str, Any]] = None,
    timeout_s: int = 1800,
) -> Tuple[bool, str, Dict[str, Any]]:
    url = f"{api_base.rstrip('/')}/agentic/js-macro/repair"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    payload = {
        "session_id": session_id,
        "document_name": document_name,
        "host_app": host_app,
        "capabilities": capabilities or {},
        "attempt": attempt,
        "error_type": error_type,
        "error_message": error_message,
        "code": code,
    }
    t0 = time.perf_counter()
    resp = requests.post(url, headers=headers, data=json.dumps(payload), timeout=timeout_s)
    resp.raise_for_status()
    data = resp.json()
    dt_ms = int((time.perf_counter() - t0) * 1000)
    fixed = str(data.get("code") or "")
    ok = bool(data.get("success")) and bool(fixed.strip())
    return ok, fixed, {"duration_ms": dt_ms, "raw": data}


def report_error(
    api_base: str,
    api_key: str,
    *,
    error_type: str,
    error_message: str,
    error_code: str,
    correction_suggestion: str = "",
    user_context: str = "",
    severity: str = "medium",
) -> None:
    url = f"{api_base.rstrip('/')}/agentic/error/report"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    payload = {
        "error_type": error_type,
        "error_message": error_message,
        "error_code": error_code,
        "correction_suggestion": correction_suggestion,
        "user_context": user_context,
        "severity": severity,
    }
    try:
        resp = requests.post(url, headers=headers, data=json.dumps(payload), timeout=20)
        if not resp.ok:
            return
    except Exception:
        return


def syntax_check_with_node(js_code: str) -> Tuple[bool, str]:
    """
    Use Node to parse the code via `new Function(...)`.
    This approximates the WPS taskpane JS engine class of SyntaxErrors.
    """
    tmp = os.path.join(os.getcwd(), f"tmp_macro_bench_{uuid.uuid4().hex}.js")
    runner = os.path.join(os.getcwd(), f"tmp_macro_bench_runner_{uuid.uuid4().hex}.js")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(js_code)
        with open(runner, "w", encoding="utf-8") as f:
            f.write(
                "const fs = require('fs');\n"
                "const path = process.argv[2];\n"
                "const code = fs.readFileSync(path, 'utf8');\n"
                "try {\n"
                "  // Parse only.\n"
                "  new Function(code);\n"
                "  process.stdout.write('OK');\n"
                "} catch (e) {\n"
                "  process.stdout.write(String(e && (e.name || 'Error')) + ': ' + String(e && e.message || e));\n"
                "  process.exitCode = 2;\n"
                "}\n"
            )
        cp = subprocess.run(
            ["node", runner, tmp],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        out = (cp.stdout or "").strip()
        if cp.returncode == 0 and out == "OK":
            return True, ""
        err = out or (cp.stderr or "").strip() or "SyntaxError"
        return False, err
    finally:
        for p in (tmp, runner):
            try:
                os.remove(p)
            except Exception:
                pass


def bench_one_case(
    api_base: str,
    api_key: str,
    case: Case,
    *,
    max_repairs: int,
    document_name: str,
) -> Dict[str, Any]:
    session_id = f"bench_{case.host_app}_{_now_ms()}"
    capabilities = {"host_app": case.host_app, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    out: Dict[str, Any] = {"case": case.__dict__, "session_id": session_id, "events": []}

    ok, code, meta = call_vibe_stream(
        api_base,
        api_key,
        user_query=case.query,
        session_id=session_id,
        document_name=document_name,
        host_app=case.host_app,
        capabilities=capabilities,
    )
    out["events"].append({"type": "vibe_generate", "ok": ok, "meta": meta, "code_len": len(code)})
    if not code.strip():
        return out

    # Parse check. If it fails, report and try repair.
    cur = code
    for attempt in range(1, max_repairs + 1):
        parse_ok, parse_err = syntax_check_with_node(cur)
        out["events"].append({"type": "syntax_check", "ok": parse_ok, "error": parse_err, "attempt": attempt})
        if parse_ok:
            out["final_ok"] = True
            out["final_code_len"] = len(cur)
            return out

        report_error(
            api_base,
            api_key,
            error_type="javascript_syntax_error",
            error_message=f"bench SyntaxError: {parse_err}",
            error_code=cur[:4000],
            user_context=f"bench case={case.name} host={case.host_app} attempt={attempt}",
            severity="medium",
        )

        rok, fixed, rmeta = call_repair(
            api_base,
            api_key,
            code=cur,
            session_id=session_id,
            document_name=document_name,
            host_app=case.host_app,
            attempt=attempt,
            error_type="javascript_syntax_error",
            error_message=f"bench SyntaxError: {parse_err}",
            capabilities=capabilities,
        )
        out["events"].append({"type": "repair", "ok": rok, "meta": rmeta, "code_len": len(fixed), "attempt": attempt})
        if not fixed.strip():
            break
        cur = fixed

    out["final_ok"] = False
    out["final_code_len"] = len(cur)
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
    ap.add_argument("--max-repairs", type=int, default=3)
    ap.add_argument("--document-name", default="bench.doc")
    ap.add_argument("--only-host", choices=["wps", "et", "wpp"], default=None)
    ap.add_argument("--json-out", default="")
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
            max_repairs=args.max_repairs,
            document_name=args.document_name,
        )
        results.append(r)
        ok = bool(r.get("final_ok"))
        print(f"[bench]   session_id={r.get('session_id')} final_ok={ok} final_code_len={r.get('final_code_len')}")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

    failed = [r for r in results if not r.get("final_ok")]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

