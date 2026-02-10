from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ah32.telemetry import get_telemetry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class TelemetryIngestRequest(BaseModel):
    events: List[Dict[str, Any]] = Field(default_factory=list)


@router.get("/capabilities")
async def telemetry_capabilities() -> Dict[str, Any]:
    t = get_telemetry()
    if not t:
        return {"enabled": False, "mode": "off"}
    caps = t.capabilities()
    return {"enabled": True, **caps.to_dict()}


@router.post("/events")
async def telemetry_events_ingest(req: TelemetryIngestRequest) -> Dict[str, Any]:
    t = get_telemetry()
    if not t:
        return {"accepted": 0, "enabled": False}
    accepted = 0
    try:
        accepted = t.ingest(req.events or [])
    except Exception as e:
        logger.error("[telemetry] ingest failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="telemetry ingest failed")
    return {"accepted": accepted, "enabled": True}
