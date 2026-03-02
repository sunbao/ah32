from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


@dataclass(frozen=True)
class _PackItem:
    pack: Dict[str, Any]
    expires_at: float


class SkillsPackStore:
    """Ephemeral in-memory cache for client-sent skills packs.

    Goal: reduce per-turn payload by allowing clients to send a pack once, then
    refer to it by `skills_pack_ref` (hash) in later turns.
    """

    def __init__(self, *, ttl_seconds: int = 3600, max_sessions: int = 5000) -> None:
        self.ttl_seconds = int(ttl_seconds)
        self.max_sessions = int(max_sessions)
        self._lock = threading.Lock()
        # Key: (tenant_id, session_id, pack_ref)
        self._items: Dict[Tuple[str, str, str], _PackItem] = {}

    def cleanup_expired(self) -> int:
        now = time.time()
        removed = 0
        with self._lock:
            keys = [k for k, v in self._items.items() if v.expires_at <= now]
            for k in keys:
                self._items.pop(k, None)
                removed += 1
        return removed

    def put(self, *, tenant_id: str = "", session_id: str, pack_ref: str, pack: Dict[str, Any]) -> None:
        tid = str(tenant_id or "").strip()
        sid = str(session_id or "").strip()
        ref = str(pack_ref or "").strip()
        if not sid or not ref:
            return
        expires_at = time.time() + float(self.ttl_seconds)
        with self._lock:
            self._items[(tid, sid, ref)] = _PackItem(pack=dict(pack or {}), expires_at=expires_at)
            # Best-effort bound: if too many sessions, drop oldest by expires_at.
            if self.max_sessions > 0 and len(self._items) > self.max_sessions:
                # Remove ~10% oldest
                n = max(1, int(self.max_sessions * 0.1))
                oldest = sorted(self._items.items(), key=lambda kv: kv[1].expires_at)[:n]
                for k, _v in oldest:
                    self._items.pop(k, None)

    def get(self, *, tenant_id: str = "", session_id: str, pack_ref: str) -> Optional[Dict[str, Any]]:
        tid = str(tenant_id or "").strip()
        sid = str(session_id or "").strip()
        ref = str(pack_ref or "").strip()
        if not sid or not ref:
            return None
        now = time.time()
        with self._lock:
            item = self._items.get((tid, sid, ref))
            if item is None:
                return None
            if item.expires_at <= now:
                self._items.pop((tid, sid, ref), None)
                return None
            return dict(item.pack or {})


_STORE: SkillsPackStore | None = None


def get_skills_pack_store(*, ttl_seconds: int = 3600, max_sessions: int = 5000) -> SkillsPackStore:
    global _STORE
    if _STORE is None:
        _STORE = SkillsPackStore(ttl_seconds=ttl_seconds, max_sessions=max_sessions)
    return _STORE
