from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ah32.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dev/skills", tags=["dev", "skills"])


def _resolve_tenant_id(tenant_id: Optional[str]) -> str:
    default_tid = str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
    return str(tenant_id or "").strip() or default_tid


def _tenant_skills_dir(storage_root: Path, tenant_id: str) -> Path:
    tid = str(tenant_id or "").strip() or "public"
    return Path(storage_root) / "tenants" / tid / "skills"


def _ensure_seeded_registry(request: Request, tenant_id: str):
    mgr = getattr(getattr(request, "app", None), "state", None)
    manager = getattr(mgr, "_tenant_skills_registry", None) if mgr is not None else None
    if manager is None:
        raise HTTPException(status_code=500, detail="tenant_skills_registry_not_initialized")
    try:
        reg = manager.get(tenant_id)
    except Exception as e:
        logger.error("[dev/skills] manager.get failed tenant_id=%s err=%s", tenant_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="tenant_skills_registry_get_failed")
    if reg is None:
        raise HTTPException(status_code=500, detail="tenant_skills_registry_missing")
    return reg


class PatchSkillMetaRequest(BaseModel):
    skill_id: str = Field(..., description="Skill id (folder name).")
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    name: Optional[str] = None


class PrimaryByPriorityRequest(BaseModel):
    allow_skill_ids: List[str] = Field(default_factory=list)


@router.get("/list")
async def dev_skills_list(
    request: Request,
    tenant_id: Optional[str] = Header(None, alias="X-AH32-Tenant-Id"),
) -> Dict[str, Any]:
    if not settings.enable_dev_routes:
        raise HTTPException(status_code=404, detail="not found")

    tid = _resolve_tenant_id(tenant_id)
    reg = _ensure_seeded_registry(request, tid)

    skills = []
    try:
        for s in reg.list_skills():
            skills.append(
                {
                    "id": getattr(s, "skill_id", ""),
                    "name": getattr(s, "name", ""),
                    "version": getattr(s, "version", ""),
                    "enabled": bool(getattr(s, "enabled", False)),
                    "priority": int(getattr(s, "priority", 0) or 0),
                    "group": getattr(s, "group", "") or "",
                }
            )
    except Exception as e:
        logger.error("[dev/skills] list_skills failed tenant_id=%s err=%s", tid, e, exc_info=True)
        raise HTTPException(status_code=500, detail="list_skills_failed")

    skills.sort(key=lambda x: (int(x.get("priority") or 0), str(x.get("id") or "")), reverse=True)
    return {"ok": True, "tenant_id": tid, "skills": skills, "count": len(skills)}


@router.post("/patch_meta")
async def dev_skills_patch_meta(
    request: Request,
    body: PatchSkillMetaRequest,
    tenant_id: Optional[str] = Header(None, alias="X-AH32-Tenant-Id"),
) -> Dict[str, Any]:
    if not settings.enable_dev_routes:
        raise HTTPException(status_code=404, detail="not found")

    tid = _resolve_tenant_id(tenant_id)
    _ensure_seeded_registry(request, tid)

    skill_id = str(body.skill_id or "").strip()
    if not skill_id:
        raise HTTPException(status_code=400, detail="skill_id required")

    root = _tenant_skills_dir(Path(settings.storage_root), tid) / skill_id
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.error("[dev/skills] ensure skill dir failed tenant_id=%s skill_id=%s err=%s", tid, skill_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="ensure_skill_dir_failed")

    manifest = root / "skill.json"
    data: Dict[str, Any] = {}
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("[dev/skills] invalid skill.json tenant_id=%s skill_id=%s err=%s", tid, skill_id, e, exc_info=True)
            data = {}

        # Backup before modifying.
        try:
            ts = int(time.time())
            backup = root / f"skill.json.bak.{ts}.json"
            shutil.copyfile(manifest, backup)
        except Exception as e:
            logger.warning("[dev/skills] backup skill.json failed (ignored) tenant_id=%s skill_id=%s err=%s", tid, skill_id, e, exc_info=True)
    else:
        data = {
            "schema_version": "ah32.skill.v1",
            "meta": {"id": skill_id, "name": skill_id, "version": "0.0.0", "enabled": True, "priority": 0},
            "routing": {},
            "output": {},
            "capabilities": {},
        }

    if not isinstance(data, dict):
        data = {}
    if str(data.get("schema_version") or "").strip() != "ah32.skill.v1":
        data["schema_version"] = "ah32.skill.v1"

    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    meta["id"] = str(meta.get("id") or skill_id).strip() or skill_id

    changed: Dict[str, Any] = {}
    if body.enabled is not None:
        meta["enabled"] = bool(body.enabled)
        changed["enabled"] = bool(body.enabled)
    if body.priority is not None:
        try:
            meta["priority"] = int(body.priority)
            changed["priority"] = int(body.priority)
        except Exception:
            raise HTTPException(status_code=400, detail="priority must be int")
    if body.name is not None:
        meta["name"] = str(body.name or "").strip() or meta.get("name") or skill_id
        changed["name"] = meta["name"]

    data["meta"] = meta

    try:
        manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.error("[dev/skills] write skill.json failed tenant_id=%s skill_id=%s err=%s", tid, skill_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="write_skill_manifest_failed")

    return {"ok": True, "tenant_id": tid, "skill_id": skill_id, "changed": changed, "manifest": str(manifest)}


@router.post("/primary_by_priority")
async def dev_skills_primary_by_priority(
    request: Request,
    body: PrimaryByPriorityRequest,
    tenant_id: Optional[str] = Header(None, alias="X-AH32-Tenant-Id"),
) -> Dict[str, Any]:
    """Deterministic routing check: pick primary skill purely by (enabled, priority, id) ordering.

    This is intentionally message-agnostic and is used for regression of the tie-break rule:
    when multiple skills are candidates, the higher-priority skill should win.
    """
    if not settings.enable_dev_routes:
        raise HTTPException(status_code=404, detail="not found")

    tid = _resolve_tenant_id(tenant_id)
    reg = _ensure_seeded_registry(request, tid)

    allow = [str(x or "").strip() for x in (body.allow_skill_ids or [])]
    allow = [x for x in allow if x]
    allow_set = set(allow)

    out = []
    try:
        for s in reg.list_skills():
            sid = str(getattr(s, "skill_id", "") or "").strip()
            if not sid:
                continue
            if allow_set and sid not in allow_set:
                continue
            out.append(
                {
                    "id": sid,
                    "name": str(getattr(s, "name", "") or ""),
                    "enabled": bool(getattr(s, "enabled", False)),
                    "priority": int(getattr(s, "priority", 0) or 0),
                }
            )
    except Exception as e:
        logger.error("[dev/skills] primary_by_priority list_skills failed tenant_id=%s err=%s", tid, e, exc_info=True)
        raise HTTPException(status_code=500, detail="list_skills_failed")

    enabled = [x for x in out if bool(x.get("enabled"))]
    enabled.sort(key=lambda x: (int(x.get("priority") or 0), str(x.get("id") or "")), reverse=True)
    primary = enabled[0]["id"] if enabled else ""

    return {"ok": True, "tenant_id": tid, "allow_skill_ids": allow, "primary_skill_id": primary, "skills": enabled}

