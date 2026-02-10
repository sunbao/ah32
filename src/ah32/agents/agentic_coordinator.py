"""阿蛤（AH32）Agent 协调器 - 专注于上下文感知，不做决策

根据 docs/AH32_DESIGN.md 设计：
- Agent感知 → LLM决策 → JS执行
- Agent只收集上下文（文档状态、光标、选区等）
- LLM基于实时上下文自主决策生成JS代码
- 不预设意图分类和工作流
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

from langchain.agents import create_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_core.language_models import BaseLanguageModel
from langchain_core.tools import BaseTool

from . import get_all_tools
from ah32.services.models import load_llm
from ah32.config import settings

logger = logging.getLogger(__name__)

# 常量定义 - 提高代码可维护性
DEFAULT_SESSION_ID = "default_session"
MAX_CONVERSATION_HISTORY = 20
DEFAULT_FONT = {"name": "宋体", "size": 12}


class Ah32Coordinator:
    """Ah32 Agent协调器 - 统一管理所有工具和交互（Agentic模式）"""

    def __init__(self, vector_store=None):
        self.llm: Optional[BaseLanguageModel] = None
        self.tools: List[BaseTool] = []
        self.agent_executor: Optional[Any] = None
        self.conversation_history: List[BaseMessage] = []
        self.conversation_id: str = DEFAULT_SESSION_ID
        self.is_monitoring = False
        self.monitoring_task = None
        self._pending_changes: List[Dict] = []  # 待处理的变化通知
        self.vector_store = vector_store  # 向量存储实例

        # 延迟初始化系统提示词（避免在__init__中调用format）
        self._system_prompt_created = False

    def _create_system_prompt(self, context: Dict[str, Any] = None) -> str:
        """创建系统提示词（增强版，充分利用所有感知数据）"""
        if context is None:
            context = {}

        return """你是阿蛤（AH32）智能办公助手，核心能力是根据完整的实时感知数据生成可执行的 WPS JS 宏代码。

职责分离：
- Agent感知：收集完整的文档状态（光标、选区、结构、格式、质量分析、智能建议）
- LLM决策：基于完整感知数据自主决策生成JS代码
- JS执行：操作WPS文档

感知维度：
1. 基础感知：文档信息、光标位置、选区内容、结构信息、格式状态
2. 语义理解：语义章节识别、文档类型分析、任务类型推断
3. 质量分析：可读性评分、逻辑流程、完整性检查、格式问题检测
4. 智能建议：内容建议、格式推荐、效率提示
5. 实时状态：文档变化、用户行为、性能数据、错误恢复

工作流程：
1. 分析完整感知数据（包含质量分析和智能建议）
2. 基于语义理解和任务类型自主决策处理策略
3. 生成可执行的WPS JS宏代码
4. 代码格式：```js\\nfunction Xxx() {\\n    // JS宏代码\\n}\\n```

