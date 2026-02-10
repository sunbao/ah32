"""WPP Outline Tools Registry."""

from .layout_recommender import recommend_layout
from .placeholder_mapper import get_placeholder_map

TOOLS = {
    "layout_recommender": {
        "name": "layout_recommender",
        "description": "根据幻灯片内容推荐合适的 WPP 版式ID",
    },
    "recommend_layout": {
        "name": "recommend_layout",
        "description": "根据幻灯片内容推荐合适的 WPP 版式ID",
        "func": recommend_layout,
    },
    "placeholder_mapper": {
        "name": "placeholder_mapper",
        "description": "获取指定版式的占位区域映射",
    },
    "get_placeholder_map": {
        "name": "get_placeholder_map",
        "description": "获取指定版式的占位区域映射",
        "func": get_placeholder_map,
    },
}

__all__ = ["TOOLS", "recommend_layout", "get_placeholder_map"]
