from __future__ import annotations

from datetime import datetime
from typing import Any, Dict


def date_calculator(start_date: str, end_date: str, inclusive: bool = False) -> Dict[str, Any]:
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    days = (end - start).days
    if inclusive:
        days += 1
    return {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "days": days,
        "inclusive": bool(inclusive),
    }

