# ========== 文档同步 API ==========
#
# Goal:
# - Support "cross-host aggregated open document list" across Writer/ET/WPP.
# - Each host taskpane periodically syncs its currently-open docs to backend.
# - Backend returns *only currently-open* docs for the same client (not stale, not other machines).
#
# Design:
# - client_id: stable per machine/browser profile (stored in localStorage on frontend).
# - host_app: wps|et|wpp|unknown (which WPS host sent this snapshot).
# - Each sync call replaces the snapshot for (client_id, host_app) and updates last_seen.
# - /api/documents returns a TTL-filtered union across host_app for the given client_id.
#
# NOTE: This is local-first. No auth boundary here unless enabled globally.

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

import json
import logging
import os
import time

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Persist on disk so reopening the taskpane can show the last known docs quickly.
# We still TTL-filter on read, so stale entries won't appear as "currently open".
SYNC_DIR = Path.home() / ".ah32" / "sync"
SYNC_FILE = SYNC_DIR / "documents.json"


HostApp = Literal["wps", "et", "wpp", "unknown"]


class DocumentInfo(BaseModel):
    """Document metadata (no content)."""

    id: str = ""
    name: str = ""
    path: str = ""  # full path if available (can be empty for unsaved docs)
    isActive: bool = False
    hostApp: HostApp = "unknown"
    # Optional stats; kept for compatibility with older UI bits.
    pageCount: int = 0
    wordCount: int = 0


class DocumentSyncRequest(BaseModel):
    """A snapshot from one taskpane instance (one host app)."""

    client_id: str = Field(default="default", description="Stable client identifier (frontend localStorage).")
    host_app: HostApp = Field(default="unknown", description="Source host of this snapshot.")
    documents: List[Dict[str, Any]] = Field(default_factory=list, description="Raw doc dicts from frontend.")


class DocumentSyncResponse(BaseModel):
    success: bool
    count: int = 0


@dataclass(frozen=True)
class _SnapshotKey:
    client_id: str
    host_app: HostApp


def _ttl_seconds() -> int:
    """How long a snapshot is considered 'live' (currently open)."""
    try:
        v = int(os.environ.get("AH32_DOC_SYNC_TTL_SEC") or "30")
        return max(5, min(v, 3600))
    except Exception:
        return 30


def _now() -> float:
    return time.time()


def _normalize_host(v: str) -> HostApp:
    s = (v or "").strip().lower()
    if s in ("wps", "et", "wpp"):
        return s  # type: ignore[return-value]
    return "unknown"


def _normalize_client_id(v: str) -> str:
    s = (v or "").strip()
    if not s:
        return "default"
    # keep it simple; avoid path separators and weird whitespace
    s = s.replace("\\", "_").replace("/", "_").strip()
    return s[:120] if len(s) > 120 else s


def _coerce_doc(raw: Dict[str, Any], host_app: HostApp) -> DocumentInfo:
    # Frontend might send different shapes; keep it permissive.
    return DocumentInfo(
        id=str(raw.get("id") or ""),
        name=str(raw.get("name") or ""),
        path=str(raw.get("path") or raw.get("fullPath") or raw.get("fullName") or ""),
        isActive=bool(raw.get("isActive") or False),
        hostApp=_normalize_host(str(raw.get("hostApp") or host_app)),
        pageCount=int(raw.get("pageCount") or 0),
        wordCount=int(raw.get("wordCount") or 0),
    )


def _load_store() -> Dict[str, Any]:
    """Load store from disk, upgrading older formats if needed."""
    if not SYNC_FILE.exists():
        return {"version": 2, "updated_at": _now(), "clients": {}}

    try:
        data = json.loads(SYNC_FILE.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {"version": 2, "updated_at": _now(), "clients": {}}

    # v1 legacy: file was a list of docs
    if isinstance(data, list):
        docs = []
        for it in data:
            if isinstance(it, dict):
                docs.append(it)
        return {
            "version": 2,
            "updated_at": _now(),
            "clients": {
                "default": {
                    "hosts": {
                        "unknown": {"last_seen": _now(), "documents": docs}
                    }
                }
            },
        }

    if not isinstance(data, dict):
        return {"version": 2, "updated_at": _now(), "clients": {}}

    # v2 expected shape
    if "clients" not in data or not isinstance(data.get("clients"), dict):
        data["clients"] = {}
    data.setdefault("version", 2)
    data.setdefault("updated_at", _now())
    return data


def _save_store(store: Dict[str, Any]) -> None:
    try:
        SYNC_DIR.mkdir(parents=True, exist_ok=True)
        SYNC_FILE.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"保存同步文档失败: {e}")


