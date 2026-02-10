from __future__ import annotations

from typing import Any, Dict


def number_generator(prefix: str = "NO", start: int = 1, width: int = 4) -> Dict[str, Any]:
    value = max(0, int(start or 0))
    padded = str(value).zfill(max(1, int(width or 1)))
    return {
        "prefix": str(prefix or "").strip(),
        "start": value,
        "width": max(1, int(width or 1)),
        "number": f"{str(prefix or '').strip()}{padded}",
    }

