from __future__ import annotations

from typing import Any, Dict, List


def table_parser(table_text: str, delimiter: str = ",") -> Dict[str, Any]:
    lines = [line for line in str(table_text or "").splitlines() if line.strip()]
    if not lines:
        return {"headers": [], "rows": [], "row_count": 0}
    split = str(delimiter or ",")
    headers = [h.strip() for h in lines[0].split(split)]
    rows: List[Dict[str, Any]] = []
    for line in lines[1:]:
        cols = [c.strip() for c in line.split(split)]
        row = {headers[idx] if idx < len(headers) else f"col_{idx+1}": cols[idx] for idx in range(len(cols))}
        rows.append(row)
    return {"headers": headers, "rows": rows, "row_count": len(rows)}

