"""Ah32 智能文档分割器

基于LangChain + 自研算法的文档分割器，支持多种分割策略。
"""

import re
import logging
from typing import List, Dict, Any, Optional, Tuple
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class TextSplitter(ABC):
    """文档分割器抽象基类"""

    @abstractmethod
    def split(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """分割文本

        Args:
            text: 输入文本
            metadata: 文档元数据

        Returns:
            分割后的文本块列表，每个块包含content和metadata
        """
        pass

    @abstractmethod
    def get_config(self) -> Dict[str, Any]:
        """获取分割器配置"""
        pass


class SimpleSplitter(TextSplitter):
    """简单文档分割器

    原生实现，按段落和字符长度分割
    """

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        """初始化简单分割器

        Args:
            chunk_size: 分块大小（字符数）
            chunk_overlap: 分块重叠大小
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        logger.debug(f"SimpleSplitter初始化: chunk_size={chunk_size}, chunk_overlap={chunk_overlap}")

    def split(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """分割文本"""
        if not text or len(text.strip()) == 0:
            logger.debug("文本为空，返回空列表")
            return []

        text_length = len(text)
        metadata = metadata or {}
        logger.debug(f"开始文本分割 (SimpleSplitter): 文本长度={text_length}, chunk_size={self.chunk_size}")

        # 如果文本长度小于chunk_size，直接返回
        if text_length <= self.chunk_size:
            logger.debug(f"文本长度({text_length}) <= chunk_size({self.chunk_size})，返回单个块")
            return [{
                "content": text.strip(),
                "metadata": {
                    **metadata,
                    "chunk_index": 0,
                    "chunk_size": text_length,
                    "splitter_type": "simple"
                }
            }]

        chunks = []
        current_chunk = ""
        chunk_index = 0

        # 按段落分割
        paragraphs = text.split('\n\n')
        logger.debug(f"按段落分割，共 {len(paragraphs)} 个段落")

        for i, paragraph in enumerate(paragraphs):
            paragraph = paragraph.strip()
            if not paragraph:
                continue

            logger.debug(f"处理段落 {i+1}/{len(paragraphs)}: 长度={len(paragraph)}")

            # 检查是否需要开始新块
            if len(current_chunk) + len(paragraph) + 2 > self.chunk_size:
                logger.debug(f"需要新块: 当前块长度={len(current_chunk)}, 段落长度={len(paragraph)}, 总长度={len(current_chunk) + len(paragraph) + 2} > chunk_size={self.chunk_size}")

                # 保存当前块
                if current_chunk:
                    chunk_info = {
                        "content": current_chunk.strip(),
                        "metadata": {
                            **metadata,
                            "chunk_index": chunk_index,
                            "chunk_size": len(current_chunk),
                            "splitter_type": "simple"
                        }
                    }
                    chunks.append(chunk_info)
                    logger.debug(f"保存块 {chunk_index}: 长度={len(current_chunk)}")
                    chunk_index += 1

                    # 处理重叠
                    if self.chunk_overlap > 0 and chunk_index > 1:
                        overlap_start = max(0, len(current_chunk) - self.chunk_overlap)
                        current_chunk = current_chunk[overlap_start:]
                        logger.debug(f"处理重叠: 重叠长度={self.chunk_overlap}, 剩余长度={len(current_chunk)}")
                    else:
                        current_chunk = ""

                # 如果段落本身太长，需要进一步分割
                if len(paragraph) > self.chunk_size:
                    logger.debug(f"段落过长({len(paragraph)} > {self.chunk_size})，按句号分割")
                    # 按句号分割
                    sentences = re.split(r'[。！？.!?]', paragraph)
                    temp_chunk = ""

                    for sentence in sentences:
                        sentence = sentence.strip()
                        if not sentence:
                            continue

                        if len(temp_chunk) + len(sentence) + 1 > self.chunk_size:
                            # 保存临时块
                            if temp_chunk:
                                chunk_info = {
                                    "content": temp_chunk.strip(),
                                    "metadata": {
                                        **metadata,
                                        "chunk_index": chunk_index,
                                        "chunk_size": len(temp_chunk),
                                        "splitter_type": "simple"
                                    }
                                }
                                chunks.append(chunk_info)
                                logger.debug(f"保存句子块 {chunk_index}: 长度={len(temp_chunk)}")
                                chunk_index += 1
                                temp_chunk = ""

                        if len(sentence) <= self.chunk_size:
                            temp_chunk += ('。' if temp_chunk else '') + sentence
                        else:
                            # 句子太长，直接添加
                            chunks.append({
                                "content": sentence[:self.chunk_size],
                                "metadata": {
                                    **metadata,
                                    "chunk_index": chunk_index,
                                    "chunk_size": len(sentence[:self.chunk_size]),
                                    "splitter_type": "simple"
                                }
                            })
                            logger.debug(f"保存超长句子块 {chunk_index}: 长度={len(sentence[:self.chunk_size])}")
                            chunk_index += 1

                    logger.debug(f"句子分割完成，共生成 {len(chunks) - chunk_index + 1} 个句子块")
                    current_chunk = temp_chunk
                else:
                    logger.debug(f"段落长度适中，直接添加到当前块")
                    current_chunk = paragraph
            else:
                # 添加到当前块
                if current_chunk:
                    current_chunk += '\n\n' + paragraph
                    logger.debug(f"段落添加到当前块: 新长度={len(current_chunk)}")
                else:
                    current_chunk = paragraph
                    logger.debug(f"创建新块: 长度={len(paragraph)}")

        # 添加最后一个块
        if current_chunk:
            chunk_info = {
                "content": current_chunk.strip(),
                "metadata": {
                    **metadata,
                    "chunk_index": chunk_index,
                    "chunk_size": len(current_chunk),
                    "splitter_type": "simple"
                }
            }
            chunks.append(chunk_info)
            logger.debug(f"保存最后块 {chunk_index}: 长度={len(current_chunk)}")

        logger.info(f"文本分割完成 (SimpleSplitter): 原文长度={text_length}, 生成块数={len(chunks)}")
        return chunks

    def get_config(self) -> Dict[str, Any]:
        """获取配置"""
        return {
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "splitter_type": "simple"
        }


class LangChainSplitter(TextSplitter):
    """LangChain文档分割器

    使用LangChain的递归字符分割器
    """

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200, separators: Optional[List[str]] = None):
        """初始化LangChain分割器

        Args:
            chunk_size: 分块大小
            chunk_overlap: 分块重叠大小
            separators: 分割符列表，按优先级排序
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators or [
            "\n\n",  # 段落
            "\n",    # 行
            "。",    # 中文句号
            "！",    # 中文感叹号
            "？",    # 中文问号
            ".",     # 英文句号
            "!",     # 英文感叹号
            "?",     # 英文问号
            " ",     # 空格
            ""       # 字符级分割
        ]

        # 尝试导入LangChain
        try:
            from langchain.text_splitter import RecursiveCharacterTextSplitter
            self.splitter = RecursiveCharacterTextSplitter(
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                separators=self.separators,
                length_function=len,
                keep_separator=False
            )
            self._available = True
        except ImportError:
            logger.warning("LangChain未安装，使用简单的分割实现")
            self.splitter = None
            self._available = False

    def split(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """分割文本"""
        if not text or len(text.strip()) == 0:
            return []

        metadata = metadata or {}

        if not self._available:
            # 使用简单的分割实现
            return self._simple_split(text, metadata)

        try:
            # 使用LangChain分割器
            chunks = self.splitter.split_text(text)

            result = []
            for i, chunk in enumerate(chunks):
                result.append({
                    "content": chunk,
                    "metadata": {
                        **metadata,
                        "chunk_index": i,
                        "chunk_size": len(chunk),
                        "splitter_type": "langchain",
                        "total_chunks": len(chunks)
                    }
                })

            return result

        except Exception as e:
            logger.error(f"LangChain分割失败，使用简单分割: {e}")
            return self._simple_split(text, metadata)

    def _simple_split(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        """简单的分割实现"""
        simple_splitter = SimpleSplitter(self.chunk_size, self.chunk_overlap)
        simple_splitter.separators = self.separators
        return simple_splitter.split(text, metadata)

    def get_config(self) -> Dict[str, Any]:
        """获取配置"""
        return {
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "separators": self.separators,
            "splitter_type": "langchain",
            "available": self._available
        }


class SemanticSplitter(TextSplitter):
    """语义分割器

    基于语义的智能分割，保持段落和章节完整性
    """

    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200):
        """初始化语义分割器

        Args:
            chunk_size: 分块大小
            chunk_overlap: 分块重叠大小
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

        # 标题模式（Markdown、Word等）
        self.title_patterns = [
            r'^#{1,6}\s+',           # Markdown标题
            r'^\d+\.?\s+',           # 数字标题 (1. 2. 3.)
            r'^[一二三四五六七八九十]+[、\.]\s+',  # 中文数字标题
            r'^[（\(]\d+[）\)]\s+',     # 带括号数字标题
            r'^[A-Z][A-Z\s]+[：:]\s*$',  # 全大写标题
        ]

    def split(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """基于语义的分割"""
        if not text or len(text.strip()) == 0:
            return []

        metadata = metadata or {}

        # 识别章节结构
        sections = self._identify_sections(text)

        if len(sections) == 1:
            # 只有一个大段落，使用简单分割
            return SimpleSplitter(self.chunk_size, self.chunk_overlap).split(text, metadata)

        # 按章节分割
        chunks = []
        current_chunk = ""
        chunk_index = 0

        for section in sections:
            section_text = section["text"]
            section_title = section.get("title", "")

            # 检查是否需要新块
            if len(current_chunk) + len(section_text) + 2 > self.chunk_size:
                # 保存当前块
                if current_chunk:
                    chunks.append({
                        "content": current_chunk.strip(),
                        "metadata": {
                            **metadata,
                            "chunk_index": chunk_index,
                            "chunk_size": len(current_chunk),
                            "splitter_type": "semantic"
                        }
                    })
                    chunk_index += 1

                    # 处理重叠
                    if self.chunk_overlap > 0 and chunk_index > 1:
                        overlap_start = max(0, len(current_chunk) - self.chunk_overlap)
                        current_chunk = current_chunk[overlap_start:]
                    else:
                        current_chunk = ""

            # 添加章节标题
            if section_title and current_chunk:
                current_chunk += '\n\n' + section_title + '\n\n'
            elif section_title:
                current_chunk = section_title + '\n\n'

            current_chunk += section_text

        # 添加最后一个块
        if current_chunk:
            chunks.append({
                "content": current_chunk.strip(),
                "metadata": {
                    **metadata,
                    "chunk_index": chunk_index,
                    "chunk_size": len(current_chunk),
                    "splitter_type": "semantic"
                }
            })

        return chunks

    def _identify_sections(self, text: str) -> List[Dict[str, Any]]:
        """识别文档章节结构"""
        lines = text.split('\n')
        sections = []
        current_section = {"title": "", "text": ""}

        for line in lines:
            line = line.strip()

            # 检查是否是标题
            is_title = False
            for pattern in self.title_patterns:
                if re.match(pattern, line):
                    is_title = True
                    break

            if is_title:
                # 保存当前章节
                if current_section["text"]:
                    sections.append(current_section)

                # 开始新章节
                current_section = {
                    "title": line,
                    "text": ""
                }
            else:
                # 添加到当前章节
                if current_section["text"]:
                    current_section["text"] += '\n' + line
                else:
                    current_section["text"] = line

        # 添加最后一个章节
        if current_section["text"]:
            sections.append(current_section)

        return sections

    def get_config(self) -> Dict[str, Any]:
        """获取配置"""
        return {
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "title_patterns": self.title_patterns,
            "splitter_type": "semantic"
        }


class Ah32TextSplitter:
    """Ah32统一文本分割器

    整合多种分割策略，提供智能分割
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """初始化文本分割器

        Args:
            config: 配置字典
        """
        self.config = config or {}

        # 获取分割策略
        self.splitter_type = self.config.get('splitter_type', 'auto')
        self.chunk_size = self.config.get('chunk_size', 1000)
        self.chunk_overlap = self.config.get('chunk_overlap', 200)
        self.separators = self.config.get('separators')

        # 初始化分割器
        self.splitters = {
            'simple': SimpleSplitter(self.chunk_size, self.chunk_overlap),
            'langchain': LangChainSplitter(self.chunk_size, self.chunk_overlap, self.separators),
            'semantic': SemanticSplitter(self.chunk_size, self.chunk_overlap)
        }

        # 分割器优先级（auto模式时）
        self.splitter_priority = ['semantic', 'langchain', 'simple']

        logger.info(f"Ah32TextSplitter初始化完成，类型: {self.splitter_type}")

    def split_text(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """分割文本的主要接口

        Args:
            text: 输入文本
            metadata: 文档元数据

        Returns:
            分割后的文本块列表
        """
        if not text or len(text.strip()) == 0:
            return []

        # 根据配置选择分割器
        if self.splitter_type == 'auto':
            # 自动选择最合适的分割器
            return self._auto_split(text, metadata)
        elif self.splitter_type in self.splitters:
            # 使用指定的分割器
            splitter = self.splitters[self.splitter_type]
            result = splitter.split(text, metadata)
            logger.debug(f"使用{self.splitter_type}分割器分割文本")
            return result
        else:
            logger.error(f"未知的分割器类型: {self.splitter_type}，使用简单分割器")
            return self.splitters['simple'].split(text, metadata)

    def _auto_split(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        """自动选择合适的分割器"""
        for splitter_name in self.splitter_priority:
            splitter = self.splitters[splitter_name]

            try:
                result = splitter.split(text, metadata)

                # 检查分割结果质量
                if self._evaluate_split_quality(result, text):
                    logger.debug(f"自动选择{splitter_name}分割器")
                    return result

            except Exception as e:
                logger.warning(f"{splitter_name}分割器失败，尝试下一个: {e}")
                continue

        # 如果所有分割器都失败，使用简单分割器
        logger.warning("所有自动分割器都失败，使用简单分割器")
        return self.splitters['simple'].split(text, metadata)

    def _evaluate_split_quality(self, chunks: List[Dict[str, Any]], original_text: str) -> bool:
        """评估分割结果质量"""
        if not chunks:
            return False

        # 检查是否有内容
        total_length = sum(len(chunk['content']) for chunk in chunks)
        if total_length < len(original_text) * 0.8:  # 至少保留80%内容
            return False

        # 检查分割是否过于细碎
        avg_chunk_size = total_length / len(chunks)
        if avg_chunk_size < 100:  # 平均块太小
            return False

        return True

    def get_splitter_info(self) -> Dict[str, Any]:
        """获取分割器信息"""
        info = {
            "splitter_type": self.splitter_type,
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "available_splitters": list(self.splitters.keys()),
            "splitter_priority": self.splitter_priority
        }

        # 添加各分割器配置
        splitter_configs = {}
        for name, splitter in self.splitters.items():
            splitter_configs[name] = splitter.get_config()

        info["splitter_configs"] = splitter_configs
        return info


# 便捷函数
def split_document(text: str, metadata: Optional[Dict[str, Any]] = None,
                  config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """便捷函数：分割单个文档

    Args:
        text: 文档文本
        metadata: 文档元数据
        config: 分割配置

    Returns:
        分割后的文本块列表
    """
    splitter = Ah32TextSplitter(config)
    return splitter.split_text(text, metadata)


def split_documents(documents: List[Dict[str, Any]],
                   config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """便捷函数：批量分割文档

    Args:
        documents: 文档列表，每个文档包含content和metadata
        config: 分割配置

    Returns:
        分割后的文本块列表
    """
    splitter = Ah32TextSplitter(config)
    all_chunks = []

    for doc in documents:
        content = doc.get('content', '')
        metadata = doc.get('metadata', {})
        chunks = splitter.split_text(content, metadata)
        all_chunks.extend(chunks)

    return all_chunks
