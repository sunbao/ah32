from __future__ import annotations

from typing import Any, Dict, List


def placeholder_mapper(layout_id: int) -> Dict[str, Any]:
    lid = int(layout_id)
    maps: Dict[int, List[Dict[str, Any]]] = {
        15: [
            {"id": "title", "type": "text", "rect": [8, 12, 84, 16]},
            {"id": "subtitle", "type": "text", "rect": [12, 34, 76, 10]},
        ],
        18: [
            {"id": "title", "type": "text", "rect": [6, 6, 88, 12]},
            {"id": "content", "type": "text", "rect": [8, 22, 84, 66]},
        ],
        23: [
            {"id": "title", "type": "text", "rect": [6, 6, 88, 12]},
            {"id": "left", "type": "text", "rect": [8, 22, 40, 64]},
            {"id": "right", "type": "image", "rect": [52, 22, 40, 64]},
        ],
        34: [
            {"id": "title", "type": "text", "rect": [6, 6, 88, 12]},
            {"id": "chart", "type": "chart", "rect": [8, 22, 84, 64]},
        ],
    }

    placeholders = maps.get(
        lid,
        [
            {"id": "title", "type": "text", "rect": [6, 6, 88, 12]},
            {"id": "content", "type": "text", "rect": [8, 22, 84, 66]},
        ],
    )

    return {
        "layout_id": lid,
        "placeholders": placeholders,
    }
