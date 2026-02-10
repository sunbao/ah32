from __future__ import annotations

from typing import Any, Dict, List


def seDeadline_checklist(bid_doc: str) -> Dict[str, Any]:
    text = str(bid_doc or "")

    baseline = [
        ("签章完整性", ["签章", "盖章", "公章", "法人章"]),
        ("密封要求", ["密封", "封标", "封条"]),
        ("授权委托书", ["授权委托书", "授权"]),
        ("报价表", ["报价", "报价表"]),
    ]

    checks: List[Dict[str, Any]] = []
    missing: List[str] = []

    for item, keywords in baseline:
        hit = any(word in text for word in keywords)
        status = "已检查" if hit else "未检查"
        notes = "命中关键词" if hit else "建议人工确认"
        checks.append({"item": item, "status": status, "notes": notes})
        if not hit:
            missing.append(item)

    return {
        "checks": checks,
        "missing": missing,
    }
