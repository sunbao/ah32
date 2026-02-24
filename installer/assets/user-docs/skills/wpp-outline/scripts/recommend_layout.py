"""Layout Recommender - Recommend WPP layouts based on content."""

from typing import Any, Dict, List, Optional


def recommend_layout(
    content_type: str = "text",
    has_title: bool = True,
    has_chart: bool = False,
    has_image: bool = False,
    point_count: int = 0,
    custom_requirements: str = ""
) -> Dict[str, Any]:
    """根据幻灯片内容推荐合适的 WPP 版式。

    Args:
        content_type: 内容类型
            - title: 标题页
            - toc: 目录页
            - two_column: 两栏内容
            - chart: 图表页
            - image: 图片页
            - text: 纯文本
            - mix: 混合内容
        has_title: 是否包含标题
        has_chart: 是否包含图表
        has_image: 是否包含图片
        point_count: 要点数量
        custom_requirements: 自定义需求描述

    Returns:
        {
            "recommendations": [
                {
                    "layout_id": 15,
                    "layout_name": "标题页",
                    "confidence": 0.95,
                    "reason": "标题页场景，简洁大气设计"
                }
            ],
            "alternatives": [
                {"layout_id": 16, "layout_name": "副标题页", "confidence": 0.80, "reason": "可添加副标题和日期"}
            ],
            "suggestions": ["建议使用公司标准配色"]
        }
    """
    # 版式推荐规则库
    layout_rules = {
        "title": [
            {"layout_id": 1, "layout_name": "简洁标题页", "reason": "大气简洁，适合正式场合"},
            {"layout_id": 2, "layout_name": "副标题标题页", "reason": "支持主副标题和日期"},
            {"layout_id": 3, "layout_name": "居中标题页", "reason": "文字居中，适合简洁风格"},
            {"layout_id": 5, "layout_name": "全图标题页", "reason": "背景图+标题，适合品牌展示"},
        ],
        "toc": [
            {"layout_id": 6, "layout_name": "标准目录页", "reason": "经典目录布局"},
            {"layout_id": 7, "layout_name": "图形化目录", "reason": "图标+文字，适合可视化"},
            {"layout_id": 8, "layout_name": "数字目录", "reason": "数字编号+内容，适合步骤展示"},
        ],
        "text": [
            {"layout_id": 11, "layout_name": "单栏标题正文", "reason": "标题+正文，适合要点展示"},
            {"layout_id": 12, "layout_name": "大标题正文", "reason": "大字号标题，适合强调"},
            {"layout_id": 13, "layout_name": "左标题右正文", "reason": "左侧标题，右侧正文"},
        ],
        "two_column": [
            {"layout_id": 21, "layout_name": "左右两栏", "reason": "标准左右分栏"},
            {"layout_id": 22, "layout_name": "左图右文", "reason": "左侧图片，右侧说明"},
            {"layout_id": 23, "layout_name": "左文右图", "reason": "左侧说明，右侧图片"},
            {"layout_id": 24, "layout_name": "对比布局", "reason": "左右对比，适合并列内容"},
        ],
        "chart": [
            {"layout_id": 36, "layout_name": "单图表页", "reason": "单图表+标题说明"},
            {"layout_id": 37, "layout_name": "图表+要点", "reason": "图表+3-4个要点"},
            {"layout_id": 38, "layout_name": "双图表页", "reason": "并排两个图表"},
            {"layout_id": 40, "layout_name": "数据卡片", "reason": "多个数据卡片展示"},
        ],
        "image": [
            {"layout_id": 51, "layout_name": "全图背景", "reason": "图片铺满，可叠加文字"},
            {"layout_id": 52, "layout_name": "图片拼贴", "reason": "多图并排展示"},
            {"layout_id": 53, "layout_name": "图片标题", "reason": "大图+标题+简短说明"},
        ],
        "mix": [
            {"layout_id": 66, "layout_name": "图文并茂", "reason": "图片+文字组合"},
            {"layout_id": 67, "layout_name": "图表组合", "reason": "图表+说明文字"},
            {"layout_id": 68, "layout_name": "多内容区", "reason": "多个内容区块组合"},
            {"layout_id": 70, "layout_name": "自定义布局", "reason": "灵活内容组合"},
        ],
    }

    # 根据内容类型选择版式
    content_type = content_type.lower()
    if content_type not in layout_rules:
        content_type = "mix"

    candidates = [dict(x) for x in layout_rules[content_type]]
    for rec in candidates:
        rec.setdefault("confidence", 0.9)

    # 根据特征调整推荐
    if has_title and content_type != "title":
        for rec in candidates:
            if "标题" not in rec["layout_name"]:
                rec["confidence"] *= 0.9

    if has_chart:
        # 提高图表相关版式的权重
        for rec in candidates:
            if "图表" in rec["layout_name"] or "数据" in rec["layout_name"]:
                rec["confidence"] = min(1.0, (rec.get("confidence", 0.9) or 0.9) * 1.1)

    if has_image:
        for rec in candidates:
            if "图" in rec["layout_name"]:
                rec["confidence"] = min(1.0, (rec.get("confidence", 0.9) or 0.9) * 1.1)

    # 根据要点数量调整
    if point_count > 0:
        for rec in candidates:
            if "要点" in rec["layout_name"] or "要点" in rec["reason"]:
                if 3 <= point_count <= 4:
                    rec["confidence"] = min(1.0, (rec.get("confidence", 0.9) or 0.9) * 1.05)
                else:
                    rec["confidence"] *= 0.95

    # 按置信度排序
    candidates.sort(key=lambda x: x.get("confidence", 0.9), reverse=True)

    # 提取主推荐和备选
    recommendations = []
    alternatives = []

    for i, rec in enumerate(candidates):
        item = {
            "layout_id": rec["layout_id"],
            "layout_name": rec["layout_name"],
            "confidence": rec.get("confidence", 0.9),
            "reason": rec["reason"]
        }
        if i < 1:
            recommendations.append(item)
        else:
            alternatives.append(item)

    # 生成建议
    suggestions = _generate_suggestions(content_type, has_title, has_chart, has_image, custom_requirements)

    return {
        "recommendations": recommendations,
        "alternatives": alternatives[:2],
        "suggestions": suggestions,
        "matched_criteria": {
            "content_type": content_type,
            "has_title": has_title,
            "has_chart": has_chart,
            "has_image": has_image,
            "point_count": point_count
        }
    }


