from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def _safe_str(v: object) -> str:
    return str(v or "").strip()


@dataclass(frozen=True)
class TenantKey:
    tenant_id: str
    api_key: str


class TenantKeyring:
    """A tiny local keyring for tenant -> api_key mapping.

    File format (v1):
    {
      "tenants": {
        "tenantA": {"api_key": "..."},
        "tenantB": {"api_key": "..."}
      }
    }
    """

    def __init__(self, *, path: Path, max_tenants: int = 100, reload_interval_sec: int = 5) -> None:
        self._path = Path(path)
        self._max_tenants = int(max_tenants)
        self._reload_interval_sec = int(reload_interval_sec)
        self._lock = threading.RLock()
        self._last_load_ts = 0.0
        self._tenants: Dict[str, TenantKey] = {}

    @property
    def path(self) -> Path:
        return self._path

    def _should_reload(self) -> bool:
        return (time.time() - float(self._last_load_ts)) >= float(self._reload_interval_sec)

    def _load_if_needed(self) -> None:
        with self._lock:
            if self._tenants and not self._should_reload():
                return
            self._last_load_ts = time.time()

            if not self._path.exists():
                self._tenants = {}
                return
            try:
                raw = self._path.read_text(encoding="utf-8")
                obj = json.loads(raw) if raw.strip() else {}
            except Exception as e:
                logger.error("[auth] keyring load failed path=%s err=%s", self._path, e, exc_info=True)
                self._tenants = {}
                return

            tenants = obj.get("tenants") if isinstance(obj, dict) else None
            if not isinstance(tenants, dict):
                self._tenants = {}
                return

            out: Dict[str, TenantKey] = {}
            for tid, payload in list(tenants.items())[: self._max_tenants + 1]:
                if len(out) >= self._max_tenants:
                    break
                tenant_id = _safe_str(tid)
                if not tenant_id:
                    continue
                api_key = ""
                if isinstance(payload, dict):
                    api_key = _safe_str(payload.get("api_key"))
                if not api_key:
                    continue
                out[tenant_id] = TenantKey(tenant_id=tenant_id, api_key=api_key)

            self._tenants = out

    def get(self, tenant_id: str) -> Optional[TenantKey]:
        self._load_if_needed()
        with self._lock:
            return self._tenants.get(_safe_str(tenant_id))

    def verify(self, *, tenant_id: str, api_key: str) -> bool:
        t = self.get(tenant_id)
        if t is None:
            return False
        return _safe_str(api_key) == t.api_key


_KEYRING: TenantKeyring | None = None


def get_tenant_keyring(*, path: Path | None = None) -> TenantKeyring:
    global _KEYRING
    if _KEYRING is not None and path is None:
        return _KEYRING

    from ah32.config import settings

    kr = TenantKeyring(
        path=path or getattr(settings, "tenant_keyring_path", (settings.storage_root / "tenants" / "keyring.json")),
        max_tenants=int(getattr(settings, "max_tenants", 100) or 100),
        reload_interval_sec=int(getattr(settings, "tenant_keyring_reload_sec", 5) or 5),
    )
    if path is None:
        _KEYRING = kr
    return kr

