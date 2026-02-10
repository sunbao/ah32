"""Ah32 文档处理配置管理

统一管理文档处理相关的所有配置选项。
"""

import os
import json
from typing import Dict, Any, Optional, List
from pathlib import Path
from dataclasses import dataclass, asdict, field

def _require_env_value(key: str) -> str:
    value = os.getenv(key)
    if value is None or not str(value).strip():
        raise RuntimeError(f"{key} is missing in .env; please configure it before use.")
    return str(value).strip()

logger = logger = logger = logger


@dataclass
class DocumentLoaderConfig:
    """文档加载器配置"""

    # 加载器类型
    preferred_loader: str = "auto"  # "auto", "simple", "langchain", "unstructured"

    # 文件大小限制
    max_file_size: int = 50 * 1024 * 1024  # 50MB
    min_file_size: int = 100  # 100B

    # 编码支持
    encoding_priority: List[str] = field(default_factory=lambda: ['utf-8', 'gbk', 'gb2312', 'latin1'])

    # 支持的文件格式
    supported_extensions: List[str] = field(default_factory=lambda: [
        '.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md',
        '.html', '.xml', '.json', '.csv', '.eml', '.msg'
    ])

    # LangChain配置
    langchain_config: Dict[str, Any] = field(default_factory=lambda: {
        'pdf': {'mode': 'single'},  # PDF加载模式
        'unstructured': {
            'strategy': 'auto',  # 解析策略
            'include_metadata': True,
            'include_page_breaks': True
        }
    })

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'DocumentLoaderConfig':
        """从字典创建配置"""
        return cls(**data)


@dataclass
class TextSplitterConfig:
    """文档分割器配置"""

    # 分割器类型
    splitter_type: str = "auto"  # "auto", "simple", "langchain", "semantic"

    # 基础参数
    chunk_size: int = 1000
    chunk_overlap: int = 200
    min_chunk_size: int = 100
    max_chunk_size: int = 2000

    # LangChain分割器配置
    langchain_separators: List[str] = field(default_factory=lambda: [
        "\n\n", "\n", "。", "！", "？", ".", "!", "?", " ", ""
    ])

    # 语义分割器配置
    semantic_config: Dict[str, Any] = field(default_factory=lambda: {
        'title_patterns': [
            r'^#{1,6}\s+',
            r'^\d+\.?\s+',
            r'^[一二三四五六七八九十]+[、\.]\s+',
            r'^[（\(]\d+[）\)]\s+',
            r'^[A-Z][A-Z\s]+[：:]\s*$'
        ],
        'preserve_structure': True
    })

    # 性能参数
    max_chunks_per_document: int = 1000
    batch_split_size: int = 100

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TextSplitterConfig':
        """从字典创建配置"""
        return cls(**data)


@dataclass
class VectorStoreConfig:
    """向量存储配置"""

    # 向量存储类型
    vector_store_type: str = "chroma"  # "chroma", "pinecone", "weaviate"

    # ChromaDB配置
    chroma_config: Dict[str, Any] = field(default_factory=lambda: {
        'persist_directory': './data/chroma_db',
        'collection_name': 'ah32_documents',
        'distance_metric': 'cosine',  # cosine, l2, ip
        'embedding_model': _require_env_value("AH32_EMBEDDING_MODEL")
    })

    # 检索配置
    retrieval_config: Dict[str, Any] = field(default_factory=lambda: {
        'default_k': 4,
        'max_k': 20,
        'similarity_threshold': 0.7,
        'score_threshold': 0.5
    })

    # 批量操作配置
    batch_config: Dict[str, Any] = field(default_factory=lambda: {
        'batch_size': 100,
        'max_batch_size': 500,
        'parallel_processing': True,
        'max_workers': 4
    })

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'VectorStoreConfig':
        """从字典创建配置"""
        return cls(**data)


@dataclass
class AtReferenceConfig:
    """@引用处理器配置"""

    # 处理器模式
    processor_mode: str = "enhanced"  # "original", "enhanced", "auto"

    # 文件验证
    file_validation: Dict[str, Any] = field(default_factory=lambda: {
        'check_file_exists': True,
        'check_file_size': True,
        'check_file_type': True,
        'allowed_extensions': ['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md'],
        'max_file_size': 50 * 1024 * 1024,  # 50MB
        'min_file_size': 100  # 100B
    })

    # 处理选项
    processing_options: Dict[str, Any] = field(default_factory=lambda: {
        'enable_progress_logging': True,
        'enable_error_recovery': True,
        'skip_duplicates': True,
        'max_retries': 3,
        'retry_delay': 1.0
    })

    # 性能参数
    performance_config: Dict[str, Any] = field(default_factory=lambda: {
        'max_concurrent_files': 5,
        'timeout_per_file': 300,  # 5分钟
        'memory_limit_mb': 1024,  # 1GB
        'cache_enabled': True,
        'cache_ttl': 3600  # 1小时
    })

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'AtReferenceConfig':
        """从字典创建配置"""
        return cls(**data)


