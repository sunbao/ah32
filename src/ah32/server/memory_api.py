"""Memory management API (user-confirmed writes).

This router provides a minimal, local-first workflow:
- Suggest memory patches from a piece of text (heuristic, keyword-based).
- Commit selected patches explicitly (no automatic long-term writes).
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ah32.services.memory import (
    ProjectContext,
    UserPreference,
    UserProfile,
    get_global_user_memory,
    get_task_memory,
)
from ah32.session.session_id_generator import SessionIdGenerator
from ah32.strategies.llm_driven_strategy import classify_conversation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/memory", tags=["memory"])

Scope = Literal["global", "document"]
Kind = Literal["user_profile", "user_preferences", "project_context", "document_note"]


class MemoryPatch(BaseModel):
    patch_id: str
    scope: Scope
    kind: Kind
    title: str
    preview: str = ""
    data: Dict[str, Any] = Field(default_factory=dict)
    recommended: bool = False
    reason: str = ""


class SuggestRequest(BaseModel):
    session_id: Optional[str] = None
    message: str
    message_role: Optional[str] = None
    message_id: Optional[str] = None


class SuggestResponse(BaseModel):
    success: bool = True
    recommended_patch_ids: List[str] = Field(default_factory=list)
    patches: List[MemoryPatch] = Field(default_factory=list)


class CommitRequest(BaseModel):
    session_id: Optional[str] = None
    patches: List[MemoryPatch]


class CommitResponse(BaseModel):
    success: bool = True
    applied_patch_ids: List[str] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)


def _new_patch_id() -> str:
    return uuid.uuid4().hex


def _compact(text: str, limit: int = 120) -> str:
    t = (text or "").strip().replace("\n", " ")
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "..."


def _merge_non_empty_str(old: Optional[str], new: Optional[str]) -> Optional[str]:
    n = (new or "").strip()
    if n:
        return n
    return old


def _merge_list_unique(old: List[str], new: List[str], limit: int = 50) -> List[str]:
    seen = set()
    out: List[str] = []
    for v in (old or []) + (new or []):
        s = str(v).strip()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= limit:
            break
    return out


def _extract_profile_patch(message: str) -> Dict[str, Any]:
    text = (message or "").strip()
    out: Dict[str, Any] = {}

    m = re.search(r"(?:我叫|我的名字是)\s*([^\s，。,；;]{1,20})", text)
    if m:
        out["name"] = m.group(1).strip()

    m = re.search(r"(?:我在|公司是|来自)\s*([^\s，。,；;]{2,40})", text)
    if m:
        out["company"] = m.group(1).strip()

    m = re.search(r"(?:职位是|岗位是|我是)\s*([^\s，。,；;]{2,40})", text)
    if m:
        out["role"] = m.group(1).strip()

    m = re.search(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})", text)
    if m:
        out["email"] = m.group(1).strip()

    return out


def _extract_preferences_patch(message: str) -> Dict[str, Any]:
    text = (message or "").strip()
    out: Dict[str, Any] = {}

    # language
    if "中英" in text or "中英文" in text or "混合" in text:
        out["language"] = "中英混合"
    elif "英文" in text or "English" in text:
        out["language"] = "英文"
    elif "中文" in text:
        out["language"] = "中文"

    # writing_style
    if re.search(r"(正式|严谨|规范|公文)", text):
        out["writing_style"] = "formal"
    elif re.search(r"(口语|随意|轻松|聊天)", text):
        out["writing_style"] = "casual"

    # preferred formats (very small, opt-in)
    preferred_formats: Dict[str, str] = {}
    if re.search(r"(要点|要点列表|bullet)", text, re.IGNORECASE):
        preferred_formats["layout"] = "bullets"
    if "表格" in text:
        preferred_formats["layout"] = "table"
    if "Markdown" in text or "md" in text:
        preferred_formats["format"] = "markdown"
    if preferred_formats:
        out["preferred_formats"] = preferred_formats

    # focus areas (simple)
    focus: List[str] = []
    m = re.search(r"(?:关注|重点|主要看|侧重)[:：]?(.{1,80})", text)
    if m:
        raw = m.group(1)
        parts = re.split(r"[，,、;；/\\n\\r]", raw)
        focus = [p.strip() for p in parts if p.strip()]
    if focus:
        out["focus_areas"] = focus[:10]

    return out


def _extract_project_context_patch(message: str) -> Dict[str, Any]:
    text = (message or "").strip()
    out: Dict[str, Any] = {}

    # Treat as "document/project constraints" in a generic office sense.
    reqs: List[str] = []
    m = re.search(r"(?:需求|要求|约束|重点|关注点)[:：]?(.{1,120})", text)
    if m:
        raw = m.group(1)
        parts = re.split(r"[，,、;；/\\n\\r]", raw)
        reqs = [p.strip() for p in parts if p.strip()]

    if reqs:
        out["key_requirements"] = reqs[:12]

    # Very light-weight extraction for budget/timeline keywords (optional)
    m = re.search(r"(?:预算|金额)[:：]?\\s*([0-9]{1,3}(?:[,，][0-9]{3})*(?:\\.[0-9]+)?\\s*(?:元|万元|w|W|k|K)?)", text)
    if m:
        out["budget"] = m.group(1).strip()
    m = re.search(r"(?:截止|交付|完成|时间)[:：]?\\s*([0-9]{4}[-/年][0-9]{1,2}[-/月][0-9]{1,2}日?|\\d+\\s*(?:天|周|月))", text)
    if m:
        out["timeline"] = m.group(1).strip()

    return out


@router.post("/suggest", response_model=SuggestResponse)
async def suggest_memory_patches(req: SuggestRequest) -> SuggestResponse:
    message = (req.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    patches: List[MemoryPatch] = []
    recommended_ids: List[str] = []

    classification = None
    try:
        classification = classify_conversation(message)
    except Exception as e:
        logger.warning(f"[memory] classify_conversation failed: {e}")

    storage_level = getattr(getattr(classification, "storage_level", None), "value", "") if classification else ""
    category = getattr(getattr(classification, "category", None), "value", "") if classification else ""
    reason = getattr(classification, "reasoning", "") if classification else ""

    # 1) Always offer a document note (explicit user action).
    note_id = _new_patch_id()
    note_patch = MemoryPatch(
        patch_id=note_id,
        scope="document",
        kind="document_note",
        title="保存为本文件记忆（备注）",
        preview=_compact(message, 140),
        data={
            "note": message,
            "source": {
                "role": req.message_role,
                "message_id": req.message_id,
                "saved_at": time.time(),
            },
        },
        recommended=(storage_level == "P2_跨会话记忆"),
        reason=reason or "手动保存为本文件可复用记忆",
    )
    patches.append(note_patch)
    if note_patch.recommended:
        recommended_ids.append(note_id)

    # 2) Global profile (P0)
    if category in ("identity", "qualification") or storage_level == "P0_全局记忆":
        profile_data = _extract_profile_patch(message)
        if profile_data:
            pid = _new_patch_id()
            p = MemoryPatch(
                patch_id=pid,
                scope="global",
                kind="user_profile",
                title="保存为全局记忆（用户档案）",
                preview=_compact(str(profile_data), 140),
                data=profile_data,
                recommended=True,
                reason=reason or "检测到身份/档案信息",
            )
            patches.append(p)
            recommended_ids.append(pid)

    # 3) Global preferences (P0)
    if category == "preference" or ("偏好" in message) or storage_level == "P0_全局记忆":
        pref_data = _extract_preferences_patch(message)
        if pref_data:
            pid = _new_patch_id()
            p = MemoryPatch(
                patch_id=pid,
                scope="global",
                kind="user_preferences",
                title="保存为全局记忆（偏好设置）",
                preview=_compact(str(pref_data), 140),
                data=pref_data,
                recommended=(category == "preference"),
                reason=reason or "检测到偏好表达",
            )
            patches.append(p)
            if p.recommended:
                recommended_ids.append(pid)

    # 4) Document/project context (P2 candidate)
    ctx_data = _extract_project_context_patch(message)
    if ctx_data:
        cid = _new_patch_id()
        p = MemoryPatch(
            patch_id=cid,
            scope="document",
            kind="project_context",
            title="保存为本文件记忆（结构化上下文）",
            preview=_compact(str(ctx_data), 140),
            data=ctx_data,
            recommended=(storage_level == "P2_跨会话记忆"),
            reason=reason or "检测到可复用的上下文约束",
        )
        patches.append(p)
        if p.recommended:
            recommended_ids.append(cid)

    # If nothing is marked recommended, default to the document note.
    if not recommended_ids and patches:
        recommended_ids = [patches[0].patch_id]

    return SuggestResponse(success=True, recommended_patch_ids=recommended_ids, patches=patches)


@router.post("/commit", response_model=CommitResponse)
async def commit_memory_patches(req: CommitRequest) -> CommitResponse:
    if not req.patches:
        raise HTTPException(status_code=400, detail="patches is required")

    session_id = (req.session_id or "").strip()

    applied: List[str] = []
    errors: List[str] = []

    global_memory = None
    task_memory = None

    for patch in req.patches:
        try:
            if patch.scope == "global":
                if global_memory is None:
                    global_memory = get_global_user_memory()

                if patch.kind == "user_profile":
                    existing = global_memory.get_user_profile()
                    next_profile = UserProfile(
                        name=_merge_non_empty_str(existing.name, patch.data.get("name")),
                        company=_merge_non_empty_str(existing.company, patch.data.get("company")),
                        role=_merge_non_empty_str(existing.role, patch.data.get("role")),
                        email=_merge_non_empty_str(existing.email, patch.data.get("email")),
                        created_at=existing.created_at,
                        updated_at=time.time(),
                    )
                    global_memory.update_user_profile(next_profile)
                    applied.append(patch.patch_id)
                    continue

                if patch.kind == "user_preferences":
                    existing = global_memory.get_user_preferences()
                    incoming_formats = patch.data.get("preferred_formats")
                    next_formats = dict(existing.preferred_formats or {})
                    if isinstance(incoming_formats, dict):
                        for k, v in incoming_formats.items():
                            k2 = str(k).strip()
                            v2 = str(v).strip()
                            if k2 and v2:
                                next_formats[k2] = v2

                    next_focus = list(existing.focus_areas or [])
                    if isinstance(patch.data.get("focus_areas"), list):
                        next_focus = _merge_list_unique(next_focus, patch.data.get("focus_areas") or [], limit=50)

                    next_pref = UserPreference(
                        writing_style=str(patch.data.get("writing_style") or existing.writing_style or "formal"),
                        preferred_formats=next_formats,
                        language=str(patch.data.get("language") or existing.language or "中文"),
                        focus_areas=next_focus,
                    )
                    global_memory.update_user_preferences(next_pref)
                    applied.append(patch.patch_id)
                    continue

                raise ValueError(f"unsupported global patch kind: {patch.kind}")

            # Document-scoped patches
            if patch.scope == "document":
                if not session_id:
                    raise ValueError("session_id is required for document-scoped memory")
                if task_memory is None:
                    task_memory = get_task_memory(session_id)

                if patch.kind == "project_context":
                    existing_ctx = task_memory.get_project_context()
                    incoming_reqs = patch.data.get("key_requirements") or []
                    merged_reqs = _merge_list_unique(
                        list(existing_ctx.key_requirements or []),
                        list(incoming_reqs) if isinstance(incoming_reqs, list) else [],
                        limit=100,
                    )
                    next_ctx = ProjectContext(
                        project_name=_merge_non_empty_str(existing_ctx.project_name, patch.data.get("project_name")),
                        project_type=_merge_non_empty_str(existing_ctx.project_type, patch.data.get("project_type")),
                        industry=_merge_non_empty_str(existing_ctx.industry, patch.data.get("industry")),
                        budget=_merge_non_empty_str(existing_ctx.budget, patch.data.get("budget")),
                        timeline=_merge_non_empty_str(existing_ctx.timeline, patch.data.get("timeline")),
                        key_requirements=merged_reqs,
                    )
                    task_memory.update_project_context(next_ctx)
                    applied.append(patch.patch_id)
                    continue

                if patch.kind == "document_note":
                    doc_hash = SessionIdGenerator.get_file_hash(session_id) or session_id
                    key = "notes"
                    record = task_memory.get_cross_session_memory(doc_hash, key)
                    existing_list: List[Dict[str, Any]] = []
                    if isinstance(record, dict) and isinstance(record.get("value"), list):
                        existing_list = list(record.get("value") or [])

                    note_text = str(patch.data.get("note") or "").strip()
                    if not note_text:
                        raise ValueError("note is empty")

                    item = {
                        "text": note_text,
                        "source": patch.data.get("source") or {},
                        "created_at": time.time(),
                    }
                    existing_list.append(item)
                    # keep only a reasonable tail
                    existing_list = existing_list[-200:]

                    task_memory.update_cross_session_memory(
                        doc_hash,
                        key,
                        existing_list,
                        metadata={"kind": "document_note"},
                    )
                    applied.append(patch.patch_id)
                    continue

                raise ValueError(f"unsupported document patch kind: {patch.kind}")

            raise ValueError(f"unsupported patch scope: {patch.scope}")

        except Exception as e:
            msg = f"{patch.patch_id}: {e}"
            logger.warning(f"[memory] commit failed: {msg}", exc_info=True)
            errors.append(msg)

    return CommitResponse(success=len(errors) == 0, applied_patch_ids=applied, errors=errors)
