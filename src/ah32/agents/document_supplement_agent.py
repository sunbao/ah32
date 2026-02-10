"""文档智能补充Agent - 基于RAG和LLM"""

from __future__ import annotations

import json
import logging
from typing import Dict, List, Any, Optional
from datetime import datetime

from ah32.core.prompts import get_prompt
from ah32.memory.manager import Ah32MemorySystem

logger = logging.getLogger(__name__)


class DocumentSupplementAgent:
    """文档智能补充Agent"""

    def __init__(self, llm, memory_system: Ah32MemorySystem):
        self.llm = llm
        self.memory_system = memory_system
        self.supplement_prompt = get_prompt("document_supplement")

    async def analyze_and_supplement(
        self,
        reference_content: str,
        target_content: str,
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """分析文档并生成补充建议"""

        try:
            # 1. 分析参考文档要求
            reference_requirements = await self._extract_reference_requirements(reference_content)

            # 2. 分析目标文档响应
            target_responses = await self._extract_target_responses(target_content)

            # 3. 匹配要求与响应
            matched, missing = await self._match_requirements_and_responses(
                reference_requirements, target_responses
            )

            # 4. 生成补充建议
            supplement_suggestions = []
            for req in missing:
                # 4a. 通过RAG检索相关信息
                rag_info = await self._retrieve_rag_info(req)

                # 4b. 如果RAG中没有，使用LLM生成建议
                if not rag_info:
                    llm_suggestion = await self._generate_llm_suggestion(req)
                else:
                    llm_suggestion = rag_info

                supplement_suggestions.append({
                    "requirement": req,
                    "suggestion": llm_suggestion,
                    "priority": req.get("priority", "medium"),
                    "category": req.get("category", "general")
                })

            # 5. 按优先级排序
            supplement_suggestions.sort(
                key=lambda x: {"high": 0, "medium": 1, "low": 2}.get(x["priority"], 1)
            )

            return {
                "success": True,
                "reference_requirements_count": len(reference_requirements),
                "target_responses_count": len(target_responses),
                "matched_count": len(matched),
                "missing_count": len(missing),
                "match_rate": len(matched) / len(reference_requirements) if reference_requirements else 0,
                "supplement_suggestions": supplement_suggestions,
                "summary": self._generate_summary(matched, missing, supplement_suggestions),
                "timestamp": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"文档补充分析失败: {e}")
            return {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    async def _extract_reference_requirements(self, content: str) -> List[Dict[str, Any]]:
        """提取参考文档要求"""
        prompt = f"""
请分析以下参考文档，提取所有要求和建议，并以JSON格式返回：

文档内容：
{content[:8000]}

请提取以下信息（必须是有效的JSON格式）：
{{
    "requirements": [
        {{
            "id": "req_001",
            "chapter": "章节名称",
            "title": "要求标题",
            "content": "要求内容",
            "type": "技术要求/商务要求/资质要求",
            "priority": "high/medium/low",
            "is_mandatory": true,
            "keywords": ["关键词1", "关键词2"]
        }}
    ],
    "key_evaluation_criteria": ["评分标准1", "评分标准2"],
    "summary": "参考文档总结"
}}

只返回JSON，不要其他文字。
        """

        try:
            response = self.llm.invoke([("human", prompt)])
            result = json.loads(response.content)
            return result.get("requirements", [])
        except Exception as e:
            logger.error(f"提取参考要求失败: {e}")
            return []

    async def _extract_target_responses(self, content: str) -> List[Dict[str, Any]]:
        """提取目标文档响应"""
        prompt = f"""
请分析以下目标文档，提取所有响应内容，并以JSON格式返回：

文档内容：
{content[:8000]}

请提取以下信息（必须是有效的JSON格式）：
{{
    "responses": [
        {{
            "id": "resp_001",
            "chapter": "章节名称",
            "title": "响应标题",
            "content": "响应内容",
            "covers_requirements": ["要求1", "要求2"],
            "completeness": "complete/partial/missing",
            "quality_score": 8.5
        }}
    ],
    "technical_solution_summary": "技术方案总结",
    "compliance_points": ["合规点1", "合规点2"],
    "summary": "目标文档总结"
}}

只返回JSON，不要其他文字。
        """

        try:
            response = self.llm.invoke([("human", prompt)])
            result = json.loads(response.content)
            return result.get("responses", [])
        except Exception as e:
            logger.error(f"提取目标响应失败: {e}")
            return []

    async def _match_requirements_and_responses(
        self,
        requirements: List[Dict[str, Any]],
        responses: List[Dict[str, Any]]
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """匹配要求与响应，找出缺失项"""

        matched = []
        missing = []

        for req in requirements:
            is_matched = False
            for resp in responses:
                # 检查响应是否覆盖该要求
                if self._check_coverage(req, resp):
                    matched.append({
                        "requirement": req,
                        "response": resp,
                        "coverage_score": self._calculate_coverage(req, resp)
                    })
                    is_matched = True
                    break

            if not is_matched:
                missing.append(req)

        return matched, missing

    def _check_coverage(self, req: Dict[str, Any], resp: Dict[str, Any]) -> bool:
        """检查响应是否覆盖要求"""
        req_keywords = req.get("keywords", [])
        resp_content = resp.get("content", "").lower()
        resp_title = resp.get("title", "").lower()

        # 检查关键词匹配
        for keyword in req_keywords:
            if keyword.lower() in resp_content or keyword.lower() in resp_title:
                return True

        # 检查内容相关性
        req_content = req.get("content", "").lower()
        if any(word in resp_content for word in req_content.split()[:5]):
            return True

        return False

    def _calculate_coverage(self, req: Dict[str, Any], resp: Dict[str, Any]) -> float:
        """计算覆盖率（0-1）"""
        req_content = req.get("content", "")
        resp_content = resp.get("content", "")

        # 简单的词汇匹配算法
        req_words = set(req_content.lower().split())
        resp_words = set(resp_content.lower().split())

        if not req_words:
            return 1.0

        intersection = req_words.intersection(resp_words)
        return len(intersection) / len(req_words)

    async def _retrieve_rag_info(self, requirement: Dict[str, Any]) -> Optional[str]:
        """通过RAG检索相关信息"""
        try:
            # 构建检索查询
            query = f"{requirement.get('title', '')} {requirement.get('content', '')}"
            keywords = requirement.get("keywords", [])

            # 检索相关记忆和知识
            search_results = await self.memory_system.search(
                query=query,
                top_k=3
            )

            if search_results and len(search_results) > 0:
                # 返回最相关的检索结果
                return search_results[0].get("content", "")

            return None

        except Exception as e:
            logger.warning(f"RAG检索失败: {e}")
            return None

    async def _generate_llm_suggestion(self, requirement: Dict[str, Any]) -> str:
        """使用LLM生成补充建议"""
        prompt = f"""
作为一位资深的招投标专家，请为以下缺失的要求生成具体的补充建议：

要求信息：
- 章节：{requirement.get('chapter', '未知')}
- 标题：{requirement.get('title', '未知')}
- 内容：{requirement.get('content', '未知')}
- 类型：{requirement.get('type', '未知')}
- 优先级：{requirement.get('priority', 'medium')}

请提供：
1. **具体补充内容**：应该添加什么内容
2. **写作建议**：如何写这部分内容
3. **参考模板**：提供一个简单的写作模板
4. **注意事项**：需要避免的问题

请用专业的语言回答，条理清晰。
        """

        try:
            response = self.llm.invoke([("human", prompt)])
            return response.content
        except Exception as e:
            logger.error(f"LLM生成建议失败: {e}")
            return f"生成建议失败: {str(e)}"

    def _generate_summary(
        self,
        matched: List[Dict[str, Any]],
        missing: List[Dict[str, Any]],
        suggestions: List[Dict[str, Any]]
    ) -> str:
        """生成总结报告"""

        high_priority = [s for s in suggestions if s["priority"] == "high"]
        medium_priority = [s for s in suggestions if s["priority"] == "medium"]
        low_priority = [s for s in suggestions if s["priority"] == "low"]

        summary = f"""
=== 投标文件分析总结 ===

✅ **匹配情况**：
- 已匹配要求：{len(matched)}项
- 缺失要求：{len(missing)}项
- 整体匹配率：{len(matched)/(len(matched)+len(missing))*100:.1f}%

🔴 **高优先级补充**（{len(high_priority)}项）：
"""

        for s in high_priority[:3]:  # 只显示前3项
            summary += f"  • {s['requirement'].get('title', '未知')}\n"

        summary += f"""
🟡 **中优先级补充**（{len(medium_priority)}项）：
"""

        for s in medium_priority[:3]:
            summary += f"  • {s['requirement'].get('title', '未知')}\n"

        summary += f"""
🟢 **建议操作**：
1. 优先补充高优先级缺失项
2. 使用RAG检索相关案例和模板
3. 参考LLM生成的建议内容
4. 确保所有必需要求都有响应

总计需要补充：{len(suggestions)}项
        """

        return summary.strip()


# 便捷函数
async def analyze_and_supplement_document(
    llm,
    memory_system: Ah32MemorySystem,
    reference_content: str,
    target_content: str,
    session_id: Optional[str] = None
) -> Dict[str, Any]:
    """便捷函数：分析文档并生成补充建议"""
    agent = DocumentSupplementAgent(llm, memory_system)
    return await agent.analyze_and_supplement(
        reference_content, target_content, session_id
    )
