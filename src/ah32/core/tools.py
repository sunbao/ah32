"""Ah32统一工具注册表管理系统"""

from __future__ import annotations

import logging
from typing import Dict, List, Any, Optional, Type, Set
from enum import Enum
from dataclasses import dataclass

try:
    from langchain.tools import BaseTool
except ImportError:
    from langchain_core.tools import BaseTool


logger = logging.getLogger(__name__)


class ToolCategory(Enum):
    """工具类别"""
    DOCUMENT = "文档"  # 文档操作
    ANALYSIS = "分析"  # 分析工具
    ASSOCIATION = "关联"  # 关联分析
    ASSESSMENT = "评估"  # 评估工具
    INTELLIGENCE = "智能"  # 智能工具
    SUGGESTION = "建议"  # 建议生成
    GENERATION = "生成"  # 代码生成
    SYSTEM = "系统"  # 系统工具


@dataclass
class ToolMetadata:
    """工具元数据"""
    name: str
    description: str
    category: ToolCategory
    version: str = "1.0.0"
    author: str = "Ah32"
    tags: List[str] = None
    priority: int = 0  # 优先级，数字越大优先级越高
    enabled: bool = True
    # Agentic 模式相关字段
    agentic_capable: bool = True  # 是否支持 Agentic 模式
    llm_required: bool = False  # 是否需要 LLM 支持
    memory_required: bool = False  # 是否需要记忆系统支持

    def __post_init__(self):
        if self.tags is None:
            self.tags = []


class ToolRegistry:
    """统一工具注册表"""

    def __init__(self):
        self._tools: Dict[str, Type[BaseTool]] = {}
        self._tool_metadata: Dict[str, ToolMetadata] = {}
        self._tool_instances: Dict[str, BaseTool] = {}
        self._categories: Dict[ToolCategory, List[str]] = {cat: [] for cat in ToolCategory}
        self._aliases: Dict[str, str] = {}  # 别名映射
        self._initialized = False

    def register(self, tool_class: Type[BaseTool], metadata: Optional[ToolMetadata] = None):
        """注册工具"""
        if not issubclass(tool_class, BaseTool):
            raise TypeError(f"工具类必须继承自BaseTool: {tool_class}")

        tool_name = tool_class.name if hasattr(tool_class, 'name') else tool_class.__name__

        if metadata is None:
            # 自动创建元数据
            description = getattr(tool_class, 'description', f"工具: {tool_name}")
            category = getattr(tool_class, 'category', ToolCategory.SYSTEM)
            if isinstance(category, str):
                category = ToolCategory(category)
            metadata = ToolMetadata(
                name=tool_name,
                description=description,
                category=category
            )

        self._tools[tool_name] = tool_class
        self._tool_metadata[tool_name] = metadata
        self._categories[metadata.category].append(tool_name)

        logger.info(f"注册工具: {tool_name} ({metadata.category.value})")

    def unregister(self, tool_name: str):
        """注销工具"""
        if tool_name in self._tools:
            tool_class = self._tools.pop(tool_name)
            metadata = self._tool_metadata.pop(tool_name, None)
            if metadata:
                self._categories[metadata.category].remove(tool_name)
            if tool_name in self._tool_instances:
                del self._tool_instances[tool_name]
            logger.info(f"注销工具: {tool_name}")

    def get_tool(self, tool_name: str, use_cache: bool = True) -> Optional[BaseTool]:
        """获取工具实例"""
        # 检查别名
        tool_name = self._aliases.get(tool_name, tool_name)

        if use_cache and tool_name in self._tool_instances:
            return self._tool_instances[tool_name]

        tool_class = self._tools.get(tool_name)
        if tool_class:
            instance = tool_class()
            if use_cache:
                self._tool_instances[tool_name] = instance
            return instance

        return None

    def get_all_tools(self, use_cache: bool = True, enabled_only: bool = True) -> List[BaseTool]:
        """获取所有工具实例"""
        tools = []
        for tool_name, tool_class in self._tools.items():
            metadata = self._tool_metadata.get(tool_name)
            if enabled_only and metadata and not metadata.enabled:
                continue
            instance = self.get_tool(tool_name, use_cache)
            if instance:
                tools.append(instance)
        return tools

    def get_tools_by_category(self, category: ToolCategory, use_cache: bool = True) -> List[BaseTool]:
        """根据类别获取工具"""
        tools = []
        for tool_name in self._categories.get(category, []):
            metadata = self._tool_metadata.get(tool_name)
            if metadata and metadata.enabled:
                instance = self.get_tool(tool_name, use_cache)
                if instance:
                    tools.append(instance)
        return tools

    def search_tools(self, query: str, use_cache: bool = True) -> List[BaseTool]:
        """搜索工具"""
        query_lower = query.lower()
        results = []

        for tool_name, metadata in self._tool_metadata.items():
            if not metadata.enabled:
                continue

            # 检查名称、描述、标签
            if (query_lower in tool_name.lower() or
                query_lower in metadata.description.lower() or
                any(query_lower in tag.lower() for tag in metadata.tags)):
                instance = self.get_tool(tool_name, use_cache)
                if instance:
                    results.append(instance)

        # 按优先级排序
        results.sort(key=lambda t: self._tool_metadata.get(t.name, ToolMetadata("", "", ToolCategory.SYSTEM)).priority, reverse=True)
        return results

    def get_tool_info(self, tool_name: str) -> Optional[Dict[str, Any]]:
        """获取工具信息"""
        metadata = self._tool_metadata.get(tool_name)
        if not metadata:
            return None

        return {
            "name": metadata.name,
            "description": metadata.description,
            "category": metadata.category.value,
            "version": metadata.version,
            "author": metadata.author,
            "tags": metadata.tags,
            "priority": metadata.priority,
            "enabled": metadata.enabled
        }

    def list_all_tools_info(self) -> List[Dict[str, Any]]:
        """列出所有工具信息"""
        return [self.get_tool_info(name) for name in self._tools.keys()]

    def add_alias(self, alias: str, tool_name: str):
        """添加工具别名"""
        if tool_name in self._tools:
            self._aliases[alias] = tool_name
            logger.info(f"添加别名: {alias} -> {tool_name}")

    def remove_alias(self, alias: str):
        """删除工具别名"""
        if alias in self._aliases:
            del self._aliases[alias]
            logger.info(f"删除别名: {alias}")

    def enable_tool(self, tool_name: str):
        """启用工具"""
        if tool_name in self._tool_metadata:
            self._tool_metadata[tool_name].enabled = True
            logger.info(f"启用工具: {tool_name}")

    def disable_tool(self, tool_name: str):
        """禁用工具"""
        if tool_name in self._tool_metadata:
            self._tool_metadata[tool_name].enabled = False
            logger.info(f"禁用工具: {tool_name}")

    def set_priority(self, tool_name: str, priority: int):
        """设置工具优先级"""
        if tool_name in self._tool_metadata:
            self._tool_metadata[tool_name].priority = priority
            logger.info(f"设置工具 {tool_name} 优先级: {priority}")

    def get_categories(self) -> Dict[ToolCategory, List[str]]:
        """获取所有类别及工具"""
        return {cat: list(names) for cat, names in self._categories.items()}

    def get_tools_by_tags(self, tags: List[str], use_cache: bool = True) -> List[BaseTool]:
        """根据标签获取工具"""
        results = []
        for tool_name, metadata in self._tool_metadata.items():
            if not metadata.enabled:
                continue
            if any(tag in metadata.tags for tag in tags):
                instance = self.get_tool(tool_name, use_cache)
                if instance:
                    results.append(instance)
        return results

    def clear_cache(self):
        """清空工具实例缓存"""
        self._tool_instances.clear()
        logger.info("清空工具实例缓存")

    def get_registry_stats(self) -> Dict[str, Any]:
        """获取注册表统计信息"""
        total_tools = len(self._tools)
        enabled_tools = sum(1 for m in self._tool_metadata.values() if m.enabled)
        category_stats = {cat.value: len(names) for cat, names in self._categories.items()}

        return {
            "total_tools": total_tools,
            "enabled_tools": enabled_tools,
            "disabled_tools": total_tools - enabled_tools,
            "categories": category_stats,
            "aliases": len(self._aliases),
            "cached_instances": len(self._tool_instances)
        }

    def export_registry(self) -> Dict[str, Any]:
        """导出注册表"""
        return {
            "tools": {name: meta.__dict__ for name, meta in self._tool_metadata.items()},
            "aliases": self._aliases,
            "export_time": "2024-12-15"
        }

    def import_registry(self, data: Dict[str, Any]):
        """导入注册表"""
        # 这里只导入元数据，实际的工具类需要在代码中注册
        if "aliases" in data:
            self._aliases.update(data["aliases"])


