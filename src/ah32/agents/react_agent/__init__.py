"""ReAct Agent - 模块化版本

这个包包含了ReAct Agent的核心功能，已拆分为多个专门的模块：
- core.py: 核心ReAct Agent类
- tool_execution.py: 工具执行和流式处理
- conversation.py: 对话管理和上下文构建
- dual_doc_analyzer.py: 双文档分析器
- api_integration.py: 外部API集成功能
"""

from .core import ReActAgent, ToolCall
from .tool_execution import ToolExecutor, StreamProcessor
from .conversation import ContextBuilder, ConversationManager
from .dual_doc_analyzer import DualDocAnalyzer
from .api_integration import (
    MemoryManager, RiskAssessor, SemanticMatcher,
    ExportManager, AnalysisReport, react_chat
)

__all__ = [
    # 核心类
    'ReActAgent',
    'ToolCall',

    # 工具执行
    'ToolExecutor',
    'StreamProcessor',

    # 对话管理
    'ContextBuilder',
    'ConversationManager',

    # 文档分析
    'DualDocAnalyzer',

    # API集成
    'MemoryManager',
    'RiskAssessor',
    'SemanticMatcher',
    'ExportManager',
    'AnalysisReport',

    # 便捷函数
    'react_chat'
]
