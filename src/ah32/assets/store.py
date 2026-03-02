from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Literal, Optional, Tuple

logger = logging.getLogger(__name__)

AssetKind = Literal["image"]


def _now() -> float:
    return time.time()


def _clamp_int(v: Any, *, lo: int, hi: int, default: int) -> int:
    try:
        n = int(v)
    except Exception:
        return default
    return max(lo, min(hi, n))


def _safe_key_part(v: str) -> str:
    s = str(v or "").strip()
    if not s:
        return "unknown"
    s = s.replace("\\", "_").replace("/", "_").replace(":", "_").strip()
    return s[:120] if len(s) > 120 else s


@dataclass(frozen=True)
class AssetInitResult:
    asset_id: str
    replaced_asset_id: Optional[str]
    created_at: float
    expires_in_sec: int


class AssetStore:
    """Ephemeral blob store with TTL cleanup (crash-safety)."""

    def __init__(
        self,
        *,
        root_dir: Path,
        default_ttl_sec: int = 600,
        max_bytes: int = 20_000_000,
    ) -> None:
        self._root_dir = Path(root_dir)
        self._default_ttl_sec = _clamp_int(default_ttl_sec, lo=30, hi=24 * 3600, default=600)
        self._max_bytes = _clamp_int(max_bytes, lo=100_000, hi=500_000_000, default=20_000_000)

        self._root_dir.mkdir(parents=True, exist_ok=True)
        # In-memory live index: (client_id, session_id, host_app, doc_id, kind) -> asset_id
        self._live_by_scope: Dict[Tuple[str, str, str, str, str], str] = {}

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    def _asset_dir(self, asset_id: str) -> Path:
        return self._root_dir / str(asset_id)

    def _meta_path(self, asset_id: str) -> Path:
        return self._asset_dir(asset_id) / "meta.json"

    def _content_path(self, asset_id: str) -> Path:
        return self._asset_dir(asset_id) / "content.bin"

    def _load_meta(self, asset_id: str) -> Dict[str, Any]:
        p = self._meta_path(asset_id)
        if not p.exists():
            return {}
        try:
            raw = p.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
            return data if isinstance(data, dict) else {}
        except Exception:
            logger.warning("[asset] load meta failed: %s", p, exc_info=True)
            return {}

    def _save_meta(self, asset_id: str, meta: Dict[str, Any]) -> None:
        p = self._meta_path(asset_id)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception:
            logger.warning("[asset] save meta failed: %s", p, exc_info=True)

    def cleanup_expired(self) -> int:
        deleted = 0
        now = _now()
        try:
            for child in self._root_dir.iterdir():
                if not child.is_dir():
                    continue
                aid = child.name
                meta = self._load_meta(aid)
                exp = float(meta.get("expires_at") or 0.0) if isinstance(meta, dict) else 0.0
                if exp <= 0:
                    try:
                        exp = child.stat().st_mtime + float(self._default_ttl_sec)
                    except Exception:
                        exp = 0.0
                if exp > 0 and exp < now:
                    if self.delete(aid, reason="ttl_expired"):
                        deleted += 1
        except Exception:
            logger.debug("[asset] cleanup_expired failed (ignored)", exc_info=True)
        return deleted

    def init_asset(
        self,
        *,
        kind: AssetKind,
        mime: str,
        suggested_name: str | None,
        ttl_sec: int | None,
        replace_previous: bool,
        scope: Dict[str, Any] | None,
    ) -> AssetInitResult:
        self.cleanup_expired()

        scope = scope if isinstance(scope, dict) else {}
        client_id_raw = scope.get("client_id") or scope.get("clientId") or "default"
        session_id_raw = scope.get("session_id") or scope.get("sessionId") or ""
        host_app_raw = scope.get("host_app") or scope.get("hostApp") or ""
        doc_id_raw = scope.get("doc_id") or scope.get("docId") or ""

        client_id = _safe_key_part(str(client_id_raw))
        session_id = _safe_key_part(str(session_id_raw))
        host_app = _safe_key_part(str(host_app_raw))
        doc_id = _safe_key_part(str(doc_id_raw))
        kind_key = _safe_key_part(str(kind))

        scope_key = (client_id, session_id, host_app, doc_id, kind_key)
        replaced_id: Optional[str] = None
        if replace_previous:
            replaced_id = self._live_by_scope.get(scope_key)
            if replaced_id:
                self.delete(replaced_id, reason="replaced_by_new_asset")

        asset_id = uuid.uuid4().hex
        created_at = _now()
        use_ttl = _clamp_int(ttl_sec, lo=30, hi=24 * 3600, default=self._default_ttl_sec)
        expires_at = created_at + float(use_ttl)

        ad = self._asset_dir(asset_id)
        ad.mkdir(parents=True, exist_ok=True)

        meta: Dict[str, Any] = {
            "schema": "ah32.asset.v1",
            "asset_id": asset_id,
            "created_at": created_at,
            "expires_at": expires_at,
            "kind": str(kind),
            "mime": str(mime or "").strip() or "application/octet-stream",
            "suggested_name": str(suggested_name or "").strip() or None,
            "scope": {
                "client_id": client_id,
                "session_id": session_id or None,
                "host_app": host_app or None,
                "doc_id": doc_id or None,
            },
            "bytes": 0,
            "sha256": None,
            "ready": False,
        }
        self._save_meta(asset_id, meta)
        self._live_by_scope[scope_key] = asset_id

        return AssetInitResult(
            asset_id=asset_id,
            replaced_asset_id=replaced_id,
            created_at=created_at,
            expires_in_sec=int(use_ttl),
        )

    def put_content(
        self,
        asset_id: str,
        *,
        content_type: str | None,
        data_stream,
    ) -> Dict[str, Any]:
        meta = self._load_meta(asset_id)
        if not meta:
            raise FileNotFoundError(f"asset not found: {asset_id}")

        out_path = self._content_path(asset_id)
        tmp_path = out_path.with_suffix(".tmp")

        h = hashlib.sha256()
        total = 0
        try:
            with tmp_path.open("wb") as f:
                while True:
                    chunk = data_stream.read(1024 * 1024)
                    if not chunk:
                        break
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8", errors="ignore")
                    if not isinstance(chunk, (bytes, bytearray)):
                        raise TypeError("invalid chunk type")
                    total += len(chunk)
                    if total > self._max_bytes:
                        raise ValueError(f"asset exceeds max_bytes={self._max_bytes}")
                    h.update(chunk)
                    f.write(chunk)
        except Exception:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                logger.debug("[asset] delete tmp failed (ignored): %s", tmp_path, exc_info=True)
            raise

        tmp_path.replace(out_path)

        if content_type and (not meta.get("mime")):
            meta["mime"] = str(content_type).split(";")[0].strip()
        meta["bytes"] = int(total)
        meta["sha256"] = h.hexdigest()
        meta["ready"] = True
        meta["updated_at"] = _now()
        self._save_meta(asset_id, meta)

        logger.info("[asset] uploaded asset_id=%s bytes=%s", asset_id, total)
        return meta

    def get_content_path(self, asset_id: str) -> Optional[Path]:
        meta = self._load_meta(asset_id)
        if not meta:
            return None
        p = self._content_path(asset_id)
        return p if p.exists() else None

    def status(self, asset_id: str) -> Dict[str, Any]:
        meta = self._load_meta(asset_id)
        if not meta:
            raise FileNotFoundError(f"asset not found: {asset_id}")
        return meta

    def delete(self, asset_id: str, *, reason: str = "deleted") -> bool:
        aid = str(asset_id or "").strip()
        if not aid:
            return False

        try:
            for scope_key, cur in list(self._live_by_scope.items()):
                if cur == aid:
                    self._live_by_scope.pop(scope_key, None)
        except Exception:
            logger.debug("[asset] delete: live index cleanup failed (ignored)", exc_info=True)

        ad = self._asset_dir(aid)
        if not ad.exists():
            return False
        try:
            shutil.rmtree(ad, ignore_errors=False)
            logger.info("[asset] deleted asset_id=%s reason=%s", aid, reason)
            return True
        except FileNotFoundError:
            return False
        except Exception:
            logger.warning(
                "[asset] delete failed asset_id=%s reason=%s",
                aid,
                reason,
                exc_info=True,
            )
            try:
                shutil.rmtree(ad, ignore_errors=True)
            except Exception:
                logger.debug(
                    "[asset] delete ignore_errors cleanup failed (ignored): %s",
                    ad,
                    exc_info=True,
                )
            return False


_ASSET_STORES: dict[str, AssetStore] = {}


def get_asset_store(
    *,
    root_dir: Path | None = None,
    default_ttl_sec: int | None = None,
    max_bytes: int | None = None,
) -> AssetStore:
    from ah32.tenancy.context import get_tenant_id

    from ah32.config import settings

    tenant_id = (get_tenant_id() or str(getattr(settings, "default_tenant_id", "public") or "public")).strip() or "public"
    key = str(tenant_id)
    if root_dir is None:
        root_dir = settings.storage_root / "tenants" / tenant_id / "assets"

    store = _ASSET_STORES.get(key)
    if store is not None and Path(getattr(store, "root_dir", "")) == Path(root_dir):
        return store

    store = AssetStore(
        root_dir=root_dir or getattr(settings, "assets_path", (settings.storage_root / "assets")),
        default_ttl_sec=default_ttl_sec
        if default_ttl_sec is not None
        else int(getattr(settings, "asset_ttl_sec_default", 600) or 600),
        max_bytes=max_bytes
        if max_bytes is not None
        else int(getattr(settings, "asset_max_bytes", 20_000_000) or 20_000_000),
    )
    _ASSET_STORES[key] = store
    return store
