"""Answer-mode Position Calculator.

This tool is a deterministic helper for Answer Mode writeback:
- Locate question anchors by question id candidates (e.g., "1、", "第1题", "（1）").
- Locate the nearest placeholder after the anchor within a search window:
  parentheses/brackets slot, underline blanks, dash blanks.
- Detect existing AH32 markers to support idempotent updates.

Note:
- In the AH32 runtime, `doc_text` can be auto-injected from the active document
  (to avoid re-sending large text in tool arguments).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_UNDERLINE_RE = re.compile(r"(_{2,}|＿{2,})")
_DASH_RE = re.compile(r"(-{3,}|－{3,}|—{2,}|–{2,}|─{2,}|━{2,})")


def position_calculator(
    doc_text: str = "",
    answers: Optional[List[Dict[str, Any]]] = None,
    block_id: str = "ah32_answer_mode",
    search_window_chars: int = 520,
    context_chars: int = 16,
    max_results: int = 2000,
) -> Dict[str, Any]:
    """Calculate per-question positions for Answer Mode writeback.

    Args:
        doc_text: Plain text of the active document (can be auto-injected by runtime).
        answers: Answer items: [{"q":"1","answer":"A"}, ...]
        block_id: Stable id used to build marker tags.
        search_window_chars: Search window after the anchor.
        context_chars: Context around the slot for debugging.
        max_results: Safety cap for returned items.

    Returns:
        {
          "items": [
            {
              "q": "1",
              "anchor": {"start": 12, "end": 14, "matched": "1、"},
              "mode": "update|insert|failed",
              "reason": "..."?,
              "marker": {"id": "ah32_answer_mode:ans:1", "start_tag": "...", "end_tag": "..."},
              "update_range": {"start": 123, "end": 128}?,
              "slot": {"kind": "paren|bracket|underline|dash", "start": 200, "end": 206, "placeholder": "____"}?
            }
          ],
          "total": 2,
          "failed": 0
        }
    """
    text = str(doc_text or "")
    items_in = answers if isinstance(answers, list) else []
    search_window_chars = max(120, min(4000, int(search_window_chars or 520)))
    context_chars = max(0, int(context_chars or 0))
    max_results = max(1, int(max_results or 0))

    out: List[Dict[str, Any]] = []
    failed = 0

    from_pos = 0
    for raw in items_in:
        if len(out) >= max_results:
            break
        q = ""
        try:
            if isinstance(raw, dict):
                q = str(raw.get("q") or raw.get("no") or raw.get("question") or raw.get("id") or "")
            else:
                q = str(raw or "")
        except Exception:
            q = ""
        q = q.strip()
        if not q:
            continue

        marker_id = _answer_marker_id(block_id, q)
        start_tag = _tag(marker_id, "START")
        end_tag = _tag(marker_id, "END")

        anchor = _find_question_anchor(text, q, start_at=from_pos)
        if anchor is None:
            failed += 1
            out.append(
                {
                    "q": q,
                    "mode": "failed",
                    "reason": "question_not_found",
                    "marker": {"id": marker_id, "start_tag": start_tag, "end_tag": end_tag},
                }
            )
            continue

        from_pos = anchor["end"]

        # Idempotent update: update between existing markers.
        start_idx = text.find(start_tag, anchor["end"])
        if start_idx >= 0:
            end_idx = text.find(end_tag, start_idx + len(start_tag))
            if end_idx < 0:
                failed += 1
                out.append(
                    {
                        "q": q,
                        "anchor": anchor,
                        "mode": "failed",
                        "reason": "marker_end_not_found",
                        "marker": {"id": marker_id, "start_tag": start_tag, "end_tag": end_tag},
                    }
                )
                continue
            inner_start = start_idx + len(start_tag)
            inner_end = end_idx
            out.append(
                {
                    "q": q,
                    "anchor": anchor,
                    "mode": "update",
                    "marker": {"id": marker_id, "start_tag": start_tag, "end_tag": end_tag},
                    "update_range": {"start": inner_start, "end": inner_end},
                    "context": _context(text, inner_start, inner_end, context_chars),
                }
            )
            continue

        # New insert: find the nearest placeholder slot after anchor.
        win_start = anchor["end"]
        win_end = min(len(text), win_start + search_window_chars)
        slot = _find_answer_slot(text[win_start:win_end])
        if slot is None:
            failed += 1
            out.append(
                {
                    "q": q,
                    "anchor": anchor,
                    "mode": "failed",
                    "reason": "placeholder_not_found",
                    "marker": {"id": marker_id, "start_tag": start_tag, "end_tag": end_tag},
                }
            )
            continue

        slot_start = win_start + int(slot["start"])
        slot_end = win_start + int(slot["end"])
        out.append(
            {
                "q": q,
                "anchor": anchor,
                "mode": "insert",
                "marker": {"id": marker_id, "start_tag": start_tag, "end_tag": end_tag},
                "slot": {
                    "kind": slot["kind"],
                    "start": slot_start,
                    "end": slot_end,
                    "placeholder": text[slot_start:slot_end],
                },
                "context": _context(text, slot_start, slot_end, context_chars),
            }
        )
        from_pos = max(from_pos, slot_end)

    return {"items": out, "total": len(out), "failed": failed, "search_window_chars": search_window_chars}


def _context(text: str, start: int, end: int, window: int) -> Dict[str, str]:
    if window <= 0:
        return {"before": "", "after": ""}
    left = max(0, int(start) - window)
    right = min(len(text), int(end) + window)
    return {"before": text[left:int(start)], "after": text[int(end):right]}


def _tag(marker_id: str, kind: str) -> str:
    return f"[[AH32:{marker_id}:{kind}]]"


def _sanitize_id(s: str, *, max_len: int) -> str:
    t = str(s or "").strip()
    if not t:
        return ""
    t = re.sub(r"[^a-zA-Z0-9_\-:.]", "_", t)
    if len(t) > max_len:
        t = t[:max_len]
    return t


def _answer_marker_id(block_id: str, qid: str) -> str:
    bid = _sanitize_id(block_id or "ah32_auto", max_len=32) or "ah32_auto"
    q = _sanitize_id(qid, max_len=24) or "q"
    return f"{bid}:ans:{q}"


def _build_question_candidates(q: str) -> List[str]:
    base = str(q or "").strip()
    if not base:
        return []
    cands: List[str] = []
    cands.append(base)
    if re.fullmatch(r"[0-9]+", base):
        cands.extend(
            [
                f"第{base}题",
                f"第{base}小题",
                f"{base}、",
                f"{base}.",
                f"{base}．",
                f"{base})",
                f"{base}）",
                f"({base})",
                f"（{base}）",
            ]
        )
    # De-dup preserving order.
    seen = set()
    uniq: List[str] = []
    for x in cands:
        t = str(x or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        uniq.append(t)
    return uniq


def _find_question_anchor(text: str, q: str, *, start_at: int = 0) -> Optional[Dict[str, Any]]:
    s = str(text or "")
    start_at = max(0, int(start_at or 0))
    for cand in _build_question_candidates(q):
        idx = s.find(cand, start_at)
        if idx >= 0:
            return {"start": idx, "end": idx + len(cand), "matched": cand}
    return None


def _strip_spaces(s: str) -> str:
    try:
        return re.sub(r"\s+", "", str(s or ""))
    except Exception:
        return str(s or "")


def _is_likely_answer_slot_inner(inner: str) -> bool:
    t = _strip_spaces(inner)
    if not t:
        return True
    if "[[AH32:" in t:
        return True
    if re.fullmatch(r"_+", t) or re.fullmatch(r"＿+", t):
        return True
    if re.fullmatch(r"[-－—–─━]+", t):
        return True
    if re.fullmatch(r"[A-H]", t):
        return True
    if re.fullmatch(r"(?:√|×|对|错|正确|错误)", t):
        return True
    if re.fullmatch(r"[0-9]+", t):
        return False
    if re.search(r"[\u4e00-\u9fff]", t):
        return False
    return len(t) <= 2


def _find_pair_slot(text: str, open_ch: str, close_ch: str, *, kind: str) -> Optional[Dict[str, Any]]:
    s = str(text or "")
    idx = 0
    while idx < len(s):
        i = s.find(open_ch, idx)
        if i < 0:
            break
        j = s.find(close_ch, i + 1)
        if j < 0:
            break
        if (j - i) > 24:
            idx = i + 1
            continue
        inner = s[i + 1 : j]
        if _is_likely_answer_slot_inner(inner):
            return {"kind": kind, "start": i + 1, "end": j}
        idx = j + 1
    return None


def _find_underline_slot(text: str) -> Optional[Dict[str, Any]]:
    s = str(text or "")
    m = _UNDERLINE_RE.search(s)
    if not m:
        return None
    return {"kind": "underline", "start": m.start(), "end": m.end()}


def _find_dash_slot(text: str) -> Optional[Dict[str, Any]]:
    s = str(text or "")
    m = _DASH_RE.search(s)
    if not m:
        return None
    return {"kind": "dash", "start": m.start(), "end": m.end()}


def _find_answer_slot(text: str) -> Optional[Dict[str, Any]]:
    s = str(text or "")

    # Prefer empty-ish parentheses first, then brackets, then underline/dash blanks.
    for open_ch, close_ch, kind in (
        ("（", "）", "paren"),
        ("(", ")", "paren"),
        ("【", "】", "bracket"),
        ("[", "]", "bracket"),
    ):
        p = _find_pair_slot(s, open_ch, close_ch, kind=kind)
        if p:
            return p

    u = _find_underline_slot(s)
    if u:
        return u

    d = _find_dash_slot(s)
    if d:
        return d

    return None

