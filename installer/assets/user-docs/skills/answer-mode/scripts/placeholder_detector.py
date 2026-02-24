"""Placeholder Detector - Detect common answer slots in exam papers/forms.

This tool is intended to reduce LLM guesswork for deterministic writeback:
- parentheses: （ ） / ( )
- brackets: [] / 【】
- underline blanks: ______ / ＿＿＿＿
- dash blanks: ---- / —— / ——（various dash glyphs）
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_UNDERLINE_RE = re.compile(r"(_{2,}|＿{2,})")
_DASH_RE = re.compile(r"(-{3,}|－{3,}|—{2,}|–{2,}|─{2,}|━{2,})")


def placeholder_detector(doc_text: str, context_chars: int = 20, max_results: int = 200) -> Dict[str, Any]:
    """Detect placeholders in doc_text.

    Args:
        doc_text: Document plain text.
        context_chars: Context characters before/after each placeholder.
        max_results: Maximum number of placeholders returned.

    Returns:
        {
          "placeholders": [
            {
              "kind": "paren|bracket|underline|dash",
              "question_id": "1",
              "position": {"start": 123, "end": 124},
              "placeholder_text": "（ ）",
              "context_before": "...",
              "context_after": "..."
            }
          ],
          "total_count": 12,
          "kind_counts": {"paren": 3, "bracket": 1, "underline": 6, "dash": 2}
        }
    """
    text = str(doc_text or "")
    if not text.strip():
        return {"placeholders": [], "total_count": 0, "kind_counts": {}}

    context_chars = max(0, int(context_chars or 0))
    max_results = max(1, int(max_results or 0))

    placeholders: List[Dict[str, Any]] = []
    occupied: List[Tuple[int, int]] = []

    def _is_overlapping(span: Tuple[int, int]) -> bool:
        s0, e0 = span
        for s1, e1 in occupied:
            if s0 < e1 and e0 > s1:
                return True
        return False

    def _push(
        *,
        kind: str,
        start: int,
        end: int,
        placeholder_text: str,
    ) -> None:
        if len(placeholders) >= max_results:
            return
        span = (int(start), int(end))
        if span[1] <= span[0]:
            return
        if _is_overlapping(span):
            return
        before = text[max(0, span[0] - 80) : span[0]]
        qid = _find_question_id(before)
        placeholders.append(
            {
                "kind": kind,
                "question_id": qid,
                "position": {"start": span[0], "end": span[1]},
                "placeholder_text": placeholder_text,
                "context_before": text[max(0, span[0] - context_chars) : span[0]],
                "context_after": text[span[1] : span[1] + context_chars],
            }
        )
        occupied.append(span)

    # 1) Parentheses/brackets slots first (so we don't double-count inner underlines).
    for open_ch, close_ch, kind in (
        ("（", "）", "paren"),
        ("(", ")", "paren"),
        ("[", "]", "bracket"),
        ("【", "】", "bracket"),
    ):
        for inner_start, inner_end, raw in _iter_pair_slots(text, open_ch, close_ch):
            _push(kind=kind, start=inner_start, end=inner_end, placeholder_text=raw)
            if len(placeholders) >= max_results:
                break
        if len(placeholders) >= max_results:
            break

    # 2) Underlines.
    if len(placeholders) < max_results:
        for m in _UNDERLINE_RE.finditer(text):
            _push(kind="underline", start=m.start(), end=m.end(), placeholder_text=m.group(0))
            if len(placeholders) >= max_results:
                break

    # 3) Dashes.
    if len(placeholders) < max_results:
        for m in _DASH_RE.finditer(text):
            _push(kind="dash", start=m.start(), end=m.end(), placeholder_text=m.group(0))
            if len(placeholders) >= max_results:
                break

    kind_counts: Dict[str, int] = {}
    for item in placeholders:
        k = str(item.get("kind") or "")
        if not k:
            continue
        kind_counts[k] = int(kind_counts.get(k, 0)) + 1

    return {
        "placeholders": placeholders,
        "total_count": len(placeholders),
        "kind_counts": kind_counts,
    }


def _iter_pair_slots(text: str, open_ch: str, close_ch: str) -> List[Tuple[int, int, str]]:
    """Iterate likely answer slots like '（ ）' and return (inner_start, inner_end, raw_text)."""
    out: List[Tuple[int, int, str]] = []
    s = str(text or "")
    if not s:
        return out

    max_inner_len = 24
    idx = 0
    while True:
        i = s.find(open_ch, idx)
        if i < 0:
            break
        j = s.find(close_ch, i + 1)
        if j < 0:
            idx = i + 1
            continue
        if (j - i) > max_inner_len:
            idx = i + 1
            continue
        inner = s[i + 1 : j]
        if _is_likely_slot_inner(inner):
            out.append((i + 1, j, s[i : j + 1]))
        idx = j + 1
    return out


def _is_likely_slot_inner(inner: str) -> bool:
    s = str(inner or "")
    if not s.strip():
        return True
    # Common blank fillers inside parentheses/brackets: underscore/dashes/spaces.
    return bool(re.fullmatch(r"[\s_＿\-－—–─━]{1,24}", s))


def _find_question_id(text_before: str) -> str:
    """Best-effort: find the nearest question id before a placeholder."""
    s = str(text_before or "")
    if not s.strip():
        return ""

    patterns = [
        r"第\s*(\d+)\s*[题问]",  # 第1题 / 第1问
        r"(\d+)\s*[、.．]",  # 1、 / 1. / 1．
        r"\((\d+)\)",  # (1)
        r"（(\d+)）",  # （1）
        r"(\d+)\)",  # 1)
        r"(\d+)）",  # 1）
    ]

    for pat in patterns:
        matches = list(re.finditer(pat, s))
        if matches:
            return str(matches[-1].group(1)).strip()
    return ""

