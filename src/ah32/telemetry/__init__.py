"""Telemetry core (ah32.telemetry.v1).

Design constraints (from AGENTS / TODOLIST):
- No silent failures: best-effort is OK, but must leave logs.
- Core emits events via a lightweight `telemetry.emit(...)` API.
- Storage / forwarding implementations live in `_internal/telemetry_sinks/` so they can be
  swapped or kept private later without touching business logic.
"""

from .run_context import RunContext
from .service import TelemetryService, get_telemetry, set_telemetry

__all__ = ["RunContext", "TelemetryService", "get_telemetry", "set_telemetry"]
