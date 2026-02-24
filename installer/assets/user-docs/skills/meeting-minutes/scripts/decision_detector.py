"""Meeting minutes decision detector.

Goal:
- Detect decision statements from chat logs by keyword patterns.

Notes:
- This tool is intentionally simple and deterministic; it does not try to "summarize".
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


_DECISION_RX = re.compile(
    r"(?:^|[\s:：])(?:决议|决定|结论|确认|同意|通过|批准|定稿|最终|统一|采用|采纳)(?:[\s:：]|$)"
)


def decision_detector(
    doc_text: str = "",
    max_results: int = 80,
) -> Dict[str, Any]:
    """Detect decisions from chat logs.

    Args:
        doc_text: Chat text.
        max_results: Safety cap.

    Returns:
        {
          "decisions": [{"index": 1, "speaker": "张三", "timestamp": "10:05", "text": "..."}],
          "total": 1
        }
    """
    raw = str(doc_text or "")
    if not raw.strip():
        return {"decisions": [], "total": 0}

    max_results = max(1, int(max_results or 0))

    decisions: List[Dict[str, Any]] = []
    current_speaker = ""
    current_ts = ""

    for line in raw.splitlines():
        ln = str(line or "").rstrip()
        if not ln.strip():
            continue

        parsed = _parse_line_simple(ln)
        if parsed is not None:
            current_speaker = parsed.get("speaker") or current_speaker
            current_ts = parsed.get("timestamp") or current_ts
            text = parsed.get("text") or ""
        else:
            text = ln.strip()

        if not text:
            continue

        if not _DECISION_RX.search(text):
            continue

        decisions.append(
            {
                "index": len(decisions) + 1,
                "speaker": current_speaker,
                "timestamp": current_ts,
                "text": _extract_decision_text(text),
            }
        )
        if len(decisions) >= max_results:
            break

    return {"decisions": decisions, "total": len(decisions)}


_LINE_RX = re.compile(
    r"^\s*(?:\[(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?P<speaker>[^:：]{1,40})[:：]\s*(?P<text>.+?)\s*$"
)


def _parse_line_simple(line: str) -> Optional[Dict[str, str]]:
    m = _LINE_RX.match(line)
    if not m:
        return None
    speaker = str(m.group("speaker") or "").strip()
    speaker = re.sub(r"[（(][^）)]{0,20}[）)]\s*$", "", speaker).strip()
    if not speaker:
        return None
    ts = str(m.group("time") or "").strip()
    text = str(m.group("text") or "").strip()
    return {"speaker": speaker[:40], "timestamp": ts, "text": text}


def _extract_decision_text(text: str) -> str:
    s = str(text or "").strip()
    # Strip leading "决定/结论/确认:" prefix when present.
    m = re.match(r"^(?:决议|决定|结论|确认|同意|通过|批准|定稿|最终|统一|采用|采纳)\s*[:：]\s*(.+)$", s)
    if m:
        return m.group(1).strip()
    return s

