from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from ah32.config import settings
from ah32.runtime_paths import runtime_root

logger = logging.getLogger(__name__)


def _policies_dir() -> Path:
    root = runtime_root() / "data" / "rag" / "policies"
    if root.exists():
        return root
    return settings.storage_root / "rag_data" / "policies"


def _safe_date(d: Optional[str]) -> str:
    s = str(d or "").strip()
    return s if s else "0000-00-00"


def get_latest_policies(limit: int = 10) -> Dict[str, Any]:
    """Return latest policy metadata from local JSON files."""
    try:
        limit = max(1, int(limit))
        out: List[Dict[str, Any]] = []
        for path in sorted(_policies_dir().glob("*.json"), key=lambda p: p.name.lower()):
            if path.name.lower() == "readme.md":
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8") or "{}")
                if not isinstance(raw, dict):
                    continue
                out.append(
                    {
                        "policy_name": raw.get("policy_name") or path.stem,
                        "issue_date": raw.get("issue_date"),
                        "document_number": raw.get("document_number"),
                        "source_url": raw.get("source_url"),
                        "category": raw.get("category"),
                        "is_major": bool(raw.get("is_major", False)),
                        "file_name": path.name,
                    }
                )
            except Exception:
                logger.debug("[bidding-helper] parse policy json failed: %s", path, exc_info=True)
                continue

        out.sort(key=lambda x: _safe_date(x.get("issue_date")), reverse=True)
        return {"ok": True, "items": out[:limit], "total": len(out)}
    except Exception as e:
        logger.warning("[bidding-helper] get_latest_policies failed: %s", e, exc_info=True)
        return {"ok": False, "message": "读取政策库失败", "error": {"message": str(e)}}

