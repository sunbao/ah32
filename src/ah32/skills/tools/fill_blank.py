from __future__ import annotations

import re
from typing import Any, Dict, List


def fill_blank(doc_text: str, context_chars: int = 20) -> Dict[str, Any]:
    text = str(doc_text or "")
    window = max(0, int(context_chars or 0))
    pattern = re.compile(r"_{3,}|＿{3,}|﹍{3,}|\(\s*\)")

    items: List[Dict[str, Any]] = []
    for idx, m in enumerate(pattern.finditer(text), start=1):
        start, end = m.span()
        items.append(
            {
                "id": str(idx),
                "start": start,
                "end": end,
                "placeholder": m.group(0),
                "before": text[max(0, start - window):start],
                "after": text[end:min(len(text), end + window)],
            }
        )

    return {"fill_blanks": items, "total_count": len(items)}

