"""Load and scan local RAG library data under `data/rag/` (repo/runtime).

This module is intentionally lightweight (no vector DB dependency). It is used for:
- Reading structured policy JSON files.
- Loading the sensitive words list and performing simple substring checks.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ah32.config import settings
from ah32.runtime_paths import runtime_root

logger = logging.getLogger(__name__)


def get_rag_data_dir() -> Path:
    """Return the preferred RAG data dir.

    Preference:
    0) `AH32_RAG_DATA_DIR` when set.
    1) `<runtime_root>/data/rag` when it is writable (create if missing).
    2) `<storage_root>/rag_data` fallback (writable for packaged builds / read-only runtimes).
    """
    configured = str(os.environ.get("AH32_RAG_DATA_DIR") or "").strip()
    if configured:
        p = Path(configured).expanduser()
        if not p.is_absolute():
            p = (runtime_root() / p).resolve()
        try:
            p.mkdir(parents=True, exist_ok=True)
            test = p / ".write_test"
            test.write_text("ok", encoding="utf-8")
            test.unlink(missing_ok=True)
            return p
        except Exception as e:
            logger.info(
                "[rag_library] configured data dir not writable, fallback: %s err=%s",
                p,
                e,
                exc_info=True,
            )

    primary = runtime_root() / "data" / "rag"
    try:
        primary.mkdir(parents=True, exist_ok=True)
        test = primary / ".write_test"
        test.write_text("ok", encoding="utf-8")
        test.unlink(missing_ok=True)
        return primary
    except Exception as e:
        logger.info(
            "[rag_library] data dir not writable, fallback to storage: %s err=%s",
            primary,
            e,
            exc_info=True,
        )
        fallback = settings.storage_root / "rag_data"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def iter_policy_files() -> Iterable[Path]:
    root = get_rag_data_dir() / "policies"
    if not root.exists():
        return []
    return sorted([p for p in root.glob("*.json") if p.is_file() and p.name.lower() != "readme.md"])


def load_policies(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for path in iter_policy_files():
        try:
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            if not isinstance(raw, dict):
                continue
            raw.setdefault("file_name", path.name)
            out.append(raw)
        except Exception as e:
            logger.warning("[rag_library] load policy failed: %s err=%s", path, e, exc_info=True)
            continue
        if limit is not None and len(out) >= int(limit):
            break
    return out


_SENSITIVE_HEADER_RE = re.compile(r"^##\s*(.+?)\s*$")


def load_sensitive_words(path: Optional[Path] = None) -> Dict[str, List[str]]:
    """Load sensitive words list grouped by category."""
    p = Path(path) if path else (get_rag_data_dir() / "sensitive_words" / "sensitive_words.txt")
    if not p.exists():
        return {}

    current = "未分类"
    out: Dict[str, List[str]] = {current: []}
    try:
        for raw_line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            m = _SENSITIVE_HEADER_RE.match(line)
            if m:
                current = m.group(1).strip() or "未分类"
                out.setdefault(current, [])
                continue
            out.setdefault(current, []).append(line)
    except Exception as e:
        logger.warning("[rag_library] load sensitive words failed: %s err=%s", p, e, exc_info=True)
        return {}

    # De-dupe while keeping order.
    for k, words in list(out.items()):
        seen: set[str] = set()
        uniq: List[str] = []
        for w in words:
            w = str(w or "").strip()
            if not w or w in seen:
                continue
            seen.add(w)
            uniq.append(w)
        out[k] = uniq
    return out


def detect_sensitive_words(
    text: str,
    words_by_category: Dict[str, List[str]],
    *,
    max_hits: int = 50,
) -> List[Dict[str, Any]]:
    """Naive substring-based sensitive word detection.

    Returns hits with:
    - category
    - word
    - index (first occurrence)
    """
    content = str(text or "")
    if not content or not words_by_category:
        return []

    hits: List[Dict[str, Any]] = []
    for category, words in (words_by_category or {}).items():
        for w in words or []:
            if not w:
                continue
            idx = content.find(w)
            if idx < 0:
                continue
            hits.append({"category": str(category), "word": str(w), "index": int(idx)})
            if len(hits) >= max_hits:
                return hits
    return hits
