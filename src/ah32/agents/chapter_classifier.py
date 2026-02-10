"""智能章节识别器 - 基于关键词和模式匹配"""

from __future__ import annotations

import re
import logging
from typing import Tuple, Dict, Any, List

from ah32.services.chapter_types import (
    ChapterType,
    CHAPTER_TYPE_CONFIG,
    get_type_keywords,
    get_type_patterns,
)

logger = logging.getLogger(__name__)


class ChapterClassifier:
    """智能章节分类器"""

    def __init__(self):
        self.type_keywords = get_type_keywords()
        self.type_patterns = get_type_patterns()

    def classify(
        self,
        chapter_title: str,
        chapter_content: str,
        context: str = ""
    ) -> Dict[str, Any]:
        """
        智能分类章节类型

        Args:
            chapter_title: 章节标题
            chapter_content: 章节内容
            context: 上下文信息（如前后章节）

        Returns:
            {
                "primary_type": ChapterType,
                "confidence": 0.95,
                "type_name": "技术要求",
                "all_scores": {...},
                "matched_keywords": [...],
                "matched_patterns": [...],
                "requirements": [...]
            }
        """
        # 合并所有文本用于分析
        full_text = f"{chapter_title}\n{chapter_content}\n{context}".lower()

        # 计算每个类型的匹配分数
        type_scores = {}
        matched_keywords = {}
        matched_patterns = {}

        for chapter_type, keywords in self.type_keywords.items():
            score = 0
            type_matched_keywords = []
            type_matched_patterns = []

            # 关键词匹配评分
            for keyword in keywords:
                if keyword in full_text:
                    # 标题中的关键词权重更高
                    title_weight = 3 if keyword in chapter_title.lower() else 1
                    content_weight = 1
                    score += title_weight + content_weight
                    type_matched_keywords.append(keyword)

            # 正则模式匹配评分
            patterns = self.type_patterns[chapter_type]
            for pattern in patterns:
                if re.search(pattern, full_text, re.IGNORECASE):
                    # 标题中匹配权重更高
                    title_match = re.search(pattern, chapter_title, re.IGNORECASE)
                    weight = 5 if title_match else 3
                    score += weight
                    type_matched_patterns.append(pattern)

            type_scores[chapter_type] = score
            matched_keywords[chapter_type] = type_matched_keywords
            matched_patterns[chapter_type] = type_matched_patterns

        # 找出最高分的类型
        if not type_scores or max(type_scores.values()) == 0:
            # 没有匹配，返回默认类型
            primary_type = ChapterType.TECHNICAL
            confidence = 0.1
        else:
            primary_type = max(type_scores, key=type_scores.get)
            max_score = type_scores[primary_type]
            total_score = sum(type_scores.values())

            # 计算置信度：最高分 / (最高分 + 第二高分 + 修正项)
            sorted_scores = sorted(type_scores.values(), reverse=True)
            if len(sorted_scores) > 1:
                confidence = max_score / (max_score + sorted_scores[1] + 5)
            else:
                # 只有一个类型匹配，给予较高置信度
                confidence = 0.85

            # 置信度范围调整
            confidence = min(0.99, max(0.3, confidence))

        # 解析具体要求
        requirements = self._extract_requirements(chapter_content)

        return {
            "primary_type": primary_type,
            "confidence": round(confidence, 3),
            "type_name": CHAPTER_TYPE_CONFIG[primary_type]["name"],
            "all_scores": {t.value: s for t, s in type_scores.items()},
            "matched_keywords": matched_keywords.get(primary_type, []),
            "matched_patterns": matched_patterns.get(primary_type, []),
            "requirements": requirements,
            "type_config": CHAPTER_TYPE_CONFIG[primary_type],
        }

    def _extract_requirements(self, chapter_content: str) -> List[Dict[str, Any]]:
        """
        从章节内容中提取具体要求

        Args:
            chapter_content: 章节内容

        Returns:
            要求列表
        """
        requirements = []

        # 按行分割内容
        lines = chapter_content.split('\n')

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # 检查是否包含要求标记
            importance = None
            markers = []

            for marker in ["★", "▲", "※"]:
                if marker in line:
                    markers.append(marker)
                    if marker == "★":
                        importance = "mandatory"  # 废标项
                    elif marker == "※":
                        importance = "scoring"  # 评分项
                    elif marker == "▲":
                        importance = "important"  # 重要项

            # 检查是否看起来像要求（以数字开头、以冒号结尾等）
            if importance or re.match(r'^\d+[\.\)]\s+', line) or '：' in line:
                req = {
                    "text": line,
                    "importance": importance or "normal",
                    "markers": markers,
                    "needs_evidence": self._needs_evidence(line),
                }
                requirements.append(req)

        return requirements

    def _needs_evidence(self, text: str) -> bool:
        """判断要求是否需要证明文件"""
        evidence_keywords = [
            "提供", "提交", "附", "证明", "证书", "文件",
            "报告", "证明材料", "资质证明", "业绩证明",
            "财务证明", "信誉证明"
        ]

        return any(keyword in text for keyword in evidence_keywords)

    def get_response_format(self, chapter_type: ChapterType) -> str:
        """获取章节类型的建议响应格式"""
        return CHAPTER_TYPE_CONFIG[chapter_type]["response_format"]

    def suggest_evidence(self, chapter_type: ChapterType) -> List[str]:
        """建议需要的证明文件"""
        if CHAPTER_TYPE_CONFIG[chapter_type]["evidence_needed"]:
            # 基于类型返回常见的证明文件
            evidence_map = {
                ChapterType.QUALIFICATION: [
                    "营业执照副本",
                    "资质证书",
                    "财务审计报告",
                    "业绩证明材料",
                    "ISO认证证书",
                    "法定代表人身份证明",
                    "投标人诚信承诺书"
                ],
                ChapterType.TECHNICAL: [
                    "产品技术白皮书",
                    "检测报告",
                    "技术方案详细说明",
                    "创新点说明"
                ],
                ChapterType.COMMERCIAL: [
                    "报价明细表",
                    "成本分析报告",
                    "付款方式说明"
                ],
            }
            return evidence_map.get(chapter_type, [])
        return []

    def batch_classify(self, chapters: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """
        批量分类章节

        Args:
            chapters: [{"title": "...", "content": "..."}, ...]

        Returns:
            分类结果列表
        """
        results = []
        for i, chapter in enumerate(chapters):
            result = self.classify(
                chapter_title=chapter.get("title", ""),
                chapter_content=chapter.get("content", ""),
            )
            result["index"] = i
            result["title"] = chapter.get("title", "")
            results.append(result)

        return results


# 单例实例
_classifier = None


def get_classifier() -> ChapterClassifier:
    """获取章节分类器单例"""
    global _classifier
    if _classifier is None:
        _classifier = ChapterClassifier()
    return _classifier