@dataclass
class DocumentProcessingConfig:
    """完整文档处理配置"""

    # 子配置
    loader_config: DocumentLoaderConfig = field(default_factory=DocumentLoaderConfig)
    splitter_config: TextSplitterConfig = field(default_factory=TextSplitterConfig)
    vector_config: VectorStoreConfig = field(default_factory=VectorStoreConfig)
    at_reference_config: AtReferenceConfig = field(default_factory=AtReferenceConfig)

    # 全局配置
    global_config: Dict[str, Any] = field(default_factory=lambda: {
        'debug_mode': False,
        'log_level': 'INFO',
        'enable_metrics': True,
        'enable_profiling': False,
        'temp_dir': './temp',
        'max_memory_usage_mb': 2048
    })

    # 环境配置
    environment: str = "development"  # development, testing, production

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'loader_config': self.loader_config.to_dict(),
            'splitter_config': self.splitter_config.to_dict(),
            'vector_config': self.vector_config.to_dict(),
            'at_reference_config': self.at_reference_config.to_dict(),
            'global_config': self.global_config,
            'environment': self.environment
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'DocumentProcessingConfig':
        """从字典创建配置"""
        return cls(
            loader_config=DocumentLoaderConfig.from_dict(data.get('loader_config', {})),
            splitter_config=TextSplitterConfig.from_dict(data.get('splitter_config', {})),
            vector_config=VectorStoreConfig.from_dict(data.get('vector_config', {})),
            at_reference_config=AtReferenceConfig.from_dict(data.get('at_reference_config', {})),
            global_config=data.get('global_config', {}),
            environment=data.get('environment', 'development')
        )

    @classmethod
    def from_file(cls, config_path: str) -> 'DocumentProcessingConfig':
        """从文件加载配置

        Args:
            config_path: 配置文件路径

        Returns:
            配置实例
        """
        config_path = Path(config_path)

        if not config_path.exists():
            logger.warning(f"配置文件不存在: {config_path}，使用默认配置")
            return cls()

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                if config_path.suffix.lower() == '.json':
                    data = json.load(f)
                else:
                    raise ValueError(f"不支持的配置文件格式: {config_path.suffix}")

            return cls.from_dict(data)

        except Exception as e:
            logger.error(f"加载配置文件失败 {config_path}: {e}，使用默认配置")
            return cls()

    def save_to_file(self, config_path: str, overwrite: bool = False) -> bool:
        """保存配置到文件

        Args:
            config_path: 配置文件路径
            overwrite: 是否覆盖已存在的文件

        Returns:
            是否成功保存
        """
        config_path = Path(config_path)

        if config_path.exists() and not overwrite:
            logger.error(f"配置文件已存在: {config_path}")
            return False

        try:
            config_path.parent.mkdir(parents=True, exist_ok=True)

            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

            logger.info(f"配置已保存到: {config_path}")
            return True

        except Exception as e:
            logger.error(f"保存配置文件失败 {config_path}: {e}")
            return False

    def merge_with_env(self) -> 'DocumentProcessingConfig':
        """从环境变量合并配置

        Returns:
            合并后的配置实例
        """
        config_dict = self.to_dict()

        # 环境变量映射
        env_mappings = {
            'AH32_DOCUMENT_DEBUG': ('global_config', 'debug_mode', bool),
            'AH32_DOCUMENT_LOG_LEVEL': ('global_config', 'log_level', str),
            'AH32_CHUNK_SIZE': ('splitter_config', 'chunk_size', int),
            'AH32_CHUNK_OVERLAP': ('splitter_config', 'chunk_overlap', int),
            'AH32_MAX_FILE_SIZE': ('loader_config', 'max_file_size', int),
            'AH32_SIMILARITY_THRESHOLD': ('vector_config', 'retrieval_config', 'similarity_threshold', float),
            'AH32_COLLECTION_NAME': ('vector_config', 'chroma_config', 'collection_name', str),
            'AH32_PERSIST_DIRECTORY': ('vector_config', 'chroma_config', 'persist_directory', str),
        }

        for env_var, (config_path, *rest) in env_mappings.items():
            value = os.getenv(env_var)
            if value is not None:
                try:
                    # 转换类型
                    if len(rest) == 2:
                        config_key, value_type = rest
                        if value_type == bool:
                            value = value.lower() in ('true', '1', 'yes', 'on')
                        elif value_type == int:
                            value = int(value)
                        elif value_type == float:
                            value = float(value)
                        else:
                            value = str(value)

                        # 设置值
                        if config_key not in config_dict[config_path]:
                            config_dict[config_path][config_key] = value
                        else:
                            config_dict[config_path][config_key] = value

                    logger.debug(f"从环境变量设置 {env_var} = {value}")

                except Exception as e:
                    logger.warning(f"无法解析环境变量 {env_var} = {value}: {e}")

        return self.from_dict(config_dict)

    def get_loader_config(self) -> DocumentLoaderConfig:
        """获取文档加载器配置"""
        return self.loader_config

    def get_splitter_config(self) -> TextSplitterConfig:
        """获取文档分割器配置"""
        return self.splitter_config

    def get_vector_config(self) -> VectorStoreConfig:
        """获取向量存储配置"""
        return self.vector_config

    def get_at_reference_config(self) -> AtReferenceConfig:
        """获取@引用处理器配置"""
        return self.at_reference_config

    def validate(self) -> List[str]:
        """验证配置有效性

        Returns:
            错误列表（空列表表示配置有效）
        """
        errors = []

        # 验证文档加载器配置
        if self.loader_config.chunk_size <= 0:
            errors.append("chunk_size必须大于0")

        if self.loader_config.chunk_overlap < 0:
            errors.append("chunk_overlap不能为负数")

        if self.loader_config.max_file_size <= 0:
            errors.append("max_file_size必须大于0")

        # 验证向量存储配置
        if self.vector_config.retrieval_config['similarity_threshold'] < 0 or \
           self.vector_config.retrieval_config['similarity_threshold'] > 1:
            errors.append("similarity_threshold必须在0-1之间")

        # 验证@引用配置
        if self.at_reference_config.file_validation['max_file_size'] <= 0:
            errors.append("max_file_size必须大于0")

        if self.at_reference_config.processing_options['max_retries'] < 0:
            errors.append("max_retries不能为负数")

        return errors

    def __str__(self) -> str:
        """字符串表示"""
        return f"DocumentProcessingConfig(environment={self.environment})"

    def __repr__(self) -> str:
        """详细字符串表示"""
        return f"DocumentProcessingConfig(environment={self.environment}, loader={self.loader_config.preferred_loader}, splitter={self.splitter_config.splitter_type})"


