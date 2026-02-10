"""
Ah32 策略模块

这个模块定义了Ah32系统的各种策略，包括：
- 基于关键词的上下文构建策略 (context_strategy.py)
- 基于关键词的记忆分类策略 (llm_driven_strategy.py)

主要组件:
1. ContextStrategy - 基于关键词的传统策略
2. SimpleClassificationStrategy - 基于关键词的记忆分类策略
"""

# 基于关键词的传统策略
from .context_strategy import (
    context_strategy,
    get_query_type,
    InfoPriority,
    ContextStrategy
)

# 基于关键词的记忆分类策略
from .llm_driven_strategy import (
    MemoryClassificationResult,
    BiddingClassificationResult,
    StorageLevel,
    ConfidenceLevel,
    ClassificationCategory,
    SimpleClassificationStrategy,
    classify_conversation
)

__all__ = [
    # 传统策略
    'context_strategy',
    'get_query_type',
    'InfoPriority',
    'ContextStrategy',

    # 基于关键词的记忆分类策略
    'MemoryClassificationResult',
    'BiddingClassificationResult',
    'StorageLevel',
    'ConfidenceLevel',
    'ClassificationCategory',
    'SimpleClassificationStrategy',
    'classify_conversation'
]