请充分利用所有感知数据，提供智能化的办公助手功能。"""

    def _format_tools_for_prompt(self) -> str:
        """格式化工具列表供提示词使用"""
        if not self.tools:
            return "无可用工具"
        
        tool_descriptions = []
        for tool in self.tools:
            tool_name = getattr(tool, 'name', tool.__class__.__name__)
            tool_description = getattr(tool, 'description', '无描述')
            tool_descriptions.append(f"- {tool_name}: {tool_description}")
        
        return "\n".join(tool_descriptions)

    def _get_default_context(self) -> Dict[str, Any]:
        """获取默认上下文（减少硬编码）"""
        return {
            "document_state": {"name": "未知文档", "total_lines": 0},
            "cursor_position": {"line": 1, "column": 1},
            "selection": {"is_empty": True, "text": None},
            "structure": {"headings": [], "tables": [], "images": []},
            "format_state": {"font": DEFAULT_FONT, "paragraph": {"alignment": 0}}
        }

    async def _handle_at_references(self, user_input: str) -> Dict[str, Any]:
        """处理@引用

        Args:
            user_input: 用户输入文本

        Returns:
            @引用处理结果
        """
        try:
            logger.debug("开始处理@引用...")

            # 导入@引用处理器
            from ah32.services.at_reference_handler import AtReferenceHandler
            from ah32.knowledge.store import LocalVectorStore

            # 获取向量存储实例
            # 注意：这里需要确保vector_store可用
            vector_store = getattr(self, 'vector_store', None)
            if not vector_store:
                logger.warning("向量存储不可用，跳过@引用处理")
                return {"paths": [], "processed": [], "errors": ["向量存储不可用"]}

            # 创建@引用处理器
            at_handler = AtReferenceHandler(vector_store)

            # 处理@引用
            result = await at_handler.handle(user_input)

            logger.debug("@引用处理完成")
            return result

        except ImportError as e:
            logger.warning(f"@引用处理器导入失败: {e}")
            return {"paths": [], "processed": [], "errors": [f"导入错误: {str(e)}"]}
        except Exception as e:
            logger.error(f"@引用处理失败: {e}")
            logger.debug(f"@引用处理错误详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return {"paths": [], "processed": [], "errors": [str(e)]}

    def _create_agent(self):
        """创建LangChain Agent（适配新版本API）"""
        if not self.llm:
            self.llm = load_llm(settings)

        if not self.tools:
            self.tools = get_all_tools()

        # 延迟创建系统提示词
        if not self._system_prompt_created:
            self.system_prompt = self._create_system_prompt()
            self._system_prompt_created = True

        # 创建Agent（适配新版本API）
        self.agent_executor = create_agent(
            model=self.llm,
            tools=self.tools,
            system_prompt=self.system_prompt
        )

        return self.agent_executor

    async def gather_context(self, frontend_context: Dict[str, Any] = None, user_input: str = None) -> Dict[str, Any]:
        """感知文档状态（Agentic核心：对话触发感知 → 立即传给LLM）

        Agentic设计理念：
        - 用户发起对话时感知文档状态（光标、选区、结构、格式）
        - 立即传给LLM进行智能决策
        - 编辑时零干扰，感知时高效准确

        Args:
            frontend_context: 前端感知的文档状态（光标、选区、结构等）
            user_input: 用户输入文本，用于处理@引用

        Returns:
            对话上下文，直接传给LLM
        """
        try:
            logger.info("开始Agentic感知文档状态...")

            # 如果有前端上下文，使用真实感知；否则使用默认上下文
            if frontend_context:
                # ✅ 使用前端感知的完整文档状态（包含所有感知维度）
                real_time_context = {
                    "document": {
                        "name": frontend_context.get("document", {}).get("name", "未命名"),
                        "path": frontend_context.get("document", {}).get("path", ""),
                        "total_pages": frontend_context.get("document", {}).get("totalPages", 0),
                        "total_words": frontend_context.get("document", {}).get("totalWords", 0)
                    },
                    "cursor": frontend_context.get("cursor", {}),
                    "selection": frontend_context.get("selection", {}),
                    "structure": {
                        "headings": frontend_context.get("structure", {}).get("headings", []),
                        "tables": frontend_context.get("structure", {}).get("tables", 0),
                        "images": frontend_context.get("structure", {}).get("images", 0),
                        "current_section": frontend_context.get("structure", {}).get("currentSection", ""),
                        "semantic_sections": frontend_context.get("structure", {}).get("semanticSections", []),
                        "document_type": frontend_context.get("structure", {}).get("documentType", "report"),
                        "task_types": frontend_context.get("structure", {}).get("taskTypes", [])
                    },
                    "format": frontend_context.get("format", {}),
                    "quality_analysis": frontend_context.get("qualityAnalysis", {}),
                    "intelligent_suggestions": frontend_context.get("intelligentSuggestions", {}),
                    "realtime_status": frontend_context.get("realtime", {}),
                    "performance_data": frontend_context.get("performance", {}),
                    "user_behavior": frontend_context.get("behavior", {}),
                    "error_status": frontend_context.get("errors", {})
                }
                logger.info(f"[Agentic感知] 收集文档状态: {real_time_context['document']['name']}")
            else:
                # 使用默认上下文
                real_time_context = self._get_default_context()

            # 处理@引用
            if user_input:
                logger.debug(f"开始处理@引用，输入: {user_input[:100]}...")
                at_result = await self._handle_at_references(user_input)
                if at_result.get("processed"):
                    logger.info(f"成功处理 {len(at_result['processed'])} 个@引用文件")
                    # 将@引用结果添加到上下文
                    real_time_context["at_references"] = at_result
                else:
                    logger.debug("未找到@引用或处理失败")
            else:
                logger.debug("无用户输入，跳过@引用处理")

            logger.info("Agentic感知完成")
            return {
                "success": True,
                "context": real_time_context,
                "timestamp": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"动态感知失败: {e}")
            logger.debug(f"感知失败详情: {type(e).__name__}: {str(e)}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    async def chat(self, message: str, frontend_context: Dict[str, Any] = None) -> Dict[str, Any]:
        """Agentic感知式交互入口（对话驱动感知 → 智能决策）

        Agentic设计流程：
        1. 用户发起对话
        2. 前端感知文档状态（光标、选区、结构、格式）
        3. 后端收集完整上下文
        4. LLM基于上下文进行智能决策
        5. 返回个性化响应

        Args:
            message: 用户消息
            frontend_context: 前端感知的文档状态（光标、选区、结构等）

        Returns:
            LLM生成的响应和使用的上下文
        """
        try:
            logger.info(f"处理用户消息: {message[:50]}...")

            # 步骤1：Agentic感知文档状态（对话驱动）
            context_result = await self.gather_context(frontend_context, message)
            if context_result.get("success"):
                real_time_context = context_result["context"]
            else:
                # 如果动态感知失败，使用默认上下文
                real_time_context = self._get_default_context()

            # 步骤2：构建输入（包含感知上下文）
            input_dict = {
                "input": message,
                "chat_history": self.conversation_history,
                "context": real_time_context
            }

            # 步骤3：调用LLM（基于感知上下文进行智能决策）
            try:
                result = await self.agent_executor.ainvoke(input_dict)
            except TypeError:
                # 如果不支持异步，使用同步调用
                result = self.agent_executor.invoke(input_dict)

            # 步骤4：更新对话历史
            self.conversation_history.append(HumanMessage(content=message))
            self.conversation_history.append(SystemMessage(content=result["output"]))

            # 保持历史记录在合理范围内（使用常量）
            if len(self.conversation_history) > MAX_CONVERSATION_HISTORY:
                self.conversation_history = self.conversation_history[-MAX_CONVERSATION_HISTORY:]

            # 返回结果
            return {
                "success": True,
                "output": result["output"],
                "tool_calls": getattr(result, 'intermediate_steps', []),
                "context_used": real_time_context,  # 返回使用的实时感知上下文
                "timestamp": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"动态感知处理失败: {e}")
            return {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    async def start_monitoring(self, interval: int = 5):
        """启动文档变化监听

        注意：根据 docs/AH32_RULES.md 规则，检测到变化后不会自动触发分析，
        而是记录变化并通知用户，由用户决定是否需要分析。
        """
        if self.is_monitoring:
            logger.warning("监听已在运行中")
            return

        self.is_monitoring = True
        self._pending_changes = []
        logger.info(f"启动文档变化监听，间隔: {interval}秒")

        async def monitor_loop():
            try:
                while self.is_monitoring:
                    # 检测文档变化
                    try:
                        from . import get_tool_by_name
                        monitor_tool = get_tool_by_name("monitor_document_changes")
                        if monitor_tool:
                            changes = await monitor_tool.arun()

                            if "检测到文档变化" in changes:
                                logger.info("检测到文档变化，记录变化通知用户")
                                # 记录变化，等待用户确认后处理
                                self._pending_changes.append({
                                    "time": datetime.now().isoformat(),
                                    "changes": changes
                                })
                    except Exception as e:
                        logger.debug(f"检测文档变化失败: {e}")

                    await asyncio.sleep(interval)

            except asyncio.CancelledError:
                logger.info("文档监听任务已取消")
            except Exception as e:
                logger.error(f"监听过程出错: {e}")
            finally:
                self.is_monitoring = False

        self.monitoring_task = asyncio.create_task(monitor_loop())

    def get_pending_changes(self) -> List[Dict]:
        """获取待处理的文档变化"""
        return self._pending_changes.copy()

    def clear_pending_changes(self):
        """清空待处理的变化记录"""
        self._pending_changes = []

    def check_changes_and_notify(self) -> Optional[str]:
        """检查是否有待处理的变化，返回通知消息"""
        if not self._pending_changes:
            return None

        count = len(self._pending_changes)
        self._pending_changes = []
        return f"📄 检测到 {count} 处文档变化，请告诉我是否需要分析这些变化的影响。"

    def stop_monitoring(self):
        """停止文档变化监听"""
        if not self.is_monitoring:
            logger.warning("监听未在运行")
            return

        self.is_monitoring = False
        if self.monitoring_task:
            self.monitoring_task.cancel()

        logger.info("已停止文档变化监听")

    async def auto_analyze(self, analysis_type: str = "full") -> Dict[str, Any]:
        """执行分析（阿蛤（AH32）模式）

        简化处理，让LLM基于实时上下文自主决策分析方向。
        不预设固定步骤，由LLM根据用户需求自主判断。

        Args:
            analysis_type: 分析类型（仅用于用户意图表达）
        """
        logger.info(f"开始{analysis_type}分析")

        try:
            # 简洁的意图描述，让LLM自主决策
            intent = f"请分析当前文档，{analysis_type}模式。"

            # 将意图传达给LLM，让LLM基于实时上下文自主判断
            result = await self.chat(intent)

            return result

        except Exception as e:
            logger.error(f"分析失败: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    async def suggest_analysis(self, context: str = "") -> str:
        """基于当前上下文智能建议分析方向（Agentic 模式）

        根据已打开的文档和对话上下文，建议用户可能需要的分析操作。
        """
        try:
            suggestion_prompt = """
