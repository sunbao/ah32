from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Dict, List


def _parse_date(token: str) -> date | None:
    t = token.strip()
    fmts = ["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"]
    for fmt in fmts:
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            continue
    return None


def timeline_generator(bid_doc_text: str, today: str = "") -> Dict[str, Any]:
    text = str(bid_doc_text or "")
    now = _parse_date(today) if today else date.today()
    if now is None:
        now = date.today()

    pattern = re.compile(r"(\d{4}[年\-\/.]\d{1,2}[月\-\/.]\d{1,2}日?)")
    phases: List[Dict[str, Any]] = []

    for idx, match in enumerate(pattern.finditer(text), start=1):
        token = match.group(1)
        ddl = _parse_date(token)
        if ddl is None:
            continue
        label = f"里程碑{idx}"
        days_remaining = (ddl - now).days
        phases.append(
            {
                "name": label,
                "ddl": ddl.isoformat(),
                "days_remaining": days_remaining,
            }
        )

    return {
        "phases": phases,
        "total_days": max([p["days_remaining"] for p in phases], default=0),
    }
