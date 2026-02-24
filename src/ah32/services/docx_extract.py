"""Minimal .docx text extraction (no third-party deps).

This is used to give the LLM enough *document content* to answer tasks like
"help me solve this exam paper" where generation quality depends heavily on
reading the existing document, not just producing a new template.
"""

from __future__ import annotations

import logging
import os
import re
import zipfile
from typing import Optional

logger = logging.getLogger(__name__)


def _cap_text(s: str, *, max_chars: int) -> str:
    out = str(s or "")
    max_chars = int(max_chars or 0)
    if max_chars <= 0:
        return out
    if len(out) > max_chars:
        out = out[: max_chars - 20] + "\n...(truncated)"
    return out


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
        logger.debug("[docx_extract] stat size failed (ignored): %s", p, exc_info=True)

    try:
        with zipfile.ZipFile(p) as zf:
            xml = zf.read("word/document.xml")
    except Exception:
        logger.warning(
            "[docx_extract] read document.xml failed (ignored): %s", p, exc_info=True
        )
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

    return _cap_text(out, max_chars=max_chars)


def maybe_extract_active_doc_text_full(frontend_context: Optional[dict]) -> str:
    """Return the full active document text from frontend_context when present.

    Privacy note:
      This is intended for *ephemeral per-request* use. Callers should avoid persisting it.

    Priority:
      1) frontend_context.active_doc_text_full (preferred, full payload)
      2) frontend_context.active_doc_text (fallback, may be preview)
      3) local .docx path read (when backend can access it)
    """
    try:
        if isinstance(frontend_context, dict):
            direct_full = (
                frontend_context.get("active_doc_text_full")
                or frontend_context.get("activeDocTextFull")
                or frontend_context.get("active_document_text_full")
                or frontend_context.get("activeDocumentTextFull")
            )
            if isinstance(direct_full, str) and direct_full.strip():
                return direct_full

            direct = (
                frontend_context.get("active_doc_text")
                or frontend_context.get("activeDocText")
                or frontend_context.get("active_document_text")
                or frontend_context.get("activeDocumentText")
            )
            if isinstance(direct, str) and direct.strip():
                return direct

        active = (frontend_context or {}).get("activeDocument") or {}
        p = (active.get("fullPath") or active.get("path") or "").strip()
        # max_chars<=0 => no cap (caller expects full).
        return extract_docx_text(p, max_chars=0)
    except Exception:
        logger.warning("[docx_extract] maybe_extract_active_doc_text_full failed (ignored)", exc_info=True)
        return ""


def maybe_extract_active_docx(frontend_context: Optional[dict], *, max_chars: int = 60_000) -> str:
    """Best-effort helper: extract text based on frontend_context.

    Priority:
    1) Use frontend-provided active doc text (works for WPS/ET/WPP) when present.
    2) Fall back to reading a local .docx path for environments where the backend can access it.
    """

    try:
        if isinstance(frontend_context, dict):
            direct = (
                frontend_context.get("active_doc_text")
                or frontend_context.get("activeDocText")
                or frontend_context.get("active_document_text")
                or frontend_context.get("activeDocumentText")
            )
            if isinstance(direct, str) and direct.strip():
                return _cap_text(direct, max_chars=max_chars)

        active = (frontend_context or {}).get("activeDocument") or {}
        p = (active.get("fullPath") or active.get("path") or "").strip()
        return extract_docx_text(p, max_chars=max_chars)
    except Exception:
        logger.warning("[docx_extract] maybe_extract_active_docx failed (ignored)", exc_info=True)
        return ""