def _update_snapshot(store: Dict[str, Any], key: _SnapshotKey, docs: List[Dict[str, Any]]) -> int:
    clients = store.setdefault("clients", {})
    client = clients.setdefault(key.client_id, {})
    hosts = client.setdefault("hosts", {})

    coerced: List[Dict[str, Any]] = []
    for raw in docs or []:
        if not isinstance(raw, dict):
            continue
        d = _coerce_doc(raw, key.host_app)
        # Keep only meaningful entries to reduce noise.
        if not d.id and not d.name and not d.path:
            continue
        coerced.append(d.model_dump())

    hosts[str(key.host_app)] = {"last_seen": _now(), "documents": coerced}
    store["updated_at"] = _now()
    return len(coerced)


def _read_union(store: Dict[str, Any], client_id: str) -> List[Dict[str, Any]]:
    ttl = _ttl_seconds()
    cutoff = _now() - ttl
    clients = store.get("clients") or {}
    client = clients.get(client_id) or {}
    hosts = (client.get("hosts") or {}) if isinstance(client, dict) else {}

    # TTL filter + union
    docs: List[Dict[str, Any]] = []
    for host_key, snap in (hosts.items() if isinstance(hosts, dict) else []):
        if not isinstance(snap, dict):
            continue
        last_seen = float(snap.get("last_seen") or 0.0)
        if last_seen < cutoff:
            continue
        for raw in snap.get("documents") or []:
            if isinstance(raw, dict):
                docs.append(raw)

    # De-dupe by (hostApp, id) and fallback to (hostApp, path|name)
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for d in docs:
        host = _normalize_host(str(d.get("hostApp") or host_key))
        did = str(d.get("id") or "").strip()
        path = str(d.get("path") or "").strip()
        name = str(d.get("name") or "").strip()
        key = (host, did) if did else (host, path or name)
        if key in seen:
            continue
        seen.add(key)
        # Ensure hostApp is present for frontend UI.
        d2 = dict(d)
        d2["hostApp"] = host
        out.append(d2)

    # Sort: active docs first, then name
    out.sort(key=lambda x: (0 if x.get("isActive") else 1, str(x.get("name") or "")))
    return out


router = APIRouter(prefix="/api", tags=["文档同步"])


@router.post("/documents/sync", response_model=DocumentSyncResponse)
async def sync_documents(request: DocumentSyncRequest):
    """Receive a snapshot of currently-open docs from one host app."""
    try:
        client_id = _normalize_client_id(request.client_id)
        host_app = _normalize_host(request.host_app)
        store = _load_store()
        count = _update_snapshot(store, _SnapshotKey(client_id=client_id, host_app=host_app), request.documents)
        _save_store(store)
        logger.info(f"[documents/sync] client_id={client_id} host={host_app} docs={count}")
        return DocumentSyncResponse(success=True, count=count)
    except Exception as e:
        logger.error(f"文档同步失败: {e}", exc_info=True)
        return DocumentSyncResponse(success=False, count=0)


@router.get("/documents")
async def get_documents(client_id: str = Query(default="default")):
    """Return union of currently-open documents for a client (TTL-filtered)."""
    cid = _normalize_client_id(client_id)
    store = _load_store()
    docs = _read_union(store, cid)
    return {"documents": docs, "client_id": cid, "ttl_sec": _ttl_seconds()}


@router.post("/documents/clear")
async def clear_documents(client_id: Optional[str] = Query(default=None)):
    """Clear stored snapshots. Default clears all clients (dev convenience)."""
    try:
        store = _load_store()
        if client_id:
            cid = _normalize_client_id(client_id)
            (store.get("clients") or {}).pop(cid, None)
        else:
            store["clients"] = {}
        store["updated_at"] = _now()
        _save_store(store)
    except Exception as e:
        # Dev convenience endpoint; never fail the call, but don't swallow errors silently.
        logger.warning(f"[documents/clear] failed: {e}", exc_info=True)
    return {"success": True}


# -----------------------
# Debug log endpoint
# -----------------------


class LogRequest(BaseModel):
    message: str
    level: str = "info"


@router.get("/log")
async def receive_log(message: str, level: str = "info"):
    """Receive frontend logs via GET (WPS webview constraints)."""
    msg = f"[WPS-前端] {message}"
    level_lower = level.lower()
    if level_lower == "error":
        logger.error(msg)
    elif level_lower == "warning":
        logger.warning(msg)
    else:
        logger.info(msg)
    return {"success": True}
