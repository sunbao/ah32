"""Agentic聊天API"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import hashlib
import ctypes
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Header, Query, Request
from fastapi.responses import StreamingResponse
from fastapi import Response
from pydantic import BaseModel, ConfigDict, ValidationError
import sys

from ah32.config import settings
from ah32.services.models import load_llm, load_llm_custom
from ah32.services.js_sanitize import sanitize_wps_js, looks_like_wps_js_macro
from ah32.services.plan_prompts import get_plan_generation_prompt, get_plan_repair_prompt
from ah32.core.metrics_recorder import metrics_recorder
from ah32.core.audit_recorder import audit_recorder
from ah32.agents import get_all_tools
from ah32.agents.react_agent import ReActAgent
from ah32.memory import Ah32MemorySystem
from ah32.session.session_id_generator import SessionIdGenerator

logger = logging.getLogger(__name__)

def _parse_bool_qp(v: object) -> bool:
    s = str(v or "").strip()
    return s in ("1", "true", "True")


def _effective_stream_debug_flags(*, query_params, expose_agent_thoughts: bool, expose_rag_hits: bool) -> tuple[bool, bool]:
    """Apply admin 'master switches' to per-request debug toggles.

    Policy:
    - Master switch OFF => per-request toggle has no effect.
    - Master switch ON  => per-request toggle controls visibility for that user/session.
    """
    show_thoughts_req = _parse_bool_qp(getattr(query_params, "get", lambda *_: None)("show_thoughts"))
    show_rag_req = _parse_bool_qp(getattr(query_params, "get", lambda *_: None)("show_rag"))
    return (bool(expose_agent_thoughts) and show_thoughts_req, bool(expose_rag_hits) and show_rag_req)

# 创建路由
router = APIRouter(prefix="/agentic", tags=["agentic"])


def _sanitize_frontend_context_for_failure_store(frontend_context: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Remove document content from debug retention.

    Policy:
    - Never keep active document text in the server-side failure context store.
    - Keep only minimal metadata to help correlate issues without leaking user documents.
    """
    try:
        if not isinstance(frontend_context, dict):
            return None

        host_app = frontend_context.get("host_app") or frontend_context.get("hostApp")

        active = frontend_context.get("activeDocument") or frontend_context.get("document") or {}
        active_out: Dict[str, Any] = {}
        if isinstance(active, dict):
            if "id" in active:
                active_out["id"] = active.get("id")
            if "name" in active:
                active_out["name"] = active.get("name")
            if "hostApp" in active:
                active_out["hostApp"] = active.get("hostApp")

        run_context = frontend_context.get("run_context") or frontend_context.get("runContext") or {}
        run_out: Dict[str, Any] = {}
        if isinstance(run_context, dict):
            for k in ("run_id", "mode", "host_app", "doc_id", "doc_key", "session_id", "message_id"):
                if k in run_context:
                    run_out[k] = run_context.get(k)

        docs = frontend_context.get("documents") or []
        docs_count = len(docs) if isinstance(docs, list) else 0
        doc_snapshot_id = None
        try:
            if isinstance(frontend_context, dict):
                v = (
                    frontend_context.get("doc_snapshot_id")
                    or frontend_context.get("docSnapshotId")
                    or frontend_context.get("doc_snapshot")
                    or frontend_context.get("docSnapshot")
                )
                if isinstance(v, str) and v.strip():
                    doc_snapshot_id = v.strip()
        except Exception:
            logger.debug("[failure_context] extract doc_snapshot_id failed (ignored)", exc_info=True)

        return {
            "host_app": host_app,
            "activeDocument": active_out or None,
            "documents_count": docs_count,
            "doc_snapshot_id": doc_snapshot_id,
            "run_context": run_out or None,
            "timestamp": frontend_context.get("timestamp"),
        }
    except Exception:
        logger.debug("[failure_context] sanitize frontend_context failed (ignored)", exc_info=True)
        return None


def _extract_javascript_code(text: str) -> str:
    """Extract executable JS code from a model response.

    Policy (for "实事求是"):
    - Prefer a fenced ```javascript```/```js``` block.
    - If the model omitted fences, accept raw text only when it still *looks like*
      a WPS JS macro (heuristic).
    - Never treat HTML/other formats as JS; return empty so the caller can surface
      a clear error instead of executing garbage.
    """
    if not text:
        return ""
    m = re.search(r"```(?:javascript|js)\s*\n([\s\S]*?)```", text, re.IGNORECASE)
    if m and m.group(1):
        return m.group(1).strip()
    t = text.strip()
    if not t:
        return ""
    # Reject common "wrong code type" outputs early (HTML/markup).
    if re.search(r"```\\s*html\\b", text, re.IGNORECASE) or t.lstrip().startswith(("<!DOCTYPE html", "<html", "<div", "<p")):
        return ""
    # Some models omit fences; accept only if it still resembles a macro.
    return t if looks_like_wps_js_macro(t) else ""


def _has_template_literal_delimiter(code: str) -> bool:
    """Return True if code contains a backtick (`) outside strings/comments.

    NOTE: Backticks inside normal strings/comments are harmless; we only block template literals
    because older WPS embedded engines frequently don't support them.
    """
    src = str(code or "")
    if "`" not in src:
        return False

    mode = "normal"  # normal | single | double | line_comment | block_comment
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if mode == "line_comment":
            if ch == "\n":
                mode = "normal"
            i += 1
            continue

        if mode == "block_comment":
            if ch == "*" and nxt == "/":
                i += 2
                mode = "normal"
                continue
            i += 1
            continue

        if mode == "single":
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                mode = "normal"
            i += 1
            continue

        if mode == "double":
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                mode = "normal"
            i += 1
            continue

        # mode == normal
        if ch == "/" and nxt == "/":
            mode = "line_comment"
            i += 2
            continue
        if ch == "/" and nxt == "*":
            mode = "block_comment"
            i += 2
            continue
        if ch == "'":
            mode = "single"
            i += 1
            continue
        if ch == '"':
            mode = "double"
            i += 1
            continue
        if ch == "`":
            return True

        i += 1

    return False


def _unsupported_js_reason(code: str) -> str:
    """Return a human-friendly reason when code uses JS syntax known to break WPS TaskPane runtimes."""
    src = str(code or "")
    if not src.strip():
        return "empty code"
    if _has_template_literal_delimiter(src):
        return "template_literal_backtick"
    if "=>" in src:
        return "arrow_function"
    if re.search(r"\basync\b|\bawait\b|\bclass\b", src):
        return "es6_plus_syntax"
    return ""


def _extract_json_payload(text: str) -> str:
    """Extract a JSON object string from a model response (fenced or raw)."""
    if not text:
        return ""
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if m and m.group(1):
        return m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end >= 0 and end > start:
        return text[start : end + 1].strip()
    return text.strip()


def _normalize_path_for_hash(p: str) -> str:
    s = (p or "").strip()
    if not s:
        return ""
    if os.name == "nt":
        s = s.replace("/", "\\").lower()
    return s


def _windows_file_identity(path: str) -> Optional[str]:
    """Return a stable identity for a file on Windows (survives rename/move)."""
    if os.name != "nt":
        return None
    p = (path or "").strip()
    if not p:
        return None

    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE = 0x00000004
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x00000080

    class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    CreateFileW = kernel32.CreateFileW
    CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    CreateFileW.restype = wintypes.HANDLE

    GetFileInformationByHandle = kernel32.GetFileInformationByHandle
    GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
    GetFileInformationByHandle.restype = wintypes.BOOL

    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL

    handle = CreateFileW(
        p,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )
    if handle == wintypes.HANDLE(-1).value:
        return None
    try:
        info = BY_HANDLE_FILE_INFORMATION()
        ok = GetFileInformationByHandle(handle, ctypes.byref(info))
        if not ok:
            return None
        file_index = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
        return f"win:{int(info.dwVolumeSerialNumber):08x}:{file_index:016x}"
    finally:
        try:
            CloseHandle(handle)
        except Exception as e:
            # Best-effort cleanup; never fail identity probing, but don't swallow.
            logger.debug(f"[file-id] CloseHandle failed: {e}", exc_info=True)


def _compute_document_identity(document_path: str, document_id: str, document_name: str) -> str:
    """Compute a stable identity string used to derive session_id."""
    p_norm = _normalize_path_for_hash(document_path)
    if p_norm:
        try:
            p = Path(document_path)
            if p.exists():
                wid = _windows_file_identity(document_path)
                if wid:
                    return wid
                st = p.stat()
                ino = getattr(st, "st_ino", None)
                dev = getattr(st, "st_dev", None)
                if ino is not None and dev is not None:
                    return f"posix:{dev}:{ino}"
        except Exception as e:
            # Identity is best-effort; keep request alive but leave breadcrumbs.
            logger.debug(f"[session-id] compute identity failed (fallback to path/name): {e}", exc_info=True)
        return f"path:{p_norm}"

    did = (document_id or "").strip()
    if did:
        return f"id:{did}"

    n = (document_name or "").strip()
    if n:
        return f"name:{n}"
    return "unknown"


@router.post("/session/generate")
async def generate_session(
    request: Request,
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.
        
        # 读取原始请求体用于调试
        body_bytes = await request.body()
        logger.debug(f"原始请求体: {body_bytes}")

        # 解析请求体
        body = await request.json()
        client_id = (body.get('client_id') or body.get('clientId') or '').strip()
        document_name = (body.get('document_name') or '').strip()
        document_path = (body.get('document_path') or body.get('document_key') or '').strip()
        document_id = (body.get('document_id') or body.get('documentId') or '').strip()
        host_app = (body.get('host_app') or body.get('hostApp') or '').strip()

        logger.debug(
            "解析后的 client_id=%r document_name=%r document_path=%r document_id=%r host_app=%r",
            client_id,
            document_name,
            document_path,
            document_id,
            host_app,
        )

        # Need at least one identity field.
        if not document_name and not document_path and not document_id:
            raise HTTPException(status_code=400, detail="document_name, document_path or document_id is required for session ID generation")

        identity = _compute_document_identity(document_path, document_id, document_name)
        if host_app:
            safe_host = re.sub(r"[^a-zA-Z0-9_\-:.]", "_", host_app)[:32]
            if safe_host:
                identity = f"host:{safe_host}|{identity}"
        # Remote backend can serve multiple client machines. Add an optional client namespace
        # so cross-client session_id collisions don't pollute memory.
        if client_id:
            # Keep ids filesystem/search friendly and bounded.
            safe_client = re.sub(r"[^a-zA-Z0-9_\-:.]", "_", client_id)[:128]
            if safe_client:
                identity = f"client:{safe_client}|{identity}"
        # Deterministic session id to keep memory stable across restarts and file renames/moves.
        file_hash32 = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]
        session_id = f"session_{file_hash32}"

        logger.info(
            "为文档生成session_id: session_id=%s identity=%s client_id=%r name=%r path=%r",
            session_id,
            identity,
            client_id,
            document_name,
            document_path,
        )
        
        return {"session_id": session_id}
        
    except HTTPException:
        # 重新抛出HTTP异常
        raise
    except Exception as e:
        logger.error(f"生成session_id失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to generate session ID")


