from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from .registry import Skill, SkillRegistry


@dataclass(frozen=True)
class SkillRoutingHints:
    """Optional extra signals for skill routing.

    This keeps routing logic (message shaping) explicit and testable, while the
    underlying ranking algorithm can remain in SkillRegistry.
    """

    host: Optional[str] = None
    document_name: str = ""
    recent_user_messages: tuple[str, ...] = ()
    extra: tuple[str, ...] = ()


class SkillRouter:
    """A thin facade over SkillRegistry for dynamic skill selection."""

    def __init__(self, registry: SkillRegistry) -> None:
        self.registry = registry

    @staticmethod
    def build_query(message: str, *, hints: Optional[SkillRoutingHints] = None) -> str:
        msg = (message or "").strip()
        if not hints:
            return msg

        parts: List[str] = [msg] if msg else []
        hint_lines: List[str] = []

        doc = (hints.document_name or "").strip()
        if doc:
            hint_lines.append("doc_name: " + doc[:120])

        if hints.recent_user_messages:
            recent = [str(x or "").strip() for x in hints.recent_user_messages if str(x or "").strip()]
            if recent:
                hint_lines.append("recent_user: " + " | ".join([r[:80] for r in recent[:3]]))

        for x in (hints.extra or ()):
            xx = (str(x or "").strip())[:200]
            if xx:
                hint_lines.append(xx)

        if hint_lines:
            parts.append("\n".join(hint_lines))

        return "\n\n".join([p for p in parts if p]).strip()

    def select_for_message(
        self,
        message: str,
        *,
        embedder: Any = None,
        hints: Optional[SkillRoutingHints] = None,
        host: Optional[str] = None,
        top_k: int = 4,
        min_score: float = 0.18,
    ) -> List[Dict[str, Any]]:
        # Prefer explicit host arg; fall back to hints.host.
        resolved_host = host if host is not None else (hints.host if hints else None)
        query = self.build_query(message, hints=hints)
        return self.registry.select_for_message(
            query,
            embedder=embedder,
            host=resolved_host,
            top_k=top_k,
            min_score=min_score,
        )

    def render_for_prompt(self, selected: Optional[Iterable[Skill]] = None) -> str:
        return self.registry.render_for_prompt(selected=selected)

