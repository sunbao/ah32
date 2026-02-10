"""JS宏生成工具 - 用于生成WPS JS宏代码"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from ..agent_modules.base_agent_tools import BaseTool, ToolMetadata
from ...core.tools import register_tool, ToolCategory

logger = logging.getLogger(__name__)


@register_tool(ToolCategory.GENERATION, tags=["js", "macro", "wps", "automation"], priority=10)
class GenerateJSMacroCodeTool(BaseTool):
    """生成WPS JS宏代码的工具"""

    name: str = "generate_js_macro_code"
    description: str = "根据用户需求生成WPS JS宏代码，用于自动化文档操作"
    category: str = "生成"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="generate_js_macro_code",
        description="根据用户需求生成WPS JS宏代码",
        category="generation",
        tags=["js", "macro", "wps", "automation"],
        priority=10,
        agentic_capable=True,
        llm_required=True,  # 需要LLM支持
        memory_required=False
    )

    def _run(self, query: str, **kwargs) -> str:
        """同步生成JS宏代码（不建议在异步服务器中使用）"""
        return (
            "该工具建议使用异步调用（arun）。\n"
            "如果你在ReAct/流式对话中触发了 generate_js_macro_code，它会走异步路径。"
        )

    async def _arun(self, query: str, **kwargs) -> str:
        """异步生成JS宏代码（Vibe Coding 工作流）"""
        llm = kwargs.get("llm", None)
        if llm is None:
            return (
                "=== JS宏代码生成失败 ===\n\n"
                "错误信息：LLM实例不可用（llm=None）\n"
            ).strip()

        try:
            from ah32.agents.react_agent.js_macro_workflow import JSMacroVibeWorkflow

            workflow = JSMacroVibeWorkflow(llm=llm)
            session_id = kwargs.get("session_id") or f"tool_{uuid.uuid4().hex[:12]}"

            final_code = ""
            attempt_count = 0
            success = False
            async for event in workflow.process_with_visualization(query, session_id):
                if event.get("type") == "final_result":
                    result = event.get("result") or {}
                    success = bool(result.get("success", False))
                    final_code = (result.get("code") or "").strip()
                    attempt_count = int(result.get("attempt_count", 0) or 0)

            if not final_code:
                return (
                    "=== JS宏代码生成失败 ===\n\n"
                    "错误信息：Vibe Coding未返回可用代码\n"
                ).strip()

            # Keep tool output minimal so the assistant can directly surface an executable block.
            return f"```javascript\n{final_code}\n```"

        except Exception as e:
            logger.error(f"生成JS宏代码失败: {e}", exc_info=True)
            return (
                "=== JS宏代码生成失败 ===\n\n"
                f"错误信息：{str(e)}\n"
            ).strip()
