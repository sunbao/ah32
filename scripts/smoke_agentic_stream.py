"""
Smoke test for /agentic/chat/stream SSE behavior (no WPS required).

Keep this file ASCII-only (use \\u escapes) to avoid Windows console encoding issues.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx


API = "http://127.0.0.1:5123/agentic/chat/stream"


def _read_sse_text(*, message: str, session_id: str) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
    body = {
        "message": message,
        "session_id": session_id,
        "document_name": "\u6587\u5b57\u6587\u7a3f1",  # 文字文稿1
        "frontend_context": {
            "document": {
                "id": "doc_smoke",
                "name": "\u6587\u5b57\u6587\u7a3f1",
                "fullPath": "\u6587\u5b57\u6587\u7a3f1",
                "hostApp": "wps",
            },
            "cursor": {"page": None},
            "selection": {"hasSelection": False},
        },
    }

    chunks: list[str] = []
    events: list[tuple[str, dict[str, Any]]] = []

    with httpx.Client(timeout=120) as client:
        with client.stream("POST", API, json=body, headers={"Accept": "text/event-stream"}) as r:
            r.raise_for_status()
            current_event = ""
            for line in r.iter_lines():
                if not line:
                    continue
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                    continue
                if not line.startswith("data:"):
                    continue

                raw = line.split(":", 1)[1].strip()
                try:
                    obj = json.loads(raw)
                except Exception:
                    obj = {"_raw": raw}

                t = str(obj.get("type") or current_event or "")
                if t == "content":
                    chunks.append(str(obj.get("content") or ""))
                events.append((t, obj))
                if t in ("done", "error"):
                    break

    return "".join(chunks), events


def main() -> None:
    sid = f"session_smoke_{int(time.time())}"
    cases = [
        ("\u4f60\u597d", "regular_chat"),  # 你好
        ("\u63d2\u5165\u4e00\u4e2a99\u4e58\u6cd5\u8868", "writeback_expected"),  # 插入一个99乘法表
        ("\u7ee7\u7eed\u753b99\u4e58\u6cd5\u8868", "writeback_expected"),  # 继续画99乘法表
    ]

    for msg, label in cases:
        text, events = _read_sse_text(message=msg, session_id=sid)
        has_fence = "```" in text
        has_plan = ('"schema_version"' in text) and ("ah32.plan.v1" in text)
        tail = [t for (t, _) in events if t != "content"][-8:]

        print("\\n===", label)
        print("user:", msg)
        print("assistant_len:", len(text), "has_fence:", has_fence, "has_plan:", has_plan)
        print("assistant_preview:", text[:240].replace("\\n", "\\\\n"))
        print("event_tail:", tail)


if __name__ == "__main__":
    main()