# 全局工具注册表实例
_tool_registry: Optional[ToolRegistry] = None


def get_tool_registry() -> ToolRegistry:
    """获取全局工具注册表"""
    global _tool_registry
    if _tool_registry is None:
        _tool_registry = ToolRegistry()
    return _tool_registry


# 装饰器：简化工具注册
def register_tool(category: ToolCategory, tags: List[str] = None, priority: int = 0):
    """工具注册装饰器"""
    def decorator(tool_class: Type[BaseTool]):
        # 创建元数据
        metadata = ToolMetadata(
            name=getattr(tool_class, 'name', tool_class.__name__),
            description=getattr(tool_class, 'description', f"工具: {tool_class.__name__}"),
            category=category,
            tags=tags or [],
            priority=priority
        )

        # 注册到全局注册表
        registry = get_tool_registry()
        registry.register(tool_class, metadata)

        return tool_class
    return decorator


# 便捷函数
def get_tool(tool_name: str, use_cache: bool = True) -> Optional[BaseTool]:
    """获取工具"""
    return get_tool_registry().get_tool(tool_name, use_cache)


def get_all_tools(use_cache: bool = True, enabled_only: bool = True) -> List[BaseTool]:
    """获取所有工具"""
    return get_tool_registry().get_all_tools(use_cache, enabled_only)


def get_tools_by_category(category: ToolCategory, use_cache: bool = True) -> List[BaseTool]:
    """根据类别获取工具"""
    return get_tool_registry().get_tools_by_category(category, use_cache)


def search_tools(query: str, use_cache: bool = True) -> List[BaseTool]:
    """搜索工具"""
    return get_tool_registry().search_tools(query, use_cache)
