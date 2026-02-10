from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request

from ah32.config import settings
from ah32.telemetry import get_telemetry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dev/telemetry", tags=["dev", "telemetry"])


@router.get("/events")
async def telemetry_events_query(
    request: Request,
    limit: int = 200,
    since_ts: Optional[float] = None,
    event_name: Optional[str] = None,
    run_id: Optional[str] = None,
    host_app: Optional[str] = None,
    doc_key: Optional[str] = None,
    session_id: Optional[str] = None,
    block_id: Optional[str] = None,
    client_id: Optional[str] = None,
) -> Dict[str, Any]:
    # Query is dev-only by default to avoid exposing internal traces publicly.
    if not settings.enable_dev_routes:
        raise HTTPException(status_code=404, detail="not found")

    t = get_telemetry()
    if not t:
        return {"events": [], "enabled": False}
    events = t.query_events(
        limit=limit,
        since_ts=since_ts,
        event_name=event_name,
        run_id=run_id,
        host_app=host_app,
        doc_key=doc_key,
        session_id=session_id,
        block_id=block_id,
        client_id=client_id,
    )
    return {"events": events, "enabled": True, "now_ts": time.time()}


@router.get("/ui")
async def telemetry_ui() -> Any:
    """A tiny built-in UI for quick debugging (dev-only)."""
    if not settings.enable_dev_routes:
        raise HTTPException(status_code=404, detail="not found")
    # Inline HTML to avoid depending on the frontend build for server-side diagnostics.
    return (
        """
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Ah32 Telemetry (Dev)</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    input, select { padding: 6px 8px; }
    button { padding: 6px 10px; cursor: pointer; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b1020; color: #e6e6e6; padding: 12px; border-radius: 8px; }
    .hint { color: #555; font-size: 12px; }
  </style>
</head>
<body>
  <h2>Telemetry (Dev)</h2>
  <div class="row">
    <label>limit <input id="limit" type="number" value="120" min="1" max="2000"/></label>
    <label>event <input id="event" placeholder="chat.turn_done"/></label>
    <label>session <input id="session" placeholder="session_id"/></label>
    <label>doc_key <input id="doc" placeholder="doc_key"/></label>
    <button id="load">Load</button>
  </div>
  <p class="hint">Dev-only endpoint: /dev/telemetry/events (gated by AH32_ENABLE_DEV_ROUTES=true)</p>
  <pre id="out">Loading...</pre>
  <script>
    async function load() {
      const limit = document.getElementById('limit').value || '120';
      const event = document.getElementById('event').value || '';
      const session = document.getElementById('session').value || '';
      const doc = document.getElementById('doc').value || '';
      const qs = new URLSearchParams();
      qs.set('limit', limit);
      if (event) qs.set('event_name', event);
      if (session) qs.set('session_id', session);
      if (doc) qs.set('doc_key', doc);
      const res = await fetch('/dev/telemetry/events?' + qs.toString());
      const data = await res.json();
      document.getElementById('out').textContent = JSON.stringify(data, null, 2);
    }
    document.getElementById('load').addEventListener('click', load);
    load().catch(function (e) { document.getElementById('out').textContent = String(e); });
  </script>
</body>
</html>
"""
    )
