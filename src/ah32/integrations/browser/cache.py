"""Best-effort browser cache: memory + file.

This is intended for short-lived crawl results, not for session cookies.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from ah32.config import settings

logger = logging.getLogger(__name__)


def make_cache_key(url: str, *, extra: str = "") -> str:
    raw = f"{url or ''}|{extra or ''}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _safe_filename(key: str) -> str:
    key = str(key or "").strip()
    if not key:
        return "empty"
    # Keep stable even when key contains separators or unicode.
    if all(c.isalnum() or c in ("_", "-", ".") for c in key) and len(key) <= 80:
        return key
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CacheEntry:
    created_at: float
    expires_at: float
    data: Any


class BrowserCache:
    def __init__(
        self,
        root_dir: Optional[Path] = None,
        *,
        default_ttl_seconds: int = 3600,
        max_entries: int = 500,
    ) -> None:
        self.root_dir = Path(root_dir) if root_dir else (settings.storage_root / "browser_cache")
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.default_ttl_seconds = int(default_ttl_seconds)
        self.max_entries = int(max_entries)
        self._mem: Dict[str, CacheEntry] = {}

    def get(self, key: str) -> Any | None:
        now = time.time()
        k = str(key or "")
        entry = self._mem.get(k)
        if entry and entry.expires_at > now:
            return entry.data

        path = self._entry_path(k)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            expires_at = float(raw.get("expires_at") or 0.0)
            if expires_at <= now:
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    logger.debug("[browser-cache] delete expired failed: %s", path, exc_info=True)
                return None
            data = raw.get("data")
            created_at = float(raw.get("created_at") or now)
            self._mem[k] = CacheEntry(created_at=created_at, expires_at=expires_at, data=data)
            return data
        except Exception as e:
            logger.warning("[browser-cache] read failed key=%s path=%s err=%s", k, path, e, exc_info=True)
            return None

    def put(self, key: str, data: Any, *, ttl_seconds: int | None = None) -> None:
        now = time.time()
        ttl = int(ttl_seconds) if ttl_seconds is not None else self.default_ttl_seconds
        ttl = max(ttl, 1)
        expires_at = now + ttl
        k = str(key or "")
        self._mem[k] = CacheEntry(created_at=now, expires_at=expires_at, data=data)

        path = self._entry_path(k)
        payload = {"created_at": now, "expires_at": expires_at, "data": data}
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as e:
            logger.warning("[browser-cache] write failed key=%s path=%s err=%s", k, path, e, exc_info=True)

        # Best-effort size control.
        try:
            self._cleanup_if_needed()
        except Exception:
            logger.debug("[browser-cache] cleanup failed (ignored)", exc_info=True)

    def delete(self, key: str) -> None:
        k = str(key or "")
        self._mem.pop(k, None)
        path = self._entry_path(k)
        try:
            path.unlink(missing_ok=True)
        except Exception:
            logger.debug("[browser-cache] delete failed: %s", path, exc_info=True)

    def _entry_path(self, key: str) -> Path:
        return self.root_dir / f"{_safe_filename(key)}.json"

    def _cleanup_if_needed(self) -> None:
        # Keep memory small.
        if len(self._mem) > self.max_entries:
            # Drop oldest by expires_at.
            items = sorted(self._mem.items(), key=lambda kv: kv[1].expires_at)
            for k, _ in items[: max(0, len(self._mem) - self.max_entries)]:
                self._mem.pop(k, None)

        # Keep disk entries bounded.
        files = sorted(
            (p for p in self.root_dir.glob("*.json") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for p in files[self.max_entries :]:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                logger.debug("[browser-cache] delete old file failed: %s", p, exc_info=True)

