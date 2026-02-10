"""Ah32 向量存储适配器

适配LangChain和Ah32现有向量存储接口，提供统一的操作接口。
"""

import logging
from typing import List, Dict, Any, Optional, Union, Tuple
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class VectorStoreAdapter(ABC):
    """向量存储适配器抽象基类"""

    @abstractmethod
    def add_documents(self, documents: List[Dict[str, Any]]) -> List[str]:
        """添加文档

        Args:
            documents: 文档列表，每个文档包含content和metadata

        Returns:
            文档ID列表
        """
        pass

    @abstractmethod
    def similarity_search(self, query: str, k: int = 4,
                        filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Dict[str, Any], float]]:
        """相似度搜索

        Args:
            query: 查询文本
            k: 返回结果数量
            filter: 过滤条件

        Returns:
            文档和相似度分数列表
        """
        pass

    @abstractmethod
    def delete_by_filter(self, filter: Dict[str, Any]) -> bool:
        """根据过滤条件删除文档

        Args:
            filter: 过滤条件

        Returns:
            是否成功删除
        """
        pass

    @abstractmethod
    def check_document_exists(self, source: str) -> bool:
        """检查文档是否存在

        Args:
            source: 文档源路径

        Returns:
            是否存在
        """
        pass


class LangChainChromaAdapter(VectorStoreAdapter):
    """LangChain Chroma适配器

    使用LangChain的Chroma向量存储
    """

    def __init__(self, vector_store):
        """初始化适配器

        Args:
            vector_store: LangChain Chroma向量存储实例
        """
        self.vector_store = vector_store

    def add_documents(self, documents: List[Dict[str, Any]]) -> List[str]:
        """添加文档"""
        try:
            doc_count = len(documents)
            logger.debug(f"开始添加文档块 (LangChainChroma): 数量={doc_count}")

            # 转换为LangChain文档格式
            langchain_docs = self._convert_to_langchain_docs(documents)
            logger.debug(f"转换为LangChain文档格式: {len(langchain_docs)} 个文档")

            # 添加到向量存储
            ids = self.vector_store.add_documents(langchain_docs)
            logger.debug(f"向量存储添加完成，返回IDs数量: {len(ids)}")

            logger.info(f"成功添加{doc_count}个文档块，分配IDs: {len(ids)}")
            return ids

        except Exception as e:
            logger.error(f"添加文档失败: {e}")
            logger.debug(f"添加文档失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            raise

    def similarity_search(self, query: str, k: int = 4,
                        filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Dict[str, Any], float]]:
        """相似度搜索"""
        try:
            logger.debug(f"开始相似度搜索: 查询='{query[:100]}...', k={k}, filter={filter}")

            # 执行搜索
            results = self.vector_store.similarity_search_with_score(
                query, k=k, filter=filter
            )
            logger.debug(f"向量存储搜索完成，返回结果数量: {len(results)}")

            # 转换为统一格式
            formatted_results = []
            for i, (doc, score) in enumerate(results):
                formatted_doc = {
                    "content": doc.page_content,
                    "metadata": doc.metadata,
                    "id": getattr(doc, 'id', None)
                }
                formatted_results.append((formatted_doc, float(score)))
                logger.debug(f"结果 {i+1}: 分数={score:.4f}, 内容长度={len(doc.page_content)}")

            logger.info(f"相似度搜索完成: 查询='{query[:50]}...', 结果数={len(formatted_results)}")
            return formatted_results

        except Exception as e:
            logger.error(f"相似度搜索失败: {e}")
            logger.debug(f"搜索失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            raise

    def delete_by_filter(self, filter: Dict[str, Any]) -> bool:
        """根据过滤条件删除文档"""
        try:
            logger.debug(f"开始删除文档: filter={filter}")

            # LangChain Chroma的删除方法
            self.vector_store.delete(filter=filter)
            logger.info(f"成功删除过滤条件匹配的文档: {filter}")
            return True

        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            logger.debug(f"删除失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return False

    def check_document_exists(self, source: str) -> bool:
        """检查文档是否存在"""
        try:
            logger.debug(f"检查文档存在性: source={source}")

            # 搜索指定源的文档
            results = self.vector_store.get(
                where={"source": source},
                limit=1
            )

            metadatas = results.get('metadatas', [])
            exists = len(metadatas) > 0

            logger.debug(f"文档存在性检查结果: {source} -> {exists} (找到 {len(metadatas)} 个匹配)")
            return exists

        except Exception as e:
            logger.error(f"检查文档存在性失败: {e}")
            logger.debug(f"检查失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return False

    def _convert_to_langchain_docs(self, documents: List[Dict[str, Any]]):
        """转换为LangChain文档格式"""
        try:
            from langchain.schema import Document

            langchain_docs = []
            for doc in documents:
                content = doc.get('content', '')
                metadata = doc.get('metadata', {})

                # 确保metadata是基本类型
                clean_metadata = self._clean_metadata(metadata)

                langchain_doc = Document(
                    page_content=content,
                    metadata=clean_metadata
                )
                langchain_docs.append(langchain_doc)

            return langchain_docs

        except ImportError:
            logger.error("LangChain未安装")
            raise

    def _clean_metadata(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """清理元数据，确保所有值都是基本类型"""
        allowed_types = (str, bool, int, float, type(None))

        clean_metadata = {}
        for key, value in metadata.items():
            if isinstance(value, allowed_types):
                clean_metadata[key] = value
            else:
                # 转换为字符串
                try:
                    clean_metadata[key] = str(value)
                except Exception:
                    clean_metadata[key] = None
                    logger.warning(f"无法处理元数据值: {key}={value}，设为None")

        return clean_metadata


class NativeChromaAdapter(VectorStoreAdapter):
    """原生Chroma适配器

    使用Ah32现有的ChromaDB存储
    """

    def __init__(self, vector_store):
        """初始化适配器

        Args:
            vector_store: 原生ChromaDB存储实例
        """
        self.vector_store = vector_store

    def add_documents(self, documents: List[Dict[str, Any]]) -> List[str]:
        """添加文档"""
        try:
            # 转换文档格式
            adapted_docs = []
            for doc in documents:
                adapted_doc = {
                    "content": doc.get('content', ''),
                    "metadata": doc.get('metadata', {})
                }
                adapted_docs.append(adapted_doc)

            # 添加到向量存储
            ids = self.vector_store.add_documents(adapted_docs)

            logger.info(f"成功添加{len(documents)}个文档块")
            return ids

        except Exception as e:
            logger.error(f"添加文档失败: {e}")
            raise

    def similarity_search(self, query: str, k: int = 4,
                        filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Dict[str, Any], float]]:
        """相似度搜索"""
        try:
            # 执行搜索
            results = self.vector_store.similarity_search(
                query, k=k, filter=filter
            )

            # 转换为统一格式
            formatted_results = []
            for doc in results:
                formatted_doc = {
                    "content": doc.page_content,
                    "metadata": doc.metadata,
                    "id": getattr(doc, 'id', None)
                }
                # 如果有相似度分数，从metadata中获取
                score = doc.metadata.get('similarity_score', 0.0)
                formatted_results.append((formatted_doc, float(score)))

            return formatted_results

        except Exception as e:
            logger.error(f"相似度搜索失败: {e}")
            raise

    def delete_by_filter(self, filter: Dict[str, Any]) -> bool:
        """根据过滤条件删除文档"""
        try:
            # 使用原生删除方法
            self.vector_store.delete_by_filter(filter)
            logger.info(f"成功删除过滤条件匹配的文档: {filter}")
            return True

        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            return False

    def check_document_exists(self, source: str) -> bool:
        """检查文档是否存在"""
        try:
            # 使用原生检查方法
            return self.vector_store.check_document_exists(source)

        except Exception as e:
            logger.error(f"检查文档存在性失败: {e}")
            return False


class ChromaDBAdapter:
    """Ah32统一ChromaDB适配器

    自动检测并适配不同的ChromaDB实现
    """

    def __init__(self, vector_store):
        """初始化适配器

        Args:
            vector_store: ChromaDB向量存储实例
        """
        self.vector_store = vector_store
        self.adapter = self._detect_and_create_adapter()

        logger.info(f"ChromaDBAdapter初始化完成，使用{type(self.adapter).__name__}")

    def _detect_and_create_adapter(self) -> VectorStoreAdapter:
        """检测向量存储类型并创建适配器"""
        # 检查是否是LangChain Chroma实例
        if hasattr(self.vector_store, 'add_documents') and \
           hasattr(self.vector_store, 'similarity_search_with_score'):
            return LangChainChromaAdapter(self.vector_store)

        # 检查是否是原生Ah32 Chroma实例
        elif hasattr(self.vector_store, 'add_documents') and \
             hasattr(self.vector_store, 'similarity_search') and \
             hasattr(self.vector_store, 'delete_by_filter'):
            return NativeChromaAdapter(self.vector_store)

        else:
            raise ValueError(f"不支持的向量存储类型: {type(self.vector_store)}")

    def add_documents(self, documents: List[Dict[str, Any]]) -> List[str]:
        """添加文档"""
        return self.adapter.add_documents(documents)

    def similarity_search(self, query: str, k: int = 4,
                        filter: Optional[Dict[str, Any]] = None) -> List[Tuple[Dict[str, Any], float]]:
        """相似度搜索"""
        return self.adapter.similarity_search(query, k, filter)

    def delete_by_filter(self, filter: Dict[str, Any]) -> bool:
        """根据过滤条件删除文档"""
        return self.adapter.delete_by_filter(filter)

    def check_document_exists(self, source: str) -> bool:
        """检查文档是否存在"""
        return self.adapter.check_document_exists(source)

    def get_adapter_info(self) -> Dict[str, Any]:
        """获取适配器信息"""
        return {
            "adapter_type": type(self.adapter).__name__,
            "vector_store_type": type(self.vector_store).__name__,
            "vector_store_module": self.vector_store.__class__.__module__
        }

    # 便捷方法
    async def upsert_document(self, file_path: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
        """更新或插入文档

        Args:
            file_path: 文件路径
            chunks: 文档块列表

        Returns:
            更新结果
        """
        try:
            # 检查文档是否已存在
            exists = self.check_document_exists(file_path)

            if exists:
                # 删除旧版本
                self.delete_by_filter({"source": file_path})
                action = "updated"
            else:
                action = "added"

            # 添加新文档
            chunk_ids = self.add_documents(chunks)

            result = {
                "updated": True,
                "action": action,
                "status": "success",
                "chunks_added": len(chunk_ids)
            }

            logger.info(f"成功{action}文档: {file_path}，新增{len(chunk_ids)}个块")
            return result

        except Exception as e:
            logger.error(f"更新文档失败 {file_path}: {e}")
            return {
                "updated": False,
                "action": "failed",
                "status": "error",
                "error": str(e),
                "chunks_added": 0
            }

    async def batch_retrieve(self, queries: List[Dict[str, Any]]) -> List[List[Tuple[Dict[str, Any], float]]]:
        """批量检索

        Args:
            queries: 查询列表，每个查询包含query、k、filter等参数

        Returns:
            检索结果列表
        """
        results = []

        for query_config in queries:
            query = query_config.get('query', '')
            k = query_config.get('k', 4)
            filter = query_config.get('filter')

            result = self.similarity_search(query, k, filter)
            results.append(result)

        return results

    def get_collection_stats(self) -> Dict[str, Any]:
        """获取集合统计信息"""
        try:
            # 获取集合信息
            collection_info = {
                "name": getattr(self.vector_store, 'collection_name', 'unknown'),
                "count": 0,
                "adapter_type": type(self.adapter).__name__
            }

            # 尝试获取文档数量
            if hasattr(self.vector_store, '_collection'):
                collection_info["count"] = self.vector_store._collection.count()
            elif hasattr(self.vector_store, 'get'):
                # 尝试获取所有文档计数
                results = self.vector_store.get(limit=1)
                collection_info["count"] = results.get('total_count', 0) if results else 0

            return collection_info

        except Exception as e:
            logger.error(f"获取集合统计信息失败: {e}")
            return {
                "name": "unknown",
                "count": -1,
                "adapter_type": type(self.adapter).__name__,
                "error": str(e)
            }


# 便捷函数
def create_vector_store_adapter(vector_store) -> ChromaDBAdapter:
    """创建向量存储适配器

    Args:
        vector_store: ChromaDB向量存储实例

    Returns:
        ChromaDBAdapter实例
    """
    return ChromaDBAdapter(vector_store)


def adapt_vector_store(vector_store, config: Optional[Dict[str, Any]] = None) -> ChromaDBAdapter:
    """适配向量存储

    Args:
        vector_store: 向量存储实例
        config: 配置字典

    Returns:
        适配后的向量存储
    """
    adapter = create_vector_store_adapter(vector_store)
    logger.info(f"向量存储适配完成: {adapter.get_adapter_info()}")
    return adapter
