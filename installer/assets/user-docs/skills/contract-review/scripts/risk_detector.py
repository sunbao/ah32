"""Contract risk detector (deterministic rules).

Goal:
- Highlight high-risk signals in contract text by regex patterns and missing-clause heuristics.

Notes:
- `doc_text` can be auto-injected from the active document by AH32 runtime.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


_RISK_PATTERNS: List[Dict[str, Any]] = [
    {
        "id": "unilateral_termination",
        "category": "单方解除/单方变更",
        "severity": "high",
        "regex": r"(?:甲方|需方|买方).{0,20}(?:有权|可)(?:单方|随时).{0,20}(?:解除|终止|变更)",
        "suggestion": "建议补充对等解除条件、通知期、违约责任与已发生费用结算方式。",
    },
    {
        "id": "unlimited_liability",
        "category": "无限责任/责任过重",
        "severity": "high",
        "regex": r"(?:承担|赔偿).{0,10}(?:一切|全部).{0,10}(?:损失|责任)|无限(?:责任|赔偿)|不设(?:上限|限额)",
        "suggestion": "建议增加责任上限、排除间接/可得利益损失，并与价款/保费等挂钩。",
    },
    {
        "id": "excessive_penalty",
        "category": "违约金过高",
        "severity": "high",
        "regex": r"违约金.{0,20}(?:每日|每逾期|按日).{0,20}(?:万分之|千分之|百分之)\s*\d+",
        "suggestion": "建议设置违约金封顶比例，并明确起算点与免责情形（不可抗力/对方原因）。",
    },
    {
        "id": "invoice_before_payment",
        "category": "开票与付款不对等",
        "severity": "medium",
        "regex": r"(?:先行|必须).{0,10}(?:开具|提供).{0,10}发票.{0,30}(?:方可|才能).{0,10}(?:付款|支付)",
        "suggestion": "建议约定合理的开票/付款节点（例如验收/对账后），避免单方控制付款条件。",
    },
    {
        "id": "acceptance_subjective",
        "category": "验收口径主观",
        "severity": "medium",
        "regex": r"以(?:甲方|需方|买方).{0,10}(?:最终|单方).{0,10}验收为准|验收标准由(?:甲方|需方|买方)决定",
        "suggestion": "建议明确验收标准与可操作的验收流程，约定默认验收条款（超期未反馈视为通过）。",
    },
    {
        "id": "ip_assignment",
        "category": "知识产权归属不利",
        "severity": "high",
        "regex": r"(?:知识产权|成果|源代码).{0,20}(?:归(?:甲方|需方|买方)所有|无偿转让)",
        "suggestion": "建议区分背景/前景知识产权，明确许可范围、交付物归属与使用限制。",
    },
    {
        "id": "confidentiality_forever",
        "category": "保密期限过长",
        "severity": "low",
        "regex": r"(?:永久|无限期).{0,10}保密|保密期限.{0,10}永久",
        "suggestion": "建议设定合理保密期限，并明确例外（已公开信息/司法披露等）。",
    },
]


_MISSING_CLAUSE_HINTS: List[Dict[str, Any]] = [
    {
        "id": "missing_liability_cap",
        "category": "缺失责任上限",
        "severity": "medium",
        "keywords": ["责任上限", "责任限制", "最高不超过", "不超过"],
        "suggestion": "建议补充责任限制条款（上限/排除间接损失/索赔期限）。",
    },
    {
        "id": "missing_force_majeure",
        "category": "缺失不可抗力",
        "severity": "low",
        "keywords": ["不可抗力", "force majeure"],
        "suggestion": "建议补充不可抗力条款（通知、减损、免责范围、终止条件）。",
    },
    {
        "id": "missing_dispute_resolution",
        "category": "缺失争议解决",
        "severity": "low",
        "keywords": ["争议", "仲裁", "诉讼", "管辖", "法院"],
        "suggestion": "建议补充争议解决与适用法律条款（管辖地/仲裁机构）。",
    },
]


def risk_detector(doc_text: str = "", context_chars: int = 36, max_results: int = 120) -> Dict[str, Any]:
    """Detect risk signals in contract text.

    Args:
        doc_text: Contract plain text.
        context_chars: Context window size around match.
        max_results: Safety cap.

    Returns:
        {
          "risks":[
            {"id":"unilateral_termination","severity":"high","match":"...","position":{"start":1,"end":2},"context":"..."}
          ],
          "total": 3
        }
    """
    text = str(doc_text or "")
    if not text.strip():
        return {"risks": [], "total": 0}

    context_chars = max(0, int(context_chars or 0))
    max_results = max(1, int(max_results or 0))

    risks: List[Dict[str, Any]] = []

    for pat in _RISK_PATTERNS:
        if len(risks) >= max_results:
            break
        rx = re.compile(str(pat["regex"]), flags=re.IGNORECASE | re.DOTALL)
        for m in rx.finditer(text):
            if len(risks) >= max_results:
                break
            start, end = m.span()
            risks.append(
                {
                    "id": pat["id"],
                    "category": pat["category"],
                    "severity": pat["severity"],
                    "match": m.group(0)[:200],
                    "position": {"start": start, "end": end},
                    "context": _context(text, start, end, context_chars),
                    "suggestion": pat.get("suggestion") or "",
                }
            )

    # Missing clause heuristics (only add when the hint keywords do not exist at all).
    lower = text.lower()
    for hint in _MISSING_CLAUSE_HINTS:
        if len(risks) >= max_results:
            break
        keywords = [str(x or "").strip() for x in (hint.get("keywords") or []) if str(x or "").strip()]
        if not keywords:
            continue
        if any((kw.lower() in lower) for kw in keywords):
            continue
        risks.append(
            {
                "id": hint["id"],
                "category": hint["category"],
                "severity": hint["severity"],
                "match": "",
                "position": None,
                "context": "",
                "suggestion": hint.get("suggestion") or "",
                "kind": "missing_clause",
            }
        )

    return {"risks": risks[:max_results], "total": len(risks[:max_results])}


def _context(text: str, start: int, end: int, window: int) -> str:
    if window <= 0:
        return ""
    left = max(0, int(start) - window)
    right = min(len(text), int(end) + window)
    return text[left:right].replace("\n", " ").strip()

