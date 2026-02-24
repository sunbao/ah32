"""Policy monitor runtime cache.

Cache location: `storage/policy_cache/` (never under `data/`).
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from ah32.config import settings

logger = logging.getLogger(__name__)


SCHEMA_VERSION = "ah32.policy_cache.v1"


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


@dataclass
class PolicyCache:
    """Disk-backed cache for policy monitoring state."""

    root_dir: Path
    cache_file: Path

    @classmethod
    def default(cls) -> "PolicyCache":
        root = settings.storage_root / "policy_cache"
        root.mkdir(parents=True, exist_ok=True)
        return cls(root_dir=root, cache_file=root / "policy_cache.json")

    def load(self) -> Dict[str, Any]:
        if not self.cache_file.exists():
            return {"schema_version": SCHEMA_VERSION, "last_checked_at": None, "items": []}
        try:
            raw = self.cache_file.read_text(encoding="utf-8") or "{}"
            data = json.loads(raw) if raw.strip() else {}
            if not isinstance(data, dict):
                return {"schema_version": SCHEMA_VERSION, "last_checked_at": None, "items": []}
            data.setdefault("schema_version", SCHEMA_VERSION)
            data.setdefault("last_checked_at", None)
            data.setdefault("items", [])
            if not isinstance(data.get("items"), list):
                data["items"] = []
            return data
        except Exception as e:
            logger.warning("[policy-cache] load failed: %s", e, exc_info=True)
            return {"schema_version": SCHEMA_VERSION, "last_checked_at": None, "items": []}

    def save(self, data: Dict[str, Any]) -> None:
        payload = dict(data or {})
        payload["schema_version"] = SCHEMA_VERSION
        payload.setdefault("last_checked_at", _now_iso())
        payload.setdefault("items", [])
        try:
            self.cache_file.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        except Exception as e:
            logger.warning("[policy-cache] save failed: %s", e, exc_info=True)

    def is_fresh(self, data: Dict[str, Any], *, ttl_hours: int) -> bool:
        ttl = max(0, int(ttl_hours))
        if ttl == 0:
            return False
        last = data.get("last_checked_at")
        if not last:
            return False
        try:
            # ISO "Z" expected.
            import datetime as _dt

            ts = str(last).replace("Z", "+00:00")
            dt = _dt.datetime.fromisoformat(ts)
            return (_dt.datetime.now(_dt.timezone.utc) - dt).total_seconds() < ttl * 3600
        except Exception:
            return False

    @staticmethod
    def known_policy_ids(data: Dict[str, Any]) -> set[str]:
        out: set[str] = set()
        for item in (data.get("items") or []):
            if not isinstance(item, dict):
                continue
            pid = str(item.get("policy_id") or "").strip()
            if pid:
                out.add(pid)
        return out

