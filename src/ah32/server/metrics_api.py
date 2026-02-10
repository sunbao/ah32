from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import PlainTextResponse

from ah32.config import settings
from ah32.core.metrics_recorder import metrics_recorder

router = APIRouter(prefix="/agentic/metrics", tags=["metrics"])


def _auth(api_key: str | None) -> None:
    if settings.enable_auth:
        if not api_key or api_key != settings.api_key:
            raise HTTPException(status_code=401, detail="Invalid API Key")


@router.get("/summary")
async def metrics_summary(api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    return metrics_recorder.summary()


@router.get("/events")
async def metrics_events(limit: int = 200, api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    return {"events": metrics_recorder.events(limit=limit)}


@router.get("/export.csv")
async def metrics_export_csv(limit: int = 2000, api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    return PlainTextResponse(metrics_recorder.export_csv(limit=limit), media_type="text/csv; charset=utf-8")


@router.post("/reset")
async def metrics_reset(api_key: str | None = Header(None, alias="X-API-Key")):
    _auth(api_key)
    metrics_recorder.reset()
    return {"success": True}