# 预设配置
class PresetConfigs:
    """预设配置"""

    @staticmethod
    def development() -> DocumentProcessingConfig:
        """开发环境配置"""
        config = DocumentProcessingConfig()
        config.environment = "development"
        config.global_config.update({
            'debug_mode': True,
            'log_level': 'DEBUG',
            'enable_profiling': True
        })
        config.loader_config.preferred_loader = "auto"
        config.splitter_config.splitter_type = "auto"
        return config

    @staticmethod
    def production() -> DocumentProcessingConfig:
        """生产环境配置"""
        config = DocumentProcessingConfig()
        config.environment = "production"
        config.global_config.update({
            'debug_mode': False,
            'log_level': 'WARNING',
            'enable_profiling': False
        })
        config.loader_config.preferred_loader = "enhanced"
        config.splitter_config.splitter_type = "semantic"
        return config

    @staticmethod
    def testing() -> DocumentProcessingConfig:
        """测试环境配置"""
        config = DocumentProcessingConfig()
        config.environment = "testing"
        config.loader_config.max_file_size = 10 * 1024 * 1024  # 10MB for testing
        config.splitter_config.max_chunks_per_document = 100
        return config


# 全局配置实例
_global_config: Optional[DocumentProcessingConfig] = None


def get_document_config() -> DocumentProcessingConfig:
    """获取全局文档处理配置

    Returns:
        配置实例
    """
    global _global_config
    if _global_config is None:
        # 默认从环境变量加载
        _global_config = DocumentProcessingConfig().merge_with_env()
    return _global_config


def set_document_config(config: DocumentProcessingConfig):
    """设置全局文档处理配置

    Args:
        config: 配置实例
    """
    global _global_config
    _global_config = config


def reset_document_config():
    """重置全局配置为默认配置"""
    global _global_config
    _global_config = DocumentProcessingConfig()


# 便捷函数
def load_config_from_file(config_path: str) -> DocumentProcessingConfig:
    """从文件加载配置

    Args:
        config_path: 配置文件路径

    Returns:
        配置实例
    """
    return DocumentProcessingConfig.from_file(config_path)


def save_config_to_file(config: DocumentProcessingConfig, config_path: str) -> bool:
    """保存配置到文件

    Args:
        config: 配置实例
        config_path: 配置文件路径

    Returns:
        是否成功保存
    """
    return config.save_to_file(config_path)


def create_development_config() -> DocumentProcessingConfig:
    """创建开发环境配置

    Returns:
        配置实例
    """
    return PresetConfigs.development()


def create_production_config() -> DocumentProcessingConfig:
    """创建生产环境配置

    Returns:
        配置实例
    """
    return PresetConfigs.production()


def create_testing_config() -> DocumentProcessingConfig:
    """创建测试环境配置

    Returns:
        配置实例
    """
    return PresetConfigs.testing()
