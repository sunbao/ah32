"""Bidding Helper Tools Registry."""

from .generate_timeline import generate_timeline
from .check_compliance import check_compliance
from .generate_checklist import generate_checklist

TOOLS = {
    "generate_timeline": {
        "name": "generate_timeline",
        "description": "从招标文档提取里程碑时间线，包括资格审查、现场探勘、答疑截止、投标截止等关键日期",
        "func": generate_timeline,
    },
    "check_compliance": {
        "name": "check_compliance",
        "description": "逐条检查投标文件与招标文件的符合性，识别符合、偏离、待确认项",
        "func": check_compliance,
    },
    "generate_checklist": {
        "name": "generate_checklist",
        "description": "生成封标前检查清单，包括签章完整性、密封要求、必备文件等",
        "func": generate_checklist,
    },
}

__all__ = ["TOOLS", "generate_timeline", "check_compliance", "generate_checklist"]
