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

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from ah32.config import settings
from ah32.tenancy.context import get_tenant_id
from ah32.tenancy.usage_audit import UsageSpan

logger = logging.getLogger(__name__)

# Frontend log ingestion can be extremely noisy (multi-line batches, huge diag payloads).
# Keep logs actionable by:
# - splitting "[HH:MM:SS] [LEVEL] ..." batches into per-line logs
# - truncating very large payloads
# - down-leveling known benign warnings
_FRONTEND_LOG_LINE_RE = re.compile(r"^\[\d{2}:\d{2}:\d{2}\]\s+\[(INFO|WARNING|ERROR|DEBUG)\]\s+(.+)$")
_NOISY_FRONTEND_SUBSTRINGS = (
    "requires ExecFunc context",
    "[WPSBridge] getHostApp.ActiveDocument/Documents requires ExecFunc context",
)


def _frontend_log_max_chars() -> int:
    try:
        v = int(os.environ.get("AH32_FRONTEND_LOG_MAX_CHARS") or "4000")
        return max(256, min(v, 200_000))
    except Exception:
        return 4000


def _truncate_frontend_log(s: str) -> str:
    raw = str(s or "")
    limit = _frontend_log_max_chars()
    if len(raw) <= limit:
        return raw
    return raw[:limit] + f"...(truncated,len={len(raw)})"


def _is_noisy_frontend_log_line(line: str) -> bool:
    s = str(line or "")
    return any(x in s for x in _NOISY_FRONTEND_SUBSTRINGS)


# Per-tenant cache + write-behind persistence (to avoid I/O storms).
_STORE_LOCK = threading.RLock()
_STORE_CACHE_BY_TENANT: Dict[str, Dict[str, Any]] = {}
_STORE_DIRTY_BY_TENANT: Dict[str, bool] = {}
_FLUSH_TASK_BY_TENANT: Dict[str, asyncio.Task] = {}
_LAST_SIG_BY_KEY: Dict[Tuple[str, str, str], str] = {}
_LAST_UNCHANGED_LOG_AT: Dict[Tuple[str, str, str], float] = {}


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

    boot_id: Optional[str] = Field(
        default=None,
        description="Per-taskpane boot id (for correlation).",
    )
    boot_seq: Optional[int] = Field(
        default=None,
        description="Boot sequence counter (localStorage).",
    )
    client_id: str = Field(
        default="default",
        description="Stable client identifier (frontend localStorage).",
    )
    host_app: HostApp = Field(default="unknown", description="Source host of this snapshot.")
    documents: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Raw doc dicts from frontend.",
    )


class DocumentSyncResponse(BaseModel):
    success: bool
    count: int = 0


@dataclass(frozen=True)
class _SnapshotKey:
    client_id: str
    host_app: HostApp


async def _bind_tenancy(req: Request):
    """Bind tenant/user/auth context for non-/agentic routes."""
    trace_id = str(getattr(req.state, "trace_id", "") or "").strip() or uuid.uuid4().hex
    from ah32.security.request_context import bind_tenancy_for_request

    with bind_tenancy_for_request(req, trace_id=trace_id):
        yield


