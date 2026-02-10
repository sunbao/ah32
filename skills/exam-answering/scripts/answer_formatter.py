from __future__ import annotations

from typing import Any, Dict, List


def answer_formatter(
    answers: List[Dict[str, Any]],
    format: str = "plan_json",
    include_rationale: bool = False,
) -> Dict[str, Any]:
    normalized: List[Dict[str, Any]] = []
    for idx, item in enumerate(answers or [], start=1):
        entry = item if isinstance(item, dict) else {"answer": item}
        normalized_entry: Dict[str, Any] = {
            "question_id": str(entry.get("question_id") or idx),
            "answer": entry.get("answer"),
        }
        if include_rationale and entry.get("rationale"):
            normalized_entry["rationale"] = entry.get("rationale")
        normalized.append(normalized_entry)

    out_format = str(format or "plan_json").strip().lower()
    if out_format != "plan_json":
        out_format = "plan_json"

    return {
        "format": out_format,
        "answers": normalized,
        "total": len(normalized),
    }
