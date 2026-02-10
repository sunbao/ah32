"""Answer Formatter - Format answers into Plan JSON."""

import json
import uuid
from typing import Any, Dict, List, Optional


def answer_formatter(
    answers: List[Dict[str, Any]],
    format: str = "json"
) -> Dict[str, Any]:
    """格式化答案，生成 Plan JSON 格式。

    Args:
        answers: 答案列表，每个元素包含 q 和 answer
        format: 输出格式，支持 "letter" | "text" | "json"

    Returns:
        Plan JSON 格式的答案块
    """
    if format == "letter":
        # 只返回选项字母
        return _format_letter(answers)
    elif format == "text":
        # 返回文字答案
        return _format_text(answers)
    else:
        # 返回完整 JSON 格式
        return _format_json(answers)


def _format_letter(answers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """格式化为字母答案。"""
    return {
        "type": "answer_letter",
        "data": {
            "answers": [
                {"q": str(a.get("q", "")), "answer": str(a.get("answer", ""))}
                for a in answers
            ]
        }
    }


def _format_text(answers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """格式化为文字答案。"""
    return {
        "type": "answer_text",
        "data": {
            "answers": [
                {
                    "q": str(a.get("q", "")),
                    "answer": str(a.get("answer", "")),
                    "type": str(a.get("type", "text"))
                }
                for a in answers
            ]
        }
    }


def _format_json(answers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """格式化为完整的 Plan JSON。"""
    # 生成稳定的 block_id
    content_hash = _hash_answers(answers)
    block_id = f"exam_answer_{content_hash[:12]}"

    return {
        "schema_version": "ah32.plan.v1",
        "blocks": [
            {
                "id": block_id,
                "type": "answer_sheet",
                "data": {
                    "title": "答案与解析",
                    "answers": [
                        {
                            "q": str(a.get("q", "")),
                            "answer": str(a.get("answer", "")),
                            "type": str(a.get("type", "text")),
                            "analysis": str(a.get("analysis", ""))
                        }
                        for a in answers
                    ],
                    "metadata": {
                        "generated_at": _get_timestamp(),
                        "question_count": len(answers),
                        "format": "complete"
                    }
                }
            }
        ]
    }


def _hash_answers(answers: List[Dict[str, Any]]) -> str:
    """生成答案的哈希值，用于生成稳定的 block_id。"""
    import hashlib
    content = json.dumps(answers, sort_keys=True)
    return hashlib.md5(content.encode()).hexdigest()


def _get_timestamp() -> str:
    """获取当前时间戳。"""
    from datetime import datetime
    return datetime.now().isoformat()


# 便捷函数：创建标准答案
def create_answer(q: str, answer: str, qtype: str = "text") -> Dict[str, Any]:
    """创建一个标准答案对象。"""
    return {
        "q": q,
        "answer": answer,
        "type": qtype
    }


# 便捷函数：创建选择题答案
def create_choice_answer(q: str, letter: str, analysis: str = "") -> Dict[str, Any]:
    """创建一个选择题答案。"""
    return {
        "q": q,
        "answer": letter.upper(),  # 统一大写
        "type": "choice",
        "analysis": analysis
    }


# 便捷函数：创建填空题答案
def create_fill_blank_answer(q: str, answer: str) -> Dict[str, Any]:
    """创建一个填空题答案。"""
    return {
        "q": q,
        "answer": answer,
        "type": "fill_blank"
    }


# 便捷函数：创建阅读题答案
def create_reading_answer(q: str, answer: str, key_points: List[str] = None) -> Dict[str, Any]:
    """创建一个阅读题答案。"""
    return {
        "q": q,
        "answer": answer,
        "type": "reading",
        "key_points": key_points or []
    }


# 便捷函数：生成完整的答案表
def generate_answer_sheet(
    choices: List[Dict[str, Any]] = None,
    fill_blanks: List[Dict[str, Any]] = None,
    essays: List[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """生成完整的答案表（包含所有题型）。"""
    answers = []

    if choices:
        answers.extend(choices)
    if fill_blanks:
        answers.extend(fill_blanks)
    if essays:
        answers.extend(essays)

    return _format_json(answers)


# 便捷函数：验证答案格式
def validate_answers(answers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """验证答案列表的格式。"""
    valid = []
    invalid = []

    for a in answers:
        if a.get("q") and a.get("answer"):
            valid.append(a)
        else:
            invalid.append(a)

    return {
        "valid_count": len(valid),
        "invalid_count": len(invalid),
        "is_valid": len(invalid) == 0,
        "invalid_items": invalid
    }
