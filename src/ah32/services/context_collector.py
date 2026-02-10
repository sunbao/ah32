"""上下文收集器 - 阿蛤（AH32）核心服务

根据 docs/AH32_DESIGN.md 设计：
- 整合前端感知数据 + RAG + Memory
- 组装完整上下文传给LLM
- 每次对话前必须执行动态感知

执行流程：
1. 前端感知 → 2. 传给后端 → 3. 组装上下文 → 4. 调用LLM
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ah32.services.at_reference_handler import AtReferenceHandler
from ah32.knowledge.store import LocalVectorStore

logger = logging.getLogger(__name__)


class ContextCollector:
    """上下文收集器 - 整合前端感知数据 + RAG + Memory"""

    def __init__(self, vector_store: LocalVectorStore):
        self.vector_store = vector_store
        self.at_handler = AtReferenceHandler(vector_store)

    async def gather_context(
        self,
        frontend_context: Dict[str, Any],
        session_id: str,
        user_input: str,
        memory_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        收集完整上下文

        Args:
            frontend_context: 前端感知数据（文档状态、光标、选区等）
            session_id: 会话ID
            user_input: 用户输入
            memory_data: Memory数据（用户偏好、对话历史等）

        Returns:
            完整上下文，供LLM使用
        """
        try:
            logger.info(f"开始收集上下文，会话ID: {session_id}")

            # 1. 基础文档信息（来自前端）
            doc_info = frontend_context.get("document", {})

            # 2. 获取用户偏好（来自Memory）
            user_prefs = self._extract_user_preferences(memory_data)

            # 3. 处理@引用（来自用户输入）
            at_result = await self.at_handler.handle(user_input)

            # 4. 检索RAG（如果有知识库引用）
            rag_results = await self._retrieve_rag(user_input, at_result)

            # 5. 组装完整上下文（包含所有感知数据）
            full_context = {
                "document": {
                    "name": doc_info.get("name", "未命名"),
                    "path": doc_info.get("path", ""),
                    "total_pages": doc_info.get("totalPages", 0),
                    "total_words": doc_info.get("totalWords", 0),
                    "total_lines": doc_info.get("total_lines", 0)
                },
                "cursor": frontend_context.get("cursor", {}),
                "selection": frontend_context.get("selection", {}),
                "structure": {
                    "headings": frontend_context.get("structure", {}).get("headings", []),
                    "tables": frontend_context.get("structure", {}).get("tables", 0),
                    "images": frontend_context.get("structure", {}).get("images", 0),
                    "current_section": frontend_context.get("structure", {}).get("currentSection", ""),
                    "semantic_sections": frontend_context.get("structure", {}).get("semanticSections", []),
                    "document_type": frontend_context.get("structure", {}).get("documentType", "report"),
                    "task_types": frontend_context.get("structure", {}).get("taskTypes", [])
                },
                "format": frontend_context.get("format", {}),
                "quality_analysis": frontend_context.get("qualityAnalysis", {}),
                "intelligent_suggestions": frontend_context.get("intelligentSuggestions", {}),
                "realtime_status": frontend_context.get("realtime", {}),
                "performance_data": frontend_context.get("performance", {}),
                "user_behavior": frontend_context.get("behavior", {}),
                "error_status": frontend_context.get("errors", {}),
                "user_preferences": user_prefs,
                "rag_references": rag_results,
                "at_references": at_result.get("processed", []),
                "available_api": [
                    "GoTo", "Find", "Range", "Selection",
                    "Copy", "Paste", "InlineShapes", "Tables"
                ]
            }

            logger.info("上下文收集完成")
            return {
                "success": True,
                "context": full_context,
                "timestamp": "2026-01-13"
            }

        except Exception as e:
            logger.error(f"上下文收集失败: {str(e)}")
            return {
                "success": False,
                "error": str(e)
            }

    def _extract_user_preferences(self, memory_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """从Memory数据中提取用户偏好"""
        if not memory_data:
            return {}

        preferences = memory_data.get("preferences", {})
        return {
            "output_style": preferences.get("output_style", "详细"),
            "language": preferences.get("language", "中文"),
            "focus_areas": preferences.get("focus_areas", []),
            "last_reference": memory_data.get("last_reference")
        }

    async def _retrieve_rag(self, user_input: str, at_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """检索RAG知识库

        Args:
            user_input: 用户输入
            at_result: @引用处理结果

        Returns:
            RAG检索结果列表
        """
        try:
            # 1. 检查是否有@引用（最高优先级）
            if at_result.get("processed"):
                # 检索指定文件
                paths = [item["path"] for item in at_result["processed"]]
                return await self._retrieve_specific_files(paths)

            # 2. 检查是否需要一般检索
            if not self._needs_knowledge_search(user_input):
                return []

            # 3. 一般检索（检索所有文件，最多5条）
            return await self._retrieve_general(user_input, limit=5)

        except Exception as e:
            logger.error(f"RAG检索失败: {str(e)}")
            return []

    async def _retrieve_specific_files(self, paths: List[str]) -> List[Dict[str, Any]]:
        """检索指定文件

        Args:
            paths: 文件路径列表

        Returns:
            检索结果
        """
        results = []
        for path in paths:
            try:
                # 在向量存储中检索
                docs_and_scores = self.vector_store.similarity_search(
                    path,  # 使用文件路径作为查询
                    k=3  # 每个文件最多3条结果
                )

                for item in docs_and_scores:
                    doc, score = item if isinstance(item, tuple) and len(item) == 2 else (item, 0.0)
                    results.append({
                        "content": doc.page_content,
                        "source": doc.metadata.get("source", path),
                        "score": float(score) if isinstance(score, (int, float)) else 0.0,
                        "type": "specific_file"
                    })

            except Exception as e:
                logger.error(f"检索文件失败 {path}: {str(e)}")

        return results

    async def _retrieve_general(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """一般检索

        Args:
            query: 查询文本
            limit: 返回结果数量限制

        Returns:
            检索结果列表
        """
        try:
            docs_and_scores = self.vector_store.similarity_search(query, k=limit)
            results = []

            for item in docs_and_scores:
                doc, score = item if isinstance(item, tuple) and len(item) == 2 else (item, 0.0)
                results.append({
                    "content": doc.page_content,
                    "source": doc.metadata.get("source", "unknown"),
                    "score": float(score) if isinstance(score, (int, float)) else 0.0,
                    "type": "general"
                })

            return results

        except Exception as e:
            logger.error(f"一般检索失败: {str(e)}")
            return []

    def _needs_knowledge_search(self, user_input: str) -> bool:
        """判断是否需要知识库检索

        Args:
            user_input: 用户输入

        Returns:
            是否需要检索
        """
        # 检查是否包含知识库检索关键词
        keywords = ["根据", "参考", "知识库", "按照", "依据", "参考", "参照"]
        return any(keyword in user_input for keyword in keywords)

    def _is_referencing_history(self, user_input: str) -> bool:
        """判断是否指代历史内容

        Args:
            user_input: 用户输入

        Returns:
            是否指代历史
        """
        reference_keywords = ["那个", "上次", "之前", "前面", "它"]
        question_keywords = ["什么", "哪些", "多少", "谁"]
        has_reference = any(k in user_input for k in reference_keywords)
        has_question = any(k in user_input for k in question_keywords)
        return has_reference and has_question


# 便捷函数
async def collect_context(
    frontend_context: Dict[str, Any],
    session_id: str,
    user_input: str,
    vector_store: LocalVectorStore,
    memory_data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """收集上下文的便捷函数"""
    collector = ContextCollector(vector_store)
    return await collector.gather_context(frontend_context, session_id, user_input, memory_data)
