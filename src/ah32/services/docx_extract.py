"""Minimal .docx text extraction (no third-party deps).

This is used to give the LLM enough *document content* to answer tasks like
"help me solve this exam paper" where generation quality depends heavily on
reading the existing document, not just producing a new template.
"""

from __future__ import annotations

import os
import re
import zipfile
from typing import Optional


def extract_docx_text(path: str, *, max_chars: int = 60_000, max_bytes: int = 8_000_000) -> str:
    """Extract plain text from a .docx file.

    Notes:
      - Best-effort: prefers robustness over perfect formatting fidelity.
      - Caps output size to avoid bloating prompts.
    """

    p = (path or "").strip()
    if not p or not p.lower().endswith(".docx"):
        return ""
    if not os.path.exists(p):
        return ""
    try:
        if os.path.getsize(p) > max_bytes:
            return ""
    except Exception:
        # If size can't be determined, continue best-effort.
        pass

    try:
        with zipfile.ZipFile(p) as zf:
            xml = zf.read("word/document.xml")
    except Exception:
        return ""

    # The document.xml is typically UTF-8, but be tolerant.
    s = xml.decode("utf-8", errors="ignore")

    # Preserve basic structure: tabs and paragraph breaks.
    s = re.sub(r"<w:tab[^>]*/>", "\t", s)
    s = re.sub(r"</w:p>", "\n", s)

    # Drop remaining tags.
    s = re.sub(r"<[^>]+>", "", s)

    # Unescape a few common entities.
    s = (
        s.replace("&quot;", '"')
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
    )

    # Normalize lines; keep content dense for prompting.
    out_lines = []
    for raw in s.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Collapse internal whitespace.
        line = re.sub(r"\s+", " ", line)
        out_lines.append(line)

    out = "\n".join(out_lines)
    if not out:
        return ""

    max_chars = max(0, int(max_chars or 0)) or 60_000
    if len(out) > max_chars:
        out = out[: max_chars - 20] + "\n...(truncated)"
    return out


def maybe_extract_active_docx(frontend_context: Optional[dict], *, max_chars: int = 60_000) -> str:
    """Best-effort helper: extract text based on the activeDocument path in frontend_context."""

    try:
        active = (frontend_context or {}).get("activeDocument") or {}
        p = (active.get("fullPath") or active.get("path") or "").strip()
        return extract_docx_text(p, max_chars=max_chars)
    except Exception:
        return ""

