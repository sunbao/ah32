"""阿蛤（AH32）文档处理 Agent 工具 - 文档读取和管理"""

from __future__ import annotations

import logging
from typing import Any

from .base_agent_tools import BaseTool, ToolMetadata, get_synced_documents
from ...core.tools import register_tool, ToolCategory

logger = logging.getLogger(__name__)


@register_tool(ToolCategory.DOCUMENT, tags=["文档", "列表", "打开"], priority=5)
class ListOpenDocumentsTool(BaseTool):
    """列出所有已打开的文档"""

    name: str = "list_open_documents"
    description: str = "列出当前所有可用的文档（参考文档和目标文档）"
    category: str = "文档"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="list_open_documents",
        description="列出当前所有可用的文档",
        category="document",
        tags=["文档", "列表", "打开"],
        priority=5,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "") -> str:
        """列出所有可用的文档

        Args:
            query: 可选的查询条件（暂未使用）

        Returns:
            格式化的文档列表字符串，每行 `[序号] 文档名`
        """
        try:
            docs = []

            # 从后端 API 获取同步的文档（来自前端 WPS）
            synced_docs = get_synced_documents()
            if synced_docs:
                for doc in synced_docs:
                    doc_role = doc.get("role", "reference")
                    type_icon = "⭐" if doc_role == "target" else "📄"
                    active_mark = " [活动]" if doc.get("isActive", False) else ""
                    docs.append({
                        "name": doc.get("name", "未知文档"),
                        "path": doc.get("path", ""),
                        "role": doc_role,
                        "icon": type_icon,
                        "active": active_mark
                    })

            if not docs:
                return """
=== 文档列表 ===

当前没有打开的文档。

请在前端 WPS 中打开文档，系统会自动同步文档列表。
支持的文档类型：.docx, .doc, .wps

读取文档请使用：read_document("文档名或完整路径")
                """.strip()

            # 构建返回结果
            lines = ["=== 文档列表 ===\n"]
            for i, doc in enumerate(docs, 1):
                lines.append(f"{i}. {doc['icon']} {doc['name']}{doc['active']}")
                lines.append(f"   角色: {'目标文档' if doc['role'] == 'target' else '参考文档'}")
                lines.append(f"   路径: {doc['path'] or '未保存'}")
                lines.append("")

            lines.append(f"共 {len(docs)} 个文档")

            # 建议下一步操作
            if len(docs) >= 1:
                first_doc_name = docs[0]['name']
                lines.append("\n下一步：")
                lines.append(f'调用 read_document("{first_doc_name}") 读取文档内容')

            lines.append("\n读取文档后可以进行：")
            lines.append("- 内容分析 (quick_analyze)")
            lines.append("- 语义搜索 (semantic_search)")
            lines.append("- 生成写回 Plan JSON（不使用 JS 宏）")

            return "\n".join(lines)

        except Exception as e:
            logger.error(f"列出文档失败: {e}", exc_info=True)
            return f"获取文档列表失败: {str(e)}"

    async def _arun(self, query: str = "") -> str:
        """异步执行"""
        return self._run(query)


@register_tool(ToolCategory.ANALYSIS, tags=["知识库", "导入", "上传"], priority=6)
class ImportDocumentsTool(BaseTool):
    """文档导入工具 - 将文档导入到知识库"""

    name: str = "import_documents"
    description: str = "将文档或目录导入到知识库，支持文本、PDF、Word、PPT等格式"
    category: str = "分析"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="import_documents",
        description="将文档或目录导入到知识库",
        category="analysis",
        tags=["知识库", "导入", "上传"],
        priority=6,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    async def _arun(self, source_path: str = "", reset: bool = False) -> str:
        """异步执行"""
        try:
            from pathlib import Path
            import subprocess
            import sys

            if not source_path:
                return """
=== 文档导入工具 ===

[ERROR] 请提供要导入的文档路径

使用方法：
- 指定文档路径：import_documents("C:/Users/Desktop/招标文件.pdf")
- 指定目录路径：import_documents("D:/Documents/tenders")
- 导入并清空：import_documents("/path", reset=True)
                """.strip()

            source = Path(source_path)
            if not source.exists():
                return f"[ERROR] 路径不存在：{source_path}"

            cmd = [sys.executable, "-m", "ah32.knowledge.ingest", str(source)]
            if reset:
                cmd.append("--reset")

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

            if result.returncode == 0:
                return f"""
=== 文档导入成功 ===

[SUCCESS] 成功导入文档到知识库

导入详情：
- 源路径：{source_path}
- 文档类型：{'目录' if source.is_dir() else '文件'}
- 向量存储：已持久化到 ChromaDB

下一步：
- 使用 semantic_search 搜索相关内容
- 使用 answer_question 进行RAG问答
                """.strip()
            else:
                return f"[ERROR] 导入失败：{result.stderr}"

        except subprocess.TimeoutExpired:
            return "[WARNING] 导入超时（60秒），请分批导入较小的文档集"
        except Exception as e:
            logger.error(f"文档导入失败: {e}", exc_info=True)
            return f"[ERROR] 导入失败：{str(e)}"

    def run(self, tool_input: str, **kwargs) -> str:
        """标准run接口"""
        import json
        try:
            if tool_input and tool_input.strip():
                params = json.loads(tool_input)
                source_path = params.get("source_path", "")
                reset = params.get("reset", False)
            else:
                source_path = ""
                reset = False
        except Exception:
            logger.exception("文档导入工具参数解析失败，回退为原始输入", exc_info=True)
            source_path = tool_input.strip()
            reset = False

        return f"""
=== 文档导入工具 ===

功能：导入文档到知识库
参数：source_path="{source_path}", reset={reset}

详细功能请使用异步接口。
        """.strip()



