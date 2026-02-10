from __future__ import annotations

import re
from typing import Any, Dict, List


def fill_blank_detector(doc_text: str, context_chars: int = 20) -> Dict[str, Any]:
    text = str(doc_text or "")
    window = max(0, int(context_chars or 0))
    pattern = re.compile(r"_{3,}|＿{3,}|﹍{3,}|\b\(\s*\)\b")

    fill_blanks: List[Dict[str, Any]] = []
    for idx, match in enumerate(pattern.finditer(text), start=1):
        start, end = match.span()
        before = text[max(0, start - window):start]
        after = text[end:min(len(text), end + window)]
        fill_blanks.append(
            {
                "question_id": str(idx),
                "position": {"start": start, "end": end},
                "placeholder": match.group(0),
                "context_before": before,
                "context_after": after,
            }
        )

    return {
        "fill_blanks": fill_blanks,
        "total_count": len(fill_blanks),
    }