def _generate_suggestions(
    content_type: str,
    has_title: bool,
    has_chart: bool,
    has_image: bool,
    custom_requirements: str
) -> List[str]:
    """生成使用建议。"""
    suggestions = []

    if content_type == "title":
        suggestions.append("建议使用公司标准色系作为主色调")
        suggestions.append("标题建议使用品牌字体")

    if content_type == "toc":
        suggestions.append("目录项建议控制在5-7项之间")
        suggestions.append("可使用图标增强可视化效果")

    if has_chart:
        suggestions.append("图表数据建议标注数据来源")
        suggestions.append("重要数据点可添加文字说明")

    if has_image:
        suggestions.append("图片建议保持风格统一")
        suggestions.append("可添加边框或阴影增强层次感")

    if custom_requirements:
        suggestions.append(f"根据自定义需求：{custom_requirements}")

    return suggestions


# 便捷函数：根据场景名称推荐版式
def recommend_by_scene(scene: str) -> Dict[str, Any]:
    """根据场景名称推荐版式。"""
    scene_map = {
        "产品介绍": {"content_type": "mix", "has_image": True, "has_chart": True},
        "项目汇报": {"content_type": "two_column", "has_chart": True, "point_count": 4},
        "培训课件": {"content_type": "text", "point_count": 3},
        "会议演示": {"content_type": "title", "has_title": True},
        "年度总结": {"content_type": "mix", "has_chart": True, "point_count": 5},
    }

    if scene in scene_map:
        return recommend_layout(**scene_map[scene])
    else:
        return recommend_layout(content_type="mix")


# 便捷函数：批量推荐多页幻灯片版式
def batch_recommend(slides: List[Dict[str, Any]]) -> Dict[str, Any]:
    """为多页幻灯片批量推荐版式。"""
    recommendations = []

    for i, slide in enumerate(slides, start=1):
        result = recommend_layout(
            content_type=slide.get("type", "text"),
            has_title=slide.get("has_title", True),
            has_chart=slide.get("has_chart", False),
            has_image=slide.get("has_image", False),
            point_count=slide.get("point_count", 0),
        )
        recommendations.append({
            "slide_number": i,
            "recommendations": result["recommendations"],
            "alternatives": result["alternatives"],
        })

    return {
        "slides": recommendations,
        "total_slides": len(slides)
    }


def layout_recommender(slide_content: Dict[str, Any]) -> Dict[str, Any]:
    payload = slide_content if isinstance(slide_content, dict) else {}
    return recommend_layout(
        content_type=str(payload.get("type") or "text"),
        has_title=bool(payload.get("has_title", True)),
        has_chart=bool(payload.get("has_chart", False)),
        has_image=bool(payload.get("has_image", False)),
        point_count=int(payload.get("point_count", 0) or 0),
        custom_requirements=str(payload.get("custom_requirements") or ""),
    )
