"""
30-case Plan JSON success benchmark (focus: reduce model retries).

- Generates ah32.plan.v1 via backend `/agentic/js-plan/vibe-coding/stream` (same stream shape as the old JS macro bench).
- No WPS required: this only validates the backend generation + strict plan schema extraction.
- Reports attempt_count (1..3) and latency.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
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


def _call_plan_vibe_stream(
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
    ap.add_argument(
        "--max-repairs",
        type=int,
        default=5,
        help="Bucket upper bound only (attempt_count is fixed by backend stream: 1..3).",
    )
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
        ok, plan, meta = _call_plan_vibe_stream(
            args.api_base,
            args.api_key,
            user_query=c.query,
            session_id=session_id,
            document_name=doc_name,
            host_app=c.host_app,
            capabilities=caps,
        )
        gen_ms = int(meta.get("duration_ms") or 0) if isinstance(meta, dict) else 0
        total_gen_ms.append(gen_ms)

        attempt_count = int(meta.get("attempt_count") or 0) if isinstance(meta, dict) else 0
        repairs_used = max(0, attempt_count - 1) if ok else 0
        if repairs_used > args.max_repairs:
            repairs_used = args.max_repairs

        ops = _collect_ops(plan.get("actions") if isinstance(plan, dict) else None)

        case_ms = int((time.perf_counter() - t_case0) * 1000)
        total_ms.append(case_ms)

        if ok:
            bucket_counts[repairs_used] += 1
        else:
            bucket_counts["fail"] += 1  # type: ignore[index]

        row = {
            "case": c.__dict__,
            "session_id": session_id,
            "generate_ok": ok,
            "generate_ms": gen_ms,
            "workflow_attempt_count": attempt_count,
            "repairs_used": repairs_used,
            "case_ms": case_ms,
            "last_error": str(meta.get("error") or "")[:300] if isinstance(meta, dict) else "",
            "plan_len": len(json.dumps(plan, ensure_ascii=False, default=str)) if isinstance(plan, dict) else 0,
            "ops": ops[:24],
            "ops_count": len(ops),
        }
        results.append(row)
        # Persist progress after each case, so long-running runs are resumable.
        try:
            _write_json_atomic(out_path, results)
        except Exception:
            pass
        print(
            f"[bench30] {idx:02d}/30 done ok={ok} repairs={repairs_used} gen_ms={gen_ms} total_ms={case_ms}"
            + (f" err={str(meta.get('error') or '')[:120]}" if not ok else "")
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
