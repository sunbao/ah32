from __future__ import annotations

import re
from typing import Any, Dict, List


def question_parser(doc_text: str, parse_options: bool = True) -> Dict[str, Any]:
    lines = [line.strip() for line in str(doc_text or "").splitlines()]
    questions: List[Dict[str, Any]] = []

    current: Dict[str, Any] | None = None
    q_head = re.compile(r"^\s*(\d{1,3})[\.、\)]\s*(.+)$")
    opt_head = re.compile(r"^\s*([A-Da-d])[\.、\)]\s*(.+)$")

    def flush_current() -> None:
        if current is None:
            return
        stem = str(current.get("stem") or "")
        options = current.get("options") or []
        if options:
            qtype = "single_choice"
        elif "___" in stem or "＿＿" in stem or "____" in stem:
            qtype = "fill_blank"
        else:
            qtype = "short_answer"
        current["question_type"] = qtype
        questions.append(dict(current))

    for line in lines:
        if not line:
            continue
        q_match = q_head.match(line)
        if q_match:
            flush_current()
            current = {
                "question_id": q_match.group(1),
                "stem": q_match.group(2).strip(),
                "options": [],
            }
            continue

        if current is None:
            continue

        if parse_options:
            o_match = opt_head.match(line)
            if o_match:
                current["options"].append(
                    {
                        "label": o_match.group(1).upper(),
                        "text": o_match.group(2).strip(),
                    }
                )
                continue

        current["stem"] = (str(current.get("stem") or "") + " " + line).strip()

    flush_current()

    return {
        "questions": questions,
        "total_count": len(questions),
    }
