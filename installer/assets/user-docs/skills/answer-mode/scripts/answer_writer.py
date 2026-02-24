"""Answer-mode Plan writer.

This tool generates a minimal `ah32.plan.v1` payload for `answer_mode_apply`.

Design goal:
- Keep Plan generation deterministic and small.
- Avoid embedding raw document text in the plan (the frontend macro locates placeholders).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


_ID_SAFE_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,64}$")


def answer_writer(
    answers: Optional[List[Dict[str, Any]]] = None,
    block_id: str = "ah32_answer_mode",
    strict: bool = True,
    search_window_chars: int = 520,
    backup: Optional[bool] = None,
) -> Dict[str, Any]:
    """Build a runnable Plan JSON for Answer Mode.

    Args:
        answers: [{"q":"1","answer":"A"}, ...]
        block_id: Stable idempotency key; keep it stable (no random/date).
        strict: Fail the whole op if any question fails.
        search_window_chars: Placeholder search window after question anchor.
        backup: Whether to persist a rollback point.

    Returns:
        Plan JSON object (dict) with a single action: answer_mode_apply.
    """
    items_in = answers if isinstance(answers, list) else []
    normalized: List[Dict[str, str]] = []
    for item in items_in:
        if not isinstance(item, dict):
            continue
        q = str(item.get("q") or item.get("no") or item.get("question") or item.get("id") or "").strip()
        if not q:
            continue
        a = ""
        try:
            a = str(
                item.get("answer")
                if item.get("answer") is not None
                else (item.get("a") if item.get("a") is not None else (item.get("text") or ""))
            )
        except Exception:
            a = ""
        a = str(a or "").strip()
        normalized.append({"q": q, "answer": a})

    if not normalized:
        raise ValueError("answer_writer: answers is empty")

    bid = str(block_id or "").strip() or "ah32_answer_mode"
    if not _ID_SAFE_RE.match(bid):
        # Sanitize best-effort (keep deterministic).
        bid = re.sub(r"[^a-zA-Z0-9_\-:.]", "_", bid)[:64] or "ah32_answer_mode"

    search_window_chars = int(search_window_chars or 520)
    if search_window_chars < 120:
        search_window_chars = 120
    if search_window_chars > 4000:
        search_window_chars = 4000

    action: Dict[str, Any] = {
        "id": "answer_mode_apply_0",
        "title": "Answer Mode Apply",
        "op": "answer_mode_apply",
        "block_id": bid,
        "answers": normalized,
        "strict": bool(strict),
        "search_window_chars": search_window_chars,
    }
    if backup is not None:
        action["backup"] = bool(backup)

    return {
        "schema_version": "ah32.plan.v1",
        "host_app": "wps",
        "actions": [action],
    }