class PlanGenerateRequest(BaseModel):
    """Deterministic Plan generation request model."""

    user_query: str
    session_id: str
    document_name: str = ""
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None


class PlanGenerateResponse(BaseModel):
    """Deterministic Plan generation response model."""

    success: bool
    plan: Optional[Dict[str, Any]] = None
    error: str = ""


class PlanRepairRequest(BaseModel):
    """Deterministic Plan repair request model."""

    session_id: str
    document_name: str = ""
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None
    attempt: int = 1
    error_type: str
    error_message: str
    plan: Dict[str, Any]


class PlanRepairResponse(BaseModel):
    """Deterministic Plan repair response model."""

    success: bool
    plan: Optional[Dict[str, Any]] = None
    error: str = ""


@router.post("/plan/repair")
async def plan_repair(
    request: PlanRepairRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """Repair a deterministic Plan JSON (strict schema) for frontend execution."""
    t0 = time.perf_counter()
    host = (request.host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"
    error_type = (request.error_type or "").strip().lower()
    fast_path_only = bool(request.attempt <= 0 or error_type in ("preflight", "preflight_validate", "validate_only"))
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        # Deterministic fast-path: many "repair" requests are just schema noise (e.g. `params` wrappers).
        # Normalize + validate first so we don't waste LLM calls and we avoid repeated "invalid plan" loops.
        try:
            from ah32.plan.schema import Plan
            from ah32.plan.normalize import normalize_plan_payload

            normalized = normalize_plan_payload(request.plan, host_app=host)
            fixed0 = Plan.model_validate(normalized)
            if fixed0.host_app == host:
                resp = PlanRepairResponse(success=True, plan=fixed0.model_dump(mode="json"))
                metrics_recorder.record(
                    op="plan_repair",
                    success=resp.success,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    extra={"host_app": host, "fast_path": True, "fast_path_only": fast_path_only},
                )
                return resp
        except ValidationError as e:
            # For preflight/validate-only checks, do not invoke LLM; return deterministic error early.
            if fast_path_only:
                resp = PlanRepairResponse(
                    success=False,
                    error=f"invalid plan: {e.errors(include_url=False)}",
                )
                metrics_recorder.record(
                    op="plan_repair",
                    success=resp.success,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    extra={"host_app": host, "fast_path": True, "fast_path_only": True},
                )
                return resp
            # Continue to LLM repair below.
            pass
        except Exception as e:
            logger.error(f"Plan repair fast path failed: {e}", exc_info=True)
            if fast_path_only:
                resp = PlanRepairResponse(success=False, error=str(e))
                metrics_recorder.record(
                    op="plan_repair",
                    success=resp.success,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    extra={"host_app": host, "fast_path": True, "fast_path_only": True},
                )
                return resp

        try:
            llm = load_llm(settings)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        system = get_plan_repair_prompt(host)
        user = (
            f"session_id: {request.session_id}\n"
            f"document_name: {request.document_name}\n"
            f"host_app: {host}\n"
            f"capabilities: {json.dumps(request.capabilities, ensure_ascii=False, default=str) if request.capabilities else ''}\n"
            f"attempt: {request.attempt}\n\n"
            f"error_type: {request.error_type}\n"
            f"error_message: {request.error_message}\n\n"
            "Original plan:\n"
            f"{json.dumps(request.plan, ensure_ascii=False, default=str)}\n"
        )

        response = await llm.ainvoke([("system", system), ("user", user)])
        raw = (getattr(response, "content", "") or "").strip()
        payload = _extract_json_payload(raw)
        if not payload:
            resp = PlanRepairResponse(success=False, error="empty model response")
            metrics_recorder.record(
                op="plan_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        from ah32.plan.schema import Plan
        from ah32.plan.normalize import normalize_plan_payload

        try:
            fixed_obj = json.loads(payload)
            fixed = Plan.model_validate(normalize_plan_payload(fixed_obj, host_app=host))
        except (ValidationError, json.JSONDecodeError, TypeError, ValueError) as e:
            if isinstance(e, ValidationError):
                resp = PlanRepairResponse(success=False, error=f"invalid plan: {e.errors(include_url=False)}")
            else:
                resp = PlanRepairResponse(success=False, error=f"invalid plan: {str(e)}")
            metrics_recorder.record(
                op="plan_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        if fixed.host_app != host:
            resp = PlanRepairResponse(
                success=False,
                error=f"host_app mismatch: request={host!r} plan={fixed.host_app!r}",
            )
            metrics_recorder.record(
                op="plan_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        resp = PlanRepairResponse(success=True, plan=fixed.model_dump(mode="json"))
        metrics_recorder.record(
            op="plan_repair",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        return resp

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Plan repair failed: {e}", exc_info=True)
        resp = PlanRepairResponse(success=False, error=str(e))
        metrics_recorder.record(
            op="plan_repair",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        return resp


@router.post("/plan/generate")
async def plan_generate(
    request: PlanGenerateRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """Generate a deterministic Plan JSON (strict schema) for frontend execution."""
    t0 = time.perf_counter()
    host = (request.host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        try:
            llm = load_llm(settings)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        system = get_plan_generation_prompt(host)
        user = (
            f"session_id: {request.session_id}\n"
            f"document_name: {request.document_name}\n"
            f"host_app: {host}\n"
            f"capabilities: {json.dumps(request.capabilities, ensure_ascii=False, default=str) if request.capabilities else ''}\n\n"
            f"User request:\n{request.user_query}\n"
        )

        response = await llm.ainvoke([("system", system), ("user", user)])
        raw = (getattr(response, "content", "") or "").strip()
        payload = _extract_json_payload(raw)
        if not payload:
            resp = PlanGenerateResponse(success=False, error="empty model response")
            metrics_recorder.record(
                op="plan_generate",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        from ah32.plan.schema import Plan
        from ah32.plan.normalize import normalize_plan_payload

        try:
            plan_obj = json.loads(payload)
            plan = Plan.model_validate(normalize_plan_payload(plan_obj, host_app=host))
        except (ValidationError, json.JSONDecodeError, TypeError, ValueError) as e:
            if isinstance(e, ValidationError):
                resp = PlanGenerateResponse(success=False, error=f"invalid plan: {e.errors(include_url=False)}")
            else:
                resp = PlanGenerateResponse(success=False, error=f"invalid plan: {str(e)}")
            metrics_recorder.record(
                op="plan_generate",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        if plan.host_app != host:
            resp = PlanGenerateResponse(
                success=False,
                error=f"host_app mismatch: request={host!r} plan={plan.host_app!r}",
            )
            metrics_recorder.record(
                op="plan_generate",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            return resp

        resp = PlanGenerateResponse(success=True, plan=plan.model_dump(mode="json"))
        metrics_recorder.record(
            op="plan_generate",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        return resp

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Plan generate failed: {e}", exc_info=True)
        resp = PlanGenerateResponse(success=False, error=str(e))
        metrics_recorder.record(
            op="plan_generate",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        return resp


class ChatRequest(BaseModel):
    """聊天请求模型"""

    model_config = ConfigDict(extra="forbid")

    message: str
    context: Optional[Dict[str, Any]] = None
    session_id: Optional[str] = None  # 优先使用前端传的 session_id
    document_name: Optional[str] = None  # 当前打开的文档名，用于生成 session_id
    frontend_context: Optional[Dict[str, Any]] = None  # 动态感知：前端收集的文档上下文（光标、选区、格式等）
    rule_files: Optional[list[str]] = None  # 每次请求注入的规则文件（docx/txt/md），支持热更新
    # v1: doc snapshot transport (ephemeral, privacy-first). Prefer putting it inside frontend_context,
    # but keep a top-level field for API evolution and easier clients.
    doc_snapshot_id: Optional[str] = None

# 前端统一使用 /agentic/chat/stream 流式接口

@router.post("/chat/stream")
async def agentic_chat_stream(
    request: ChatRequest,
    req: Request,
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    # 🔥 关键修复：在源头阻止uvicorn取消
    from contextlib import asynccontextmanager

    # 防止取消的上下文管理器
    @asynccontextmanager
    async def shield_cancellation():
        """使用asyncio.shield()提供完整保护"""
        try:
            yield
        except asyncio.CancelledError:
            # 连接已断开/请求被取消：立即终止本轮，释放资源
            logger.info("[HTTP连接] 捕获CancelledError，终止当前流式请求")
            raise
        except Exception as e:
            logger.error(f"[HTTP连接] 流式处理异常: {e}")
            raise

    # 在最外层使用保护
    async with shield_cancellation():
        try:
            # Auth is enforced centrally for /agentic/* in server middleware.

            boot_id = ""
            boot_seq = ""
            client_id = ""
            try:
                fc = request.frontend_context or {}
                if isinstance(fc, dict):
                    boot_id = str(fc.get("boot_id") or fc.get("bootId") or "").strip()
                    boot_seq = str(fc.get("boot_seq") or fc.get("bootSeq") or "").strip()
                    client_id = str(fc.get("client_id") or fc.get("clientId") or "").strip()
            except Exception:
                logger.debug("[chat] parse boot_id/client_id failed (ignored)", exc_info=True)

            meta_parts = []
            if client_id:
                meta_parts.append(f"client_id={client_id[:48]}")
            if boot_id:
                meta_parts.append(f"boot={boot_id[:48]}")
            if boot_seq:
                meta_parts.append(f"boot_seq={boot_seq[:16]}")
            meta = f" ({' '.join(meta_parts)})" if meta_parts else ""

            logger.info(f"收到Agentic流式对话请求{meta}: {request.message[:50]}...")

            async def generate_stream():
                """生成SSE事件流 - 真正调用ReActAgent"""
                # 记录开始时间
                request_start_time = time.time()
                logger.info(
                    f"[响应时间监控] 请求开始时间: {datetime.fromtimestamp(request_start_time).strftime('%Y-%m-%d %H:%M:%S')}"
                )

                trace_id = str(getattr(req.state, "trace_id", "") or "").strip()
                tenant_id = str(getattr(req.state, "tenant_id", "") or "").strip()

                snapshot_id = ""
                snapshot_store = None
                frontend_context_for_agent = request.frontend_context

                try:
                    try:
                        def _as_snapshot_id(value: Any) -> str:
                            if value is None:
                                return ""
                            if isinstance(value, str):
                                return value.strip()
                            if isinstance(value, (int, float)):
                                return str(value).strip()
                            # Ignore dict/list/etc. (frontends may attach meta objects).
                            return ""

                        fc = request.frontend_context or {}
                        snapshot_id = (
                            _as_snapshot_id(request.doc_snapshot_id)
                            or _as_snapshot_id(fc.get("doc_snapshot_id"))
                            or _as_snapshot_id(fc.get("docSnapshotId"))
                            or _as_snapshot_id(fc.get("doc_snapshot"))
                            or _as_snapshot_id(fc.get("docSnapshot"))
                        )
                    except Exception:
                        snapshot_id = ""

                    if not snapshot_id:
                        logger.debug("[doc_snapshot] no snapshot_id provided; proceeding without snapshot")

                    if snapshot_id:
                        from ah32.doc_snapshots import get_doc_snapshot_store

                        snapshot_store = get_doc_snapshot_store()
                        try:
                            snapshot_store.cleanup_expired()
                        except Exception:
                            logger.debug("[doc_snapshot] cleanup_expired failed (ignored)", exc_info=True)

                        # Validate existence early so the turn fails fast (and we still delete).
                        try:
                            has_extracted = (snapshot_store.root_dir / snapshot_id / "extracted_text.txt").exists()
                        except Exception:
                            has_extracted = False
                        has_doc = False
                        try:
                            has_doc = snapshot_store.get_doc_file_path(snapshot_id) is not None
                        except Exception:
                            has_doc = False
                        if not (has_doc or has_extracted):
                            # Best-effort: do not hard-fail the entire chat turn when snapshot is missing.
                            # This can happen in remote-backend mode due to disconnect/cancel/TTL cleanup.
                            logger.warning(
                                "[doc_snapshot] snapshot not ready or missing; proceed without snapshot id=%s",
                                snapshot_id,
                            )
                            snapshot_id = ""

                        # Ensure the agent sees doc_snapshot_id via frontend_context.
                        if snapshot_id and isinstance(frontend_context_for_agent, dict):
                            fc = dict(frontend_context_for_agent)
                            fc.setdefault("doc_snapshot_id", snapshot_id)
                            frontend_context_for_agent = fc
                        elif snapshot_id:
                            frontend_context_for_agent = {"doc_snapshot_id": snapshot_id}
                except Exception as e:
                    logger.error("[doc_snapshot] attach snapshot failed: %s", e, exc_info=True)
                    error_data = json.dumps(
                        {"message": str(e), "error": str(e), "trace_id": trace_id, "tenant_id": tenant_id},
                        ensure_ascii=False,
                    )
                    yield f"event: error\ndata: {error_data}\n\n".encode("utf-8")
                    return

                try:
                    def _elapsed_ms() -> int:
                        try:
                            return int((time.time() - request_start_time) * 1000)
                        except Exception:
                            return 0

                    def _encode_event(event_type: str, payload: Dict[str, Any]) -> bytes:
                        """Encode an SSE event.

                        IMPORTANT: the frontend expects each `data:` line to be a complete JSON object.
                        Do NOT chunk a JSON string across multiple `data:` lines (it breaks JSON parsing).
                        If we need chunking, chunk the *content field* into multiple `content` events instead.
                        """
                        payload = dict(payload or {})
                        if trace_id:
                            payload.setdefault("trace_id", trace_id)
                        if tenant_id:
                            payload.setdefault("tenant_id", tenant_id)
                        payload.setdefault("timestamp", datetime.now().isoformat())
                        payload.setdefault("elapsed_ms", _elapsed_ms())
                        data = json.dumps(payload, ensure_ascii=False, default=str)
                        return f"event: {event_type}\ndata: {data}\n\n".encode("utf-8")

                    try:
                        # Let the client know we're alive even before the model is loaded.
                        yield _encode_event("phase", {"phase": "init", "stage": "load_llm"})
                        llm = load_llm(settings)
                    except ValueError as e:
                        # Frontend expects `message`; keep `error` for backward compat.
                        error_data = json.dumps(
                            {"message": str(e), "error": str(e), "trace_id": trace_id, "tenant_id": tenant_id},
                            ensure_ascii=False,
                        )
                        yield f"event: error\ndata: {error_data}\n\n".encode("utf-8")
                        return

                    memory_system = Ah32MemorySystem()
                    # Tenant-scoped RAG vector store.
                    vector_store = None
                    try:
                        tenant_id = str(getattr(req.state, "tenant_id", "") or "").strip()
                        registry = getattr(req.app.state, "_tenant_vector_stores", None)
                        if registry is not None:
                            vector_store = registry.get_rag_store(tenant_id or str(getattr(settings, "default_tenant_id", "public") or "public"))
                        else:
                            vector_store = getattr(req.app.state, "_vector_store", None)
                    except Exception:
                        vector_store = getattr(req.app.state, "_vector_store", None)
                    # Tenant-scoped skills registry (server-managed; no client-sent skills_pack).
                    skills_registry = None
                    try:
                        tenant_id = str(getattr(req.state, "tenant_id", "") or "").strip()
                        tenant_mgr = getattr(req.app.state, "_tenant_skills_registry", None)
                        if tenant_mgr is not None:
                            skills_registry = tenant_mgr.get(
                                tenant_id or str(getattr(settings, "default_tenant_id", "public") or "public")
                            )
                        else:
                            skills_registry = getattr(req.app.state, "_skills_registry", None)
                    except Exception:
                        skills_registry = getattr(req.app.state, "_skills_registry", None)
                    tools = list(get_all_tools() or [])

                    # Client-sent skills packs are not supported in the current R&D architecture.

                    # Strong backend tools (only via LLM tool-call allowlist)
                    try:
                        from ah32.agents.agent_modules.network_agent_tools import WebFetchTool, BrowserSnapshotTool

                        tools.append(WebFetchTool())
                        tools.append(BrowserSnapshotTool())
                    except Exception as e:
                        logger.warning("[tools] init network tools failed (ignored): %s", e, exc_info=True)

                    if vector_store is not None:
                        try:
                            from ah32.agents.agent_modules.rag_agent_tools import (
                                RagSearchTool,
                                RagStatsTool,
                                RagListDocumentsTool,
                                RagIngestUrlTool,
                            )

                            tools.append(RagSearchTool(vector_store))
                            tools.append(RagStatsTool(vector_store))
                            tools.append(RagListDocumentsTool(vector_store))
                            tools.append(RagIngestUrlTool(vector_store))
                        except Exception as e:
                            logger.warning("[tools] init rag tools failed (ignored): %s", e, exc_info=True)

                    try:
                        from ah32.agents.agent_modules.mm_agent_tools import MmGenerateImageTool

                        tools.append(MmGenerateImageTool())
                    except Exception as e:
                        logger.warning("[tools] init multimodal tools failed (ignored): %s", e, exc_info=True)

                    # Apply backend LLM tool allowlist (env overrides default; "*" means allow all).
                    try:
                        from ah32.config import _default_llm_tool_allowlist

                        allow_raw = str(getattr(settings, "llm_tool_allowlist", "") or "").strip()
                        if not allow_raw:
                            allow_raw = str(_default_llm_tool_allowlist() or "").strip()
                        if allow_raw.lower() not in ("*", "all"):
                            allowed = {x.strip() for x in re.split(r"[,\n;]+", allow_raw) if x and str(x).strip()}
                            before_names = [getattr(t, "name", "") for t in tools or [] if getattr(t, "name", "")]
                            tools = [t for t in tools or [] if getattr(t, "name", None) in allowed]
                            missing = sorted(allowed - set(getattr(t, "name", "") for t in tools or []))
                            if missing:
                                logger.info("[tools] llm_tool_allowlist missing tool(s): %s", ",".join(missing))
                            logger.info(
                                "[tools] applied llm_tool_allowlist: kept=%s total_before=%s",
                                len(tools or []),
                                len(before_names),
                            )
                        else:
                            logger.info("[tools] llm_tool_allowlist=all")
                    except Exception as e:
                        logger.error("[tools] apply llm_tool_allowlist failed: %s", e, exc_info=True)
                    agent = ReActAgent(
                        llm,
                        tools,
                        memory_system,
                        vector_store=vector_store,
                        skills_registry=skills_registry,
                    )

                    # 流式聊天 - 真正调用AI系统
                    # Per-request debug toggles are gated by admin master switches.
                    show_thoughts, show_rag = _effective_stream_debug_flags(
                        query_params=req.query_params,
                        expose_agent_thoughts=settings.expose_agent_thoughts,
                        expose_rag_hits=settings.expose_rag_hits,
                    )

                    # Emit model metadata for diagnostics (best-effort; not shown in UI).
                    try:
                        llm_temp_raw = os.getenv("AH32_LLM_TEMPERATURE")
                        llm_temp = None
                        if llm_temp_raw:
                            try:
                                llm_temp = float(llm_temp_raw)
                            except Exception:
                                llm_temp = llm_temp_raw
                        meta_payload = {
                            "llm_model": str(getattr(settings, "llm_model", "") or ""),
                            "llm_temperature": llm_temp,
                            "embedding_model": str(getattr(settings, "embedding_model", "") or ""),
                            "show_thoughts": bool(show_thoughts),
                            "show_rag": bool(show_rag),
                        }
                        yield _encode_event("meta", meta_payload)
                        try:
                            from ah32._internal.failure_context_store import record_failure_context

                            record_failure_context(
                                session_id=request.session_id,
                                kind="server_meta",
                                data=meta_payload,
                                run_id="",
                            )
                        except Exception as e:
                            logger.debug("[failure_context] record meta failed: %s", e, exc_info=True)
                    except Exception as e:
                        logger.debug("[sse] emit meta failed: %s", e, exc_info=True)

                    try:
                        from ah32._internal.failure_context_store import record_failure_context

                        safe_frontend_context = _sanitize_frontend_context_for_failure_store(frontend_context_for_agent)
                        record_failure_context(
                            session_id=request.session_id,
                            kind="chat",
                            data={
                                "message": request.message,
                                "document_name": request.document_name,
                                "rule_files": request.rule_files,
                                "frontend_context": safe_frontend_context,
                                "show_thoughts": bool(show_thoughts),
                                "show_rag": bool(show_rag),
                            },
                            run_id="",
                        )
                    except Exception as e:
                        logger.debug("[failure_context] record chat failed: %s", e, exc_info=True)

                    # 动态感知：记录前端上下文
                    if isinstance(frontend_context_for_agent, dict):
                        logger.debug(f"收到前端动态感知: document={frontend_context_for_agent.get('document', {}).get('name')}, "
                                   f"cursor=第{frontend_context_for_agent.get('cursor', {}).get('page')}页, "
                                   f"hasSelection={frontend_context_for_agent.get('selection', {}).get('hasSelection')}")

                    yield _encode_event("phase", {"phase": "agent_ready", "stage": "stream_chat"})

                    # Heartbeat/phase wrapper: keep the SSE connection alive even when the agent is silent.
                    q: asyncio.Queue[dict] = asyncio.Queue()
                    producer_done = asyncio.Event()

                    async def _produce():
                        try:
                            async for ev in agent.stream_chat(
                                request.message,
                                request.session_id,
                                request.document_name,
                                frontend_context=frontend_context_for_agent,
                                rule_files=request.rule_files,
                                show_rag_hits=(settings.expose_rag_hits or show_rag),
                            ):
                                if isinstance(ev, dict):
                                    await q.put(ev)
                        except Exception as e:
                            await q.put({"type": "error", "message": str(e), "error": str(e), "content": ""})
                        finally:
                            producer_done.set()

                    producer_task = asyncio.create_task(_produce())
                    current_phase = "agent_ready"

                    def _map_phase(t: str) -> Optional[str]:
                        if t in ("thinking", "reasoning"):
                            return "thinking"
                        if t == "rag":
                            return "retrieval"
                        if t == "skills":
                            return "skills"
                        if t == "content":
                            return "responding"
                        if t == "done":
                            return "done"
                        if t == "error":
                            return "error"
                        if t == "start":
                            return "start"
                        return None

                    try:
                        while True:
                            # Client disconnected: stop immediately (do not keep burning LLM/tool tokens).
                            try:
                                if await req.is_disconnected():
                                    logger.info("[agentic-chat] client disconnected; stop streaming")
                                    break
                            except Exception as e:
                                logger.debug(
                                    "[agentic-chat] is_disconnected probe failed (ignored): %s",
                                    e,
                                    exc_info=True,
                                )

                            # If the agent doesn't emit anything for a while, send a heartbeat so the UI can show elapsed.
                            try:
                                ev = await asyncio.wait_for(q.get(), timeout=5.0)
                            except asyncio.TimeoutError:
                                try:
                                    if await req.is_disconnected():
                                        logger.info("[agentic-chat] client disconnected; stop emitting heartbeats")
                                        break
                                except Exception as e:
                                    logger.debug(
                                        "[agentic-chat] is_disconnected probe failed (ignored): %s",
                                        e,
                                        exc_info=True,
                                    )
                                yield _encode_event("heartbeat", {"phase": current_phase})
                                if producer_done.is_set() and q.empty():
                                    break
                                continue

                            event_type = (ev.get("type") or "content") if isinstance(ev, dict) else "content"
                            content = (ev.get("content") or "") if isinstance(ev, dict) else ""
                            session_id = (ev.get("session_id") or request.session_id) if isinstance(ev, dict) else request.session_id

                            try:
                                from ah32._internal.failure_context_store import record_failure_context

                                if event_type == "rag":
                                    record_failure_context(
                                        session_id=session_id,
                                        kind="rag",
                                        data={"summary": content},
                                        run_id="",
                                    )
                                elif event_type == "skills":
                                    record_failure_context(
                                        session_id=session_id,
                                        kind="skills",
                                        data={"skills": ev.get("skills") if isinstance(ev, dict) else None, "raw": content},
                                        run_id="",
                                    )
                            except Exception as e:
                                logger.debug("[failure_context] record stream event failed: %s", e, exc_info=True)

                            # filter debug events
                            if event_type in ("thinking", "reasoning") and not show_thoughts:
                                continue
                            if event_type == "rag" and not show_rag:
                                try:
                                    summary = str(content or "")
                                    if summary:
                                        if len(summary) > 2000:
                                            summary = summary[:2000] + "... [truncated]"
                                        yield _encode_event("rag_meta", {"content": summary, "hidden": True})
                                except Exception as e:
                                    logger.debug("[sse] rag_meta emit failed: %s", e, exc_info=True)
                                continue

                            next_phase = _map_phase(event_type)
                            if next_phase and next_phase != current_phase:
                                current_phase = next_phase
                                yield _encode_event("phase", {"phase": current_phase})

                            payload = dict(ev) if isinstance(ev, dict) else {}
                            payload.pop("type", None)
                            payload.setdefault("content", content)
                            payload["session_id"] = session_id

                            # Chunk large content safely: emit multiple `content` events with valid JSON.
                            try:
                                if event_type == "content":
                                    max_len = int(settings.chunk_size or 0) or 800
                                    c = str(payload.get("content") or "")
                                    if c and len(c) > max_len:
                                        for j in range(0, len(c), max_len):
                                            payload2 = dict(payload)
                                            payload2["content"] = c[j : j + max_len]
                                            yield _encode_event("content", payload2)
                                        continue
                            except Exception as e:
                                logger.debug(f"[sse] content chunking failed (ignored): {e}", exc_info=True)

                            yield _encode_event(event_type, payload)

                            if event_type == "error":
                                break
                            if event_type == "done":
                                break
                            if producer_done.is_set() and q.empty():
                                break
                    finally:
                        try:
                            producer_task.cancel()
                            try:
                                await producer_task
                            except asyncio.CancelledError:
                                # Expected on disconnect/cancellation.
                                pass
                        except Exception as e:
                            # Cancellation is best-effort; ignore but log for diagnosis.
                            logger.debug(f"[agentic-chat] cancel producer task failed: {e}", exc_info=True)

                    # 正常完成，记录响应时间
                    request_end_time = time.time()
                    request_duration = request_end_time - request_start_time
                    logger.info(
                        f"[响应时间监控] 请求正常完成时间: {datetime.fromtimestamp(request_end_time).strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                    logger.info(f"[响应时间监控] 总响应时间: {request_duration:.2f}秒")

                except asyncio.CancelledError:
                    # Client disconnected or request cancelled: stop without emitting "error".
                    request_end_time = time.time()
                    request_duration = request_end_time - request_start_time
                    logger.info(
                        f"[响应时间监控] 请求被取消: {datetime.fromtimestamp(request_end_time).strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                    logger.info(f"[响应时间监控] 总响应时间: {request_duration:.2f}秒")
                    return
                except Exception as e:
                    request_end_time = time.time()
                    request_duration = request_end_time - request_start_time
                    logger.error(f"流式生成错误: {e}")
                    logger.info(
                        f"[响应时间监控] 请求结束时间: {datetime.fromtimestamp(request_end_time).strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                    logger.info(f"[响应时间监控] 总响应时间: {request_duration:.2f}秒")
                    # Frontend expects `message`; keep `error` for backward compat.
                    error_data = json.dumps(
                        {"message": str(e), "error": str(e), "trace_id": trace_id, "tenant_id": tenant_id},
                        ensure_ascii=False,
                    )
                    yield f"event: error\ndata: {error_data}\n\n".encode("utf-8")
                finally:
                    # Privacy-first: delete doc snapshot immediately after the turn ends (or fails/cancels).
                    if snapshot_store is not None and snapshot_id:
                        try:
                            snapshot_store.delete(snapshot_id, reason="turn_end")
                        except Exception as e:
                            logger.warning(
                                "[doc_snapshot] delete after turn failed snapshot_id=%s err=%s",
                                snapshot_id,
                                e,
                                exc_info=True,
                            )

            return StreamingResponse(
                generate_stream(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                    "X-Stream-Timeout": "1800",  # 30分钟流式超时 - 防止断开
                    "Keep-Alive": "timeout=1800, max=10000"  # 30分钟长连接配置 - 防止断开
                }
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Agentic流式对话失败: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def get_agent_status(
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    """获取Agent状态"""
    try:
        from ah32.config import settings
        
        # 验证API密钥
        if not api_key or api_key != settings.api_key:
            raise HTTPException(status_code=401, detail="Invalid API Key")

        from ah32.core.tools import get_tool_registry

        # 获取所有已注册的工具
        tool_registry = get_tool_registry()
        all_tools = tool_registry.get_all_tools(enabled_only=True)

        # 检查关键工具是否可用
        key_tools = ["analyze_chapter", "analyze_document_pair", "assess_quality",
                     "assess_risks", "match_requirements", "read_document"]
        available_tools = [tool.name for tool in all_tools]

        return {
            "status": "ready",
            "agent_type": "react_agent",
            "capabilities": [
                "document_analysis",
                "risk_assessment",
                "quality_assessment",
                "dual_doc_matching",
                "generate_suggestions"
            ],
            "tools_count": len(available_tools),
            "available_tools": available_tools[:10],  # 只返回前10个
            "memory_enabled": True,
            "vector_store_enabled": True
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取Agent状态失败: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"获取状态失败: {str(e)}"
        )


class ClientSkillSummary(BaseModel):
    """Lightweight skill metadata for frontend routing (prompt-only; no scripts)."""

    id: str
    name: str
    version: str = "0.0.0"
    priority: int = 0
    description: str = ""
    group: str = ""
    default_writeback: str = ""
    hosts: list[str] = []
    tags: list[str] = []
    intents: list[str] = []
    triggers: list[str] = []
    examples: list[str] = []
    output_schema: str = ""
    style_spec_hints: str = ""
    prompt_text: Optional[str] = None


class ClientSkillsCatalogResponse(BaseModel):
    schema_version: str = "ah32.client_skills_catalog.v1"
    generated_at: str
    skills: list[ClientSkillSummary]


@router.get("/skills/catalog")
async def get_client_skills_catalog(
    req: Request,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
    include_prompt: bool = Query(default=False, description="Include prompt_text for each skill (truncated)."),
    max_prompt_chars: int = Query(default=6000, ge=0, le=20000),
):
    """Return client-owned skill routing metadata for deterministic frontend routing.

    Note: this endpoint MUST NOT execute any skill scripts. It only exposes manifest/routing hints.
    """
    try:
        from ah32.config import settings

        # Auth is enforced centrally for /agentic/* in server middleware.

        tenant_id = str(getattr(req.state, "tenant_id", "") or "").strip() or str(
            getattr(settings, "default_tenant_id", "public") or "public"
        ).strip()
        app_state = getattr(getattr(req, "app", None), "state", None)
        tenant_mgr = getattr(app_state, "_tenant_skills_registry", None) if app_state is not None else None
        if tenant_mgr is not None:
            skills_registry = tenant_mgr.get(tenant_id)
        else:
            skills_registry = getattr(app_state, "_skills_registry", None) if app_state is not None else None
        if skills_registry is None or not getattr(settings, "skills_enabled", True):
            return ClientSkillsCatalogResponse(generated_at=datetime.utcnow().isoformat() + "Z", skills=[])

        items: list[ClientSkillSummary] = []
        try:
            skills = skills_registry.list_skills()
        except Exception:
            skills = []

        for s in skills or []:
            try:
                if not getattr(s, "enabled", False):
                    continue
                prompt_text = None
                if include_prompt:
                    try:
                        prompt_text = s.load_prompt_text(max_prompt_chars)
                    except Exception:
                        prompt_text = None
                items.append(
                    ClientSkillSummary(
                        id=str(getattr(s, "skill_id", "") or ""),
                        name=str(getattr(s, "name", "") or ""),
                        version=str(getattr(s, "version", "") or "0.0.0"),
                        priority=int(getattr(s, "priority", 0) or 0),
                        description=str(getattr(s, "description", "") or ""),
                        group=str(getattr(s, "group", "") or ""),
                        default_writeback=str(getattr(s, "default_writeback", "") or ""),
                        hosts=[str(x) for x in (getattr(s, "hosts", None) or []) if str(x or "").strip()],
                        tags=[str(x) for x in (getattr(s, "tags", None) or []) if str(x or "").strip()],
                        intents=[str(x) for x in (getattr(s, "intents", None) or []) if str(x or "").strip()],
                        triggers=[str(x) for x in (getattr(s, "triggers", None) or []) if str(x or "").strip()],
                        examples=[str(x) for x in (getattr(s, "examples", None) or []) if str(x or "").strip()],
                        output_schema=str(getattr(s, "output_schema", "") or ""),
                        style_spec_hints=str(getattr(s, "style_spec_hints", "") or ""),
                        prompt_text=prompt_text,
                    )
                )
            except Exception:
                logger.debug("[skills] build client catalog item failed (ignored)", exc_info=True)

        # Stable ordering for UI diffing + caching.
        items.sort(key=lambda x: (x.priority, x.id), reverse=True)
        return ClientSkillsCatalogResponse(generated_at=datetime.utcnow().isoformat() + "Z", skills=items)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[skills] get_client_skills_catalog failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class ExecutionErrorReport(BaseModel):
    """执行错误报告模型"""
    error_type: str
    error_message: str
    error_code: str = ""  # 出错的代码片段
    correction_suggestion: str = ""
    user_context: str = ""  # 用户使用场景
    severity: str = "medium"
    # Optional run context / client hints (best-effort; helps reproduce failures).
    host_app: str = ""
    session_id: str = ""
    doc_id: str = ""
    doc_key: str = ""
    document_name: str = ""
    document_path: str = ""
    block_id: str = ""
    client_id: str = ""
    run_id: str = ""
    run_context: Optional[Dict[str, Any]] = None
    extra: Optional[Dict[str, Any]] = None


class AuditRecord(BaseModel):
    """Frontend execution audit trail (plan/js). Best-effort observability endpoint."""

    mode: str = "unknown"  # plan | js | unknown
    host_app: str = ""
    session_id: str = ""
    block_id: str = ""
    ops: Optional[list[str]] = None
    success: bool = False
    error_type: str = ""
    error_message: str = ""
    extra: Optional[Dict[str, Any]] = None


@router.post("/audit/record")
async def record_audit_event(
    request: AuditRecord,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """Receive frontend audit events for macro/plan execution.

    The frontend sends these for passive diagnostics; failures should never affect UX.
    """
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        # Keep the log compact.
        mode = str(request.mode or "unknown")
        host = str(request.host_app or "")
        block_id = str(request.block_id or "")
        ok = bool(request.success)
        ops = request.ops if isinstance(request.ops, list) else []
        ops_preview = ",".join([str(x) for x in ops[:12]])
        err_preview = (request.error_message or "").replace("\r", " ").replace("\n", " ")
        if len(err_preview) > 220:
            err_preview = err_preview[:220] + "..."
        logger.info(
            "[audit] mode=%s host=%s ok=%s block_id=%s ops=%s err=%s",
            mode,
            host,
            ok,
            block_id,
            ops_preview,
            err_preview,
        )

        # Persist in-memory audit for `/agentic/audit/summary` and `/agentic/audit/events` APIs.
        # NOTE: There is also a dedicated router in `ah32.server.audit_api` with the same path.
        # Keeping this write here ensures whichever route resolves in FastAPI still records events.
        audit_recorder.record(
            session_id=str(request.session_id or ""),
            host_app=str(request.host_app or "unknown"),
            mode=str(request.mode or "unknown"),
            block_id=str(request.block_id or ""),
            ops=request.ops if isinstance(request.ops, list) else [],
            success=bool(request.success),
            error_type=str(request.error_type or ""),
            error_message=str(request.error_message or ""),
            extra=request.extra if isinstance(request.extra, dict) else None,
        )
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[audit] record failed: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@router.post("/error/report")
async def report_execution_error(
    request: ExecutionErrorReport,
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    """接收前端JS宏执行错误，用于跨会话学习"""
    try:
        # 验证API密钥
        # Auth is enforced centrally for /agentic/* in server middleware.

        # Log a compact, privacy-conscious summary for debugging.
        msg_preview = (request.error_message or "").replace("\r", " ").replace("\n", " ")
        if len(msg_preview) > 200:
            msg_preview = msg_preview[:200] + "..."
        code_preview = (request.error_code or "").replace("\r", " ").replace("\n", " ")
        if len(code_preview) > 160:
            code_preview = code_preview[:160] + "..."
        logger.error(
            f"收到执行错误报告: {request.error_type} message={msg_preview} code={code_preview}"
        )

        # 导入错误记录函数
        from ah32.memory.code_quality_memory import record_and_analyze_error

        # 记录执行错误到记忆系统
        record_and_analyze_error(
            error_type=request.error_type,
            error_code=request.error_code,
            correction_suggestion=request.correction_suggestion,
            user_context=request.user_context,
            severity=request.severity,
            error_message=request.error_message,
        )

        # Persist a minimal repro bundle for offline analysis (best-effort).
        try:
            from ah32._internal.failure_bundles import save_failure_bundle
            from ah32._internal.failure_context_store import get_failure_context

            payload = request.model_dump()
            client_extra = payload.get("extra")
            if client_extra is None:
                client_extra = {}
            if not isinstance(client_extra, dict):
                client_extra = {"raw_extra": client_extra}

            try:
                server_ctx = get_failure_context(
                    session_id=str(request.session_id or ""),
                    run_id=str(request.run_id or ""),
                )
            except Exception:
                server_ctx = {}

            if not server_ctx:
                # Fallback: ensure we still capture baseline server metadata.
                llm_temp_raw = os.getenv("AH32_LLM_TEMPERATURE")
                llm_temp = None
                if llm_temp_raw:
                    try:
                        llm_temp = float(llm_temp_raw)
                    except Exception:
                        llm_temp = llm_temp_raw
                server_ctx = {
                    "session_id": str(request.session_id or ""),
                    "run_id": str(request.run_id or ""),
                    "context": {
                        "server_meta": {
                            "llm_model": str(getattr(settings, "llm_model", "") or ""),
                            "llm_temperature": llm_temp,
                            "embedding_model": str(getattr(settings, "embedding_model", "") or ""),
                        }
                    },
                }

            payload["extra"] = {
                "client_context": client_extra,
                "server_context": server_ctx,
            }

            save_failure_bundle(
                kind=str(request.error_type or "execution_error"),
                payload=payload,
                storage_root=settings.storage_root,
            )
        except Exception as e:
            logger.error("[failures] save bundle failed: %s", e, exc_info=True)

        # Telemetry (best-effort): keep error reports queryable via /dev/telemetry.
        try:
            from ah32.telemetry import RunContext, get_telemetry

            tsvc = get_telemetry()
            if tsvc:
                ctx = None
                if isinstance(request.run_context, dict) and request.run_context:
                    ctx = RunContext.from_any(request.run_context)
                else:
                    ctx = RunContext(
                        run_id=str(request.run_id or ""),
                        mode="macro",
                        host_app=str(request.host_app or ""),
                        doc_id=str(request.doc_id or ""),
                        doc_key=str(request.doc_key or ""),
                        session_id=str(request.session_id or ""),
                        block_id=str(request.block_id or ""),
                        client_id=str(request.client_id or ""),
                    )
                tsvc.emit(
                    "macro.error_report",
                    {
                        "error_type": request.error_type,
                        "error_message": request.error_message,
                        "severity": request.severity,
                        "has_code": bool(request.error_code),
                    },
                    ctx=ctx,
                )
        except Exception as e:
            logger.debug("[telemetry] emit macro.error_report failed: %s", e, exc_info=True)

        logger.info(f"执行错误已记录到记忆系统: {request.error_type}")

        return {
            "success": True,
            "message": "错误已成功记录，将用于改进未来代码生成",
            "error_type": request.error_type
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"记录执行错误失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class JSMacroVibeRequest(BaseModel):
    """JS宏Vibe Coding请求模型"""
    user_query: str  # 用户查询
    session_id: str  # 会话ID
    document_name: str = ""  # 文档名称
    host_app: str = "wps"  # wps(et/wpp) 宿主类型（用于提示词/修复策略）
    capabilities: Optional[Dict[str, Any]] = None  # 前端能力探针（可选）
    style_spec: Optional[Dict[str, Any]] = None  # 风格参数（可选，StyleSpec v1）


class JSMacroGenerateRequest(BaseModel):
    """单次 LLM 调用的 JS 宏生成（快路径，用于提升 0 修复成功率与减少 tokens）。"""

    user_query: str
    session_id: str
    document_name: str = ""
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None
    style_spec: Optional[Dict[str, Any]] = None


class JSMacroGenerateResponse(BaseModel):
    success: bool
    code: str = ""
    error: str = ""
    duration_ms: int = 0


class JSMacroVibeResponse(BaseModel):
    """JS宏Vibe Coding响应模型"""
    success: bool
    code: str = ""  # 最终生成的代码
    visual_steps: list = []  # 可视化步骤
    attempt_count: int = 0  # 尝试次数
    execution_result: Optional[Dict[str, Any]] = None  # 执行结果
    error: str = ""  # 错误信息（如果有）


class JSPlanVibeRequest(BaseModel):
    """Plan Vibe Coding request model (stream-only)."""

    user_query: str
    session_id: str
    document_name: str = ""
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None
    style_spec: Optional[Dict[str, Any]] = None


class JSMacroRepairRequest(BaseModel):
    """前端 JS 宏执行失败后的快速修复请求（不走完整工作流）。"""

    session_id: str
    document_name: str = ""
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None
    style_spec: Optional[Dict[str, Any]] = None
    attempt: int = 1
    error_type: str
    error_message: str
    code: str


class JSMacroRepairResponse(BaseModel):
    """快速修复响应"""

    success: bool
    code: str = ""
    error: str = ""


@router.post("/js-macro/generate")
async def js_macro_generate(
    request: JSMacroGenerateRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """生成 JS 宏代码（快路径：单次 LLM 调用，不跑完整 Vibe Coding 工作流）。"""
    t0 = time.perf_counter()
    host = (request.host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"

    try:
        try:
            logger.info(
                "[js-macro/generate] start session_id=%s host=%s query_len=%s",
                request.session_id,
                host,
                len(request.user_query or ""),
            )
        except Exception as e:
            logger.warning(f"[js-macro/generate] start log failed: {e}", exc_info=True)

        # Auth is enforced centrally for /agentic/* in server middleware.

        try:
            from ah32._internal.failure_context_store import record_failure_context

            record_failure_context(
                session_id=request.session_id,
                kind="js_macro_generate",
                data={
                    "user_query": request.user_query,
                    "document_name": request.document_name,
                    "host_app": host,
                    "capabilities": request.capabilities,
                    "style_spec": request.style_spec,
                },
                run_id="",
            )
        except Exception as e:
            logger.debug("[failure_context] record js_macro_generate failed: %s", e, exc_info=True)

        # JS macro generation is latency-sensitive. Prefer a faster model by default,
        # without forcing the global chat model to change.
        try:
            macro_model = (os.getenv("AH32_JS_MACRO_MODEL") or "").strip()
            if not macro_model:
                base_model = str(getattr(settings, "llm_model", "") or os.getenv("AH32_LLM_MODEL") or "").strip()
                macro_model = (
                    "deepseek-chat"
                    if "deepseek-reasoner" in base_model.lower()
                    else (base_model or "deepseek-chat")
                )

            macro_temp_raw = (os.getenv("AH32_JS_MACRO_TEMPERATURE") or "").strip()
            macro_temp = float(macro_temp_raw) if macro_temp_raw else 0.2

            llm = load_llm_custom(settings, model=macro_model, temperature=macro_temp)
            try:
                from ah32._internal.failure_context_store import record_failure_context

                record_failure_context(
                    session_id=request.session_id,
                    kind="server_meta",
                    data={
                        "js_macro_model": macro_model,
                        "js_macro_temperature": macro_temp,
                    },
                    run_id="",
                )
            except Exception as e:
                logger.debug("[failure_context] record js_macro_model failed: %s", e, exc_info=True)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        from ah32.services.wps_js_prompts import get_wps_js_macro_generation_prompt

        target = "WPS Writer" if host == "wps" else ("WPS 表格(ET)" if host == "et" else "WPS 演示(WPP)")
        system = (
            f"你是一个 {target} 的 JS 宏代码生成专家。"
            "只返回可直接执行的 JavaScript（不是 TypeScript）。"
            "仅使用 ES5 语法：只用 var/function/for/try-catch；禁止 let/const、=>、class、async/await。"
            "禁止使用模板字符串（反引号 `），请使用字符串拼接。"
            "不要输出 HTML/解释性文字/多余 Markdown（除 ```javascript``` 围栏外）。"
            "只实现当前用户需求这一件事；不要输出多套备用方案/不要把多个需求塞到同一个脚本里；尽量短小。"
            "注意：BID.upsertBlock 正确签名是 BID.upsertBlock(blockId, function(){...}, opts?)；"
            "不要写成 BID.upsertBlock({id, content})。"
        )

        style_spec_text = "（无）"
        try:
            from ah32.style_spec import normalize_style_spec

            caps = request.capabilities or {}
            raw_style_spec = request.style_spec or caps.get("style_spec") or caps.get("styleSpec")
            style_spec = normalize_style_spec(raw_style_spec, host_app=host)
            if style_spec:
                style_spec_text = json.dumps(style_spec, ensure_ascii=False, indent=2, default=str)
                if len(style_spec_text) > 1800:
                    style_spec_text = style_spec_text[:1800] + "\n... (truncated)"
        except Exception as e:
            logger.debug(f"[js-macro/generate] normalize styleSpec failed: {e}", exc_info=True)
            style_spec_text = "（无）"

        prompt = get_wps_js_macro_generation_prompt(host).format(
            query=request.user_query,
            style_spec=style_spec_text,
        )

        caps = request.capabilities
        if caps:
            try:
                caps_json = json.dumps(caps, ensure_ascii=False, default=str)
                if len(caps_json) > 1200:
                    caps_json = caps_json[:1200] + "...(truncated)"
                prompt += (
                    "\n\n当前宿主能力探针（可能不完整，仅作参考）：\n"
                    + caps_json
                    + "\n\n请优先选择探针显示存在/可用的 API；如果某能力为 false/缺失，请改用更通用的替代方案。"
                )
            except Exception as e:
                logger.warning(f"[js-macro/generate] serialize capabilities failed: {e}", exc_info=True)

        # Compact learned hints (Top-K) to reduce repeated syntax/API mistakes without prompt bloat.
        try:
            from ah32.memory.code_quality_memory import get_code_quality_memory

            hints = get_code_quality_memory().get_prompt_hints(error_type=None, limit=3, max_chars=500)
            if hints:
                prompt += "\n\n历史高频错误预防规则（Top-K）：\n" + hints
        except Exception as e:
            logger.warning(f"[js-macro/generate] load code-quality hints failed: {e}", exc_info=True)

        resp = await llm.ainvoke([("system", system), ("user", prompt)])
        raw = getattr(resp, "content", "") or str(resp)
        code = _extract_javascript_code(raw).strip()
        if not code:
            out = JSMacroGenerateResponse(
                success=False,
                error="empty model response",
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
            metrics_recorder.record(
                op="js_macro_generate",
                success=out.success,
                duration_ms=out.duration_ms,
                extra={"host_app": host},
            )
            return out

        code2, _notes = sanitize_wps_js(code)
        code2 = code2.strip()
        if code2:
            code = code2

        reason = _unsupported_js_reason(code)
        if reason:
            out = JSMacroGenerateResponse(
                success=False,
                error=f"unsupported_js_syntax:{reason}",
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
            metrics_recorder.record(
                op="js_macro_generate",
                success=out.success,
                duration_ms=out.duration_ms,
                extra={"host_app": host, "reason": reason},
            )
            return out

        if not looks_like_wps_js_macro(code):
            out = JSMacroGenerateResponse(
                success=False,
                error="model returned non-macro content",
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
            metrics_recorder.record(
                op="js_macro_generate",
                success=out.success,
                duration_ms=out.duration_ms,
                extra={"host_app": host},
            )
            return out

        out = JSMacroGenerateResponse(
            success=True,
            code=code,
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
        try:
            from ah32._internal.failure_context_store import record_failure_context

            code_hash = hashlib.sha1((out.code or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
            record_failure_context(
                session_id=request.session_id,
                kind="js_macro_generate_result",
                data={
                    "success": True,
                    "duration_ms": out.duration_ms,
                    "code_hash": code_hash,
                    "code_preview": (out.code or "")[:2000],
                },
                run_id="",
            )
        except Exception as e:
            logger.debug("[failure_context] record js_macro_generate_result failed: %s", e, exc_info=True)
        try:
            logger.info(
                "[js-macro/generate] done success=%s duration_ms=%s code_len=%s",
                out.success,
                out.duration_ms,
                len(out.code or ""),
            )
        except Exception as e:
            logger.warning(f"[js-macro/generate] done log failed: {e}", exc_info=True)

        # Dev-only: dump full payload for bench sessions to help debugging parse failures without bloating logs.
        try:
            sid = str(request.session_id or "")
            if os.getenv("AH32_SAVE_MACRO_DEBUG", "").lower() in ("1", "true", "yes"):
                dump_dir = Path(settings.storage_root) / "macro_debug"
                dump_dir.mkdir(parents=True, exist_ok=True)
                safe_sid = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", sid)[:120] or "session"
                stem = f"{safe_sid}_{host}_generate"
                (dump_dir / f"{stem}.js").write_text(out.code or "", encoding="utf-8")
                (dump_dir / f"{stem}.json").write_text(
                    json.dumps(
                        {
                            "session_id": sid,
                            "host_app": host,
                            "document_name": request.document_name,
                            "query": request.user_query,
                            "duration_ms": out.duration_ms,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
        except Exception as e:
            logger.warning(f"[js-macro/generate] failed to dump debug payload: {e}", exc_info=True)

        metrics_recorder.record(
            op="js_macro_generate",
            success=out.success,
            duration_ms=out.duration_ms,
            extra={"host_app": host},
        )
        return out

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[js-macro/generate] failed: {e}", exc_info=True)
        out = JSMacroGenerateResponse(
            success=False,
            error=str(e),
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
        try:
            metrics_recorder.record(
                op="js_macro_generate",
                success=out.success,
                duration_ms=out.duration_ms,
                extra={"host_app": host, "error": str(e)[:200]},
            )
        except Exception as e2:
            logger.warning(f"[js-macro/generate] metrics record failed: {e2}", exc_info=True)
        return out


@router.post("/js-macro/repair")
async def js_macro_repair(
    request: JSMacroRepairRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """修复 JS 宏代码（快路径）

    说明：
    - 用于前端“自动修复循环”，避免每次都跑完整的 Vibe Coding 工作流。
    - 只返回一个可执行的 JS 代码块（或纯 JS）。
    """
    t0 = time.perf_counter()
    host = (request.host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"
    try:
        logger.info(
            "[js-macro/repair] start session_id=%s host=%s attempt=%s error_type=%s code_len=%s",
            request.session_id,
            host,
            request.attempt,
            request.error_type,
            len(request.code or ""),
        )
    except Exception as e:
        logger.warning(f"[js-macro/repair] start log failed: {e}", exc_info=True)

    # Dev-only: dump full repair input for bench sessions to help root-cause syntax errors.
    try:
        sid = str(request.session_id or "")
        if os.getenv("AH32_SAVE_MACRO_DEBUG", "").lower() in ("1", "true", "yes"):
            dump_dir = Path(settings.storage_root) / "macro_debug"
            dump_dir.mkdir(parents=True, exist_ok=True)
            safe_sid = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", sid)[:120] or "session"
            stem = f"{safe_sid}_{host}_repair_{int(request.attempt or 0)}"
            (dump_dir / f"{stem}.in.js").write_text(request.code or "", encoding="utf-8")
            (dump_dir / f"{stem}.in.json").write_text(
                json.dumps(
                    {
                        "session_id": sid,
                        "host_app": host,
                        "document_name": request.document_name,
                        "attempt": request.attempt,
                        "error_type": request.error_type,
                         "error_message": request.error_message,
                         "capabilities": request.capabilities,
                         "style_spec": request.style_spec,
                     },
                     ensure_ascii=False,
                     indent=2,
                 ),
                encoding="utf-8",
            )
    except Exception as e:
        logger.warning(f"[js-macro/repair] failed to dump input payload: {e}", exc_info=True)
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        try:
            from ah32._internal.failure_context_store import record_failure_context

            code_hash = hashlib.sha1((request.code or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
            record_failure_context(
                session_id=request.session_id,
                kind="js_macro_repair",
                data={
                    "document_name": request.document_name,
                    "host_app": host,
                    "attempt": request.attempt,
                    "error_type": request.error_type,
                    "error_message": request.error_message,
                    "code_hash": code_hash,
                    "code_preview": (request.code or "")[:2000],
                    "capabilities": request.capabilities,
                    "style_spec": request.style_spec,
                },
                run_id="",
            )
        except Exception as e:
            logger.debug("[failure_context] record js_macro_repair failed: %s", e, exc_info=True)

        # JS macro repair is latency-sensitive. Prefer a faster model by default,
        # without forcing the global chat model to change.
        try:
            macro_model = (os.getenv("AH32_JS_MACRO_MODEL") or "").strip()
            if not macro_model:
                base_model = str(getattr(settings, "llm_model", "") or os.getenv("AH32_LLM_MODEL") or "").strip()
                macro_model = (
                    "deepseek-chat"
                    if "deepseek-reasoner" in base_model.lower()
                    else (base_model or "deepseek-chat")
                )

            macro_temp_raw = (os.getenv("AH32_JS_MACRO_TEMPERATURE") or "").strip()
            macro_temp = float(macro_temp_raw) if macro_temp_raw else 0.2

            llm = load_llm_custom(settings, model=macro_model, temperature=macro_temp)
            try:
                from ah32._internal.failure_context_store import record_failure_context

                record_failure_context(
                    session_id=request.session_id,
                    kind="server_meta",
                    data={
                        "js_macro_model": macro_model,
                        "js_macro_temperature": macro_temp,
                    },
                    run_id="",
                )
            except Exception as e:
                logger.debug("[failure_context] record js_macro_model failed: %s", e, exc_info=True)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        target = "WPS Writer" if host == "wps" else ("WPS 表格(ET)" if host == "et" else "WPS 演示(WPP)")
        api_constraint = (
            "必须使用 window.Application / app.ActiveDocument / app.Selection"
            if host == "wps"
            else ("必须使用 window.Application / app.ActiveWorkbook / app.ActiveSheet / app.Selection" if host == "et"
                  else "必须使用 window.Application / app.ActivePresentation / app.Selection")
        )
        bid_hint = (
            "- 你可以使用运行时已注入的 BID 帮助对象：\n"
            "  - Writer: BID.upsertBlock(blockId, fn, opts?)/insertTable/insertChartFromSelection/insertWordArt\n"
            "    - BID.insertTable(rows, cols, opts?)：插入表格（不接收 blockId，也不接收回调函数）\n"
            "    - BID.insertWordArt(text, opts?)：插入艺术字；opts 常用字段 font/size/bold/italic/preset\n"
            "    - BID.insertChartFromSelection(opts?)：基于当前选区插入图表（失败请 throw，便于继续修复）\n"
            "  - ET/WPP: BID.upsertBlock（把产物绑定到独立工作表/幻灯片，重跑自动清空）\n\n"
        )

        try:
            from ah32.memory.code_quality_memory import get_code_quality_memory

            _mem_hints = get_code_quality_memory().get_prompt_hints(
                error_type=request.error_type, limit=4, max_chars=700
            )
        except Exception:
            _mem_hints = ""

        system_parts = [
            (
                f"你是{target} 的 JS 宏代码修复专家。你的任务是：根据错误信息修复用户的 JS 宏，使其能在 WPS 任务窗格环境执行。"
                "只修改必要部分，尽量保持原意不变。"
            ),
            "硬约束：",
            f"- {api_constraint}；",
            "- 仅使用 ES5 语法：只用 var/function/for/try-catch；禁止 let/const、=>、class、async/await；",
            "- 不允许 VBA 语法；不允许 TypeScript 语法（类型注解/interface/type/as/非空断言!）；",
            "- 语法符号必须使用半角字符；字符串分隔符只能使用 ' 或 \"（禁止使用中文全角括号/逗号/分号/花引号等作为语法符号）；",
            "- 不要使用模板字符串（反引号 `，即 template literal）。如需拼接多行文本，用数组 + '\\n' 连接，避免任何 ` 出现在脚本中；",
            "- 禁止在代码中输出字面 \\n/\\r 作为“独立 token”（例如 `'',\\n 'x'` 或 `'x'\\n ];` 这种是无效 JS，会导致 SyntaxError）。需要换行就真的换行；需要“字符串里的换行”只能用 '\\\\n' 作为字符串内容；",
            "- 所有 JSAPI 调用用 try/catch 包裹，失败时 throw，便于进入下一轮修复；",
            "- BID.upsertBlock 正确签名是 BID.upsertBlock(blockId, fn, opts?)；不要写成 BID.upsertBlock({ id, content })；",
            bid_hint.rstrip(),
        ]
        if host == "wpp":
            system_parts.append(
                "- WPP 兼容性提示：若使用 BID.upsertBlock，请不要在回调里手动调用 pres.Slides.Add(...) 创建新页；BID.upsertBlock 已负责创建/定位当前产物幻灯片。请改为获取当前页并写入内容（如 app.ActiveWindow.View.Slide）。"
            )
        if _mem_hints:
            system_parts.append(f"历史高频错误修复规则（Top-K）：\n{_mem_hints}".rstrip())
        system_parts.append("输出格式：只返回一个 ```javascript``` 代码块，不要输出任何解释文本。")
        system = "\n".join(system_parts).strip() + "\n"

        style_spec_text = "（无）"
        try:
            from ah32.style_spec import normalize_style_spec

            caps = request.capabilities or {}
            raw_style_spec = request.style_spec or caps.get("style_spec") or caps.get("styleSpec")
            style_spec = normalize_style_spec(raw_style_spec, host_app=host)
            if style_spec:
                style_spec_text = json.dumps(style_spec, ensure_ascii=False, indent=2, default=str)
                if len(style_spec_text) > 1800:
                    style_spec_text = style_spec_text[:1800] + "\n... (truncated)"
        except Exception as e:
            logger.debug(f"[js-macro/repair] normalize styleSpec failed: {e}", exc_info=True)
            style_spec_text = "（无）"

        user = (
            f"session_id: {request.session_id}\n"
            f"document_name: {request.document_name}\n"
            f"host_app: {request.host_app}\n"
            f"capabilities: {json.dumps(request.capabilities, ensure_ascii=False, default=str) if request.capabilities else ''}\n"
            f"style_spec: {style_spec_text}\n"
            f"attempt: {request.attempt}\n\n"
            f"error_type: {request.error_type}\n"
            f"error_message: {request.error_message}\n\n"
            "原代码：\n"
            "```javascript\n"
            f"{request.code}\n"
            "```"
        )

        response = await llm.ainvoke([("system", system), ("user", user)])
        fixed = _extract_javascript_code(getattr(response, "content", "") or "")
        fixed = fixed.strip()
        if not fixed:
            resp = JSMacroRepairResponse(success=False, error="empty model response")
            metrics_recorder.record(
                op="js_macro_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            try:
                logger.info(
                    "[js-macro/repair] done success=%s duration_ms=%s error=%s",
                    resp.success,
                    int((time.perf_counter() - t0) * 1000),
                    resp.error,
                )
            except Exception as e:
                logger.warning(f"[js-macro/repair] log error summary failed: {e}", exc_info=True)
            return resp

        # Backend best-effort sanitization: remove TS/ESM-only syntax + normalize punctuation.
        fixed_sanitized, notes = sanitize_wps_js(fixed)
        fixed_sanitized = fixed_sanitized.strip()
        if fixed_sanitized and fixed_sanitized != fixed:
            logger.info(f"JS宏修复输出已做本地清洗: {notes[:3]}{'...' if len(notes) > 3 else ''}")
            fixed = fixed_sanitized

        reason = _unsupported_js_reason(fixed)
        if reason:
            resp = JSMacroRepairResponse(success=False, error=f"unsupported_js_syntax:{reason}")
            metrics_recorder.record(
                op="js_macro_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host, "reason": reason},
            )
            try:
                logger.info(
                    "[js-macro/repair] done success=%s duration_ms=%s error=%s",
                    resp.success,
                    int((time.perf_counter() - t0) * 1000),
                    resp.error,
                )
            except Exception as e:
                logger.warning(f"[js-macro/repair] log error summary failed: {e}", exc_info=True)
            return resp

        # Guard: if the model still didn't return something that looks like a macro, fail fast.
        if not looks_like_wps_js_macro(fixed):
            resp = JSMacroRepairResponse(success=False, error="model returned non-macro content")
            metrics_recorder.record(
                op="js_macro_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            try:
                logger.info(
                    "[js-macro/repair] done success=%s duration_ms=%s error=%s",
                    resp.success,
                    int((time.perf_counter() - t0) * 1000),
                    resp.error,
                )
            except Exception as e:
                logger.warning(f"[js-macro/repair] log error summary failed: {e}", exc_info=True)
            return resp

        # Best-effort: avoid returning the exact same code to prevent infinite loops.
        if fixed.strip() == (request.code or "").strip():
            resp = JSMacroRepairResponse(success=False, error="model returned identical code")
            metrics_recorder.record(
                op="js_macro_repair",
                success=resp.success,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                extra={"host_app": host},
            )
            try:
                logger.info(
                    "[js-macro/repair] done success=%s duration_ms=%s error=%s",
                    resp.success,
                    int((time.perf_counter() - t0) * 1000),
                    resp.error,
                )
            except Exception as e:
                logger.warning(f"[js-macro/repair] log error summary failed: {e}", exc_info=True)
            return resp

        resp = JSMacroRepairResponse(success=True, code=fixed)
        try:
            from ah32._internal.failure_context_store import record_failure_context

            code_hash = hashlib.sha1((resp.code or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
            record_failure_context(
                session_id=request.session_id,
                kind="js_macro_repair_result",
                data={
                    "success": True,
                    "duration_ms": int((time.perf_counter() - t0) * 1000),
                    "code_hash": code_hash,
                    "code_preview": (resp.code or "")[:2000],
                },
                run_id="",
            )
        except Exception as e:
            logger.debug("[failure_context] record js_macro_repair_result failed: %s", e, exc_info=True)
        metrics_recorder.record(
            op="js_macro_repair",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        # Dev-only: save the repaired output for bench sessions.
        try:
            sid = str(request.session_id or "")
            if os.getenv("AH32_SAVE_MACRO_DEBUG", "").lower() in ("1", "true", "yes"):
                dump_dir = Path(settings.storage_root) / "macro_debug"
                dump_dir.mkdir(parents=True, exist_ok=True)
                safe_sid = re.sub(r"[^a-zA-Z0-9_.:-]+", "_", sid)[:120] or "session"
                stem = f"{safe_sid}_{host}_repair_{int(request.attempt or 0)}"
                (dump_dir / f"{stem}.out.js").write_text(resp.code or "", encoding="utf-8")
        except Exception as e:
            logger.warning(f"[js-macro/repair] failed to dump debug macro: {e}", exc_info=True)
        try:
            logger.info(
                "[js-macro/repair] done success=%s duration_ms=%s code_len=%s",
                resp.success,
                int((time.perf_counter() - t0) * 1000),
                len(resp.code or ""),
            )
        except Exception as e:
            logger.warning(f"[js-macro/repair] log summary failed: {e}", exc_info=True)
        return resp

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"JS宏快速修复失败: {e}", exc_info=True)
        resp = JSMacroRepairResponse(success=False, error=str(e))
        metrics_recorder.record(
            op="js_macro_repair",
            success=resp.success,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            extra={"host_app": host},
        )
        try:
            logger.info(
                "[js-macro/repair] done success=%s duration_ms=%s error=%s",
                resp.success,
                int((time.perf_counter() - t0) * 1000),
                resp.error,
            )
        except Exception as e:
            logger.warning(f"[js-macro/repair] log error summary failed: {e}", exc_info=True)
        return resp


@router.post("/js-macro/vibe-coding")
async def js_macro_vibe_coding(
    request: JSMacroVibeRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    """JS宏Vibe Coding可视化处理端点"""
    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        logger.info(f"收到JS宏Vibe Coding请求: {request.user_query[:50]}...")

        # 加载LLM
        try:
            llm = load_llm(settings)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # 导入Vibe Coding工作流
        from ah32.agents.react_agent.js_macro_workflow import JSMacroVibeWorkflow

        # 创建工作流实例
        workflow = JSMacroVibeWorkflow(llm=llm)

        # 收集可视化步骤
        visual_steps = []
        final_code = ""
        attempt_count = 0
        success = False
        execution_result = None

        # 执行Vibe Coding工作流
        try:
            from ah32.style_spec import normalize_style_spec

            raw_style_spec = request.style_spec or (request.capabilities or {}).get("style_spec") or (request.capabilities or {}).get("styleSpec")
            style_spec = normalize_style_spec(raw_style_spec, host_app=request.host_app)
        except Exception:
            style_spec = None

        async for event in workflow.process_with_visualization(
            request.user_query,
            request.session_id,
            request.host_app,
            request.capabilities,
            style_spec=style_spec,
        ):
            if event["type"] == "visual_step":
                # 收集可视化步骤
                visual_steps.append(event["step"])
                logger.info(f"[Vibe Coding] {event['step']['type']}: {event['step']['content']}")

            elif event["type"] == "final_result":
                # 最终结果
                result = event["result"]
                success = result["success"]
                final_code = result["code"]
                attempt_count = result["attempt_count"]
                execution_result = result.get("execution_result")

        logger.info(f"JS宏Vibe Coding完成: 成功={success}, 尝试次数={attempt_count}")

        # 返回结果
        response = JSMacroVibeResponse(
            success=success,
            code=final_code,
            visual_steps=visual_steps,
            attempt_count=attempt_count,
            execution_result=execution_result
        )

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"JS宏Vibe Coding失败: {e}", exc_info=True)
        return JSMacroVibeResponse(
            success=False,
            error=str(e)
        )


@router.post("/js-macro/vibe-coding/stream")
async def js_macro_vibe_coding_stream(
    request: JSMacroVibeRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key")
):
    """JS宏Vibe Coding流式可视化端点"""
    try:
        t0 = time.perf_counter()
        # Auth is enforced centrally for /agentic/* in server middleware.

        try:
            from ah32._internal.failure_context_store import record_failure_context

            record_failure_context(
                session_id=request.session_id,
                kind="js_macro_vibe_stream",
                data={
                    "user_query": request.user_query,
                    "document_name": request.document_name,
                    "host_app": request.host_app,
                    "capabilities": request.capabilities,
                    "style_spec": request.style_spec,
                },
                run_id="",
            )
        except Exception as e:
            logger.debug("[failure_context] record js_macro_vibe_stream failed: %s", e, exc_info=True)

        try:
            logger.info(
                "[js-macro/vibe-coding/stream] start session_id=%s host=%s query=%s",
                request.session_id,
                (request.host_app or "wps"),
                (request.user_query or "")[:80],
            )
        except Exception:
            logger.info(f"收到JS宏Vibe Coding流式请求: {request.user_query[:50]}...")

        # 加载LLM
        try:
            llm = load_llm(settings)
            try:
                llm_temp_raw = os.getenv("AH32_LLM_TEMPERATURE")
                llm_temp = None
                if llm_temp_raw:
                    try:
                        llm_temp = float(llm_temp_raw)
                    except Exception:
                        llm_temp = llm_temp_raw
                from ah32._internal.failure_context_store import record_failure_context

                record_failure_context(
                    session_id=request.session_id,
                    kind="server_meta",
                    data={
                        "llm_model": str(getattr(settings, "llm_model", "") or ""),
                        "llm_temperature": llm_temp,
                        "embedding_model": str(getattr(settings, "embedding_model", "") or ""),
                    },
                    run_id="",
                )
            except Exception as e:
                logger.debug("[failure_context] record js_macro_vibe meta failed: %s", e, exc_info=True)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # 导入Vibe Coding工作流
        from ah32.agents.react_agent.js_macro_workflow import JSMacroVibeWorkflow

        # 创建工作流实例
        workflow = JSMacroVibeWorkflow(llm=llm)

        async def event_generator():
            """生成流式事件"""
            try:
                try:
                    from ah32.style_spec import normalize_style_spec

                    raw_style_spec = request.style_spec or (request.capabilities or {}).get("style_spec") or (request.capabilities or {}).get("styleSpec")
                    style_spec = normalize_style_spec(raw_style_spec, host_app=request.host_app)
                except Exception:
                    style_spec = None

                # 执行Vibe Coding工作流
                async for event in workflow.process_with_visualization(
                    request.user_query,
                    request.session_id,
                    request.host_app,
                    request.capabilities,
                    style_spec=style_spec,
                ):
                    # 发送SSE格式的事件
                    yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"

                # 发送结束信号
                yield "data: [DONE]\n\n"
                try:
                    metrics_recorder.record(
                        op="js_macro_vibe_stream",
                        success=True,
                        duration_ms=int((time.perf_counter() - t0) * 1000),
                        extra={"host_app": (request.host_app or "wps")},
                    )
                except Exception as e:
                    logger.warning(f"[js-macro/vibe/stream] metrics record failed: {e}", exc_info=True)

            except asyncio.CancelledError:
                # Client disconnected / user cancelled: normal control flow, do not log as error.
                return
            except Exception as e:
                # Some runtimes wrap cancellation in other exception classes (anyio cancel scope).
                try:
                    import anyio  # type: ignore
                    cancelled_exc = anyio.get_cancelled_exc_class()
                except Exception as e:
                    cancelled_exc = None
                    logger.debug(f"[js-macro/vibe/stream] anyio cancellation probe failed: {e}", exc_info=True)
                if cancelled_exc and isinstance(e, cancelled_exc):
                    return
                logger.error(f"流式事件生成失败: {e}")
                error_event = {
                    "type": "error",
                    "error": str(e),
                    "timestamp": time.time()
                }
                yield f"data: {json.dumps(error_event, ensure_ascii=False, default=str)}\n\n"
                try:
                    metrics_recorder.record(
                        op="js_macro_vibe_stream",
                        success=False,
                        duration_ms=int((time.perf_counter() - t0) * 1000),
                        extra={"host_app": (request.host_app or "wps"), "error": str(e)[:200]},
                    )
                except Exception as e2:
                    logger.warning(f"[js-macro/vibe/stream] metrics record failed: {e2}", exc_info=True)

        # 返回流式响应
        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"JS宏Vibe Coding流式处理失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/js-plan/vibe-coding/stream")
async def js_plan_vibe_coding_stream(
    request: JSPlanVibeRequest,
    api_key: Optional[str] = Header(None, alias="X-API-Key"),
):
    """Plan Vibe Coding stream endpoint: emits visual_step + final_result.plan events."""
    t0 = time.perf_counter()
    host = (request.host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"

    try:
        # Auth is enforced centrally for /agentic/* in server middleware.

        try:
            llm = load_llm(settings)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        from ah32.plan.schema import Plan

        async def event_generator():
            attempt = 1
            max_attempts = 3
            error_type = "execution_error"
            error_message = ""
            original_plan_obj: Dict[str, Any] = {}

            def step(step_type: str, title: str, content: str, status: str = "processing") -> Dict[str, Any]:
                return {
                    "type": step_type,
                    "title": title,
                    "content": content,
                    "status": status,
                    "timestamp": int(time.time() * 1000),
                }

            try:
                while attempt <= max_attempts:
                    if attempt == 1:
                        system = get_plan_generation_prompt(host)
                        user = (
                            f"""session_id: {request.session_id}
document_name: {request.document_name}
host_app: {host}
capabilities: {json.dumps(request.capabilities, ensure_ascii=False, default=str) if request.capabilities else ''}

User request:
{request.user_query}
"""
                        )
                        yield "data: " + json.dumps(
                            {"type": "visual_step", "step": step("generating", "Generate Plan", "Calling LLM to generate Plan JSON")},
                            ensure_ascii=False,
                            default=str,
                        ) + "\n\n"
                    else:
                        system = get_plan_repair_prompt(host)
                        user = (
                            f"""session_id: {request.session_id}
document_name: {request.document_name}
host_app: {host}
capabilities: {json.dumps(request.capabilities, ensure_ascii=False, default=str) if request.capabilities else ''}
attempt: {attempt}

error_type: {error_type}
error_message: {error_message}

Original plan:
{json.dumps(original_plan_obj, ensure_ascii=False, default=str)}
"""
                        )
                        yield "data: " + json.dumps(
                            {
                                "type": "visual_step",
                                "step": step("fixing", f"Repair Plan (try {attempt - 1})", "Calling LLM to repair Plan JSON"),
                            },
                            ensure_ascii=False,
                            default=str,
                        ) + "\n\n"

                    response = await llm.ainvoke([("system", system), ("user", user)])
                    raw = (getattr(response, "content", "") or "").strip()
                    payload = _extract_json_payload(raw)
                    if not payload:
                        error_type = "empty_model_response"
                        error_message = "empty model response"
                        original_plan_obj = {}
                        attempt += 1
                        continue

                    try:
                        original_plan_obj = json.loads(payload)
                        if not isinstance(original_plan_obj, dict):
                            original_plan_obj = {}
                    except Exception:
                        original_plan_obj = {}

                    yield "data: " + json.dumps(
                        {"type": "visual_step", "step": step("checking", "Validate Plan", "Strict-validating Plan JSON")},
                        ensure_ascii=False,
                        default=str,
                    ) + "\n\n"

                    try:
                        from ah32.plan.normalize import normalize_plan_payload

                        plan_obj = json.loads(payload)
                        plan = Plan.model_validate(normalize_plan_payload(plan_obj, host_app=host))
                    except (ValidationError, json.JSONDecodeError, TypeError, ValueError) as e:
                        error_type = "invalid_plan"
                        if isinstance(e, ValidationError):
                            error_message = json.dumps(e.errors(include_url=False), ensure_ascii=False, default=str)
                        else:
                            error_message = str(e)
                        attempt += 1
                        continue

                    if plan.host_app != host:
                        error_type = "host_app_mismatch"
                        error_message = f"host_app mismatch: request={host!r} plan={plan.host_app!r}"
                        attempt += 1
                        continue

                    result = {"success": True, "plan": plan.model_dump(mode="json"), "attempt_count": attempt}
                    yield "data: " + json.dumps({"type": "final_result", "result": result}, ensure_ascii=False, default=str) + "\n\n"
                    yield "data: [DONE]\n\n"
                    metrics_recorder.record(
                        op="js_plan_vibe_stream",
                        success=True,
                        duration_ms=int((time.perf_counter() - t0) * 1000),
                        extra={"host_app": host, "attempt_count": attempt},
                    )
                    return

                result = {
                    "success": False,
                    "plan": None,
                    "attempt_count": max_attempts,
                    "error": {"type": error_type, "message": error_message or "failed"},
                }
                yield "data: " + json.dumps({"type": "final_result", "result": result}, ensure_ascii=False, default=str) + "\n\n"
                yield "data: [DONE]\n\n"
                metrics_recorder.record(
                    op="js_plan_vibe_stream",
                    success=False,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    extra={"host_app": host, "attempt_count": max_attempts, "error_type": error_type},
                )
            except Exception as e:
                logger.error(f"Plan Vibe Coding stream failed: {e}", exc_info=True)
                error_event = {"type": "error", "error": str(e), "timestamp": time.time()}
                yield "data: " + json.dumps(error_event, ensure_ascii=False, default=str) + "\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Plan Vibe Coding stream handler failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
