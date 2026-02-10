from __future__ import annotations

import re
from typing import Any, Dict


def format_validator(text: str, pattern: str) -> Dict[str, Any]:
    source = str(text or "")
    expr = str(pattern or "")
    if not expr:
        return {"valid": False, "error": "pattern is required"}
    try:
        ok = bool(re.search(expr, source))
        return {"valid": ok, "pattern": expr}
    except Exception as e:
        return {"valid": False, "pattern": expr, "error": str(e)}

