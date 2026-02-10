from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List
from urllib import request as urlrequest

logger = logging.getLogger(__name__)


@dataclass
class HttpForwardTelemetrySink:
    name: str = "remote"

    def __init__(self, *, endpoint: str, timeout_s: float = 3.0) -> None:
        self.endpoint = str(endpoint or "").strip()
        self.timeout_s = float(timeout_s)

    def write_many(self, events: List[Dict[str, Any]]) -> None:
        if not events:
            return
        if not self.endpoint:
            return
        payload = {"events": events}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            self.endpoint,
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=self.timeout_s) as resp:
                _ = resp.read(32)  # drain a little to finalize the request
        except Exception as e:
            # Best-effort; never crash the app due to remote telemetry failures.
            logger.warning("[telemetry/remote] forward failed: %s endpoint=%s", e, self.endpoint)

    def close(self) -> None:
        return
