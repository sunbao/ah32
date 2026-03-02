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

HostApp = Literal["wps", "et", "wpp", "unknown"]


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


def _safe_suffix(filename: str) -> str:
    try:
        suf = Path(str(filename or "")).suffix.lower()
    except Exception:
        return ""
    if not suf or len(suf) > 10:
        return ""
    if not suf.startswith("."):
        return ""
    # Keep it permissive but avoid weird path tricks.
    for ch in suf:
        if not (ch.isalnum() or ch in (".", "_", "-")):
            return ""
    return suf


@dataclass(frozen=True)
class DocSnapshotInitResult:
    snapshot_id: str
    replaced_snapshot_id: Optional[str]
    expires_in_sec: int
    created_at: float
    export_required: bool
    export_target_ext: Optional[str]
    export_notes: Optional[str]


class DocSnapshotStore:
    """Ephemeral doc snapshot store with TTL cleanup (crash-safety).

    This store is intentionally simple:
    - Each snapshot is a folder under `root_dir/<snapshot_id>/`.
    - The uploaded doc bytes are stored as `doc<ext>` inside that folder.
    - Metadata is stored as `meta.json` (no raw document content).
    """

    def __init__(
        self,
        *,
        root_dir: Path,
        ttl_sec: int = 1800,
        max_bytes: int = 200_000_000,
    ) -> None:
        self._root_dir = Path(root_dir)
        self._ttl_sec = _clamp_int(ttl_sec, lo=30, hi=24 * 3600, default=1800)
        self._max_bytes = _clamp_int(max_bytes, lo=1_000_000, hi=2_000_000_000, default=200_000_000)

        self._root_dir.mkdir(parents=True, exist_ok=True)
        # In-memory live index: (client_id, host_app, doc_id) -> snapshot_id
        self._live_by_slot: Dict[Tuple[str, str, str], str] = {}

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @property
    def ttl_sec(self) -> int:
        return self._ttl_sec

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    def _slot_key(self, *, client_id: str, host_app: str, doc_id: str) -> Tuple[str, str, str]:
        return (_safe_key_part(client_id), _safe_key_part(host_app), _safe_key_part(doc_id))

    def _snapshot_dir(self, snapshot_id: str) -> Path:
        return self._root_dir / str(snapshot_id)

    def _meta_path(self, snapshot_id: str) -> Path:
        return self._snapshot_dir(snapshot_id) / "meta.json"

    def _load_meta(self, snapshot_id: str) -> Dict[str, Any]:
        p = self._meta_path(snapshot_id)
        if not p.exists():
            return {}
        try:
            raw = p.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
            return data if isinstance(data, dict) else {}
        except Exception:
            logger.warning("[doc_snapshot] load meta failed: %s", p, exc_info=True)
            return {}

    def _save_meta(self, snapshot_id: str, meta: Dict[str, Any]) -> None:
        p = self._meta_path(snapshot_id)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception:
            logger.warning("[doc_snapshot] save meta failed: %s", p, exc_info=True)

    def cleanup_expired(self) -> int:
        """Delete expired snapshots (crash-safety only). Returns count deleted."""
        deleted = 0
        now = _now()
        try:
            for child in self._root_dir.iterdir():
                if not child.is_dir():
                    continue
                sid = child.name
                meta = self._load_meta(sid)
                exp = float(meta.get("expires_at") or 0.0) if isinstance(meta, dict) else 0.0
                # Best-effort fallback: use mtime when meta is missing.
                if exp <= 0:
                    try:
                        exp = child.stat().st_mtime + float(self._ttl_sec)
                    except Exception:
                        exp = 0.0
                if exp > 0 and exp < now:
                    if self.delete(sid, reason="ttl_expired"):
                        deleted += 1
        except Exception:
            logger.debug("[doc_snapshot] cleanup_expired failed (ignored)", exc_info=True)
        return deleted

    def init_snapshot(
        self,
        *,
        client_id: str,
        host_app: HostApp,
        doc_id: str,
        doc_name: str | None = None,
        replace_previous: bool = True,
        source_mode: str = "http_upload_bytes",
        source_doc_path: str | None = None,
    ) -> DocSnapshotInitResult:
        self.cleanup_expired()

        slot = self._slot_key(client_id=client_id, host_app=host_app, doc_id=doc_id)
        replaced_id: Optional[str] = None
        if replace_previous:
            replaced_id = self._live_by_slot.get(slot)
            if replaced_id:
                self.delete(replaced_id, reason="replaced_by_new_snapshot")

        snapshot_id = uuid.uuid4().hex
        created_at = _now()
        expires_at = created_at + float(self._ttl_sec)

        sd = self._snapshot_dir(snapshot_id)
        sd.mkdir(parents=True, exist_ok=True)

        meta: Dict[str, Any] = {
            "schema": "ah32.doc_snapshot.v1",
            "snapshot_id": snapshot_id,
            "created_at": created_at,
            "expires_at": expires_at,
            "slot": {
                "client_id": slot[0],
                "host_app": slot[1],
                "doc_id": slot[2],
                "doc_name": str(doc_name or "").strip() or None,
            },
            "source": {
                "mode": str(source_mode or "").strip(),
                "doc_path": str(source_doc_path or "").strip() or None,
            },
            "ready": False,
            "bytes_received": 0,
            "sha256": None,
            "doc_file": None,
            "attachments": [],
        }
        self._save_meta(snapshot_id, meta)
        self._live_by_slot[slot] = snapshot_id

        export_required = True
        export_target_ext: Optional[str] = None
        export_notes: Optional[str] = None

        try:
            # v1 guidance: prefer OOXML so backend parsing is predictable.
            if host_app == "wps":
                export_target_ext = "docx"
            elif host_app == "et":
                export_target_ext = "xlsx"
            elif host_app == "wpp":
                export_target_ext = "pptx"
            export_required = True
            export_notes = "Prefer OOXML export (.docx/.xlsx/.pptx) for stable parsing."
        except Exception:
            export_required = True

        if str(source_mode or "").strip() == "server_read_path" and source_doc_path:
            # Best-effort: copy immediately; snapshot becomes ready in init step.
            try:
                self.put_doc_file_from_path(snapshot_id, Path(source_doc_path))
                self.finalize(snapshot_id)
                export_required = False
            except Exception as e:
                logger.warning(
                    "[doc_snapshot] server_read_path failed snapshot_id=%s path=%s err=%s",
                    snapshot_id,
                    source_doc_path,
                    e,
                    exc_info=True,
                )
                export_required = True
                export_notes = "server_read_path failed; please upload bytes instead."

        return DocSnapshotInitResult(
            snapshot_id=snapshot_id,
            replaced_snapshot_id=replaced_id,
            expires_in_sec=int(self._ttl_sec),
            created_at=created_at,
            export_required=export_required,
            export_target_ext=export_target_ext,
            export_notes=export_notes,
        )

    def put_doc_file(
        self,
        snapshot_id: str,
        *,
        filename: str,
        content_type: str | None,
        data_stream,
    ) -> Dict[str, Any]:
        """Write the doc bytes for a snapshot.

        Args:
            snapshot_id: snapshot id
            filename: original filename (used only for suffix inference)
            content_type: MIME (stored in meta)
            data_stream: file-like with `.read(size)` method (sync)
        """
        meta = self._load_meta(snapshot_id)
        if not meta:
            raise FileNotFoundError(f"snapshot not found: {snapshot_id}")

        suf = _safe_suffix(filename)
        out_path = self._snapshot_dir(snapshot_id) / f"doc{suf or '.bin'}"
        tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")

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
                        raise ValueError(f"doc snapshot exceeds max_bytes={self._max_bytes}")
                    h.update(chunk)
                    f.write(chunk)
        except Exception:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                logger.debug(
                    "[doc_snapshot] delete tmp failed (ignored): %s",
                    tmp_path,
                    exc_info=True,
                )
            raise

        tmp_path.replace(out_path)

        meta["doc_file"] = {
            "path": str(out_path),
            "filename": str(filename or "").strip() or None,
            "content_type": str(content_type or "").strip() or None,
            "bytes": total,
            "suffix": out_path.suffix,
        }
        meta["bytes_received"] = int(total)
        meta["sha256"] = h.hexdigest()
        meta["ready"] = False
        self._save_meta(snapshot_id, meta)

        logger.info(
            "[doc_snapshot] uploaded snapshot_id=%s bytes=%s suffix=%s",
            snapshot_id,
            total,
            out_path.suffix,
        )
        return meta

    def put_doc_file_from_path(self, snapshot_id: str, source_path: Path) -> Dict[str, Any]:
        sp = Path(source_path)
        if not sp.exists() or not sp.is_file():
            raise FileNotFoundError(f"source file not found: {sp}")

        suf = _safe_suffix(sp.name)
        out_path = self._snapshot_dir(snapshot_id) / f"doc{suf or sp.suffix or '.bin'}"
        tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")

        h = hashlib.sha256()
        total = 0
        with sp.open("rb") as src, tmp_path.open("wb") as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > self._max_bytes:
                    raise ValueError(f"doc snapshot exceeds max_bytes={self._max_bytes}")
                h.update(chunk)
                dst.write(chunk)

        tmp_path.replace(out_path)
        meta = self._load_meta(snapshot_id)
        meta["doc_file"] = {
            "path": str(out_path),
            "filename": str(sp.name),
            "content_type": None,
            "bytes": total,
            "suffix": out_path.suffix,
            "source_path": str(sp),
        }
        meta["bytes_received"] = int(total)
        meta["sha256"] = h.hexdigest()
        meta["ready"] = False
        self._save_meta(snapshot_id, meta)
        logger.info(
            "[doc_snapshot] copied snapshot_id=%s bytes=%s source=%s",
            snapshot_id,
            total,
            sp,
        )
        return meta

    def put_attachments(
        self,
        snapshot_id: str,
        *,
        files: list[tuple[str, str | None, Any]],
    ) -> Dict[str, Any]:
        """Store attachments (best-effort; v1 keeps them but doesn't parse)."""
        meta = self._load_meta(snapshot_id)
        if not meta:
            raise FileNotFoundError(f"snapshot not found: {snapshot_id}")

        attach_dir = self._snapshot_dir(snapshot_id) / "attachments"
        attach_dir.mkdir(parents=True, exist_ok=True)

        items = meta.get("attachments")
        if not isinstance(items, list):
            items = []

        for filename, content_type, stream in files:
            suf = _safe_suffix(filename)
            aid = uuid.uuid4().hex[:12]
            out_path = attach_dir / f"{aid}{suf or '.bin'}"
            tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
            h = hashlib.sha256()
            total = 0
            try:
                with tmp_path.open("wb") as f:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > self._max_bytes:
                            raise ValueError(f"attachment exceeds max_bytes={self._max_bytes}")
                        h.update(chunk)
                        f.write(chunk)
            except Exception:
                try:
                    if tmp_path.exists():
                        tmp_path.unlink()
                except Exception:
                    logger.debug(
                        "[doc_snapshot] delete attachment tmp failed (ignored): %s",
                        tmp_path,
                        exc_info=True,
                    )
                raise

            tmp_path.replace(out_path)
            items.append(
                {
                    "id": aid,
                    "path": str(out_path),
                    "filename": str(filename or "").strip() or None,
                    "content_type": str(content_type or "").strip() or None,
                    "bytes": total,
                    "sha256": h.hexdigest(),
                }
            )

        meta["attachments"] = items
        self._save_meta(snapshot_id, meta)
        return meta

    def finalize(
        self,
        snapshot_id: str,
        *,
        expected_total_bytes: int | None = None,
        sha256: str | None = None,
    ) -> Dict[str, Any]:
        meta = self._load_meta(snapshot_id)
        if not meta:
            raise FileNotFoundError(f"snapshot not found: {snapshot_id}")

        doc_file = meta.get("doc_file") if isinstance(meta.get("doc_file"), dict) else None
        if not doc_file:
            # Allow extracted_text-only snapshots (text-only transport mode).
            # This is useful for remote backend deployments where the client cannot
            # reliably export OOXML bytes yet, but can provide plain text context.
            try:
                p = self._snapshot_dir(snapshot_id) / "extracted_text.txt"
                has_extracted = p.exists() and p.is_file()
            except Exception:
                has_extracted = False
            if not has_extracted:
                raise ValueError("missing doc_file")
            # Integrity checks only make sense for binary doc uploads.
            if expected_total_bytes is not None or sha256:
                raise ValueError("cannot validate bytes/sha256 without doc_file")
            meta["ready"] = True
            meta["finalized_at"] = _now()
            self._save_meta(snapshot_id, meta)
            return meta

        if expected_total_bytes is not None:
            try:
                exp = int(expected_total_bytes)
                have = int(meta.get("bytes_received") or 0)
                if exp > 0 and have != exp:
                    raise ValueError(f"total_bytes mismatch: expected={exp} have={have}")
            except Exception:
                raise

        if sha256:
            want = str(sha256 or "").strip().lower()
            have = str(meta.get("sha256") or "").strip().lower()
            if want and have and want != have:
                raise ValueError("sha256 mismatch")

        meta["ready"] = True
        meta["finalized_at"] = _now()
        self._save_meta(snapshot_id, meta)
        return meta

    def get_doc_file_path(self, snapshot_id: str) -> Optional[Path]:
        meta = self._load_meta(snapshot_id)
        doc_file = meta.get("doc_file") if isinstance(meta.get("doc_file"), dict) else None
        if not doc_file:
            return None
        p = Path(str(doc_file.get("path") or "")).expanduser()
        return p if p.exists() else None

    def status(self, snapshot_id: str) -> Dict[str, Any]:
        meta = self._load_meta(snapshot_id)
        if not meta:
            raise FileNotFoundError(f"snapshot not found: {snapshot_id}")
        # Never expose server-side file paths to clients (privacy/safety).
        out = dict(meta)
        try:
            if isinstance(out.get("doc_file"), dict):
                doc = dict(out["doc_file"])
                doc.pop("path", None)
                doc.pop("source_path", None)
                out["doc_file"] = doc
            if isinstance(out.get("attachments"), list):
                red = []
                for it in out["attachments"]:
                    if isinstance(it, dict):
                        x = dict(it)
                        x.pop("path", None)
                        red.append(x)
                out["attachments"] = red
        except Exception:
            logger.debug("[doc_snapshot] status redaction failed (ignored)", exc_info=True)
        return out

    def delete(self, snapshot_id: str, *, reason: str = "deleted") -> bool:
        sid = str(snapshot_id or "").strip()
        if not sid:
            return False

        # Remove from live index (best-effort).
        try:
            for slot, cur in list(self._live_by_slot.items()):
                if cur == sid:
                    self._live_by_slot.pop(slot, None)
        except Exception:
            logger.debug(
                "[doc_snapshot] delete: live index cleanup failed (ignored)",
                exc_info=True,
            )

        sd = self._snapshot_dir(sid)
        if not sd.exists():
            return False

        try:
            shutil.rmtree(sd, ignore_errors=False)
            logger.info("[doc_snapshot] deleted snapshot_id=%s reason=%s", sid, reason)
            return True
        except FileNotFoundError:
            return False
        except Exception:
            logger.warning(
                "[doc_snapshot] delete failed snapshot_id=%s reason=%s",
                sid,
                reason,
                exc_info=True,
            )
            try:
                shutil.rmtree(sd, ignore_errors=True)
            except Exception:
                logger.debug(
                    "[doc_snapshot] delete ignore_errors cleanup failed (ignored): %s",
                    sd,
                    exc_info=True,
                )
            return False


