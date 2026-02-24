from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .project_rag_index import ProjectContext, derive_project_context


DEFAULT_MIN_NON_WS_CHARS = 500
DEFAULT_MAX_CHARS = 200_000


def clean_extracted_text(text: str) -> str:
    s = str(text or "")
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def non_whitespace_len(text: str) -> int:
    return len(re.sub(r"\s+", "", str(text or "")))


def apply_quality_gate(text: str, *, min_non_ws_chars: int = DEFAULT_MIN_NON_WS_CHARS) -> bool:
    return non_whitespace_len(text) >= int(min_non_ws_chars or 0)


def truncate_text(text: str, *, max_chars: int = DEFAULT_MAX_CHARS) -> tuple[str, int, bool]:
    s = str(text or "")
    original = len(s)
    limit = int(max_chars or 0)
    if limit > 0 and len(s) > limit:
        return s[:limit], original, True
    return s, original, False


@dataclass(frozen=True)
class ScopeDecision:
    scope_used: str  # global|project
    project_context: Optional[ProjectContext]
    warning: Optional[str] = None  # e.g. "project_context_missing"


def decide_scope(
    *,
    requested_scope: str | None,
    context_document_path: str | None,
) -> ScopeDecision:
    raw_scope = str(requested_scope or "").strip().lower()
    ctx = derive_project_context(context_document_path or "") if context_document_path else None

    if not raw_scope:
        # Default: prefer project only when context can be derived.
        if ctx:
            return ScopeDecision(scope_used="project", project_context=ctx, warning=None)
        return ScopeDecision(scope_used="global", project_context=None, warning=None)

    if raw_scope not in ("global", "project"):
        raise ValueError("scope must be 'global' or 'project'")

    if raw_scope == "global":
        return ScopeDecision(scope_used="global", project_context=None, warning=None)

    # raw_scope == "project"
    if ctx:
        return ScopeDecision(scope_used="project", project_context=ctx, warning=None)
    return ScopeDecision(scope_used="global", project_context=None, warning="project_context_missing")

