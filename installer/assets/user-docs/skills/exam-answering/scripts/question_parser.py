"""Question Parser - Parse question structure from documents."""

import re
from typing import Any, Dict, List, Optional


def question_parser(doc_text: str) -> Dict[str, Any]:
    """解析文档中的题目结构。

    Args:
        doc_text: 文档全文内容

    Returns:
        {
            "questions": [
                {
                    "id": "1",
                    "type": "choice" | "fill_blank" | "essay" | "reading",
                    "text": "1. 下列关于北京的描述...",
                    "has_options": True,
                    "options": ["A. 华北地区...", "B. ..."],
                    "has_fill_blank": False,
                    "position": {"start": 0, "end": 100}
                }
            ],
            "total": 5,
            "types_summary": {"choice": 3, "fill_blank": 1, "essay": 1}
        }
    """
    if not doc_text:
        return {"questions": [], "total": 0, "types_summary": {}}

    questions: List[Dict[str, Any]] = []

    # 分割题目（按题号）
    # 常见题号格式：1.  (1)  1）  一、  第1题 等
    question_pattern = r'(?:^|\n)\s*(?:(\d+)\.|(\(\d+\))|(\d+）)|([一二三四五六七八九十]+、)|（([一二三四五六七八九十]+）)|(第(\d+)[题问]))'

    # 查找所有题号位置
    positions = []
    for match in re.finditer(question_pattern, doc_text):
        start = match.start()
        # 获取题号
        groups = match.groups()
        qid = _extract_qid(groups)
        if qid:
            positions.append({"id": qid, "start": start})

    # 如果没有找到题号，尝试按段落分割
    if not positions:
        paragraphs = doc_text.split('\n\n')
        for i, para in enumerate(paragraphs):
            if len(para.strip()) > 10:  # 忽略短段落
                questions.append({
                    "id": str(i + 1),
                    "type": _detect_question_type(para),
                    "text": para.strip()[:200],  # 只取前200字符
                    "has_options": _has_options(para),
                    "options": _extract_options(para) if _has_options(para) else [],
                    "has_fill_blank": _has_fill_blank(para),
                    "position": {"start": doc_text.find(para.strip()), "end": doc_text.find(para.strip()) + len(para)}
                })
    else:
        # 解析每个题目
        for i, pos in enumerate(positions):
            start = pos["start"]
            end = positions[i + 1]["start"] - 1 if i + 1 < len(positions) else len(doc_text)

            question_text = doc_text[start:end].strip()
            question_text = _clean_question_text(question_text)

            qtype = _detect_question_type(question_text)
            has_opt = _has_options(question_text)
            options = _extract_options(question_text) if has_opt else []

            questions.append({
                "id": pos["id"],
                "type": qtype,
                "text": question_text[:500],  # 限制长度
                "has_options": has_opt,
                "options": options,
                "has_fill_blank": _has_fill_blank(question_text),
                "position": {"start": start, "end": min(start + 500, end)}
            })

    # 统计各类型数量
    types_summary: Dict[str, int] = {}
    for q in questions:
        t = q["type"]
        types_summary[t] = types_summary.get(t, 0) + 1

    return {
        "questions": questions,
        "total": len(questions),
        "types_summary": types_summary
    }


def _extract_qid(groups: tuple) -> Optional[str]:
    """从正则匹配组中提取题号。"""
    for g in groups:
        if g:
            return g
    return None


def _clean_question_text(text: str) -> str:
    """清理题目文本，去除多余空白。"""
    # 统一换行符
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 合并多余空行，但保留换行用于选项/材料分段
    text = re.sub(r"\n{2,}", "\n", text)
    # 合并多余空格
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _detect_question_type(text: str) -> str:
    """检测题目类型。"""
    text_lower = text.lower()

    # 选择题特征
    if re.search(r"[ABCD][\.\uFF0E\u3001\)\uff09]|\([ABCD]\)", text):
        return "choice"

    # 填空题特征
    if re.search(r'_{2,}|\(_{2,}\)', text):
        return "fill_blank"

    # 文言文翻译/解释特征
    if re.search(r"文言文|译文|翻译成现代汉语|翻译下列|解释下列|解释加点", text):
        return "classical_chinese"

    # 阅读题特征
    if re.search(r'阅读[材料]?|阅读理解|短文', text):
        return "reading"

    # 问答/简答题特征（题号后文字较多）
    if len(text) > 100 and not re.search(r'[ABCD]', text):
        return "essay"

    # 默认返回"text"类型
    return "text"


def _has_options(text: str) -> bool:
    """检查是否有选项。"""
    # A. B. C. D. 或 (A) (B) 等
    return bool(re.search(r"[ABCD][\.\uFF0E\u3001\)\uff09]|\([ABCD]\)", text))


def _extract_options(text: str) -> List[str]:
    """提取选项内容。"""
    options: List[str] = []

    # 匹配 A. B. C. D. 格式
    for match in re.finditer(r"([ABCD])[\.\uFF0E\u3001\)\uff09]\s*([^\n]+)", text):
        options.append(f"{match.group(1)}. {match.group(2).strip()}")

    # 如果没找到，尝试 (A) (B) 格式
    if not options:
        for match in re.finditer(r"\(([ABCD])\)\s*([^\n]+)", text):
            options.append(f"{match.group(1)}. {match.group(2).strip()}")

    return options


def _has_fill_blank(text: str) -> bool:
    """检查是否有填空。"""
    return bool(re.search(r'_{2,}|\(_{2,}\)', text))


# 便捷函数：获取特定类型的题目
def get_questions_by_type(doc_text: str, qtype: str) -> List[Dict[str, Any]]:
    """获取指定类型的题目。"""
    result = question_parser(doc_text)
    return [q for q in result["questions"] if q["type"] == qtype]


# 便捷函数：统计选择题数量
def count_choice_questions(doc_text: str) -> int:
    """统计选择题数量。"""
    result = question_parser(doc_text)
    return result["types_summary"].get("choice", 0)


# 便捷函数：统计填空题数量
def count_fill_blank_questions(doc_text: str) -> int:
    """统计填空题数量。"""
    result = question_parser(doc_text)
    return result["types_summary"].get("fill_blank", 0)
