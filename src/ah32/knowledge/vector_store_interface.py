"""Vector Store Interface - 统一的向量数据库接口

这个模块定义了所有向量数据库实现需要遵循的接口，
允许在不同的向量数据库之间轻松切换。
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
import uuid
from pathlib import Path

try:
    from langchain_core.documents import Document
except ImportError:
    from langchain.documents import Document

try:
    from langchain_core.embeddings import Embeddings
except ImportError:
    from langchain.embeddings import Embeddings


class VectorStoreInterface(ABC):
    """向量数据库接口 - 定义所有向量数据库需要实现的方法"""

    @abstractmethod
    def add_documents(self, documents: List[Document]) -> None:
        """添加文档到向量数据库"""
        pass

    @abstractmethod
    def similarity_search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """基于相似度搜索文档"""
        pass

    @abstractmethod
    def search_by_vector(self, query_vector, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """基于向量进行搜索"""
        pass

    @abstractmethod
    def search_by_keywords(self, keywords: List[str], k: int = 5, filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Document, float]]:
        """基于关键词搜索"""
        pass

    @abstractmethod
    def search_contextual(self, query_text: str, source_doc: str, context_window: int = 3) -> List[Tuple[Document, float]]:
        """基于上下文搜索相邻段落"""
        pass

    @abstractmethod
    def get_document_by_id(self, doc_id: str) -> Optional[Document]:
        """根据ID获取文档"""
        pass

    @abstractmethod
    def delete_document(self, doc_id: str) -> None:
        """删除文档"""
        pass

    @abstractmethod
    def clear(self) -> None:
        """清空所有文档"""
        pass

    @abstractmethod
    def document_count(self) -> int:
        """获取文档数量"""
        pass

    @abstractmethod
    def get_all_documents(self, limit: Optional[int] = None) -> List[Dict]:
        """获取所有文档（用于统计和调试）"""
        pass

    @abstractmethod
    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        pass

    @abstractmethod
    def delete_by_filter(self, filter: Dict[str, Any]) -> int:
        """根据过滤条件删除文档，返回删除的文档数量"""
        pass

    @abstractmethod
    def update_document(self, doc_id: str, document: Document) -> bool:
        """更新文档"""
        pass


class VectorStoreFactory:
    """向量数据库工厂 - 根据配置创建相应的向量数据库实例"""

    @staticmethod
    def create_vector_store(
        store_type: str,
        persist_path: Optional[Path] = None,
        embedding: Optional[Embeddings] = None,
        config: Optional[Dict[str, Any]] = None
    ) -> VectorStoreInterface:
        """创建向量数据库实例

        Args:
            store_type: 向量数据库类型 ('chromadb', 'faiss', 'hnswlib', 'annoy')
            persist_path: 存储路径（本地数据库需要）
            embedding: 嵌入模型
            config: 配置参数

        Returns:
            VectorStoreInterface实例
        """
        if store_type.lower() == "chromadb":
            from .store import ChromaDBStore
            return ChromaDBStore(persist_path=persist_path, embedding=embedding, config=config)
        else:
            raise ValueError(f"不支持的向量数据库类型: {store_type}")


class DocumentFilter:
    """文档过滤器 - 用于构建复杂的过滤条件"""

    @staticmethod
    def and_filter(*filters: Dict[str, Any]) -> Dict[str, Any]:
        """AND过滤条件"""
        return {"$and": list(filters)}

    @staticmethod
    def or_filter(*filters: Dict[str, Any]) -> Dict[str, Any]:
        """OR过滤条件"""
        return {"$or": list(filters)}

    @staticmethod
    def eq_filter(field: str, value: Any) -> Dict[str, Any]:
        """等于过滤"""
        return {field: value}

    @staticmethod
    def neq_filter(field: str, value: Any) -> Dict[str, Any]:
        """不等于过滤"""
        return {field: {"$ne": value}}

    @staticmethod
    def in_filter(field: str, values: List[Any]) -> Dict[str, Any]:
        """包含在列表中过滤"""
        return {field: {"$in": values}}

    @staticmethod
    def nin_filter(field: str, values: List[Any]) -> Dict[str, Any]:
        """不包含在列表中过滤"""
        return {field: {"$nin": values}}

    @staticmethod
    def gt_filter(field: str, value: Any) -> Dict[str, Any]:
        """大于过滤"""
        return {field: {"$gt": value}}

    @staticmethod
    def gte_filter(field: str, value: Any) -> Dict[str, Any]:
        """大于等于过滤"""
        return {field: {"$gte": value}}

    @staticmethod
    def lt_filter(field: str, value: Any) -> Dict[str, Any]:
        """小于过滤"""
        return {field: {"$lt": value}}

    @staticmethod
    def lte_filter(field: str, value: Any) -> Dict[str, Any]:
        """小于等于过滤"""
        return {field: {"$lte": value}}

    @staticmethod
    def contains_filter(field: str, value: str) -> Dict[str, Any]:
        """包含字符串过滤"""
        return {field: {"$contains": value}}

    @staticmethod
    def regex_filter(field: str, pattern: str) -> Dict[str, Any]:
        """正则表达式过滤"""
        return {field: {"$regex": pattern}}

    @staticmethod
    def time_range_filter(field: str, start_time: float, end_time: float) -> Dict[str, Any]:
        """时间范围过滤"""
        return {
            "$and": [
                {field: {"$gte": start_time}},
                {field: {"$lte": end_time}}
            ]
        }