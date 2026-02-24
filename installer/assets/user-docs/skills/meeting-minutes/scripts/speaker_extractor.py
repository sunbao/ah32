"""Meeting minutes speaker extractor.

Goal:
- Parse chat logs into structured messages (speaker + timestamp + text).

Notes:
- `doc_text` can be auto-injected from the active document by AH32 runtime.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_PATTERNS: List[re.Pattern[str]] = [
    # 2026-02-13 10:05 张三: 内容
    re.compile(
        r"^\s*(?P<date>\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\s+(?P<speaker>[^:：]{1,40})[:：]\s*(?P<text>.+?)\s*$"
    ),
    # [10:05] 张三：内容
    re.compile(
        r"^\s*\[?(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?P<speaker>[^:：]{1,40})[:：]\s*(?P<text>.+?)\s*$"
    ),
    # 张三: 内容
    re.compile(r"^\s*(?P<speaker>[^:：]{1,40})[:：]\s*(?P<text>.+?)\s*$"),
]


def speaker_extractor(
    doc_text: str = "",
    max_messages: int = 400,
    merge_continuations: bool = True,
) -> Dict[str, Any]:
    """Extract speakers/messages from chat logs.

    Args:
        doc_text: Chat log text.
        max_messages: Safety cap.
        merge_continuations: Merge lines without speaker prefix into previous message.

    Returns:
        {
          "messages":[{"index":1,"speaker":"张三","timestamp":"10:05","text":"..."}],
          "speakers":[{"name":"张三","count":10}],
          "total_messages": 10,
          "unparsed_lines": 2
        }
    """
    raw = str(doc_text or "")
    if not raw.strip():
        return {"messages": [], "speakers": [], "total_messages": 0, "unparsed_lines": 0}

    max_messages = max(1, int(max_messages or 0))
    merge_continuations = bool(merge_continuations)

    messages: List[Dict[str, Any]] = []
    unparsed = 0

    for line in raw.splitlines():
        ln = str(line or "").rstrip()
        if not ln.strip():
            continue

        parsed = _parse_line(ln)
        if parsed is None:
            if merge_continuations and messages:
                messages[-1]["text"] = (str(messages[-1].get("text") or "") + "\n" + ln.strip()).strip()
            else:
                unparsed += 1
            continue

        if len(messages) >= max_messages:
            break

        messages.append(
            {
                "index": len(messages) + 1,
                "speaker": parsed["speaker"],
                "timestamp": parsed.get("timestamp") or "",
                "text": parsed["text"],
            }
        )

    # Speaker stats
    counts: Dict[str, int] = {}
    for m in messages:
        name = str(m.get("speaker") or "").strip()
        if not name:
            continue
        counts[name] = int(counts.get(name, 0)) + 1
    speakers = [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    return {
        "messages": messages,
        "speakers": speakers,
        "total_messages": len(messages),
        "unparsed_lines": unparsed,
    }


def _normalize_speaker(name: str) -> str:
    s = str(name or "").strip()
    if not s:
        return ""
    # Remove role suffix like 张三（PM）
    s = re.sub(r"[（(][^）)]{0,20}[）)]\s*$", "", s).strip()
    return s[:40]


def _parse_line(line: str) -> Optional[Dict[str, str]]:
    for rx in _PATTERNS:
        m = rx.match(line)
        if not m:
            continue
        speaker = _normalize_speaker(m.group("speaker"))
        if not speaker:
            return None
        text = str(m.group("text") or "").strip()
        ts = ""
        if "time" in m.groupdict() and m.group("time"):
            ts = str(m.group("time")).strip()
        if "date" in m.groupdict() and m.group("date") and ts:
            ts = f"{m.group('date').strip()} {ts}"
        return {"speaker": speaker, "timestamp": ts, "text": text}
    return None

