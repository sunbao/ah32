"""Policy terminology checker (deterministic, best-effort).

Goal:
- Extract defined terms (e.g., "XXX（以下简称“YYY”）") and check consistency.
- Highlight terms that are frequently used but never defined.

Notes:
- Natural language definition/alias detection is fuzzy; we focus on obvious cases.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_DEF_RX = re.compile(
    r"(?P<lemma>[\u4e00-\u9fffA-Za-z0-9]{2,40})\s*[（(]\s*(?:以下(?:简称|以下简称)|简称)\s*[“\"](?P<abbr>[^”\"\n]{1,24})[”\"]\s*[）)]"
)
_QUOTE_RX = re.compile(r"[“\"](?P<term>[^”\"\n]{2,24})[”\"]")
_ACRONYM_RX = re.compile(r"\b[A-Z]{2,10}\b")


def terminology_checker(doc_text: str = "", max_terms: int = 60, max_issues: int = 80) -> Dict[str, Any]:
    """Check terminology consistency.

    Args:
        doc_text: Policy text.
        max_terms: Return at most N terms.
        max_issues: Safety cap.

    Returns:
        {
          "definitions":[{"lemma":"中华人民共和国","abbr":"中国","position":123}],
          "top_terms":[{"term":"中国","count":5,"defined":true}],
          "issues":[{"issue":"undefined_term","term":"XXX","count":3,"first_pos":120}]
        }
    """
    text = str(doc_text or "")
    if not text.strip():
        return {"definitions": [], "top_terms": [], "issues": []}

    max_terms = max(1, int(max_terms or 0))
    max_issues = max(1, int(max_issues or 0))

    definitions: List[Dict[str, Any]] = []
    defined: Dict[str, Dict[str, Any]] = {}

    for m in _DEF_RX.finditer(text):
        lemma = str(m.group("lemma") or "").strip()
        abbr = str(m.group("abbr") or "").strip()
        if not lemma or not abbr:
            continue
        rec = {"lemma": lemma, "abbr": abbr, "position": m.start()}
        definitions.append(rec)
        defined.setdefault(abbr, rec)

    # Count quoted terms.
    counts: Dict[str, int] = {}
    first_pos: Dict[str, int] = {}
    for m in _QUOTE_RX.finditer(text):
        term = str(m.group("term") or "").strip()
        if not term:
            continue
        counts[term] = int(counts.get(term, 0)) + 1
        first_pos.setdefault(term, m.start())

    # Count acronyms.
    for m in _ACRONYM_RX.finditer(text):
        term = str(m.group(0) or "").strip()
        if not term:
            continue
        counts[term] = int(counts.get(term, 0)) + 1
        first_pos.setdefault(term, m.start())

    # Build top terms.
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:max_terms]
    top_terms = [
        {
            "term": k,
            "count": v,
            "defined": bool(k in defined or _is_defined_near(text, k, first_pos.get(k, 0))),
            "first_pos": int(first_pos.get(k, 0) or 0),
        }
        for k, v in top
    ]

    issues: List[Dict[str, Any]] = []
    for rec in top_terms:
        if len(issues) >= max_issues:
            break
        term = str(rec.get("term") or "")
        if not term:
            continue
        if rec.get("count", 0) < 2:
            continue
        if rec.get("defined"):
            continue
        issues.append(
            {
                "issue": "undefined_term",
                "term": term,
                "count": rec.get("count", 0),
                "first_pos": rec.get("first_pos", 0),
            }
        )

    # Defined-but-inconsistent: lemma is used frequently but abbr is also defined.
    for abbr, rec in defined.items():
        if len(issues) >= max_issues:
            break
        lemma = str(rec.get("lemma") or "")
        if not lemma:
            continue
        lemma_count = text.count(lemma)
        abbr_count = text.count(abbr)
        if lemma_count >= 3 and abbr_count >= 3:
            issues.append(
                {
                    "issue": "mixed_term_usage",
                    "lemma": lemma,
                    "abbr": abbr,
                    "lemma_count": lemma_count,
                    "abbr_count": abbr_count,
                }
            )

    return {
        "definitions": definitions[:max_terms],
        "top_terms": top_terms,
        "issues": issues[:max_issues],
    }


def _is_defined_near(text: str, term: str, pos: int) -> bool:
    if not term:
        return False
    start = max(0, int(pos) - 40)
    end = min(len(text), int(pos) + 80)
    win = text[start:end]
    # Patterns like: "X是指..." "X指..."
    rx = re.compile(re.escape(term) + r".{0,12}(?:是指|指|定义为)")
    return bool(rx.search(win))

