from __future__ import annotations

from typing import Any, Dict


def text_extractor(text: str, start: int = 0, end: int = 0) -> Dict[str, Any]:
    source = str(text or "")
    left = max(0, int(start or 0))
    right = int(end or 0)
    if right <= 0 or right > len(source):
        right = len(source)
    if left > right:
        left, right = right, left
    return {
        "start": left,
        "end": right,
        "text": source[left:right],
        "length": max(0, right - left),
    }

