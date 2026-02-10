"""Timeline Generator - Extract milestone dates from bid documents."""

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional


def generate_timeline(
    bid_doc_text: str,
    reference_date: str = None
) -> Dict[str, Any]:
    """从招标文档提取里程碑时间线。

    Args:
        bid_doc_text: 招标文档全文内容
        reference_date: 参考日期（格式：YYYY-MM-DD），默认使用今天

    Returns:
        {
            "phases": [
                {"name": "资格审查", "ddl": "2024-03-01", "days_remaining": 5, "source": "P3 招标公告"},
                {"name": "现场探勘", "ddl": "2024-03-05", "days_remaining": 9, "source": "P5 投标人须知"},
                {"name": "答疑截止", "ddl": "2024-03-10", "days_remaining": 14, "source": "P5 投标人须知"},
                {"name": "投标截止", "ddl": "2024-03-15", "days_remaining": 19, "source": "P2 招标公告"}
            ],
            "total_days": 24,
            "today": "2024-02-25"
        }
    """
    if not bid_doc_text:
        return {"phases": [], "total_days": 0, "today": _get_today()}

    phases: List[Dict[str, Any]] = []
    today = reference_date or _get_today()

    # 定义里程碑模式及其关键词
    milestone_patterns = [
        (r"资格审查.*?(?:截止|时间|日期)[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "资格审查"),
        (r"资格(?:审查|预审).*?截止.*?(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "资格审查截止"),
        (r"现场(?:探勘|踏勘|考察).*?[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "现场探勘"),
        (r"答疑.*?(?:截止|时间|日期)[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "答疑截止"),
        (r"澄清.*?(?:截止|时间|日期)[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "澄清截止"),
        (r"投标截止.*?[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "投标截止"),
        (r"递交(?:投标|响应)(?:文件)?.*?(?:截止|时间|日期)[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "投标截止"),
        (r"开标.*?[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "开标"),
        (r"截止.*?(?:日期|时间)[：:]\s*(\d{4}[-年]\d{1,2}[-月]\d{1,2})", "截止"),
    ]

    # 提取日期
    extracted_dates: List[Dict[str, Any]] = []
    for pattern, milestone_name in milestone_patterns:
        matches = re.finditer(pattern, bid_doc_text)
        for match in matches:
            date_str = match.group(1)
            parsed_date = _parse_date(date_str)
            if parsed_date:
                # 获取上下文（来源章节）
                start_pos = max(0, match.start() - 50)
                context = bid_doc_text[start_pos:match.start()].strip()
                source = _extract_source(context)

                extracted_dates.append({
                    "name": milestone_name,
                    "date": parsed_date,
                    "source": source
                })

    # 去重并按日期排序
    seen = set()
    for date_info in extracted_dates:
        key = (date_info["name"], date_info["date"])
        if key not in seen:
            seen.add(key)
            days_remaining = (datetime.strptime(date_info["date"], "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
            phases.append({
                "name": date_info["name"],
                "ddl": date_info["date"],
                "days_remaining": days_remaining,
                "source": date_info["source"]
            })

    # 按日期排序
    phases.sort(key=lambda x: x["ddl"])

    # 计算总天数
    total_days = 0
    if phases:
        first_date = datetime.strptime(phases[0]["ddl"], "%Y-%m-%d")
        last_date = datetime.strptime(phases[-1]["ddl"], "%Y-%m-%d")
        total_days = (last_date - first_date).days

    return {
        "phases": phases,
        "total_days": total_days,
        "today": today
    }


def timeline_generator(bid_doc_text: str, reference_date: str = None) -> Dict[str, Any]:
    return generate_timeline(bid_doc_text=bid_doc_text, reference_date=reference_date)


def _parse_date(date_str: str) -> Optional[str]:
    """解析各种日期格式为 YYYY-MM-DD。"""
    if not date_str:
        return None

    # 替换中文分隔符
    date_str = date_str.replace("年", "-").replace("月", "-").replace("日", "").strip()

    formats = [
        "%Y-%m-%d",
        "%Y-%m-%d",
        "%Y-%m-%d",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    return None


def _extract_source(context: str) -> str:
    """从上下文中提取来源章节。"""
    # 常见章节标记
    chapter_patterns = [
        r"第[一二三四五六七八九十]+章",
        r"P?\d+",
        r"招标公告",
        r"投标人须知",
        r"招标(?:文件|邀请)",
        r"技术规格",
        r"商务条款",
    ]

    for pattern in chapter_patterns:
        match = re.search(pattern, context)
        if match:
            return match.group(0)

    return "正文"


def _get_today() -> str:
    """获取今天的日期。"""
    return datetime.now().strftime("%Y-%m-%d")


# 便捷函数：检查是否临近截止
def is_approaching_deadline(timeline: Dict[str, Any], warning_days: int = 3) -> bool:
    """检查是否临近投标截止。"""
    if not timeline.get("phases"):
        return False

    for phase in timeline["phases"]:
        if "截止" in phase["name"] or "投标" in phase["name"]:
            return phase.get("days_remaining", 0) <= warning_days

    return False


# 便捷函数：获取下一个里程碑
def get_next_milestone(timeline: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """获取下一个未到的里程碑。"""
    if not timeline.get("phases"):
        return None

    today = timeline["today"]
    for phase in timeline["phases"]:
        if phase["ddl"] >= today:
            return phase

    return None
