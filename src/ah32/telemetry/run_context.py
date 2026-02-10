from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass(frozen=True, slots=True)
class RunContext:
    """RunContext (v1).

    Minimum "三元绑定" fields:
      - doc_id/doc_key
      - session_id
      - task_id/block_id

    Additional fields are optional but recommended for bench + observability.
    """

    run_id: str = ""
    mode: str = ""  # chat|macro|bench|client|server...
    host_app: str = ""  # wps|et|wpp
    doc_id: str = ""
    doc_key: str = ""
    session_id: str = ""

    # Bench / story routing (optional)
    story_id: str = ""
    turn_id: str = ""
    case_id: str = ""

    # Chat / artifacts (optional)
    task_id: str = ""
    message_id: str = ""
    block_id: str = ""

    # Client correlation (optional)
    client_id: str = ""

    # Extra arbitrary labels (avoid putting large payloads here; use event payload).
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "run_id": self.run_id,
            "mode": self.mode,
            "host_app": self.host_app,
            "doc_id": self.doc_id,
            "doc_key": self.doc_key,
            "session_id": self.session_id,
            "story_id": self.story_id,
            "turn_id": self.turn_id,
            "case_id": self.case_id,
            "task_id": self.task_id,
            "message_id": self.message_id,
            "block_id": self.block_id,
            "client_id": self.client_id,
        }
        if self.extra:
            d["extra"] = dict(self.extra)
        # Drop empty strings to keep payload compact.
        return {k: v for k, v in d.items() if v not in ("", None, {}, [])}

    @classmethod
    def from_any(cls, v: Any) -> "RunContext":
        if isinstance(v, RunContext):
            return v
        if isinstance(v, dict):
            return cls(
                run_id=str(v.get("run_id") or v.get("runId") or ""),
                mode=str(v.get("mode") or ""),
                host_app=str(v.get("host_app") or v.get("hostApp") or ""),
                doc_id=str(v.get("doc_id") or v.get("docId") or ""),
                doc_key=str(v.get("doc_key") or v.get("docKey") or ""),
                session_id=str(v.get("session_id") or v.get("sessionId") or ""),
                story_id=str(v.get("story_id") or v.get("storyId") or ""),
                turn_id=str(v.get("turn_id") or v.get("turnId") or ""),
                case_id=str(v.get("case_id") or v.get("caseId") or ""),
                task_id=str(v.get("task_id") or v.get("taskId") or ""),
                message_id=str(v.get("message_id") or v.get("messageId") or ""),
                block_id=str(v.get("block_id") or v.get("blockId") or ""),
                client_id=str(v.get("client_id") or v.get("clientId") or ""),
                extra=dict(v.get("extra") or {}) if isinstance(v.get("extra"), dict) else {},
            )
        return cls()

