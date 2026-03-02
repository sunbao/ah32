from __future__ import annotations

from fastapi import APIRouter, Header
from fastapi.responses import PlainTextResponse

from ah32.core.metrics_recorder import metrics_recorder

router = APIRouter(prefix="/agentic/metrics", tags=["metrics"])


def _auth(_: str | None) -> None:
    # Auth is enforced centrally for /agentic/* in server middleware.
    return


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