def _effective_tenant_id() -> str:
    try:
        tid = str(get_tenant_id() or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"


def _sync_file_for_tenant(tenant_id: str) -> Path:
    tid = str(tenant_id or "").strip() or _effective_tenant_id()
    # Tenant-scoped storage unit: storage/tenants/<tenant_id>/doc_sync/documents.json
    return Path(settings.storage_root) / "tenants" / tid / "doc_sync" / "documents.json"


def _ttl_seconds() -> int:
    """How long a snapshot is considered 'live' (currently open)."""
    try:
        v = int(os.environ.get("AH32_DOC_SYNC_TTL_SEC") or "30")
        return max(5, min(v, 3600))
    except Exception:
        logger.debug("[documents] ttl parse failed; default=30", exc_info=True)
        return 30


def _now() -> float:
    return time.time()


def _persist_enabled() -> bool:
    v = str(os.environ.get("AH32_DOC_SYNC_PERSIST") or "true").strip().lower()
    return v not in ("0", "false", "no", "off")


def _flush_interval_sec() -> float:
    try:
        v = float(os.environ.get("AH32_DOC_SYNC_FLUSH_INTERVAL_SEC") or "5")
        return max(0.5, min(v, 60.0))
    except Exception:
        logger.debug("[documents] flush interval parse failed; default=5", exc_info=True)
        return 5.0


def _write_store_payload(payload: str, *, tenant_id: str) -> None:
    try:
        out = _sync_file_for_tenant(tenant_id)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(out)
    except Exception as e:
        logger.warning(f"[documents] write store failed: {e}", exc_info=True)


async def _flush_store_after_delay(tenant_id: str) -> None:
    interval = _flush_interval_sec()
    try:
        await asyncio.sleep(interval)
        while True:
            payload: Optional[str] = None
            with _STORE_LOCK:
                store = _STORE_CACHE_BY_TENANT.get(tenant_id)
                dirty = bool(_STORE_DIRTY_BY_TENANT.get(tenant_id, False))
                if not dirty or store is None:
                    _FLUSH_TASK_BY_TENANT.pop(tenant_id, None)
                    return
                try:
                    payload = json.dumps(store, ensure_ascii=False)
                    _STORE_DIRTY_BY_TENANT[tenant_id] = False
                except Exception as e:
                    logger.warning(f"[documents] json dump failed: {e}", exc_info=True)
                    payload = None

            if payload is not None:
                _write_store_payload(payload, tenant_id=tenant_id)

            with _STORE_LOCK:
                if not bool(_STORE_DIRTY_BY_TENANT.get(tenant_id, False)):
                    _FLUSH_TASK_BY_TENANT.pop(tenant_id, None)
                    return
            await asyncio.sleep(interval)
    except Exception as e:
        logger.warning(f"[documents] flush task failed: {e}", exc_info=True)
        with _STORE_LOCK:
            _STORE_DIRTY_BY_TENANT[tenant_id] = True
            _FLUSH_TASK_BY_TENANT.pop(tenant_id, None)


def _schedule_flush(tenant_id: str) -> None:
    if not _persist_enabled():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    with _STORE_LOCK:
        existing = _FLUSH_TASK_BY_TENANT.get(tenant_id)
        if existing is not None and not existing.done():
            return
        _FLUSH_TASK_BY_TENANT[tenant_id] = loop.create_task(_flush_store_after_delay(tenant_id))


def _get_store_cached(tenant_id: str) -> Dict[str, Any]:
    with _STORE_LOCK:
        existing = _STORE_CACHE_BY_TENANT.get(tenant_id)
        if existing is None:
            existing = _load_store(tenant_id)
            _STORE_CACHE_BY_TENANT[tenant_id] = existing
        return existing


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


def _load_store(tenant_id: str) -> Dict[str, Any]:
    """Load store from disk, upgrading older formats if needed."""
    p = _sync_file_for_tenant(tenant_id)
    if not p.exists():
        return {"version": 2, "updated_at": _now(), "clients": {}}

    try:
        data = json.loads(p.read_text(encoding="utf-8") or "{}")
    except Exception:
        logger.debug("[documents] load store failed; defaulting empty", exc_info=True)
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
        _write_store_payload(
            json.dumps(store, ensure_ascii=False, indent=2),
            tenant_id=_effective_tenant_id(),
        )
    except Exception as e:
        logger.warning(f"保存同步文档失败: {e}", exc_info=True)


def _docs_signature(coerced_docs: List[Dict[str, Any]]) -> str:
    try:
        parts: List[str] = []
        for d in coerced_docs or []:
            if not isinstance(d, dict):
                continue
            host = _normalize_host(str(d.get("hostApp") or "unknown"))
            did = str(d.get("id") or "").strip()
            path = str(d.get("path") or "").strip()
            name = str(d.get("name") or "").strip()
            active = "1" if d.get("isActive") else "0"
            parts.append(f"{host}|{did}|{path}|{name}|{active}")
        parts.sort()
        raw = ";;".join(parts)
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()
    except Exception:
        logger.debug("[documents] signature failed", exc_info=True)
        return f"sig_{time.time()}"


def _update_snapshot(
    store: Dict[str, Any], key: _SnapshotKey, docs: List[Dict[str, Any]]
) -> Tuple[int, bool]:
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

    sig = _docs_signature(coerced)
    tenant_id = _effective_tenant_id()
    sig_key = (tenant_id, key.client_id, str(key.host_app))
    prev_sig = _LAST_SIG_BY_KEY.get(sig_key)
    prev_snap = hosts.get(str(key.host_app))
    changed = bool(prev_sig is None or sig != prev_sig)

    # Always keep last_seen fresh in memory (TTL filter relies on it).
    # Persist to disk only when the doc set changes, and do it write-behind.
    if changed:
        hosts[str(key.host_app)] = {"last_seen": _now(), "documents": coerced}
        _LAST_SIG_BY_KEY[sig_key] = sig
    else:
        if isinstance(prev_snap, dict):
            prev_snap["last_seen"] = _now()
        else:
            hosts[str(key.host_app)] = {"last_seen": _now(), "documents": coerced}
            _LAST_SIG_BY_KEY[sig_key] = sig
            changed = True

    store["updated_at"] = _now()
    return len(coerced), changed


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


router = APIRouter(prefix="/api", tags=["文档同步"], dependencies=[Depends(_bind_tenancy)])


@router.post("/documents/sync", response_model=DocumentSyncResponse)
async def sync_documents(request: DocumentSyncRequest):
    """Receive a snapshot of currently-open docs from one host app."""
    span = UsageSpan(
        event="api_call",
        component="doc_sync",
        action="sync",
        extra={
            "client_id": str(getattr(request, "client_id", "") or "")[:64],
            "host_app": str(getattr(request, "host_app", "") or "")[:16],
            "docs_count": len(getattr(request, "documents", None) or []) if getattr(request, "documents", None) else 0,
        },
    )
    try:
        tenant_id = _effective_tenant_id()
        client_id = _normalize_client_id(request.client_id)
        host_app = _normalize_host(request.host_app)
        boot_id = str(request.boot_id or "").strip()
        boot_seq = request.boot_seq

        with _STORE_LOCK:
            store = _get_store_cached(tenant_id)
            count, changed = _update_snapshot(
                store,
                _SnapshotKey(client_id=client_id, host_app=host_app),
                request.documents,
            )
            if changed:
                _STORE_DIRTY_BY_TENANT[tenant_id] = True
                _schedule_flush(tenant_id)

        # Throttle "unchanged" spam to keep logs usable (and reduce file I/O).
        sig_key = (tenant_id, client_id, str(host_app))
        now = _now()
        last = _LAST_UNCHANGED_LOG_AT.get(sig_key) or 0.0
        if changed or (now - last) > 5.0:
            if not changed:
                _LAST_UNCHANGED_LOG_AT[sig_key] = now
            meta = []
            if boot_id:
                meta.append(f"boot={boot_id[:32]}")
            if boot_seq is not None:
                meta.append(f"boot_seq={boot_seq}")
            meta_s = f" ({' '.join(meta)})" if meta else ""
            logger.info(
                f"[documents/sync]{meta_s} tenant_id={tenant_id} client_id={client_id} host={host_app} "
                f"docs={count} changed={changed}"
            )

        span.set_status_code(200)
        span.close()
        return DocumentSyncResponse(success=True, count=count)
    except Exception as e:
        try:
            span.set_status_code(500)
            span.fail(error_type=type(e).__name__, error_message=str(e))
            span.close()
        except Exception:
            pass
        logger.error(f"文档同步失败: {e}", exc_info=True)
        return DocumentSyncResponse(success=False, count=0)


@router.get("/documents")
async def get_documents(client_id: str = Query(default="default")):
    """Return union of currently-open documents for a client (TTL-filtered)."""
    span = UsageSpan(event="api_call", component="doc_sync", action="get_documents", extra={"client_id": str(client_id or "")[:64]})
    tenant_id = _effective_tenant_id()
    cid = _normalize_client_id(client_id)
    with _STORE_LOCK:
        store = _get_store_cached(tenant_id)
        docs = _read_union(store, cid)
    span.set_status_code(200)
    span.close()
    return {"documents": docs, "client_id": cid, "tenant_id": tenant_id, "ttl_sec": _ttl_seconds()}


@router.post("/documents/clear")
async def clear_documents(client_id: Optional[str] = Query(default=None)):
    """Clear stored snapshots. Default clears all clients (dev convenience)."""
    span = UsageSpan(event="api_call", component="doc_sync", action="clear", extra={"client_id": str(client_id or "")[:64]})
    try:
        tenant_id = _effective_tenant_id()
        with _STORE_LOCK:
            store = _get_store_cached(tenant_id)
            if client_id:
                cid = _normalize_client_id(client_id)
                (store.get("clients") or {}).pop(cid, None)
            else:
                store["clients"] = {}
            store["updated_at"] = _now()
            _STORE_DIRTY_BY_TENANT[tenant_id] = True
            _schedule_flush(tenant_id)
        span.set_status_code(200)
        span.close()
    except Exception as e:
        try:
            span.set_status_code(500)
            span.fail(error_type=type(e).__name__, error_message=str(e))
            span.close()
        except Exception:
            pass
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
async def receive_log(
    message: str,
    level: str = "info",
    boot_id: Optional[str] = Query(default=None),
    boot_seq: Optional[str] = Query(default=None),
    client_id: Optional[str] = Query(default=None),
    host_app: Optional[str] = Query(default=None),
):
    """Receive frontend logs via GET (WPS webview constraints)."""
    meta_parts: List[str] = []
    try:
        if client_id:
            meta_parts.append(f"client_id={_normalize_client_id(client_id)}")
    except Exception:
        meta_parts.append("client_id=?")
    try:
        if host_app:
            meta_parts.append(f"host={_normalize_host(host_app)}")
    except Exception:
        meta_parts.append("host=?")
    try:
        if boot_id:
            meta_parts.append(f"boot={str(boot_id)[:64]}")
    except Exception:
        meta_parts.append("boot=?")
    try:
        if boot_seq:
            meta_parts.append(f"boot_seq={str(boot_seq)[:32]}")
    except Exception:
        meta_parts.append("boot_seq=?")

    meta = f" [{' '.join(meta_parts)}]" if meta_parts else ""
    raw_message = str(message or "")
    lines = raw_message.splitlines()
    # If this looks like a batch of structured frontend log lines, split them to preserve severity.
    if len(lines) > 1 and all(_FRONTEND_LOG_LINE_RE.match(ln.strip()) for ln in lines if ln.strip()):
        for ln in lines:
            ln = ln.strip()
            if not ln:
                continue
            m = _FRONTEND_LOG_LINE_RE.match(ln)
            if not m:
                # Fallback: keep as info to avoid dropping signal.
                logger.info(f"[WPS-前端]{meta} {_truncate_frontend_log(ln)}")
                continue
            sev = (m.group(1) or "INFO").strip().lower()
            text = m.group(0)
            msg = f"[WPS-前端]{meta} {_truncate_frontend_log(text)}"
            if _is_noisy_frontend_log_line(text):
                logger.debug(msg)
            elif sev == "error":
                logger.error(msg)
            elif sev == "warning":
                logger.warning(msg)
            elif sev == "debug":
                logger.debug(msg)
            else:
                logger.info(msg)
    else:
        msg = f"[WPS-前端]{meta} {_truncate_frontend_log(raw_message)}"
        level_lower = str(level or "info").lower()
        if _is_noisy_frontend_log_line(raw_message):
            logger.debug(msg)
        elif level_lower == "error":
            logger.error(msg)
        elif level_lower == "warning":
            logger.warning(msg)
        elif level_lower == "debug":
            logger.debug(msg)
        else:
            logger.info(msg)
    return {"success": True}
