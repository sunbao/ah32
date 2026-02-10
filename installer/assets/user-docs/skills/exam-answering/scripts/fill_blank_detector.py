"""Fill Blank Detector - Detects blank positions in documents."""

import re
from typing import Any, Dict, List, Optional


def fill_blank_detector(doc_text: str, context_chars: int = 20) -> Dict[str, Any]:
    """检测文档中的纯下划线填空题。

    Args:
        doc_text: 文档全文内容
        context_chars: 前后文字符数，默认20

    Returns:
        {
            "fill_blanks": [
                {
                    "question_id": "1",
                    "position": {"start": 10, "end": 14},
                    "context_before": "1. ______北京______是首都",
                    "context_after": "。以下是...",
                    "blank_text": "______北京______",
                    "answer_placeholder": "北京",
                    "is_multi_blank": False,
                    "blank_count": 1
                }
            ],
            "total_count": 1
        }
    """
    if not doc_text:
        return {"fill_blanks": [], "total_count": 0}

    fill_blanks: List[Dict[str, Any]] = []

    # 正则匹配纯下划线（连续的 _，至少2个）
    # 模式：______（2个或以上下划线）
    pattern = r'_{2,}'

    for match_id, match in enumerate(re.finditer(pattern, doc_text), start=1):
        start, end = match.span()
        blank_text = match.group()

        # 向前查找题号
        before_text = doc_text[max(0, start - 60):start]
        question_id = _find_question_id(before_text, match_id)

        # 多空检测：检查是否有多个下划线连续或间隔出现
        multi_blank_result = _detect_multi_blanks(doc_text, start, end)
        is_multi_blank = multi_blank_result["is_multi_blank"]
        answer_placeholder = multi_blank_result["answer_placeholder"]

        # 获取上下文
        context_before = doc_text[max(0, start - context_chars):start]
        context_after = doc_text[end:end + context_chars]

        fill_blanks.append({
            "question_id": question_id,
            "position": {"start": start, "end": end},
            "context_before": context_before,
            "context_after": context_after,
            "blank_text": blank_text,
            "answer_placeholder": answer_placeholder,
            "is_multi_blank": is_multi_blank,
            "blank_count": multi_blank_result["blank_count"]
        })

    return {
        "fill_blanks": fill_blanks,
        "total_count": len(fill_blanks)
    }


def _find_question_id(text: str, fallback_id: int) -> str:
    """向前查找题号。"""
    # 常见题号格式：1.  (1)  1）  一、  (一)  第1题  第1问等
    patterns = [
        r'(\d+)\.',           # 1.
        r'\((\d+)\)',          # (1)
        r'(\d+）)',            # 1）
        r'[一二三四五六七八九十]+、',  # 一、  二、
        r'\（([一二三四五六七八九十]+)\）',  # （一）
        r'第(\d+)[题问]',       # 第1题  第1问
    ]

    for pattern in patterns:
        matches = list(re.finditer(pattern, text))
        if matches:
            # 取最后一个（离填空最近的）
            last_match = matches[-1]
            return last_match.group(1)

    # 使用默认序号
    return str(fallback_id)


def _detect_multi_blanks(doc_text: str, start: int, end: int) -> Dict[str, Any]:
    """检测是否是多空题（如 ______北京______上海______）。"""
    # 查找当前位置后面还有多少下划线
    remaining = doc_text[end:]

    # 统计剩余的下划线组
    next_blanks = re.findall(r'_{2,}', remaining)

    if not next_blanks:
        return {
            "is_multi_blank": False,
            "blank_count": 1,
            "answer_placeholder": ""
        }

    # 多空题：多个下划线组之间用小间隔分开
    # 例如：______北京______上海______
    blank_count = 1 + len(next_blanks)

    # 尝试提取答案占位符（假设用中文句号或顿号分隔）
    # 这是一个启发式方法，LLM 需要根据上下文推断
    answers = []
    for i in range(blank_count):
        answers.append(f"[空{i + 1}]")

    return {
        "is_multi_blank": blank_count > 1,
        "blank_count": blank_count,
        "answer_placeholder": " / ".join(answers) if blank_count > 1 else ""
    }


# 便捷函数：直接返回填空位置列表（简化版）
def get_fill_blank_positions(doc_text: str) -> List[Dict[str, Any]]:
    """获取填空位置的简化列表。"""
    result = fill_blank_detector(doc_text, context_chars=10)
    return [
        {
            "q": item["question_id"],
            "start": item["position"]["start"],
            "end": item["position"]["end"],
            "text": item["blank_text"]
        }
        for item in result["fill_blanks"]
    ]


# 便捷函数：检查文档是否有填空题
def has_fill_blanks(doc_text: str) -> bool:
    """检查文档是否包含填空题。"""
    result = fill_blank_detector(doc_text)
    return result["total_count"] > 0
