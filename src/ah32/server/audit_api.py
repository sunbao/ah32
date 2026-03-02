from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from ah32.core.audit_recorder import audit_recorder

router = APIRouter(prefix="/agentic/audit", tags=["audit"])


def _auth(_: str | None) -> None:
    # Auth is enforced centrally for /agentic/* in server middleware.
    return


class AuditRecordRequest(BaseModel):
    session_id: str = ""
    host_app: str = "unknown"
    mode: str = Field(default="unknown", description="plan|js|unknown")
    block_id: str = ""
    ops: List[str] = []
    success: bool
    error_type: str = ""
    error_message: str = ""
    extra: Optional[Dict[str, Any]] = None


@router.post("/record")
async def audit_record(request: AuditRecordRequest, api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    audit_recorder.record(
        session_id=request.session_id,
        host_app=request.host_app,
        mode=request.mode,
        block_id=request.block_id,
        ops=request.ops,
        success=request.success,
        error_type=request.error_type,
        error_message=request.error_message,
        extra=request.extra,
    )
    return {"success": True}


@router.get("/summary")
async def audit_summary(api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    return audit_recorder.summary()


@router.get("/events")
async def audit_events(limit: int = 200, api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    return {"events": audit_recorder.events(limit=limit)}


@router.post("/reset")
async def audit_reset(api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    audit_recorder.reset()
    return {"success": True}

