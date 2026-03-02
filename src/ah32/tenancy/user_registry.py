from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from ah32.config import settings

logger = logging.getLogger(__name__)

_USER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-:.]{0,127}$")
_TENANT_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}$")

_LOCK = threading.RLock()


def _now_ts() -> int:
    return int(time.time())


def _safe_str(v: Any) -> str:
    return str(v or "").strip()


def _normalize_tenant_id(raw: str) -> str:
    tid = _safe_str(raw)
    if not tid:
        return ""
    if not _TENANT_RE.match(tid):
        raise ValueError("invalid tenant_id")
    return tid


def _normalize_user_id(raw: str) -> str:
    uid = _safe_str(raw)
    if not uid:
        return ""
    if not _USER_RE.match(uid):
        raise ValueError("invalid user_id")
    return uid


@dataclass(frozen=True)
class TenantUserRecord:
    user_id: str
    enabled: bool
    created_at: int
    updated_at: int
    note: str = ""


class TenantUserRegistry:
    """Minimal per-tenant user allowlist for R&D/testing.

    Storage:
      storage/tenants/<tenant_id>/policy/users.json

    Policy:
      - If the file does NOT exist -> allowlist is "off" (no enforcement).
      - If the file exists -> only enabled users are allowed.
    """

    def __init__(self, *, storage_root: Path | None = None) -> None:
        self._storage_root = Path(storage_root) if storage_root is not None else Path(settings.storage_root)

    def _policy_path(self, tenant_id: str) -> Path:
        tid = _normalize_tenant_id(tenant_id) or "public"
        return self._storage_root / "tenants" / tid / "policy" / "users.json"

    def policy_path(self, tenant_id: str) -> Path:
        """Return the on-disk policy file path for this tenant."""
        return self._policy_path(tenant_id)

    def policy_exists(self, tenant_id: str) -> bool:
        try:
            return self._policy_path(tenant_id).exists()
        except Exception:
            return False

    def _load_raw(self, tenant_id: str) -> Dict[str, Any]:
        path = self._policy_path(tenant_id)
        if not path.exists():
            return {}
        try:
            raw = path.read_text(encoding="utf-8")
            obj = json.loads(raw) if raw.strip() else {}
            return obj if isinstance(obj, dict) else {}
        except Exception as e:
            logger.error("[tenant_users] load failed tenant_id=%s path=%s err=%s", tenant_id, path, e, exc_info=True)
            return {}

    def _save_raw(self, tenant_id: str, obj: Dict[str, Any]) -> None:
        path = self._policy_path(tenant_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        payload = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(path)

    def list_users(self, tenant_id: str) -> List[TenantUserRecord]:
        with _LOCK:
            obj = self._load_raw(tenant_id)
            users = obj.get("users") if isinstance(obj.get("users"), dict) else {}
            out: List[TenantUserRecord] = []
            for uid, payload in users.items():
                try:
                    user_id = _normalize_user_id(uid)
                except ValueError:
                    continue
                if not isinstance(payload, dict):
                    payload = {}
                enabled = bool(payload.get("enabled", True))
                created_at = int(payload.get("created_at") or 0) or 0
                updated_at = int(payload.get("updated_at") or 0) or 0
                note = _safe_str(payload.get("note"))
                out.append(
                    TenantUserRecord(
                        user_id=user_id,
                        enabled=enabled,
                        created_at=created_at,
                        updated_at=updated_at,
                        note=note,
                    )
                )
            out.sort(key=lambda x: x.user_id)
            return out

    def get_user(self, tenant_id: str, user_id: str) -> Optional[TenantUserRecord]:
        uid = _normalize_user_id(user_id)
        with _LOCK:
            obj = self._load_raw(tenant_id)
            users = obj.get("users") if isinstance(obj.get("users"), dict) else {}
            payload = users.get(uid)
            if not isinstance(payload, dict):
                return None
            return TenantUserRecord(
                user_id=uid,
                enabled=bool(payload.get("enabled", True)),
                created_at=int(payload.get("created_at") or 0) or 0,
                updated_at=int(payload.get("updated_at") or 0) or 0,
                note=_safe_str(payload.get("note")),
            )

    def upsert_user(self, tenant_id: str, user_id: str, *, enabled: bool = True, note: str = "") -> TenantUserRecord:
        tid = _normalize_tenant_id(tenant_id)
        uid = _normalize_user_id(user_id)
        ts = _now_ts()
        with _LOCK:
            obj = self._load_raw(tid) if tid else self._load_raw(tenant_id)
            if not obj:
                obj = {"schema_version": "ah32.tenant_users.v1", "updated_at": ts, "users": {}}
            users = obj.get("users")
            if not isinstance(users, dict):
                users = {}
                obj["users"] = users
            existing = users.get(uid) if isinstance(users.get(uid), dict) else {}
            created_at = int(existing.get("created_at") or 0) or ts
            users[uid] = {
                "enabled": bool(enabled),
                "created_at": created_at,
                "updated_at": ts,
                "note": _safe_str(note),
            }
            obj["updated_at"] = ts
            self._save_raw(tid or tenant_id, obj)
        return TenantUserRecord(user_id=uid, enabled=bool(enabled), created_at=created_at, updated_at=ts, note=_safe_str(note))

    def set_enabled(self, tenant_id: str, user_id: str, *, enabled: bool) -> TenantUserRecord:
        rec = self.get_user(tenant_id, user_id)
        if rec is None:
            # create-on-enable for convenience
            return self.upsert_user(tenant_id, user_id, enabled=enabled)
        return self.upsert_user(tenant_id, user_id, enabled=enabled, note=rec.note)

    def delete_user(self, tenant_id: str, user_id: str) -> bool:
        uid = _normalize_user_id(user_id)
        with _LOCK:
            obj = self._load_raw(tenant_id)
            if not obj:
                return False
            users = obj.get("users") if isinstance(obj.get("users"), dict) else None
            if not isinstance(users, dict) or uid not in users:
                return False
            users.pop(uid, None)
            obj["updated_at"] = _now_ts()
            self._save_raw(tenant_id, obj)
            return True

    def is_allowed(self, tenant_id: str, user_id: str) -> Optional[bool]:
        """Return:
        - None if policy file doesn't exist (no enforcement)
        - True/False if policy exists (allowed decision)
        """
        if not self.policy_exists(tenant_id):
            return None
        rec = self.get_user(tenant_id, user_id)
        if rec is None:
            return False
        return bool(rec.enabled)


_REGISTRY: TenantUserRegistry | None = None


def get_tenant_user_registry() -> TenantUserRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = TenantUserRegistry()
    return _REGISTRY
