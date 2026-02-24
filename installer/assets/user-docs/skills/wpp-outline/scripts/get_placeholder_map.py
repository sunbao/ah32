"""Placeholder Mapper - Get placeholder mapping for WPP layouts."""

from typing import Any, Dict, List, Optional


def get_placeholder_map(layout_id: int) -> Dict[str, Any]:
    """获取指定版式的占位区域映射。

    Args:
        layout_id: WPP 版式ID

    Returns:
        {
            "layout_id": 15,
            "layout_name": "标题页",
            "placeholders": [
                {
                    "id": "title",
                    "type": "text",
                    "name": "主标题",
                    "rect": [100, 150, 800, 60],
                    "style": {"font_size": 32, "bold": true}
                },
                {
                    "id": "subtitle",
                    "type": "text",
                    "name": "副标题",
                    "rect": [100, 220, 800, 40],
                    "style": {"font_size": 18}
                },
                {
                    "id": "background",
                    "type": "image",
                    "name": "背景图",
                    "rect": [0, 0, 1024, 768],
                    "style": {}
                }
            ],
            "total_placeholders": 3
        }
    """
    # 版式占位区域定义库
    placeholder_maps = {
        # 标题页版式 (1-10)
        1: {
            "layout_name": "简洁标题页",
            "placeholders": [
                {"id": "title", "type": "text", "name": "主标题", "rect": [100, 200, 824, 80], "style": {"font_size": 44, "bold": True}},
                {"id": "subtitle", "type": "text", "name": "副标题", "rect": [100, 300, 824, 50], "style": {"font_size": 24}},
                {"id": "date", "type": "text", "name": "日期", "rect": [100, 600, 400, 30], "style": {"font_size": 16}},
            ]
        },
        2: {
            "layout_name": "副标题标题页",
            "placeholders": [
                {"id": "main_title", "type": "text", "name": "主标题", "rect": [100, 150, 824, 60], "style": {"font_size": 36, "bold": True}},
                {"id": "subtitle", "type": "text", "name": "副标题", "rect": [100, 230, 824, 40], "style": {"font_size": 20}},
                {"id": "date", "type": "text", "name": "日期", "rect": [100, 650, 300, 30], "style": {"font_size": 14}},
                {"id": "footer", "type": "text", "name": "页脚", "rect": [100, 700, 824, 25], "style": {"font_size": 12}},
            ]
        },
        3: {
            "layout_name": "居中标题页",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [112, 284, 800, 100], "style": {"font_size": 54, "bold": True, "align": "center"}},
                {"id": "subtitle", "type": "text", "name": "副标题", "rect": [112, 400, 800, 50], "style": {"font_size": 24, "align": "center"}},
            ]
        },
        5: {
            "layout_name": "全图标题页",
            "placeholders": [
                {"id": "background", "type": "image", "name": "背景图", "rect": [0, 0, 1024, 768], "style": {}},
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 280, 824, 80], "style": {"font_size": 48, "bold": True, "color": "white"}},
                {"id": "subtitle", "type": "text", "name": "副标题", "rect": [100, 380, 824, 50], "style": {"font_size": 24, "color": "white"}},
            ]
        },
        # 目录页版式 (6-10)
        6: {
            "layout_name": "标准目录页",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 80, 824, 50], "style": {"font_size": 32, "bold": True}},
                {"id": "toc", "type": "text", "name": "目录内容", "rect": [100, 160, 824, 500], "style": {"font_size": 20}},
            ]
        },
        7: {
            "layout_name": "图形化目录",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 60, 824, 45], "style": {"font_size": 28, "bold": True}},
                {"id": "icon1", "type": "image", "name": "图标1", "rect": [100, 150, 60, 60], "style": {}},
                {"id": "item1", "type": "text", "name": "目录项1", "rect": [180, 165, 200, 30], "style": {"font_size": 18}},
                {"id": "icon2", "type": "image", "name": "图标2", "rect": [100, 250, 60, 60], "style": {}},
                {"id": "item2", "type": "text", "name": "目录项2", "rect": [180, 265, 200, 30], "style": {"font_size": 18}},
            ]
        },
        # 两栏内容版式 (21-25)
        21: {
            "layout_name": "左右两栏",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 32, "bold": True}},
                {"id": "left_content", "type": "text", "name": "左侧内容", "rect": [50, 130, 460, 500], "style": {"font_size": 18}},
                {"id": "right_content", "type": "text", "name": "右侧内容", "rect": [514, 130, 460, 500], "style": {"font_size": 18}},
            ]
        },
        22: {
            "layout_name": "左图右文",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 32, "bold": True}},
                {"id": "left_image", "type": "image", "name": "左侧图片", "rect": [50, 130, 460, 400], "style": {}},
                {"id": "right_text", "type": "text", "name": "右侧文字", "rect": [514, 130, 460, 400], "style": {"font_size": 18}},
            ]
        },
        # 图表页版式 (36-40)
        36: {
            "layout_name": "单图表页",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 28, "bold": True}},
                {"id": "chart", "type": "chart", "name": "图表", "rect": [100, 130, 824, 450], "style": {}},
                {"id": "note", "type": "text", "name": "备注", "rect": [100, 620, 824, 80], "style": {"font_size": 14}},
            ]
        },
        37: {
            "layout_name": "图表+要点",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 28, "bold": True}},
                {"id": "chart", "type": "chart", "name": "图表", "rect": [50, 130, 600, 350], "style": {}},
                {"id": "point1", "type": "text", "name": "要点1", "rect": [680, 150, 250, 40], "style": {"font_size": 16}},
                {"id": "point2", "type": "text", "name": "要点2", "rect": [680, 210, 250, 40], "style": {"font_size": 16}},
                {"id": "point3", "type": "text", "name": "要点3", "rect": [680, 270, 250, 40], "style": {"font_size": 16}},
            ]
        },
        # 图片页版式 (51-55)
        51: {
            "layout_name": "全图背景",
            "placeholders": [
                {"id": "background", "type": "image", "name": "背景图", "rect": [0, 0, 1024, 768], "style": {}},
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 280, 824, 80], "style": {"font_size": 48, "bold": True, "color": "white"}},
                {"id": "caption", "type": "text", "name": "说明文字", "rect": [100, 650, 824, 40], "style": {"font_size": 16, "color": "white"}},
            ]
        },
        52: {
            "layout_name": "图片拼贴",
            "placeholders": [
                {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 28, "bold": True}},
                {"id": "image1", "type": "image", "name": "图片1", "rect": [50, 130, 300, 250], "style": {}},
                {"id": "image2", "type": "image", "name": "图片2", "rect": [362, 130, 300, 250], "style": {}},
                {"id": "image3", "type": "image", "name": "图片3", "rect": [674, 130, 300, 250], "style": {}},
            ]
        },
    }

    # 获取版式信息
    layout_info = placeholder_maps.get(layout_id, {
        "layout_name": f"版式{layout_id}",
        "placeholders": [
            {"id": "title", "type": "text", "name": "标题", "rect": [100, 50, 824, 50], "style": {"font_size": 28, "bold": True}},
            {"id": "content", "type": "text", "name": "内容区", "rect": [100, 130, 824, 550], "style": {"font_size": 18}},
        ]
    })

    placeholders = layout_info.get("placeholders", [])
    for p in placeholders:
        p["rect"] = p.get("rect", [0, 0, 100, 50])

    return {
        "layout_id": layout_id,
        "layout_name": layout_info["layout_name"],
        "placeholders": placeholders,
        "total_placeholders": len(placeholders)
    }


# 便捷函数：获取占位类型统计
def get_placeholder_stats(layout_id: int) -> Dict[str, int]:
    """获取版式中各类型占位区域的数量统计。"""
    result = get_placeholder_map(layout_id)

    stats = {"text": 0, "image": 0, "chart": 0, "other": 0}
    for p in result["placeholders"]:
        ptype = p.get("type", "other")
        if ptype in stats:
            stats[ptype] += 1
        else:
            stats["other"] += 1

    return stats


# 便捷函数：查找特定类型占位
def find_placeholder_by_type(layout_id: int, placeholder_type: str) -> List[Dict[str, Any]]:
    """查找指定类型的占位区域。"""
    result = get_placeholder_map(layout_id)

    return [p for p in result["placeholders"] if p.get("type") == placeholder_type]


# 便捷函数：验证占位区域是否有效
def validate_placeholder_rect(rect: List[int]) -> bool:
    """验证占位区域坐标是否有效。"""
    if not isinstance(rect, list) or len(rect) != 4:
        return False

    left, top, width, height = rect
    return left >= 0 and top >= 0 and width > 0 and height > 0


def placeholder_mapper(layout_id: int) -> Dict[str, Any]:
    return get_placeholder_map(layout_id)
