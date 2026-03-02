"""Agentic Doc Snapshot API (v1).

This is an *ephemeral* upload/read bridge between the WPS taskpane and the backend.

Key constraints:
- Never persist private docs into RAG.
- Delete snapshots immediately after the chat turn completes/cancels/disconnects.
- TTL cleanup exists only as crash-safety.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ah32.doc_snapshots import get_doc_snapshot_store
from ah32.tenancy.usage_audit import usage_span

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agentic/doc-snapshots", tags=["agentic", "doc-snapshots"])

HostApp = Literal["wps", "et", "wpp", "unknown"]
SourceMode = Literal["http_upload_bytes", "client_export_path", "server_read_path"]


def _auth_or_401(api_key: Optional[str]) -> None:
    # Auth is enforced centrally for /agentic/* in server middleware.
    _ = api_key
    return


class DocSnapshotInitSource(BaseModel):
    mode: SourceMode = "http_upload_bytes"
    doc_path: str | None = None


class DocSnapshotInitRequest(BaseModel):
    client_id: str = Field(
        default="default",
        description="Stable client id (frontend localStorage).",
    )
    host_app: HostApp = Field(default="unknown")
    doc_id: str = Field(
        default="",
        description="Stable doc id in host app (docId).",
    )
    doc_name: str | None = None
    replace_previous: bool = True
    source: DocSnapshotInitSource = Field(default_factory=DocSnapshotInitSource)


class DocSnapshotInitExport(BaseModel):
    required: bool = True
    target_ext: str | None = None
    notes: str | None = None


class DocSnapshotInitResponse(BaseModel):
    snapshot_id: str
    replaced_snapshot_id: str | None = None
    created_at: str
    expires_in_sec: int
    export: DocSnapshotInitExport


@router.post("/init", response_model=DocSnapshotInitResponse)
async def init_snapshot(
    request: DocSnapshotInitRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_doc_snapshot_store()
    with usage_span(
        event="api_call",
        component="doc_snapshot",
        action="init",
        extra={
            "client_id": str(request.client_id or "")[:64],
            "host_app": str(request.host_app or "")[:16],
            "source_mode": str(request.source.mode or "")[:32] if request.source else "",
        },
    ) as span:
        try:
            res = store.init_snapshot(
                client_id=request.client_id,
                host_app=request.host_app,
                doc_id=request.doc_id or request.doc_name or "unknown",
                doc_name=request.doc_name,
                replace_previous=bool(request.replace_previous),
                source_mode=request.source.mode,
                source_doc_path=request.source.doc_path,
            )
            span.set_status_code(200)
            return DocSnapshotInitResponse(
                snapshot_id=res.snapshot_id,
                replaced_snapshot_id=res.replaced_snapshot_id,
                created_at=datetime.utcfromtimestamp(res.created_at).isoformat() + "Z",
                expires_in_sec=res.expires_in_sec,
                export=DocSnapshotInitExport(
                    required=bool(res.export_required),
                    target_ext=res.export_target_ext,
                    notes=res.export_notes,
                ),
            )
        except HTTPException as e:
            try:
                span.set_status_code(int(getattr(e, "status_code", 500) or 500))
                span.fail(error_type="HTTPException", error_message=str(getattr(e, "detail", str(e)) or str(e)))
            except Exception:
                pass
            raise
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error("[doc_snapshot] init failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))


class DocSnapshotUploadResponse(BaseModel):
    ok: bool = True
    snapshot_id: str
    bytes_received: int = 0
    sha256: str | None = None
    parts: Dict[str, Any] = Field(default_factory=dict)


@router.put("/{snapshot_id}/parts", response_model=DocSnapshotUploadResponse)
async def upload_parts(
    snapshot_id: str,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
    manifest: str | None = Form(default=None),
    doc_file: UploadFile | None = File(default=None),
    extracted_text: str | None = Form(default=None),
    attachments: list[UploadFile] | None = File(default=None),
):
    _auth_or_401(api_key)
    store = get_doc_snapshot_store()
    with usage_span(
        event="api_call",
        component="doc_snapshot",
        action="upload_parts",
        extra={
            "has_manifest": bool(manifest),
            "has_doc_file": bool(doc_file is not None),
            "has_extracted_text": bool(extracted_text),
            "attachments": len(attachments or []) if attachments else 0,
        },
    ) as span:
        try:
            parts: Dict[str, Any] = {}
            sha256: str | None = None
            bytes_received = 0

            if manifest:
                # Persist manifest for debugging (no raw doc content). Keep as text file.
                try:
                    meta = store._load_meta(snapshot_id)  # best-effort internal access
                    meta["manifest_raw"] = str(manifest)[:200_000]
                    store._save_meta(snapshot_id, meta)
                    parts["manifest"] = True
                except Exception as e:
                    logger.warning(
                        "[doc_snapshot] store manifest failed (ignored): %s",
                        e,
                        exc_info=True,
                    )

            if doc_file is not None:
                # Stream upload to disk via a sync wrapper to avoid buffering the whole file.
                class _UploadStream:
                    def __init__(self, f: UploadFile):
                        self._f = f

                    def read(self, size: int = -1) -> bytes:
                        # UploadFile.read is async; use UploadFile.file for sync streaming.
                        try:
                            return self._f.file.read(size)
                        except Exception:
                            return b""

                meta = store.put_doc_file(
                    snapshot_id,
                    filename=str(doc_file.filename or ""),
                    content_type=str(doc_file.content_type or ""),
                    data_stream=_UploadStream(doc_file),
                )
                bytes_received = int(meta.get("bytes_received") or 0)
                sha256 = str(meta.get("sha256") or "") or None
                parts["doc_file"] = True

            if extracted_text:
                # Best-effort: store extracted text as UTF-8 (bounded).
                try:
                    sd = store.root_dir / str(snapshot_id)
                    sd.mkdir(parents=True, exist_ok=True)
                    p = sd / "extracted_text.txt"
                    p.write_text(str(extracted_text)[:2_000_000], encoding="utf-8")
                    parts["extracted_text"] = True
                except Exception as e:
                    logger.warning(
                        "[doc_snapshot] store extracted_text failed (ignored): %s",
                        e,
                        exc_info=True,
                    )

            if attachments:
                try:
                    files = []
                    for f in attachments:
                        if not f:
                            continue

                        class _AttachStream:
                            def __init__(self, uf: UploadFile):
                                self._f = uf

                            def read(self, size: int = -1) -> bytes:
                                try:
                                    return self._f.file.read(size)
                                except Exception:
                                    return b""

                        files.append(
                            (
                                str(f.filename or ""),
                                str(f.content_type or ""),
                                _AttachStream(f),
                            )
                        )
                    store.put_attachments(snapshot_id, files=files)
                    parts["attachments"] = len(files)
                except Exception as e:
                    logger.warning(
                        "[doc_snapshot] store attachments failed (ignored): %s",
                        e,
                        exc_info=True,
                    )

            span.set_status_code(200)
            return DocSnapshotUploadResponse(
                ok=True,
                snapshot_id=snapshot_id,
                bytes_received=bytes_received,
                sha256=sha256,
                parts=parts,
            )
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="snapshot not found")
        except ValueError as e:
            try:
                span.set_status_code(400)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error(
                "[doc_snapshot] upload failed snapshot_id=%s err=%s",
                snapshot_id,
                e,
                exc_info=True,
            )
            raise HTTPException(status_code=500, detail=str(e))


class DocSnapshotFinalizeRequest(BaseModel):
    expected_total_bytes: int | None = None
    sha256: str | None = None


class DocSnapshotFinalizeResponse(BaseModel):
    ready: bool
    total_bytes: int = 0
    sha256: str | None = None
    parts: Dict[str, Any] = Field(default_factory=dict)


@router.post("/{snapshot_id}/finalize", response_model=DocSnapshotFinalizeResponse)
async def finalize_snapshot(
    snapshot_id: str,
    request: DocSnapshotFinalizeRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_doc_snapshot_store()
    with usage_span(event="api_call", component="doc_snapshot", action="finalize") as span:
        try:
            meta = store.finalize(
                snapshot_id,
                expected_total_bytes=request.expected_total_bytes,
                sha256=request.sha256,
            )
            doc_file = meta.get("doc_file") if isinstance(meta.get("doc_file"), dict) else {}
            parts: Dict[str, Any] = {"doc_file": bool(doc_file)}
            try:
                sd = store.root_dir / str(snapshot_id)
                parts["extracted_text"] = bool((sd / "extracted_text.txt").exists())
            except Exception:
                parts["extracted_text"] = False
            try:
                atts = meta.get("attachments") if isinstance(meta.get("attachments"), list) else []
                parts["attachments"] = len(atts)
            except Exception:
                parts["attachments"] = 0

            span.set_status_code(200)
            return DocSnapshotFinalizeResponse(
                ready=bool(meta.get("ready")),
                total_bytes=int(meta.get("bytes_received") or 0),
                sha256=str(meta.get("sha256") or "") or None,
                parts=parts,
            )
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="snapshot not found")
        except ValueError as e:
            try:
                span.set_status_code(400)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error(
                "[doc_snapshot] finalize failed snapshot_id=%s err=%s",
                snapshot_id,
                e,
                exc_info=True,
            )
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/{snapshot_id}/status")
async def snapshot_status(
    snapshot_id: str,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_doc_snapshot_store()
    with usage_span(event="api_call", component="doc_snapshot", action="status") as span:
        try:
            obj = {"ok": True, "snapshot": store.status(snapshot_id)}
            span.set_status_code(200)
            return obj
        except FileNotFoundError as e:
            try:
                span.set_status_code(404)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            raise HTTPException(status_code=404, detail="snapshot not found")
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error(
                "[doc_snapshot] status failed snapshot_id=%s err=%s",
                snapshot_id,
                e,
                exc_info=True,
            )
            raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: str,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    _auth_or_401(api_key)
    store = get_doc_snapshot_store()
    with usage_span(event="api_call", component="doc_snapshot", action="delete") as span:
        try:
            ok = store.delete(snapshot_id, reason="api_delete")
            span.set_status_code(200)
            return {"ok": True, "deleted": bool(ok)}
        except Exception as e:
            try:
                span.set_status_code(500)
                span.fail(error_type=type(e).__name__, error_message=str(e))
            except Exception:
                pass
            logger.error(
                "[doc_snapshot] delete failed snapshot_id=%s err=%s",
                snapshot_id,
                e,
                exc_info=True,
            )
            raise HTTPException(status_code=500, detail=str(e))
