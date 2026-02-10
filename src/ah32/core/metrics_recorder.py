from __future__ import annotations

import csv
import io
import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class MetricEvent:
    ts: float
    op: str
    success: bool
    duration_ms: int
    extra: dict[str, Any] = field(default_factory=dict)


def _percentile(sorted_values: list[int], p: float) -> int | None:
    if not sorted_values:
        return None
    if p <= 0:
        return sorted_values[0]
    if p >= 100:
        return sorted_values[-1]
    k = (len(sorted_values) - 1) * (p / 100.0)
    i = int(k)
    j = min(i + 1, len(sorted_values) - 1)
    if i == j:
        return sorted_values[i]
    frac = k - i
    return int(round(sorted_values[i] * (1 - frac) + sorted_values[j] * frac))


class MetricsRecorder:
    def __init__(self, *, max_events: int = 2000):
        self._events: deque[MetricEvent] = deque(maxlen=max_events)

    def reset(self) -> None:
        self._events.clear()

    def record(self, *, op: str, success: bool, duration_ms: int, extra: dict[str, Any] | None = None) -> None:
        self._events.append(
            MetricEvent(
                ts=time.time(),
                op=str(op),
                success=bool(success),
                duration_ms=max(int(duration_ms), 0),
                extra=dict(extra or {}),
            )
        )

    def events(self, *, limit: int = 200) -> list[dict[str, Any]]:
        n = max(int(limit), 0)
        items = list(self._events)[-n:] if n else list(self._events)
        return [asdict(e) for e in items]

    def summary(self) -> dict[str, Any]:
        by_op: dict[str, list[MetricEvent]] = defaultdict(list)
        for e in self._events:
            by_op[e.op].append(e)

        out: dict[str, Any] = {"total": len(self._events), "ops": {}}
        for op, items in sorted(by_op.items(), key=lambda kv: kv[0]):
            durations = sorted([int(e.duration_ms) for e in items])
            count = len(items)
            errors = sum(1 for e in items if not e.success)
            out["ops"][op] = {
                "count": count,
                "errors": errors,
                "success_rate": round(((count - errors) / max(count, 1)) * 100, 1),
                "avg_ms": int(round(sum(durations) / max(len(durations), 1))),
                "p50_ms": _percentile(durations, 50),
                "p90_ms": _percentile(durations, 90),
                "p99_ms": _percentile(durations, 99),
                "max_ms": durations[-1] if durations else None,
            }
        return out

    def export_csv(self, *, limit: int = 2000) -> str:
        rows = self.events(limit=limit)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["ts", "op", "success", "duration_ms", "extra_json"])
        for r in rows:
            w.writerow([r.get("ts"), r.get("op"), r.get("success"), r.get("duration_ms"), r.get("extra")])
        return buf.getvalue()


metrics_recorder = MetricsRecorder()