_DOC_SNAPSHOT_STORES: dict[str, DocSnapshotStore] = {}


def get_doc_snapshot_store(
    *,
    root_dir: Path | None = None,
    ttl_sec: int | None = None,
    max_bytes: int | None = None,
) -> DocSnapshotStore:
    """Return the DocSnapshotStore for the current tenant (fallback: default tenant)."""

    from ah32.config import settings
    from ah32.tenancy.context import get_tenant_id

    tenant_id = (get_tenant_id() or str(getattr(settings, "default_tenant_id", "public") or "public")).strip() or "public"
    key = str(tenant_id)
    if root_dir is None:
        root_dir = settings.storage_root / "tenants" / tenant_id / "doc_snapshots"

    store = _DOC_SNAPSHOT_STORES.get(key)
    if store is not None and Path(getattr(store, "root_dir", "")) == Path(root_dir):
        return store

    store = DocSnapshotStore(
        root_dir=root_dir
        or getattr(settings, "doc_snapshots_path", (settings.storage_root / "doc_snapshots")),
        ttl_sec=ttl_sec
        if ttl_sec is not None
        else int(getattr(settings, "doc_snapshot_ttl_sec", 1800) or 1800),
        max_bytes=max_bytes
        if max_bytes is not None
        else int(getattr(settings, "doc_snapshot_max_bytes", 200_000_000) or 200_000_000),
    )
    _DOC_SNAPSHOT_STORES[key] = store
    return store
