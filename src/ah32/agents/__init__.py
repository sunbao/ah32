"""
阿蛤（AH32）Agent 工具包 - 通用 Office AI 助手
按功能分类的Agent工具模块

模块结构：
- base_agent_tools: 基础类和工具注册
- document_agent_tools: 文档处理相关工具
- intelligent_agent_tools: 智能分析工具
- utility_agent_tools: 实用功能工具
- document_memory_tools: 记忆管理工具
"""

# 模块化导入 - 直接从各模块导入所需工具
from .agent_modules.base_agent_tools import (
    BaseTool,
    ToolMetadata,
    ToolCategory,
    register_tool,
    get_synced_documents
)

from .agent_modules.document_agent_tools import (
    ListOpenDocumentsTool,
    ImportDocumentsTool
)

from .agent_modules.document_memory_tools import (
    DocumentMemoryTool
)

from .agent_modules.intelligent_agent_tools import (
    ReadDocumentTool
)

from .agent_modules.utility_agent_tools import (
    GenerateReportTool,
    QuickAnalyzeTool,
    ExportAnalysisTool,
    GetUserPreferencesTool,
    KnowledgeListTool,
    SemanticSearchTool,
    ExtractSemanticEntitiesTool,
    CalculateDateTool
)

# 工具获取函数
def get_all_tools():
    """获取所有Agent工具"""
    from .agent_modules.document_agent_tools import (
        ListOpenDocumentsTool, ImportDocumentsTool
    )
    from .agent_modules.document_memory_tools import (
        DocumentMemoryTool
    )
    from .agent_modules.intelligent_agent_tools import (
        ReadDocumentTool
    )
    from .agent_modules.utility_agent_tools import (
        GenerateReportTool, QuickAnalyzeTool, ExportAnalysisTool,
        GetUserPreferencesTool, KnowledgeListTool, SemanticSearchTool,
        ExtractSemanticEntitiesTool, CalculateDateTool
    )

    return [
        ListOpenDocumentsTool(),
        ImportDocumentsTool(),
        DocumentMemoryTool(),
        ReadDocumentTool(),
        GenerateReportTool(),
        QuickAnalyzeTool(),
        ExportAnalysisTool(),
        GetUserPreferencesTool(),
        KnowledgeListTool(),
        SemanticSearchTool(),
        ExtractSemanticEntitiesTool(),
        CalculateDateTool()
    ]

def get_tool_by_name(name: str):
    """根据名称获取工具"""
    tools = {
        'list_open_documents': ListOpenDocumentsTool(),
        'import_documents': ImportDocumentsTool(),
        'document_memory': DocumentMemoryTool(),
        'read_document': ReadDocumentTool(),
        'generate_report': GenerateReportTool(),
        'quick_analyze': QuickAnalyzeTool(),
        'export_analysis': ExportAnalysisTool(),
        'get_user_preferences': GetUserPreferencesTool(),
        'knowledge_list': KnowledgeListTool(),
        'semantic_search': SemanticSearchTool(),
        'extract_semantic_entities': ExtractSemanticEntitiesTool(),
        'calculate_date': CalculateDateTool()
    }
    return tools.get(name)

def get_tools_by_category(category: str):
    """按类别获取工具"""
    all_tools = get_all_tools()
    category_tools = []

    category_mapping = {
        '文档': ['ListOpenDocumentsTool', 'ImportDocumentsTool', 'ReadDocumentTool'],
        '记忆': ['DocumentMemoryTool'],
        '实用': ['GenerateReportTool', 'QuickAnalyzeTool', 'ExportAnalysisTool',
                'GetUserPreferencesTool', 'KnowledgeListTool', 'SemanticSearchTool',
                'ExtractSemanticEntitiesTool', 'CalculateDateTool']
    }

    allowed_tools = category_mapping.get(category, [])
    for tool in all_tools:
        if tool.__class__.__name__ in allowed_tools:
            category_tools.append(tool)

    return category_tools
