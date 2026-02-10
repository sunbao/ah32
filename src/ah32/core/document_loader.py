"""Ah32 统一文档加载器 - 支持多种文档格式

基于LangChain + Unstructured实现的文档加载器，支持渐进式迁移。
"""

import os
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Union
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class DocumentLoader(ABC):
    """文档加载器抽象基类"""

    @abstractmethod
    async def load(self, file_path: str) -> Optional[Dict[str, Any]]:
        """加载文档并返回内容

        Args:
            file_path: 文件路径

        Returns:
            包含content和metadata的字典，如果失败返回None
        """
        pass

    @abstractmethod
    def is_supported(self, file_path: str) -> bool:
        """检查是否支持此文件格式

        Args:
            file_path: 文件路径

        Returns:
            是否支持
        """
        pass


class SimpleLoader(DocumentLoader):
    """简单文档加载器 - 原生实现

    支持简单的文本格式 (.md, .txt)
    """

    def __init__(self):
        self.supported_extensions = {'.md', '.txt'}
        logger.debug(f"SimpleLoader初始化，支持格式: {self.supported_extensions}")

    def is_supported(self, file_path: str) -> bool:
        """检查是否支持此文件格式"""
        suffix = Path(file_path).suffix.lower()
        supported = suffix in self.supported_extensions
        logger.debug(f"检查文件格式支持: {file_path} -> {suffix}, 支持: {supported}")
        return supported

    async def load(self, file_path: str) -> Optional[Dict[str, Any]]:
        """加载文档"""
        try:
            file_path = Path(file_path)
            logger.debug(f"开始加载文档 (SimpleLoader): {file_path}")

            # 检查文件是否存在
            if not file_path.exists():
                logger.error(f"文件不存在: {file_path}")
                return None

            # 检查文件大小 (限制10MB)
            file_size = file_path.stat().st_size
            logger.debug(f"文件大小检查: {file_size} bytes ({file_size/1024/1024:.2f}MB)")

            if file_size > 10 * 1024 * 1024:
                logger.warning(f"文件过大 ({file_size/1024/1024:.1f}MB): {file_path}")
                return None

            # 读取文件内容
            encoding = 'utf-8'
            try:
                logger.debug(f"使用编码 {encoding} 读取文件: {file_path}")
                with open(file_path, 'r', encoding=encoding) as f:
                    content = f.read()
                logger.debug(f"文件读取成功，内容长度: {len(content)} 字符")
            except UnicodeDecodeError:
                # 尝试其他编码
                logger.debug(f"UTF-8解码失败，尝试其他编码: {file_path}")
                for enc in ['gbk', 'gb2312', 'latin1']:
                    try:
                        logger.debug(f"尝试编码 {enc}: {file_path}")
                        with open(file_path, 'r', encoding=enc) as f:
                            content = f.read()
                        encoding = enc
                        logger.info(f"使用编码 {enc} 读取文件成功: {file_path}")
                        break
                    except UnicodeDecodeError:
                        logger.debug(f"编码 {enc} 失败")
                        continue
                else:
                    logger.error(f"无法解码文件 (尝试了所有编码): {file_path}")
                    return None

            # 获取文件元数据
            file_mtime = file_path.stat().st_mtime
            metadata = {
                "file_path": str(file_path),
                "file_name": file_path.name,
                "file_size": file_size,
                "file_type": file_path.suffix.lower(),
                "last_modified": file_mtime,
                "encoding": encoding,
                "loader_type": "simple",
                "content_length": len(content),
                "loaded_at": file_mtime
            }

            logger.info(f"文档加载成功 (SimpleLoader): {file_path}, "
                        f"大小: {file_size} bytes, 内容: {len(content)} 字符")

            return {
                "content": content,
                "metadata": metadata
            }

        except Exception as e:
            logger.error(f"加载文档失败 {file_path}: {e}")
            logger.debug(f"加载失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return None


class LangChainLoader(DocumentLoader):
    """LangChain文档加载器

    使用LangChain的文档加载器处理复杂格式
    """

    def __init__(self):
        self.supported_extensions = {
            '.pdf', '.docx', '.pptx', '.xlsx', '.html',
            '.xml', '.json', '.csv', '.eml', '.msg'
        }
        self._loaders = {}
        logger.debug(f"LangChainLoader初始化，支持格式: {self.supported_extensions}")

    def is_supported(self, file_path: str) -> bool:
        """检查是否支持此文件格式"""
        suffix = Path(file_path).suffix.lower()
        supported = suffix in self.supported_extensions
        logger.debug(f"检查文件格式支持 (LangChain): {file_path} -> {suffix}, 支持: {supported}")
        return supported

    async def load(self, file_path: str) -> Optional[Dict[str, Any]]:
        """使用LangChain加载文档"""
        try:
            # 动态导入避免强制依赖
            try:
                from langchain.document_loaders import (
                    PyPDFLoader, UnstructuredWordDocumentLoader,
                    UnstructuredPowerPointLoader, UnstructuredExcelLoader,
                    UnstructuredHTMLLoader, UnstructuredJSONLoader,
                    CSVLoader
                )
                from unstructured.partition.auto import partition
            except ImportError as e:
                logger.error(f"LangChain或Unstructured未安装: {e}")
                return None

            file_path = Path(file_path)
            suffix = file_path.suffix.lower()
            logger.debug(f"开始加载文档 (LangChainLoader): {file_path}, 格式: {suffix}")

            # 选择合适的加载器
            loader = self._get_loader(suffix, file_path)
            if not loader:
                logger.error(f"不支持的文件格式: {suffix}")
                return None

            logger.debug(f"选择加载器: {type(loader).__name__} for {file_path}")

            # 加载文档
            logger.debug(f"开始加载文档内容...")
            docs = loader.load()
            logger.debug(f"LangChain加载完成，原始文档数量: {len(docs) if docs else 0}")

            # 提取文本内容
            if isinstance(docs, list) and len(docs) > 0:
                content = "\n\n".join([doc.page_content for doc in docs])
                logger.debug(f"内容提取完成，合并后长度: {len(content)} 字符")
            else:
                logger.warning(f"未加载到内容: {file_path}")
                return None

            # 获取文件元数据
            file_stats = file_path.stat()
            metadata = {
                "file_path": str(file_path),
                "file_name": file_path.name,
                "file_size": file_stats.st_size,
                "file_type": suffix,
                "last_modified": file_stats.st_mtime,
                "loader_type": "langchain",
                "content_length": len(content),
                "chunk_count": len(docs),
                "loaded_at": file_stats.st_mtime,
                "loader_class": type(loader).__name__
            }

            logger.info(f"文档加载成功 (LangChainLoader): {file_path}, "
                       f"大小: {file_stats.st_size} bytes, "
                       f"内容: {len(content)} 字符, "
                       f"块数: {len(docs)}")

            return {
                "content": content,
                "metadata": metadata
            }

        except Exception as e:
            logger.error(f"LangChain加载失败 {file_path}: {e}")
            logger.debug(f"加载失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return None

    def _get_loader(self, suffix: str, file_path: Path):
        """获取合适的LangChain加载器"""
        try:
            from langchain.document_loaders import (
                PyPDFLoader, UnstructuredWordDocumentLoader,
                UnstructuredPowerPointLoader, UnstructuredExcelLoader,
                UnstructuredHTMLLoader, UnstructuredJSONLoader,
                CSVLoader
            )

            loader_map = {
                '.pdf': PyPDFLoader,
                '.docx': UnstructuredWordDocumentLoader,
                '.pptx': UnstructuredPowerPointLoader,
                '.xlsx': UnstructuredExcelLoader,
                '.html': UnstructuredHTMLLoader,
                '.xml': UnstructuredJSONLoader,
                '.json': UnstructuredJSONLoader,
                '.csv': CSVLoader,
            }

            loader_class = loader_map.get(suffix)
            if loader_class:
                logger.debug(f"找到加载器映射: {suffix} -> {loader_class.__name__}")
                return loader_class(str(file_path))
            else:
                logger.debug(f"未找到匹配的加载器: {suffix}")

            return None

        except Exception as e:
            logger.error(f"获取加载器失败: {e}")
            logger.debug(f"加载器获取失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return None


class UnstructuredLoader(DocumentLoader):
    """Unstructured高级文档加载器

    使用Unstructured的partition功能处理复杂文档
    """

    def __init__(self):
        self.supported_extensions = {
            '.pdf', '.docx', '.pptx', '.xlsx', '.html',
            '.xml', '.eml', '.msg', '.txt', '.md'
        }
        logger.debug(f"UnstructuredLoader初始化，支持格式: {self.supported_extensions}")

    def is_supported(self, file_path: str) -> bool:
        """检查是否支持此文件格式"""
        suffix = Path(file_path).suffix.lower()
        supported = suffix in self.supported_extensions
        logger.debug(f"检查文件格式支持 (Unstructured): {file_path} -> {suffix}, 支持: {supported}")
        return supported

    async def load(self, file_path: str) -> Optional[Dict[str, Any]]:
        """使用Unstructured加载文档"""
        try:
            # 动态导入避免强制依赖
            try:
                from unstructured.partition.auto import partition
                from unstructured.staging.base import elements_to_text
            except ImportError as e:
                logger.error(f"Unstructured未安装: {e}")
                return None

            file_path = Path(file_path)
            logger.debug(f"开始加载文档 (UnstructuredLoader): {file_path}")

            # 使用Unstructured解析文档
            logger.debug(f"开始Unstructured partition解析...")
            elements = partition(
                filename=str(file_path),
                include_metadata=True,
                include_page_breaks=True
            )
            logger.debug(f"Unstructured partition完成，解析到 {len(elements)} 个元素")

            # 提取文本内容
            logger.debug(f"开始提取文本内容...")
            text = elements_to_text(elements)
            logger.debug(f"文本提取完成，长度: {len(text)} 字符")

            # 提取结构化信息
            logger.debug(f"开始提取结构化信息...")
            structured_info = self._extract_structured_info(elements)
            logger.debug(f"结构化信息提取完成: {structured_info}")

            # 获取文件元数据
            file_stats = file_path.stat()
            metadata = {
                "file_path": str(file_path),
                "file_name": file_path.name,
                "file_size": file_stats.st_size,
                "file_type": file_path.suffix.lower(),
                "last_modified": file_stats.st_mtime,
                "loader_type": "unstructured",
                "content_length": len(text),
                "element_count": len(elements),
                "structured_info": structured_info,
                "loaded_at": file_stats.st_mtime
            }

            logger.info(f"文档加载成功 (UnstructuredLoader): {file_path}, "
                       f"大小: {file_stats.st_size} bytes, "
                       f"内容: {len(text)} 字符, "
                       f"元素: {len(elements)}, "
                       f"表格: {structured_info['tables']}, "
                       f"图片: {structured_info['images']}")

            return {
                "content": text,
                "metadata": metadata
            }

        except Exception as e:
            logger.error(f"Unstructured加载失败 {file_path}: {e}")
            logger.debug(f"加载失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return None

    def _extract_structured_info(self, elements) -> Dict[str, Any]:
        """提取结构化信息"""
        info = {
            "tables": 0,
            "images": 0,
            "headers": 0,
            "footers": 0,
            "page_breaks": 0
        }

        for element in elements:
            element_type = type(element).__name__.lower()

            if 'table' in element_type:
                info["tables"] += 1
            elif 'image' in element_type:
                info["images"] += 1
            elif 'header' in element_type:
                info["headers"] += 1
            elif 'footer' in element_type:
                info["footers"] += 1
            elif 'pagebreak' in element_type:
                info["page_breaks"] += 1

        logger.debug(f"结构化信息统计: {info}")
        return info


class Ah32DocumentLoader:
    """Ah32统一文档加载器

    整合多种加载器，提供统一的文档加载接口
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """初始化文档加载器

        Args:
            config: 配置字典，包含preferred_loader等选项
        """
        self.config = config or {}
        self.preferred_loader = self.config.get('preferred_loader', 'auto')

        # 初始化加载器
        self.loaders = {
            'simple': SimpleLoader(),
            'langchain': LangChainLoader(),
            'unstructured': UnstructuredLoader()
        }

        # 加载器优先级（如果auto模式）
        self.loader_priority = ['unstructured', 'langchain', 'simple']

        logger.info(f"Ah32DocumentLoader初始化完成，优先加载器: {self.preferred_loader}")
        logger.debug(f"已初始化的加载器: {list(self.loaders.keys())}")
        logger.debug(f"加载器优先级: {self.loader_priority}")

    async def load_document(self, file_path: str) -> Optional[Dict[str, Any]]:
        """加载文档的主要接口

        Args:
            file_path: 文件路径

        Returns:
            包含content和metadata的字典
        """
        file_path = str(file_path)  # 确保是字符串
        logger.debug(f"开始加载文档: {file_path}")

        if not os.path.exists(file_path):
            logger.error(f"文件不存在: {file_path}")
            return None

        try:
            # 根据配置选择加载器
            if self.preferred_loader == 'auto':
                # 自动选择最合适的加载器
                logger.debug(f"使用自动模式选择加载器")
                return await self._auto_load(file_path)
            elif self.preferred_loader in self.loaders:
                # 使用指定的加载器
                loader = self.loaders[self.preferred_loader]
                logger.debug(f"使用指定加载器: {self.preferred_loader}")

                if loader.is_supported(file_path):
                    logger.debug(f"加载器{self.preferred_loader}支持此格式，开始加载")
                    result = await loader.load(file_path)
                    if result:
                        logger.info(f"使用{self.preferred_loader}加载器成功: {file_path}")
                        return result
                    else:
                        logger.warning(f"{self.preferred_loader}加载器失败，尝试其他加载器")
                        return await self._auto_load(file_path)
                else:
                    logger.error(f"加载器{self.preferred_loader}不支持此格式: {file_path}")
                    return await self._auto_load(file_path)
            else:
                logger.error(f"未知的加载器类型: {self.preferred_loader}")
                return await self._auto_load(file_path)

        except Exception as e:
            logger.error(f"加载文档失败 {file_path}: {e}")
            logger.debug(f"加载失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return None

    async def _auto_load(self, file_path: str) -> Optional[Dict[str, Any]]:
        """自动选择合适的加载器"""
        logger.debug(f"开始自动选择加载器: {file_path}")

        for loader_name in self.loader_priority:
            loader = self.loaders[loader_name]

            if loader.is_supported(file_path):
                logger.debug(f"尝试使用{loader_name}加载器: {file_path}")
                result = await loader.load(file_path)

                if result:
                    logger.info(f"自动选择{loader_name}加载器成功: {file_path}")
                    return result
                else:
                    logger.debug(f"{loader_name}加载器返回None，继续尝试")
            else:
                logger.debug(f"{loader_name}加载器不支持此格式，跳过")

        # 如果所有加载器都失败
        logger.error(f"所有加载器都无法处理文件: {file_path}")
        logger.debug(f"已尝试的加载器: {self.loader_priority}")
        return None

    def get_supported_formats(self) -> List[str]:
        """获取支持的文件格式"""
        formats = set()
        for loader in self.loaders.values():
            # 假设有一个方法获取支持的格式
            # 这里需要修改loaders来暴露supported_extensions
            pass
        return list(formats)

    def get_loader_info(self) -> Dict[str, Any]:
        """获取加载器信息"""
        info = {
            "preferred_loader": self.preferred_loader,
            "available_loaders": list(self.loaders.keys()),
            "loader_priority": self.loader_priority
        }

        # 添加各加载器支持的文件格式
        loader_formats = {}
        for name, loader in self.loaders.items():
            if hasattr(loader, 'supported_extensions'):
                loader_formats[name] = list(loader.supported_extensions)

        info["supported_formats"] = loader_formats
        return info


# 便捷函数
async def load_document(file_path: str, config: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """便捷函数：加载单个文档

    Args:
        file_path: 文件路径
        config: 配置字典

    Returns:
        文档内容字典
    """
    loader = Ah32DocumentLoader(config)
    return await loader.load_document(file_path)


async def load_documents(file_paths: List[str], config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """便捷函数：批量加载文档

    Args:
        file_paths: 文件路径列表
        config: 配置字典

    Returns:
        文档内容字典列表
    """
    loader = Ah32DocumentLoader(config)
    results = []

    for file_path in file_paths:
        result = await loader.load_document(file_path)
        if result:
            results.append(result)

    return results