根据当前对话上下文和已打开的文档，简要建议下一步可能需要的分析方向。
请直接给出1-2个建议，不要预设步骤。

建议格式：
- 如果需要分析："[具体建议，如：分析第三章技术要求]"
- 如果不需要：""（返回空字符串）

不要提供详细的操作步骤，只需给出简洁的建议。
"""
            if context:
                suggestion_prompt += f"\n当前上下文：{context}"

            result = await self.chat(suggestion_prompt)
            return result.get("output", "").strip() if result.get("success") else ""

        except Exception as e:
            logger.error(f"生成分析建议失败: {e}")
            return ""

    async def quick_question(self, question: str) -> Dict[str, Any]:
        """快速回答问题"""
        try:
            # 使用answer_question工具直接回答
            from . import get_tool_by_name
            answer_tool = get_tool_by_name("answer_question")
            if answer_tool:
                answer = await answer_tool.arun(question=question)
                return {
                    "success": True,
                    "answer": answer,
                    "timestamp": datetime.now().isoformat()
                }
            else:
                return await self.chat(f"请回答这个问题: {question}")

        except Exception as e:
            logger.error(f"快速问答失败: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    def get_status(self) -> Dict[str, Any]:
        """获取系统状态"""
        return {
            "agent_ready": self.agent_executor is not None,
            "tools_count": len(self.tools),
            "monitoring": self.is_monitoring,
            "conversation_length": len(self.conversation_history),
            "last_activity": datetime.now().isoformat()
        }

    def clear_history(self):
        """清空对话历史"""
        self.conversation_history = []
        logger.info("已清空对话历史")

    def get_available_tools(self) -> List[Dict[str, str]]:
        """获取可用工具列表"""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "category": getattr(tool, 'category', 'unknown')
            }
            for tool in self.tools
        ]

    async def generate_report(self, report_type: str = "summary") -> Dict[str, Any]:
        """生成分析报告（Agentic 模式）

        根据 docs/AH32_RULES.md 规则，让 Agent 自主决定报告内容和结构。
        """
        try:
            # 简洁的意图描述，不预设报告结构
            intent = f"请生成一份{report_type}报告，基于当前打开的文档进行分析。"

            result = await self.chat(intent)

            return result

        except Exception as e:
            logger.error(f"生成报告失败: {e}")
            return {
                "success": False,
                "error": str(e)
            }


# 全局单例实例
_coordinator: Optional[Ah32Coordinator] = None


def get_coordinator(vector_store=None) -> Ah32Coordinator:
    """获取全局协调器实例"""
    global _coordinator
    if _coordinator is None or (vector_store is not None and _coordinator.vector_store is None):
        _coordinator = Ah32Coordinator(vector_store)
        _coordinator._create_agent()
    elif vector_store is not None and _coordinator.vector_store is None:
        # 如果已存在但没有vector_store，则更新
        _coordinator.vector_store = vector_store
    return _coordinator


# 便捷函数
async def chat(message: str, context: Dict[str, Any] = None, vector_store=None) -> Dict[str, Any]:
    """便捷的对话函数"""
    coordinator = get_coordinator(vector_store)
    return await coordinator.chat(message, context)


async def quick_question(question: str, vector_store=None) -> Dict[str, Any]:
    """便捷的快速问答函数"""
    coordinator = get_coordinator(vector_store)
    return await coordinator.quick_question(question)


async def auto_analyze(analysis_type: str = "full", vector_store=None) -> Dict[str, Any]:
    """便捷的自动分析函数"""
    coordinator = get_coordinator(vector_store)
    return await coordinator.auto_analyze(analysis_type)


def start_monitoring(interval: int = 5, vector_store=None):
    """便捷的启动监听函数"""
    coordinator = get_coordinator(vector_store)
    return coordinator.start_monitoring(interval)


def stop_monitoring(vector_store=None):
    """便捷的停止监听函数"""
    coordinator = get_coordinator(vector_store)
    return coordinator.stop_monitoring()
