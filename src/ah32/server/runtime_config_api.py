from __future__ import annotations

from fastapi import APIRouter

from ah32.config import settings

router = APIRouter(prefix="/api", tags=["runtime-config"])


@router.get("/runtime-config")
async def get_runtime_config():
    """Expose a small, safe subset of backend runtime flags for the frontend UI."""
    return {
        "expose_agent_thoughts": bool(getattr(settings, "expose_agent_thoughts", False)),
        "expose_rag_hits": bool(getattr(settings, "expose_rag_hits", False)),
        # Dev-only UI on the frontend should still be gated by VITE_ENABLE_DEV_UI, but
        # exposing this flag helps explain why server-side dev endpoints return 404.
        "enable_dev_routes": bool(getattr(settings, "enable_dev_routes", False)),
    }
