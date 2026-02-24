"""Policy numbering checker (deterministic).

Goal:
- Validate heading numbering continuity and hierarchy.
- Detect common mistakes: jumps, duplicates, missing parent level.

Notes:
- This is best-effort; documents often mix styles. We prioritize actionable issues.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_ARABIC_RE = re.compile(r"^\s*(\d+(?:\.\d+){0,3})\s*([、.．)]|\s)")
_ARABIC_SIMPLE_RE = re.compile(r"^\s*(\d+)\s*([、.．)]|\s)")
_CN_TOP_RE = re.compile(r"^\s*([一二三四五六七八九十百零]+)\s*[、.．]")
_CN_PAREN_RE = re.compile(r"^\s*[（(]([一二三四五六七八九十百零]+)[）)]")


_CN_NUM = {
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    "百": 100,
}


def numbering_checker(doc_text: str = "", max_issues: int = 80) -> Dict[str, Any]:
    """Check numbering hierarchy in policy documents.

    Args:
        doc_text: Policy text.
        max_issues: Safety cap.

    Returns:
        {
          "headings": [{"line": 1, "label": "1.1", "level": 2, "title": "..."}, ...],
          "issues": [{"line": 10, "label": "2.3", "issue": "jump", "expected": "2.2"}],
          "total_headings": 12,
          "total_issues": 3
        }
    """
    raw = str(doc_text or "")
    if not raw.strip():
        return {"headings": [], "issues": [], "total_headings": 0, "total_issues": 0}

    max_issues = max(1, int(max_issues or 0))

    headings: List[Dict[str, Any]] = []
    for i, line in enumerate(raw.splitlines(), start=1):
        h = _parse_heading_line(line)
        if h is None:
            continue
        label, parts, level, title = h
        headings.append({"line": i, "label": label, "parts": parts, "level": level, "title": title})

    issues: List[Dict[str, Any]] = []
    last: List[int] = []

    for h in headings:
        parts = list(h.get("parts") or [])
        level = int(h.get("level") or 0)
        if level <= 0 or not parts:
            continue

        # Missing parent level: e.g. jump from level 1 to level 3.
        if level > len(last) + 1:
            issues.append(
                {
                    "line": h["line"],
                    "label": h["label"],
                    "issue": "missing_parent_level",
                    "expected_level": len(last) + 1,
                }
            )
            if len(issues) >= max_issues:
                break

        # Align `last` length to current level.
        if level <= len(last):
            last = last[:level]
        while len(last) < level:
            last.append(0)

        num = int(parts[-1])
        prev = int(last[level - 1])
        expected = prev + 1 if prev > 0 else (1 if num != 0 else 0)

        if prev > 0 and num == prev:
            issues.append({"line": h["line"], "label": h["label"], "issue": "duplicate", "expected": f"{expected}"})
        elif prev > 0 and num < expected:
            issues.append({"line": h["line"], "label": h["label"], "issue": "non_increasing", "expected": f"{expected}"})
        elif prev > 0 and num > expected:
            issues.append(
                {
                    "line": h["line"],
                    "label": h["label"],
                    "issue": "jump",
                    "expected": f"{expected}",
                    "delta": num - expected,
                }
            )

        last[level - 1] = num
        # Reset deeper levels when a higher level changes.
        # (Already trimmed above.)

        if len(issues) >= max_issues:
            break

    # Strip internal parts to keep output compact.
    for h in headings:
        h.pop("parts", None)

    return {
        "headings": headings[:200],
        "issues": issues[:max_issues],
        "total_headings": len(headings),
        "total_issues": len(issues),
    }


def _parse_heading_line(line: str) -> Optional[Tuple[str, List[int], int, str]]:
    s = str(line or "").strip()
    if not s:
        return None

    m = _ARABIC_RE.match(s)
    if m:
        label = m.group(1).strip()
        parts = [int(x) for x in label.split(".") if x.isdigit()]
        level = len(parts)
        title = s[m.end() :].strip()
        return label, parts, level, title

    m2 = _CN_TOP_RE.match(s)
    if m2:
        cn = m2.group(1)
        n = _cn_to_int(cn)
        if n <= 0:
            return None
        label = f"{cn}、"
        parts = [n]
        level = 1
        title = s[m2.end() :].strip()
        return label, parts, level, title

    m3 = _CN_PAREN_RE.match(s)
    if m3:
        cn = m3.group(1)
        n = _cn_to_int(cn)
        if n <= 0:
            return None
        label = f"（{cn}）"
        parts = [n]
        level = 2  # treat as sub-level by default
        title = s[m3.end() :].strip()
        return label, parts, level, title

    # Fallback: "1)" style.
    m4 = _ARABIC_SIMPLE_RE.match(s)
    if m4:
        n = int(m4.group(1))
        if n <= 0:
            return None
        label = f"{n}{m4.group(2)}"
        parts = [n]
        level = 1
        title = s[m4.end() :].strip()
        return label, parts, level, title

    return None


def _cn_to_int(cn: str) -> int:
    s = str(cn or "").strip()
    if not s:
        return 0
    # Handle 1-99 commonly used in headings.
    if s == "十":
        return 10
    if "十" in s:
        parts = s.split("十", 1)
        left = parts[0]
        right = parts[1]
        tens = _CN_NUM.get(left, 1) if left else 1
        ones = _CN_NUM.get(right, 0) if right else 0
        return tens * 10 + ones
    total = 0
    for ch in s:
        if ch not in _CN_NUM:
            return 0
        total = total * 10 + _CN_NUM[ch]
    return total

