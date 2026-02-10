"""Ah32核心模块 - 统一管理系统"""

from .prompts import PromptManager, get_prompt_manager
from .tools import (
    ToolRegistry,
    ToolCategory,
    ToolMetadata,
    register_tool,
    get_tool_registry,
    get_tool,
    get_all_tools,
    get_tools_by_category,
    search_tools
)

# 增强文档处理模块
try:
    from .document_loader import Ah32DocumentLoader
    from .text_splitter import Ah32TextSplitter
    from .vector_store_adapter import ChromaDBAdapter

    _has_enhanced_processing = True
except ImportError as e:
    _has_enhanced_processing = False
    print(f"Warning: Enhanced document processing not available: {e}")


__all__ = [
    # 提示词管理
    "PromptManager",
    "get_prompt_manager",

    # 工具管理
    "ToolRegistry",
    "ToolCategory",
    "ToolMetadata",
    "register_tool",
    "get_tool_registry",
    "get_tool",
    "get_all_tools",
    "get_tools_by_category",
    "search_tools",
]

# 增强文档处理导出
if _has_enhanced_processing:
    __all__.extend([
        "Ah32DocumentLoader",
        "Ah32TextSplitter",
        "ChromaDBAdapter"
    ])

