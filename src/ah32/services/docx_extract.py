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

_DOC_SNAPSHOT_ID_KEYS = (
    "doc_snapshot_id",
    "docSnapshotId",
    "doc_snapshot",
    "docSnapshot",
)


def _extract_doc_snapshot_id(frontend_context: Optional[dict]) -> str:
    try:
        if not isinstance(frontend_context, dict):
            return ""
        for k in _DOC_SNAPSHOT_ID_KEYS:
            v = frontend_context.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, dict):
                sid = v.get("snapshot_id") or v.get("snapshotId") or v.get("id")
                if isinstance(sid, str) and sid.strip():
                    return sid.strip()
    except Exception:
        logger.debug("[docx_extract] extract doc_snapshot_id failed (ignored)", exc_info=True)
    return ""


def _doc_snapshot_extract_max_bytes() -> int:
    # Keep conservative by default, but allow larger docs when explicitly configured.
    try:
        v = int(os.getenv("AH32_DOC_SNAPSHOT_EXTRACT_MAX_BYTES") or "50000000")
        return max(1_000_000, min(v, 500_000_000))
    except Exception:
        return 50_000_000


def _doc_snapshot_fulltext_max_chars() -> int:
    # Prevent pathological memory blow-ups when extracting full text from large snapshots.
    try:
        v = int(os.getenv("AH32_DOC_SNAPSHOT_FULLTEXT_MAX_CHARS") or "800000")
        return max(50_000, min(v, 5_000_000))
    except Exception:
        return 800_000


def _maybe_read_snapshot_extracted_text(snapshot_id: str) -> str:
    sid = str(snapshot_id or "").strip()
    if not sid:
        return ""
    try:
        from ah32.doc_snapshots import get_doc_snapshot_store

        store = get_doc_snapshot_store()
        p = store.root_dir / sid / "extracted_text.txt"
        if not p.exists():
            return ""
        # Bound by policy (avoid huge prompt payloads).
        return p.read_text(encoding="utf-8")[: _doc_snapshot_fulltext_max_chars()]
    except Exception:
        logger.debug("[docx_extract] read snapshot extracted_text failed (ignored)", exc_info=True)
        return ""


def _maybe_extract_docx_from_snapshot(snapshot_id: str, *, max_chars: int) -> str:
    sid = str(snapshot_id or "").strip()
    if not sid:
        return ""
    try:
        from ah32.doc_snapshots import get_doc_snapshot_store

        store = get_doc_snapshot_store()
        p = store.get_doc_file_path(sid)
        if not p:
            return ""
        return extract_docx_text(
            str(p),
            max_chars=max_chars,
            max_bytes=_doc_snapshot_extract_max_bytes(),
        )
    except Exception:
        logger.debug("[docx_extract] extract snapshot docx failed (ignored)", exc_info=True)
        return ""


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

            # v1 doc snapshot: prefer the uploaded snapshot over local path probing.
            sid = _extract_doc_snapshot_id(frontend_context)
            if sid:
                txt = _maybe_read_snapshot_extracted_text(sid)
                if txt:
                    return txt
                # For "full text", still cap to avoid memory blow-ups.
                snap_text = _maybe_extract_docx_from_snapshot(
                    sid,
                    max_chars=_doc_snapshot_fulltext_max_chars(),
                )
                if snap_text:
                    return snap_text

        active = (frontend_context or {}).get("activeDocument") or {}
        p = (active.get("fullPath") or active.get("path") or "").strip()
        # max_chars<=0 => no cap (caller expects full).
        return extract_docx_text(p, max_chars=0)
    except Exception:
        logger.warning(
            "[docx_extract] maybe_extract_active_doc_text_full failed (ignored)",
            exc_info=True,
        )
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

            sid = _extract_doc_snapshot_id(frontend_context)
            if sid:
                txt = _maybe_read_snapshot_extracted_text(sid)
                if txt:
                    return _cap_text(txt, max_chars=max_chars)
                snap_text = _maybe_extract_docx_from_snapshot(sid, max_chars=max_chars)
                if snap_text:
                    return snap_text

        active = (frontend_context or {}).get("activeDocument") or {}
        p = (active.get("fullPath") or active.get("path") or "").strip()
        return extract_docx_text(p, max_chars=max_chars)
    except Exception:
        logger.warning("[docx_extract] maybe_extract_active_docx failed (ignored)", exc_info=True)
        return ""
