"""
30-case macro success benchmark (focus: reduce LLM repair loops).

- Generates JS macros via backend /agentic/js-macro/vibe-coding/stream (same as frontend).
- Executes with a Node stub runner (parse + best-effort runtime stubs).
  This is not real WPS, but it reliably catches the dominant failure class: SyntaxError + obvious ReferenceError/TypeError.
- On failure, calls /agentic/js-macro/repair up to N times (default 5).
  We count how many repair calls were needed (0..N) and measure latency.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


@dataclass(frozen=True)
class Case:
    name: str
    host_app: str  # wps|et|wpp
    query: str


def _tcp_open(host: str, port: int, timeout_s: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _start_backend_if_needed(api_base: str) -> Optional[subprocess.Popen]:
    # Only supports local base for auto-start.
    if not api_base.startswith("http://127.0.0.1:") and not api_base.startswith("http://localhost:"):
        return None
    port = int(api_base.rsplit(":", 1)[1])
    if _tcp_open("127.0.0.1", port):
        return None

    py = Path.cwd() / ".venv" / "Scripts" / "python.exe"
    if not py.exists():
        py = Path(sys.executable)  # type: ignore[name-defined]

    proc = subprocess.Popen(
        [str(py), "-m", "ah32.server.main"],
        cwd=str(Path.cwd()),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )

    deadline = time.time() + 30
    while time.time() < deadline:
        if _tcp_open("127.0.0.1", port, timeout_s=0.6):
            return proc
        time.sleep(0.8)

    try:
        proc.terminate()
    except Exception:
        pass
    return None


def _ensure_backend(api_base: str) -> Optional[subprocess.Popen]:
    """Start backend if needed; also tolerate slow startup (embeddings/model init)."""
    started = _start_backend_if_needed(api_base)
    if not api_base.startswith("http://127.0.0.1:") and not api_base.startswith("http://localhost:"):
        return started
    port = int(api_base.rsplit(":", 1)[1])
    if _tcp_open("127.0.0.1", port):
        return started
    # One more slow wait loop in case the server is still booting.
    deadline = time.time() + 75
    while time.time() < deadline:
        if _tcp_open("127.0.0.1", port, timeout_s=0.8):
            return started
        time.sleep(1.0)
    return started


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


def _call_vibe_stream(
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


def _call_generate_fast(
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
    url = f"{api_base.rstrip('/')}/agentic/js-macro/generate"
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
    resp = requests.post(url, headers=headers, data=json.dumps(payload), timeout=timeout_s)
    resp.raise_for_status()
    data = resp.json()
    dt_ms = int((time.perf_counter() - t0) * 1000)
    code = str(data.get("code") or "")
    ok = bool(data.get("success")) and bool(code.strip())
    meta = {"duration_ms": int(data.get("duration_ms") or dt_ms), "raw": data}
    return ok, code, meta


def _call_repair(
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


def _report_error(
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
        requests.post(url, headers=headers, data=json.dumps(payload), timeout=20)
    except Exception:
        return


def _classify_err(err: str) -> str:
    s = (err or "").lower()
    if "syntaxerror" in s or "unexpected token" in s or "invalid or unexpected token" in s:
        return "javascript_syntax_error"
    if "referenceerror" in s or "is not defined" in s:
        return "javascript_reference_error"
    if "typeerror" in s:
        return "javascript_type_error"
    if "macrosafetyerror" in s:
        return "macro_safety_error"
    return "execution_error"


def _node_exec(host_app: str, js_code: str) -> Tuple[bool, str, float]:
    runner = Path("scripts/macro_node_runner.js").resolve()
    tmp = Path(f"tmp_macro_bench_{uuid.uuid4().hex}.js").resolve()
    t0 = time.perf_counter()
    try:
        tmp.write_text(js_code, encoding="utf-8")
        cp = subprocess.run(
            ["node", str(runner), host_app, str(tmp)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=6,
        )
        dt_ms = (time.perf_counter() - t0) * 1000.0
        out = (cp.stdout or "").strip()
        try:
            data = json.loads(out) if out else {}
        except Exception:
            data = {}
        if cp.returncode == 0 and data.get("ok") is True:
            return True, "", dt_ms
        err = str(data.get("error") or cp.stderr or out or "exec_failed").strip()
        return False, err, dt_ms
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass


def _write_json_atomic(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _cases_30() -> List[Case]:
    # These are intentionally "simple, common office ops" aligned with built-in skill themes.
    return [
        # Writer - tables / formatting / summaries
        Case("wps_contract_risk_table", "wps", "在当前光标处插入一张“合同风险清单”表格：风险点/条款位置/风险等级/建议修改。填入3行示例。"),
        Case("wps_meeting_minutes_template", "wps", "在文末写入会议纪要模板：会议主题/时间/参会人/结论/待办(表格)。"),
        Case("wps_weekly_report", "wps", "在文末插入一个周报：本周完成(3条)/下周计划(3条)/风险与协同(2条)。标题用艺术字。"),
        Case("wps_bid_response_table", "wps", "在光标处插入“需求-响应对照表”3行4列：需求点/响应说明/证据材料/负责人。"),
        Case("wps_finance_checklist", "wps", "插入“财务审核清单”表格：项目/金额/凭证是否齐全/备注。写2行示例。"),
        Case("wps_insert_chart_note", "wps", "在文末插入一段“数据图表区域”说明，并插入一个示例柱状图（如果不支持图表API则写说明）。"),
        Case("wps_outline_toc", "wps", "在光标处插入一个三级标题大纲：1概述/2目标/3范围/4交付物；每个下面一行说明。"),
        Case("wps_99_multiplication_end", "wps", "生成9x9乘法表，写入到文档末尾，并确保重复执行不会生成第二份（覆盖原产物）。"),
        Case("wps_table_price_calc", "wps", "插入报价表：名称/数量/单价/小计/备注，共4行示例；并在最后一行写“合计”。"),
        Case("wps_insert_wordart_banner", "wps", "插入艺术字横幅：阿蛤（AH32）演示，并在下方写一句说明。"),
        Case("wps_insert_two_tables", "wps", "连续插入两张表：第一张2x3（A/B/C），第二张3x2（X/Y）。"),
        Case("wps_summary_block_end", "wps", "在文末插入“汇总”标题，并列出三条要点。"),
        Case("wps_insert_section_breaks", "wps", "在当前光标处插入一个小节：标题“附录A”，下方插入2条编号条目。"),
        Case("wps_risk_register_small", "wps", "插入一个小型风险台账表格：风险/影响/概率/对策。填3行。"),
        Case("wps_add_picture_placeholder", "wps", "在文末插入图片占位说明：这里将放置“系统架构图”。"),
        Case("wps_formatting_demo", "wps", "在光标处写一段文字并加粗标题：标题“注意事项”，正文两行。"),
        Case("wps_insert_table_header_only", "wps", "插入1行5列表头：序号/事项/负责人/截止时间/状态。"),
        Case("wps_insert_chart_from_selection", "wps", "如果当前选区是一个小表格数据，就基于选区插入图表；否则先插入一个2列6行数据表再插图。"),
        Case("wps_insert_wordart_and_table", "wps", "先插入艺术字标题“项目计划”，再插入表格：阶段/开始/结束/负责人。"),
        Case("wps_append_action_items", "wps", "在文末追加“待办事项”表格：事项/负责人/截止日期。2行示例。"),
        # ET - sheets / charts
        Case("et_monthly_trend_sheet", "et", "创建产物工作表“月度趋势”，写入月份(1-6月)与活跃用户(万)：45/52/60/65/70/68，并生成折线图。"),
        Case("et_budget_table", "et", "在产物工作表A1写预算表：类别/预算/实际/差异，填3行示例。"),
        Case("et_pivot_like_summary", "et", "写入一张简单数据表（部门/费用），再在旁边生成汇总（每部门合计）。"),
        Case("et_gantt_simple", "et", "生成一个简易甘特表：任务/开始/结束/天数，3条示例。"),
        Case("et_sales_bar_chart", "et", "写入季度销售额Q1- Q4并生成柱状图。"),
        # WPP - slides
        Case("wpp_title_slide", "wpp", "生成一页标题页：标题“项目周报”，副标题“第4周”。"),
        Case("wpp_agenda_slide", "wpp", "生成一页目录：1概述 2进展 3风险 4计划；每条前加圆点。"),
        Case("wpp_kpi_slide", "wpp", "生成一页KPI：用大号文字展示“交付准时率 98%”，并在下方写两条说明。"),
        Case("wpp_risk_slide", "wpp", "生成一页风险：标题“主要风险”，列3条风险及对策。"),
        Case("wpp_timeline_slide", "wpp", "生成一页时间线：第1周-第4周，每周一句进展。"),
    ]


def _percent(x: float) -> str:
    return f"{x * 100.0:.1f}%"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default=os.getenv("AH32_API_BASE", "http://127.0.0.1:5123"))
    ap.add_argument("--api-key", default=os.getenv("AH32_API_KEY", "test-key"))
    ap.add_argument("--max-repairs", type=int, default=5)
    ap.add_argument("--json-out", default="tmp_macro_bench_30_results.json")
    ap.add_argument(
        "--resume",
        action="store_true",
        help="Resume from an existing json-out file by skipping completed case names.",
    )
    args = ap.parse_args()

    started = _ensure_backend(args.api_base)
    cases = _cases_30()

    out_path = Path(args.json_out)
    results: List[Dict[str, Any]] = []
    completed_names: set[str] = set()
    if args.resume and out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if isinstance(existing, list):
                results = existing
                for r in results:
                    try:
                        nm = str(((r or {}).get("case") or {}).get("name") or "")
                        if nm:
                            completed_names.add(nm)
                    except Exception:
                        continue
        except Exception:
            # If the file is corrupt/partial, start fresh.
            results = []
            completed_names = set()
    bucket_counts = {i: 0 for i in range(0, args.max_repairs + 1)}
    bucket_counts["fail"] = 0  # type: ignore[index]
    total_gen_ms: List[int] = []
    total_ms: List[int] = []
    total_repair_ms: List[int] = []

    if completed_names:
        print(f"[bench30] resume: already have {len(completed_names)}/{len(cases)} cases in {out_path}")
    print(f"[bench30] cases={len(cases)} max_repairs={args.max_repairs} api={args.api_base}")

    for idx, c in enumerate(cases, 1):
        if c.name in completed_names:
            continue
        session_id = f"bench30_{c.host_app}_{int(time.time()*1000)}_{idx}"
        doc_name = "bench.doc" if c.host_app == "wps" else ("bench.xlsx" if c.host_app == "et" else "bench.ppt")
        caps = {"host_app": c.host_app, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

        print(f"[bench30] {idx:02d}/30 start host={c.host_app} case={c.name}")
        t_case0 = time.perf_counter()
        ok_gen, code, meta = _call_generate_fast(
            args.api_base,
            args.api_key,
            user_query=c.query,
            session_id=session_id,
            document_name=doc_name,
            host_app=c.host_app,
            capabilities=caps,
        )
        gen_ms = int(meta.get("duration_ms") or 0)
        total_gen_ms.append(gen_ms)

        cur = code
        repairs_used = 0
        last_err = ""
        exec_ok = False
        exec_ms = 0.0
        repairs_detail: List[Dict[str, Any]] = []

        if ok_gen and cur.strip():
            exec_ok, last_err, exec_ms = _node_exec(c.host_app, cur)
        else:
            last_err = "generate_failed"

        while not exec_ok and repairs_used < args.max_repairs and cur.strip():
            repairs_used += 1
            etype = _classify_err(last_err)
            _report_error(
                args.api_base,
                args.api_key,
                error_type=etype,
                error_message=f"bench30 {etype}: {last_err}",
                error_code=cur[:4000],
                user_context=f"bench30 case={c.name} host={c.host_app} repair={repairs_used}",
            )
            rok, fixed, rmeta = _call_repair(
                args.api_base,
                args.api_key,
                code=cur,
                session_id=session_id,
                document_name=doc_name,
                host_app=c.host_app,
                attempt=repairs_used,
                error_type=etype,
                error_message=f"bench30 {etype}: {last_err}",
                capabilities=caps,
            )
            r_ms = int(rmeta.get("duration_ms") or 0)
            total_repair_ms.append(r_ms)
            repairs_detail.append(
                {
                    "attempt": repairs_used,
                    "error_type": etype,
                    "error_message": last_err[:240],
                    "repair_ok": rok,
                    "repair_ms": r_ms,
                    "code_len": len(fixed or ""),
                }
            )
            # if backend says success but returns empty/identical, stop early
            if not fixed.strip() or fixed.strip() == cur.strip():
                last_err = str(rmeta.get("raw", {}).get("error") or "repair_no_change")
                break
            cur = fixed
            exec_ok, last_err, exec_ms = _node_exec(c.host_app, cur)

        case_ms = int((time.perf_counter() - t_case0) * 1000)
        total_ms.append(case_ms)

        if exec_ok:
            bucket_counts[repairs_used] += 1
        else:
            bucket_counts["fail"] += 1  # type: ignore[index]

        row = {
            "case": c.__dict__,
            "session_id": session_id,
            "generate_ok": ok_gen,
            "generate_ms": gen_ms,
            "workflow_attempt_count": None,
            "repairs_used": repairs_used,
            "repairs_detail": repairs_detail,
            "final_ok": exec_ok,
            "node_exec_ms": exec_ms,
            "case_ms": case_ms,
            "last_error": last_err[:300],
            "final_code_len": len(cur or ""),
        }
        results.append(row)
        # Persist progress after each case, so long-running runs are resumable.
        try:
            _write_json_atomic(out_path, results)
        except Exception:
            pass
        print(
            f"[bench30] {idx:02d}/30 done ok={exec_ok} repairs={repairs_used} gen_ms={gen_ms} total_ms={case_ms}"
            + (f" err={last_err[:120]}" if not exec_ok else "")
        )

    _write_json_atomic(out_path, results)

    ok_total = sum(bucket_counts[i] for i in range(0, args.max_repairs + 1))
    fail = bucket_counts["fail"]  # type: ignore[index]
    print("")
    print("[bench30] results:")
    print(f"  total={len(cases)} ok={ok_total} fail={fail} success_rate={_percent(ok_total/len(cases))}")
    for i in range(0, args.max_repairs + 1):
        print(f"  ok_with_repairs_{i}: {bucket_counts[i]}")
    print(f"  avg_generate_ms={sum(total_gen_ms)/len(total_gen_ms):.0f}")
    if total_repair_ms:
        print(f"  avg_repair_ms={sum(total_repair_ms)/len(total_repair_ms):.0f} (n={len(total_repair_ms)})")
    print(f"  avg_total_ms={sum(total_ms)/len(total_ms):.0f}")
    print(f"  json_out={out_path}")

    if started is not None:
        try:
            started.terminate()
        except Exception:
            pass

    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
