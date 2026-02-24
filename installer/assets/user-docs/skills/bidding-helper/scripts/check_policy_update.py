from __future__ import annotations

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


def check_policy_update(
    force_refresh: bool = False,
    ttl_hours: int = 24,
    max_items: int = 10,
    record_trace: bool = False,
    timeout_ms: int = 30000,
) -> Dict[str, Any]:
    """Check policy updates and persist structured JSON under data/rag/policies/ (best-effort).

    Args:
        force_refresh: Bypass TTL and fetch immediately.
        ttl_hours: Cache freshness window. When fresh and force_refresh=false, return cached items.
        max_items: Max list items to scrape from the list page.
        record_trace: Save Playwright traces under storage/browser_traces/.
        timeout_ms: Per-page navigation timeout.
    """
    try:
        from ah32.integrations.policy_monitor import PolicyMonitor

        monitor = PolicyMonitor()
        return monitor.check_updates(
            force_refresh=bool(force_refresh),
            ttl_hours=int(ttl_hours),
            max_items=int(max_items),
            record_trace=bool(record_trace),
            timeout_ms=int(timeout_ms),
            auto_ingest=True,
        )
    except Exception as e:
        logger.warning("[bidding-helper] check_policy_update failed: %s", e, exc_info=True)
        return {"ok": False, "from_cache": True, "message": "政策检查失败", "error": {"message": str(e)}}
