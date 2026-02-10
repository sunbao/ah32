from __future__ import annotations

from typing import Any, Dict, List


def layout_recommender(slide_content: Dict[str, Any]) -> Dict[str, Any]:
    payload = slide_content if isinstance(slide_content, dict) else {}
    content_type = str(payload.get("type") or "").strip().lower()
    has_chart = bool(payload.get("has_chart"))
    has_image = bool(payload.get("has_image"))
    point_count = int(payload.get("point_count") or 0)

    if content_type in ("title", "cover"):
        layout_id, layout_name, confidence = 15, "标题页", 0.95
    elif has_chart:
        layout_id, layout_name, confidence = 34, "图表对比", 0.9
    elif has_image:
        layout_id, layout_name, confidence = 23, "图文并列", 0.88
    elif point_count >= 5:
        layout_id, layout_name, confidence = 18, "标题+内容", 0.85
    else:
        layout_id, layout_name, confidence = 16, "副标题页", 0.8

    alternatives: List[Dict[str, Any]] = [
        {"layout_id": 16, "layout_name": "副标题页", "reason": "信息量较小时更简洁"},
        {"layout_id": 23, "layout_name": "图文并列", "reason": "存在配图时表达更直观"},
    ]

    return {
        "layout_id": layout_id,
        "layout_name": layout_name,
        "confidence": confidence,
        "alternatives": alternatives,
    }
