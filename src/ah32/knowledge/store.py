"""Local vector store implementation."""

from __future__ import annotations

import json
import uuid
import logging
from pathlib import Path
from typing import TypeVar, Sequence, List, Dict, Any, Optional, Tuple

from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings

# 修改为绝对导入
from .vector_store_interface import VectorStoreInterface

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=Document)


class ChromaDBStore(VectorStoreInterface):
    """ChromaDB向量存储实现"""

    def __init__(self, persist_path: Path, embedding: Embeddings, reset: bool = False, config: Optional[Dict[str, Any]] = None) -> None:
        self.persist_path = persist_path.resolve()
        self.embedding = embedding
        if reset and self.persist_path.exists():
            import shutil
            shutil.rmtree(self.persist_path)
        self.persist_path.mkdir(parents=True, exist_ok=True)
        collection_name = None
        collection_metadata = None
        if config:
            collection_name = config.get("collection_name") or None
            collection_metadata = config.get("collection_metadata") or None

        # NOTE: Chroma collections are strict about embedding dimensionality once created.
        # Always allow callers to provide a stable collection_name (e.g. derived from
        # embedding model) to avoid hard failures when switching models.
        self._store = Chroma(
            collection_name=collection_name or "langchain",
            persist_directory=str(self.persist_path),
            embedding_function=self.embedding,
            collection_metadata=collection_metadata,
        )

    def add_documents(self, documents: Sequence[Document]) -> None:
        """添加文档到向量数据库"""
        logger.debug("开始添加文档到向量存储: %s 个文档", len(documents))
        # Avoid per-document debug spam: it can become a perf cliff on long-running sessions.
        if logger.isEnabledFor(logging.DEBUG) and documents:
            sample = documents[0]
            logger.debug(
                "向量存储 add_documents sample: source=%s chunk_index=%s content_len=%s (showing 1/%s)",
                sample.metadata.get("source", "unknown"),
                sample.metadata.get("chunk_index", -1),
                len(sample.page_content or ""),
                len(documents),
            )

        self._store.add_documents(documents)
        logger.info(f"成功添加 {len(documents)} 个文档到向量存储")

    def similarity_search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """搜索相似文档"""
        logger.debug(f"开始相似度搜索: query='{query[:100]}...', k={k}, filter={filter}")

        # Chroma支持filter参数，但只支持简单的字典形式
        # 需要转换复杂的filter
        chroma_filter = self._convert_filter(filter)
        logger.debug(f"转换后的filter: {chroma_filter}")

        docs_and_scores = self._store.similarity_search_with_score(query, k=k, filter=chroma_filter)

        logger.debug(f"搜索完成，返回 {len(docs_and_scores)} 个结果")
        for idx, (doc, score) in enumerate(docs_and_scores):
            logger.debug(f"结果 {idx+1}: 相似度={score:.4f}, source={doc.metadata.get('source', 'unknown')}, "
                        f"内容预览={doc.page_content[:50]}...")

        return [(doc, score) for doc, score in docs_and_scores]

    def search_by_vector(self, query_vector, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """基于向量进行搜索"""
        # Chroma原生不支持直接向量搜索，这里使用一个占位符查询
        # 实际使用中，应该使用embedding模型生成查询文本
        query_text = "vector_search"
        return self.similarity_search(query_text, k=k, filter=filter)

    def search_by_keywords(self, keywords: List[str], k: int = 5, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """基于关键词进行搜索"""
        logger.debug(f"开始关键词搜索: keywords={keywords}, k={k}")

        # 将关键词组合成查询字符串
        query = " ".join(keywords)
        logger.debug(f"组合后的查询字符串: '{query}'")

        results = self.similarity_search(query, k=k, filter=filter)
        logger.debug(f"关键词搜索完成，返回 {len(results)} 个结果")
        return results

    def search_contextual(self, query_text: str, source_doc: str, context_window: int = 3) -> List[Tuple[Document, float]]:
        """上下文感知的搜索"""
        logger.debug(f"开始上下文搜索: query='{query_text[:100]}...', source_doc={source_doc}, context_window={context_window}")

        # 搜索相关文档
        logger.debug(f"执行基础搜索，k={context_window * 2}")
        base_results = self.similarity_search(query_text, k=context_window * 2)
        logger.debug(f"基础搜索完成，初始结果数: {len(base_results)}")

        # 按相关性排序
        base_results.sort(key=lambda x: x[1])
        logger.debug("结果已按相关性排序")

        # 如果指定了源文档，优先返回该文档的相关内容
        contextual_matches = []
        for doc, score in base_results:
            if doc.metadata.get("source") == source_doc:
                contextual_matches.append((doc, score))

        logger.debug(f"从源文档 {source_doc} 中找到 {len(contextual_matches)} 个匹配项")

        # 如果没有找到源文档的内容，返回所有结果
        if not contextual_matches:
            logger.debug("未找到源文档内容，返回所有基础结果")
            contextual_matches = base_results

        # 限制结果数量
        final_results = contextual_matches[:5]
        logger.debug(f"上下文搜索完成，返回 {len(final_results)} 个最终结果")
        return final_results

    def get_document_by_id(self, doc_id: str) -> Optional[Document]:
        """根据ID获取文档"""
        collection = self._store._collection
        try:
            # 使用where条件查询
            results = collection.get(where={"id": doc_id}, include=["metadatas", "documents"])
            if results["documents"]:
                return Document(page_content=results["documents"][0], metadata=results["metadatas"][0])
        except Exception as e:
            logger.warning(f"获取文档失败: {e}")
        return None

    def delete_document(self, doc_id: str) -> None:
        """删除文档"""
        try:
            self._store._collection.delete(where={"id": doc_id})
        except Exception as e:
            logger.warning(f"删除文档失败: {e}", exc_info=True)

    def clear(self) -> None:
        """清空所有文档"""
        collection = self._store._collection
        try:
            # Chroma delete() requires ids/where/where_document.
            # Use ids to reliably clear the entire collection.
            results = collection.get(include=[])
            ids = results.get("ids", []) or []
            if ids:
                collection.delete(ids=ids)
        except Exception as e:
            logger.warning(f"清空知识库失败: {e}", exc_info=True)

    def document_count(self) -> int:
        """获取文档数量"""
        return self._store._collection.count()

    def get_all_metadatas(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Return metadata only (no document contents).

        Listing RAG documents/statistics should not load all chunk texts, otherwise
        it can become very slow for large collections and may time out in webviews.
        """
        collection = self._store._collection
        try:
            results = collection.get(include=["metadatas"])
            metadatas = results.get("metadatas", []) or []
            if limit:
                return list(metadatas[:limit])
            return list(metadatas)
        except Exception:
            return []

    def get_all_documents(self, limit: Optional[int] = None) -> List[Dict]:
        """获取所有文档"""
        collection = self._store._collection
        try:
            results = collection.get(include=["metadatas", "documents"])
            documents = []
            for i, (doc, meta) in enumerate(zip(results["documents"], results["metadatas"])):
                if limit and i >= limit:
                    break
                # 生成文档ID（使用content hash）
                doc_id = f"doc_{hash(doc)}_{i}"
                documents.append({
                    "id": doc_id,
                    "content": doc,
                    "content_preview": doc[:200] + "..." if len(doc) > 200 else doc,
                    "metadata": meta,
                    "created_at": meta.get("created_at", 0)
                })
            return documents
        except Exception:
            return []

    def get_documents_by_source(self, source_path: str, limit: Optional[int] = None) -> List[Dict]:
        """根据源文件路径获取文档

        Args:
            source_path: 源文件路径
            limit: 限制返回数量

        Returns:
            匹配源文件路径的文档列表
        """
        collection = self._store._collection
        try:
            # 使用where条件查询指定源文件
            results = collection.get(
                where={"source": source_path},
                include=["metadatas", "documents"]
            )

            documents = []
            for i, (doc, meta) in enumerate(zip(results["documents"], results["metadatas"])):
                if limit and i >= limit:
                    break
                doc_id = f"doc_{hash(doc)}_{i}"
                documents.append({
                    "id": doc_id,
                    "content": doc,
                    "content_preview": doc[:200] + "..." if len(doc) > 200 else doc,
                    "metadata": meta,
                    "created_at": meta.get("created_at", 0)
                })
            return documents
        except Exception as e:
            logger.warning(f"获取源文件文档失败 {source_path}: {e}")
            return []

    def check_document_exists(self, source_path: str) -> bool:
        """检查指定源文件的文档是否已存在

        Args:
            source_path: 源文件路径

        Returns:
            是否存在该文件的文档
        """
        logger.debug(f"检查文档是否存在: source_path={source_path}")

        documents = self.get_documents_by_source(source_path, limit=1)
        exists = len(documents) > 0

        logger.debug(f"文档存在性检查结果: {source_path} -> {exists} (找到 {len(documents)} 个匹配)")
        return exists

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        try:
            total_chunks = self.document_count()

            # 获取所有文档
            collection = self._store._collection
            results = collection.get(include=["metadatas"])

            # 按源文件分组统计
            source_stats = {}
            for meta in results.get("metadatas", []):
                source = meta.get("source", "Unknown")
                if source not in source_stats:
                    source_stats[source] = {"source": source, "chunks": 0}
                source_stats[source]["chunks"] += 1

            documents = list(source_stats.values())

            return {
                "total_chunks": total_chunks,
                "total_documents": len(documents),
                "documents": documents
            }
        except Exception as e:
            return {
                "total_chunks": 0,
                "total_documents": 0,
                "documents": [],
                "error": str(e)
            }

    def delete_by_filter(self, filter: Dict[str, Any]) -> int:
        """根据过滤条件删除文档，返回删除的文档数量"""
        logger.debug(f"开始根据过滤条件删除文档: filter={filter}")

        try:
            # 先查询要删除的文档数量
            results = self._store._collection.get(where=filter, include=["documents"])
            count = len(results.get("documents", []))

            # 使用filter直接删除
            self._store._collection.delete(where=filter)
            logger.info(f"成功删除匹配过滤条件的文档: {filter}, 删除数量: {count}")
            return count
        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            logger.debug(f"删除错误详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return 0

    def update_document(self, doc_id: str, document: Document) -> bool:
        """更新文档"""
        try:
            # 删除旧文档
            self._store._collection.delete(ids=[doc_id])
            # 添加新文档
            self._store.add_documents([document])
            return True
        except Exception:
            return False

    def _convert_filter(self, filter: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """转换过滤条件为ChromaDB格式"""
        if filter is None:
            return None

        # 处理简单的字典格式
        if "$and" not in filter and "$or" not in filter:
            # 转换复杂类型
            converted = {}
            for key, value in filter.items():
                if isinstance(value, (str, int, float, bool)) or value is None:
                    converted[key] = value
                elif isinstance(value, list):
                    converted[key] = {"$in": value}
                elif isinstance(value, dict):
                    # 如果是范围查询，保留
                    converted[key] = value
                else:
                    converted[key] = str(value)
            # Newer Chroma versions require exactly one top-level operator in `where`.
            # For multiple metadata constraints, wrap with $and to avoid:
            # "Expected where to have exactly one operator, got {...}"
            if len(converted) <= 1:
                return converted
            return {"$and": [{k: v} for k, v in converted.items()]}

        # 处理复杂逻辑
        if "$and" in filter:
            return {"$and": [self._convert_filter(f) for f in filter["$and"]]}
        if "$or" in filter:
            return {"$or": [self._convert_filter(f) for f in filter["$or"]]}

        return filter

    def _matches_filter(self, metadata: Dict[str, Any], filter: Dict[str, Any]) -> bool:
        """检查文档是否匹配过滤条件"""
        # 简单的过滤匹配实现
        # 实际使用中可能需要更复杂的逻辑
        for key, value in filter.items():
            if key.startswith("$"):
                continue  # 跳过逻辑操作符
            if key not in metadata:
                return False
            if isinstance(value, dict):
                # 处理范围查询
                if "$in" in value:
                    if metadata[key] not in value["$in"]:
                        return False
                elif "$ne" in value:
                    if metadata[key] == value["$ne"]:
                        return False
                elif "$gt" in value:
                    if not (metadata[key] > value["$gt"]):
                        return False
                elif "$gte" in value:
                    if not (metadata[key] >= value["$gte"]):
                        return False
                elif "$lt" in value:
                    if not (metadata[key] < value["$lt"]):
                        return False
                elif "$lte" in value:
                    if not (metadata[key] <= value["$lte"]):
                        return False
            else:
                if metadata[key] != value:
                    return False
        return True


# 别名兼容性
LocalVectorStore = ChromaDBStore
