"""Ah32 增强@引用处理器

基于LangChain + Unstructured实现的增强@引用处理器，支持更多文档格式。
向后兼容原有API。
"""

import re
import os
import logging
import time
import asyncio
from typing import List, Dict, Any, Optional
from pathlib import Path

# 导入新实现的组件
try:
    from ..core.document_loader import Ah32DocumentLoader
    from ..core.text_splitter import Ah32TextSplitter
    from ..core.vector_store_adapter import ChromaDBAdapter
    _has_enhanced_components = True
except ImportError as e:
    _has_enhanced_components = False
    logging.warning(f"增强组件未安装，使用简化版本: {e}")

# 导入原有组件（向后兼容）
try:
    from .at_reference_handler import AtReferenceHandler as OriginalAtReferenceHandler
    _has_original_handler = True
except ImportError:
    _has_original_handler = False

logger = logging.getLogger(__name__)


class EnhancedAtReferenceHandler:
    """Ah32增强@引用处理器

    整合新实现的文档处理组件，支持更多文档格式。
    保持向后兼容，支持渐进式迁移。
    """

    def __init__(self, vector_store, config: Optional[Dict[str, Any]] = None):
        """初始化增强@引用处理器

        Args:
            vector_store: 向量存储实例
            config: 配置字典
        """
        self.vector_store = vector_store
        self.config = config or {}

        # 初始化组件
        if _has_enhanced_components:
            # 使用增强组件
            self.document_loader = Ah32DocumentLoader(self.config.get('document_loader', {}))
            self.text_splitter = Ah32TextSplitter(self.config.get('text_splitter', {}))
            self.vector_adapter = ChromaDBAdapter(vector_store)
            self.enhanced_mode = True
            logger.info("使用增强@引用处理器模式")
        else:
            # 使用原有处理器
            if _has_original_handler:
                self.original_handler = OriginalAtReferenceHandler(vector_store)
                self.enhanced_mode = False
                logger.warning("使用原有@引用处理器模式")
            else:
                raise ImportError("没有可用的@引用处理器实现")

        # 配置选项
        self.max_file_size = self.config.get('max_file_size', 50 * 1024 * 1024)  # 50MB
        self.max_chunks = self.config.get('max_chunks', 1000)
        self.enable_progress_logging = self.config.get('enable_progress_logging', True)

    def extract_at_references(self, user_input: str) -> List[str]:
        """提取@引用的文件路径

        保持与原有API兼容
        """
        # 使用正则表达式提取路径
        pattern = r'@([^\s\[\]{}()（）]+)'
        matches = re.findall(pattern, user_input)

        # 清理路径
        paths = []
        for match in matches:
            cleaned = re.sub(r'[，。；：！]$', '', match)
            paths.append(cleaned)

        logger.info(f"提取到{len(paths)}个@引用路径: {paths}")
        return paths

    async def handle(self, user_input: str) -> Dict[str, Any]:
        """处理用户输入中的@引用

        Args:
            user_input: 用户输入文本

        Returns:
            {
                "paths": [...],  # 提取的路径列表
                "processed": [...],  # 已处理的文档
                "errors": [...]  # 处理错误
            }
        """
        try:
            # 1. 提取@引用路径
            paths = self.extract_at_references(user_input)

            if not paths:
                return {
                    "paths": [],
                    "processed": [],
                    "errors": []
                }

            # 2. 处理每个文件
            processed = []
            errors = []

            for i, path in enumerate(paths):
                if self.enable_progress_logging:
                    logger.info(f"处理第{i+1}/{len(paths)}个文件: {path}")

                try:
                    result = await self._process_single_file(path)
                    processed.append(result)

                except Exception as e:
                    error_msg = f"处理文件失败 {path}: {str(e)}"
                    logger.error(error_msg)
                    errors.append(error_msg)

            return {
                "paths": paths,
                "processed": processed,
                "errors": errors
            }

        except Exception as e:
            logger.error(f"@引用处理失败: {str(e)}")
            return {
                "paths": [],
                "processed": [],
                "errors": [str(e)]
            }

    async def _process_single_file(self, file_path: str) -> Dict[str, Any]:
        """处理单个文件

        Args:
            file_path: 文件路径

        Returns:
            处理结果字典
        """
        start_time = time.time()

        try:
            # 1. 验证文件
            validation_result = self._validate_file(file_path)
            if not validation_result['valid']:
                raise ValueError(validation_result['error'])

            # 2. 加载文档
            document = await self._load_document(file_path)
            if not document:
                raise ValueError("文档加载失败")

            # 3. 分割文档
            chunks = await self._split_document(document)
            if not chunks:
                raise ValueError("文档分割失败")

            # 4. 检查文档数量限制
            if len(chunks) > self.max_chunks:
                logger.warning(f"文档块数量超限({len(chunks)} > {self.max_chunks})，截取前{self.max_chunks}个")
                chunks = chunks[:self.max_chunks]

            # 5. 智能入库
            upsert_result = await self._upsert_document(file_path, chunks)

            # 6. 记录处理时间
            processing_time = time.time() - start_time

            result = {
                "path": file_path,
                "content_length": len(document['content']),
                "chunk_count": len(chunks),
                "status": upsert_result["status"],
                "action": upsert_result["action"],
                "updated": upsert_result["updated"],
                "chunks_added": upsert_result.get("chunks_added", 0),
                "processing_time": round(processing_time, 2),
                "file_info": {
                    "file_name": Path(file_path).name,
                    "file_size": os.path.getsize(file_path) if os.path.exists(file_path) else 0,
                    "file_type": Path(file_path).suffix.lower(),
                    "loader_type": document['metadata'].get('loader_type', 'unknown')
                }
            }

            if upsert_result["updated"]:
                logger.info(f"成功{upsert_result['action']}@引用文件: {file_path} "
                           f"({len(chunks)}个块，{processing_time:.2f}秒)")
            else:
                logger.info(f"文件未变化，跳过: {file_path}")

            return result

        except Exception as e:
            raise Exception(f"处理文件{file_path}失败: {str(e)}")

    def _validate_file(self, file_path: str) -> Dict[str, Any]:
        """验证文件

        Args:
            file_path: 文件路径

        Returns:
            验证结果字典
        """
        path = Path(file_path)

        # 检查文件是否存在
        if not path.exists():
            return {
                "valid": False,
                "error": f"文件不存在: {file_path}"
            }

        # 检查文件大小
        file_size = path.stat().st_size
        if file_size > self.max_file_size:
            return {
                "valid": False,
                "error": f"文件过大 ({file_size/1024/1024:.1f}MB > {self.max_file_size/1024/1024:.1f}MB): {file_path}"
            }

        # 检查文件类型（简单检查）
        suffix = path.suffix.lower()
        if not suffix:
            return {
                "valid": False,
                "error": f"无法确定文件类型: {file_path}"
            }

        return {
            "valid": True,
            "error": None,
            "file_size": file_size,
            "file_type": suffix
        }

    async def _load_document(self, file_path: str) -> Optional[Dict[str, Any]]:
        """加载文档

        Args:
            file_path: 文件路径

        Returns:
            文档内容字典
        """
        if self.enhanced_mode and _has_enhanced_components:
            # 使用增强加载器
            return await self.document_loader.load_document(file_path)
        elif _has_original_handler:
            # 使用原有加载器
            result = await self.original_handler._read_file(file_path)
            if result:
                return {
                    "content": result,
                    "metadata": {
                        "file_path": file_path,
                        "file_name": Path(file_path).name,
                        "loader_type": "original"
                    }
                }
            return None
        else:
            raise ImportError("没有可用的文档加载器")

    async def _split_document(self, document: Dict[str, Any]) -> List[Dict[str, Any]]:
        """分割文档

        Args:
            document: 文档内容字典

        Returns:
            分割后的文档块列表
        """
        if self.enhanced_mode and _has_enhanced_components:
            # 使用增强分割器
            content = document['content']
            metadata = document.get('metadata', {})

            # 添加文档信息到元数据
            enhanced_metadata = {
                **metadata,
                "source": metadata.get('file_path', ''),
                "file_name": metadata.get('file_name', ''),
                "loader_type": metadata.get('loader_type', 'unknown')
            }

            chunks = self.text_splitter.split_text(content, enhanced_metadata)
            return chunks
        elif _has_original_handler:
            # 使用原有分割器
            content = document['content']
            chunks = self.original_handler._split_into_chunks(content)
            return [{
                "content": chunk,
                "metadata": {
                    "source": document['metadata']['file_path'],
                    "file_name": document['metadata']['file_name'],
                    "chunk_index": i,
                    "splitter_type": "original"
                }
            } for i, chunk in enumerate(chunks)]
        else:
            raise ImportError("没有可用的文档分割器")

    async def _upsert_document(self, file_path: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
        """智能入库

        Args:
            file_path: 文件路径
            chunks: 文档块列表

        Returns:
            入库结果字典
        """
        if self.enhanced_mode and _has_enhanced_components:
            # 使用增强适配器
            return await self.vector_adapter.upsert_document(file_path, chunks)
        elif _has_original_handler:
            # 使用原有处理器
            return await self.original_handler._upsert_document(file_path, "\n".join([chunk['content'] for chunk in chunks]))
        else:
            raise ImportError("没有可用的向量存储适配器")

    # 兼容性方法
    def _calculate_file_hash(self, file_path: str) -> str:
        """计算文件哈希（兼容性方法）"""
        import hashlib

        try:
            with open(file_path, 'rb') as f:
                return hashlib.md5(f.read()).hexdigest()
        except Exception as e:
            logger.error(f"计算文件哈希失败 {file_path}: {e}")
            return ""

    # 便捷方法
    async def batch_process(self, user_input: str) -> Dict[str, Any]:
        """批量处理@引用

        Args:
            user_input: 用户输入文本

        Returns:
            批量处理结果
        """
        return await self.handle(user_input)

    async def process_single_file(self, file_path: str) -> Dict[str, Any]:
        """处理单个文件

        Args:
            file_path: 文件路径

        Returns:
            处理结果
        """
        return await self._process_single_file(file_path)

    def get_supported_formats(self) -> List[str]:
        """获取支持的文件格式

        Returns:
            支持的文件扩展名列表
        """
        if self.enhanced_mode and _has_enhanced_components:
            return self.document_loader.get_loader_info().get("supported_formats", {})

        # 原有处理器支持格式
        return ['.txt', '.md']  # 简化处理

    def get_handler_info(self) -> Dict[str, Any]:
        """获取处理器信息

        Returns:
            处理器信息字典
        """
        info = {
            "enhanced_mode": self.enhanced_mode,
            "config": self.config,
            "max_file_size": self.max_file_size,
            "max_chunks": self.max_chunks,
            "component_availability": {
                "enhanced_components": _has_enhanced_components,
                "original_handler": _has_original_handler
            }
        }

        if self.enhanced_mode and _has_enhanced_components:
            info.update({
                "document_loader_info": self.document_loader.get_loader_info(),
                "text_splitter_info": self.text_splitter.get_splitter_info(),
                "vector_adapter_info": self.vector_adapter.get_adapter_info()
            })

        return info

    async def health_check(self) -> Dict[str, Any]:
        """健康检查

        Returns:
            健康检查结果
        """
        check_result = {
            "status": "healthy",
            "enhanced_mode": self.enhanced_mode,
            "timestamp": time.time(),
            "checks": {}
        }

        try:
            # 检查组件可用性
            check_result["checks"]["components"] = {
                "enhanced_components": _has_enhanced_components,
                "original_handler": _has_original_handler,
                "enhanced_mode_active": self.enhanced_mode and _has_enhanced_components
            }

            # 检查向量存储
            if self.enhanced_mode and _has_enhanced_components:
                stats = self.vector_adapter.get_collection_stats()
                check_result["checks"]["vector_store"] = {
                    "available": True,
                    "stats": stats
                }
            else:
                check_result["checks"]["vector_store"] = {
                    "available": False,
                    "error": "增强模式未激活"
                }

            # 检查文件格式支持
            supported_formats = self.get_supported_formats()
            check_result["checks"]["supported_formats"] = {
                "count": len(supported_formats),
                "formats": supported_formats
            }

            # 记录健康状态
            if check_result["checks"]["components"]["enhanced_components"]:
                check_result["status"] = "healthy"
            else:
                check_result["status"] = "degraded"

        except Exception as e:
            check_result["status"] = "unhealthy"
            check_result["error"] = str(e)

        return check_result


# 便捷函数
async def handle_enhanced_at_references(
    user_input: str,
    vector_store,
    config: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """便捷函数：处理增强@引用

    Args:
        user_input: 用户输入文本
        vector_store: 向量存储实例
        config: 配置字典

    Returns:
        处理结果
    """
    handler = EnhancedAtReferenceHandler(vector_store, config)
    return await handler.handle(user_input)


def create_enhanced_at_handler(
    vector_store,
    config: Optional[Dict[str, Any]] = None
) -> EnhancedAtReferenceHandler:
    """便捷函数：创建增强@引用处理器

    Args:
        vector_store: 向量存储实例
        config: 配置字典

    Returns:
        处理器实例
    """
    return EnhancedAtReferenceHandler(vector_store, config)
