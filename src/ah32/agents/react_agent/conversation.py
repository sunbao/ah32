"""对话管理模块 - 负责上下文构建和记忆管理"""

from typing import Dict, List, Any, Optional
import logging
import asyncio
from datetime import datetime

logger = logging.getLogger(__name__)


class ContextBuilder:
    """上下文构建器 - 负责动态构建对话上下文"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def build_context(self, memory: Dict[str, Any], session_id: Optional[str], 
                     user_info_query: bool = False, classification_result=None) -> str:
        """构建对话上下文（使用策略模式）

        Args:
            memory: 检索到的记忆
            session_id: 会话ID
            user_info_query: 是否是用户信息查询
            classification_result: LLM分类结果（可选）
        """
        context_parts = []

        # 使用简化的关键词分类结果动态构建优先级
        priority_order = None
        query_type = "regular"

        try:
            from ...strategies.context_strategy import InfoPriority

            # 如果有简化分类结果，使用它来推断查询类型
            if classification_result:
                try:
                    # 基于简化分类结果推断查询类型
                    if classification_result.category.value == "identity":
                        query_type = "user_info"
                    elif classification_result.category.value == "preference":
                        query_type = "user_info"
                    elif classification_result.category.value in ["technical", "commercial", "project", "timeline"]:
                        query_type = "analysis"

                    # 根据存储级别确定优先级
                    if classification_result.storage_level.value == "P0_全局记忆":
                        priority_order = [InfoPriority.P0_IDENTITY, InfoPriority.P2_HISTORY, InfoPriority.P1_SESSION]
                    elif classification_result.storage_level.value == "P2_跨会话记忆":
                        priority_order = [InfoPriority.P2_HISTORY, InfoPriority.P0_IDENTITY, InfoPriority.P1_SESSION]
                    else:
                        priority_order = [InfoPriority.P1_SESSION, InfoPriority.P2_HISTORY, InfoPriority.P0_IDENTITY]

                    logger.info(f"[上下文构建] 使用简化关键词分类结果构建上下文")
                    logger.info(f"[上下文构建] 分类类别: {classification_result.category.value}")
                    logger.info(f"[上下文构建] 存储级别: {classification_result.storage_level.value}")
                    logger.info(f"[上下文构建] 查询类型: {query_type}")

                except Exception as e:
                    logger.warning(f"[上下文构建] 简化分类结果构建优先级失败: {e}")
                    priority_order = None

            # 如果没有LLM分类结果，使用原有策略模式
            if not priority_order:
                try:
                    from ...strategies.context_strategy import context_strategy

                    # 判断查询类型
                    query_type = "user_info" if user_info_query else "regular"
                    if "分析" in str(memory.get("query", "")) or "评估" in str(memory.get("query", "")):
                        query_type = "analysis"

                    # 获取信息源优先级
                    priority_order = context_strategy.get_info_source_for_query("", query_type)

                    logger.info(f"[上下文构建] 使用关键词策略构建上下文")
                    logger.info(f"[上下文构建] 查询类型: {query_type}, 信息源优先级: {[p.name for p in priority_order]}")

                except ImportError:
                    # 如果策略模块不可用，使用默认逻辑
                    logger.warning("[上下文构建] 策略模块不可用，使用默认逻辑")
                    priority_order = None
                    query_type = "regular"

        except Exception as e:
            logger.warning(f"[上下文构建] 优先级构建失败: {e}")
            priority_order = None
            query_type = "regular"

        # 添加当前会话信息
        if session_id:
            context_parts.append("=== 当前会话信息 ===")
            context_parts.append(f"当前会话ID: {session_id}")

            # 添加简化分类结果信息
            if classification_result:
                context_parts.append("智能分类结果:")
                context_parts.append(f"  分类类别: {classification_result.category.value}")
                context_parts.append(f"  存储级别: {classification_result.storage_level.value}")
                context_parts.append(f"  置信度: {classification_result.confidence.value}")
                should_update = classification_result.category.value in ["identity", "preference"]
                context_parts.append(f"  记忆更新建议: {'是' if should_update else '否'}")

                # 显示检测到的关键词
                if classification_result.keywords_detected:
                    context_parts.append("  检测关键词:")
                    for keyword in classification_result.keywords_detected[:3]:  # 最多显示3个
                        context_parts.append(f"    - {keyword}")

            context_parts.append(f"查询类型: {query_type}")

            # 添加优先级信息
            if priority_order:
                context_parts.append(f"信息源优先级: {', '.join([p.name for p in priority_order])}")
            else:
                context_parts.append(f"查询类型: {'用户信息查询' if user_info_query else '常规对话'}")
            context_parts.append("")

        # 按策略优先级构建上下文
        from ...strategies.context_strategy import InfoPriority

        # P0级 - 跨会话身份信息（全局用户记忆）
        if not priority_order or InfoPriority.P0_IDENTITY in priority_order:
            try:
                from ...services.memory import get_global_user_memory
                global_memory = get_global_user_memory()
                user_profile = global_memory.get_user_profile()

                if user_profile.name or user_profile.company or user_profile.department or user_profile.position:
                    context_parts.append("=== P0 - 当前用户身份 (跨会话共享) ===")
                    context_parts.append("这是用户的个人身份信息，在所有会话中保持一致")
                    if user_profile.name:
                        context_parts.append(f"姓名: {user_profile.name}")
                    if user_profile.company:
                        context_parts.append(f"公司: {user_profile.company}")
                    if user_profile.department:
                        context_parts.append(f"部门: {user_profile.department}")
                    if user_profile.position:
                        context_parts.append(f"职位: {user_profile.position}")
                    context_parts.append("")

                # 添加用户偏好信息
                user_prefs = global_memory.get_user_preferences()
                if user_prefs.preferred_formats:
                    context_parts.append("=== 用户偏好设置 (跨会话共享) ===")
                    context_parts.append("这是用户的个人偏好，在所有会话中保持一致")
                    context_parts.append("格式偏好:")
                    for key, value in user_prefs.preferred_formats.items():
                        context_parts.append(f"  - {key}: {value}")
                    context_parts.append("")
            except Exception as e:
                logger.debug(f"获取用户信息失败: {e}")

        # P1级 - 当前会话上下文（短期记忆）
        if not priority_order or InfoPriority.P1_SESSION in priority_order:
            # 获取当前会话相关信息
            short_term_conversations = memory.get("short_term_conversations", [])
            if short_term_conversations:
                context_parts.append("=== P1 - 当前会话上下文 (仅当前会话有效) ===")
                context_parts.append("这是当前会话的上下文信息，只在当前会话中有效")
                context_parts.append("最近对话:")
                for conv in short_term_conversations[-3:]:  # 最近3轮
                    context_parts.append(f"  - {conv.get('user', '')}")
                context_parts.append("")

        # P2级 - 相关历史对话（语义检索）
        if not priority_order or InfoPriority.P2_HISTORY in priority_order:
            relevant_conversations = memory.get("relevant_conversations", [])

            # 根据查询类型过滤历史对话
            if query_type == "user_info":
                # 用户信息查询 - 只保留主动提供信息的对话
                filtered_conversations = []
                for conv in relevant_conversations:
                    content = conv.get("content", "")
                    # 只保留包含"我叫"、"我在"、"我的"等主动提供信息的对话
                    if any(keyword in content for keyword in ["我叫", "我在", "我的", "来自", "公司", "部门"]):
                        # 排除包含错误回答的对话
                        if "陈曦" not in content and "张三" not in content:
                            filtered_conversations.append(conv)
                relevant_conversations = filtered_conversations
                logger.info(f"用户信息查询：过滤后保留 {len(relevant_conversations)} 条相关对话")

            if relevant_conversations:
                context_parts.append("=== P2 - 相关历史对话 (提供参考) ===")
                context_parts.append("这是与当前问题相关的历史对话，提供参考信息")
                for i, conv in enumerate(relevant_conversations[:3]):  # 增加到3条
                    # 获取对话元信息
                    conv_session_id = conv.get("session_id", "unknown")
                    timestamp = conv.get("timestamp", "unknown")
                    content = conv.get("content", "")
                    metadata = conv.get("metadata", {})
                    confidence = metadata.get("confidence", "medium")

                    if content and ("用户:" in content or "助手:" in content):
                        context_parts.append(f"历史对话 {i+1}:")
                        context_parts.append(f"  会话ID: {conv_session_id}")
                        context_parts.append(f"  时间: {timestamp}")
                        context_parts.append(f"  可信度: {confidence}")
                        # 只显示对话内容的前100个字符
                        content_preview = content[:100] + "..." if len(content) > 100 else content
                        context_parts.append(f"  内容: {content_preview}")
                        context_parts.append("")

        # P3级 - 业务文档知识（项目上下文）
        if not priority_order or InfoPriority.P3_BUSINESS in priority_order:
            project_context = memory.get("project_context", {})
            if project_context:
                context_parts.append("=== P3 - 项目业务上下文 (提供专业背景) ===")
                context_parts.append("这是项目相关的业务上下文信息")
                context_parts.append("项目信息:")
                for key, value in project_context.items():
                    if isinstance(value, str) and len(value) > 100:
                        value = value[:100] + "..."
                    context_parts.append(f"  - {key}: {value}")
                context_parts.append("")

        # P4级 - 质量分析与智能建议（新增高价值感知）
        if not priority_order or InfoPriority.P2_HISTORY in priority_order:
            # 质量分析
            quality_analysis = memory.get("quality_analysis", {})
            if quality_analysis:
                context_parts.append("=== P4 - 文档质量分析 ===")
                context_parts.append("基于文档内容的智能质量评估")

                if quality_analysis.get("readabilityScore") is not None:
                    score = quality_analysis["readabilityScore"]
                    context_parts.append(f"可读性评分: {score:.2f} (0-1，越高越好)")

                if quality_analysis.get("logicalFlow") is not None:
                    flow = quality_analysis["logicalFlow"]
                    context_parts.append(f"逻辑流畅度: {flow:.2f} (0-1，越高越好)")

                # 完整性检查
                completeness = quality_analysis.get("completenessCheck", {})
                if completeness.get("missingSections"):
                    context_parts.append(f"缺失章节: {', '.join(completeness['missingSections'])}")
                if completeness.get("suggestedImprovements"):
                    context_parts.append("改进建议:")
                    for improvement in completeness["suggestedImprovements"]:
                        context_parts.append(f"  - {improvement}")

                # 格式问题
                format_issues = quality_analysis.get("formatIssues", [])
                if format_issues:
                    context_parts.append("格式问题:")
                    for issue in format_issues[:3]:  # 最多显示3个
                        severity = issue.get("severity", "low")
                        context_parts.append(f"  - [{severity.upper()}] {issue.get('description', '')}")
                context_parts.append("")

            # 智能建议
            intelligent_suggestions = memory.get("intelligent_suggestions", {})
            if intelligent_suggestions:
                context_parts.append("=== P5 - 智能建议系统 ===")
                context_parts.append("基于文档分析的个性化建议")

                # 内容建议
                content_suggestions = intelligent_suggestions.get("contentSuggestions", [])
                if content_suggestions:
                    context_parts.append("内容建议:")
                    for suggestion in content_suggestions[:3]:  # 最多显示3个
                        priority = suggestion.get("priority", "low")
                        context_parts.append(f"  - [{priority.upper()}] {suggestion.get('suggestion', '')}")

                # 格式推荐
                format_recommendations = intelligent_suggestions.get("formatRecommendations", [])
                if format_recommendations:
                    context_parts.append("格式推荐:")
                    for rec in format_recommendations[:3]:
                        context_parts.append(f"  - {rec}")

                # 效率提示
                productivity_tips = intelligent_suggestions.get("productivityTips", [])
                if productivity_tips:
                    context_parts.append("效率提示:")
                    for tip in productivity_tips[:3]:
                        context_parts.append(f"  - {tip}")
                context_parts.append("")

        return "\n".join(context_parts)


class ConversationManager:
    """对话管理器 - 负责对话记录和记忆存储"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    async def extract_and_store_user_info(self, message: str, session_id: str, classification_result=None):
        """提取并存储用户信息"""
        try:
            from ...services.memory import get_global_user_memory
            global_memory = get_global_user_memory()

            # 基于简化分类结果或直接消息内容提取用户信息
            if classification_result and classification_result.category.value == "identity":
                # 提取身份信息
                if "名字" in message or "姓名" in message:
                    # 提取姓名
                    import re
                    name_match = re.search(r'[我叫我叫]([^\s，。,，！？!?.。、]{2,10})', message)
                    if name_match:
                        global_memory.update_user_profile(name=name_match.group(1))
                        logger.info(f"提取到用户姓名: {name_match.group(1)}")

                elif "公司" in message:
                    # 提取公司信息
                    import re
                    company_match = re.search(r'在([^工作任职]*公司)', message)
                    if company_match:
                        global_memory.update_user_profile(company=company_match.group(1))
                        logger.info(f"提取到用户公司: {company_match.group(1)}")

                elif "部门" in message:
                    # 提取部门信息
                    import re
                    dept_match = re.search(r'在([^部门]*部门)', message)
                    if dept_match:
                        global_memory.update_user_profile(department=dept_match.group(1))
                        logger.info(f"提取到用户部门: {dept_match.group(1)}")

                elif "职位" in message or "职务" in message:
                    # 提取职位信息
                    import re
                    pos_match = re.search(r'担任([^职务]*职务)', message)
                    if pos_match:
                        global_memory.update_user_profile(position=pos_match.group(1))
                        logger.info(f"提取到用户职位: {pos_match.group(1)}")

        except Exception as e:
            logger.warning(f"提取用户信息失败: {e}")

    async def extract_and_store_user_preferences(self, message: str, session_id: str):
        """提取并存储用户偏好"""
        try:
            from ...services.memory import get_global_user_memory
            global_memory = get_global_user_memory()

            # 提取偏好信息
            preferences = {}

            # 文档格式偏好
            if "DOCX" in message.upper() or "word" in message.lower():
                preferences["document_format"] = "DOCX"
            elif "PDF" in message.upper():
                preferences["document_format"] = "PDF"
            elif "TXT" in message.upper():
                preferences["document_format"] = "TXT"

            # 语言偏好
            if "中文" in message:
                preferences["language"] = "zh-CN"
            elif "英文" in message or "English" in message:
                preferences["language"] = "en-US"

            # 分析深度偏好
            if "详细" in message:
                preferences["analysis_depth"] = "detailed"
            elif "简单" in message or "概要" in message:
                preferences["analysis_depth"] = "summary"

            # 保存偏好
            if preferences:
                global_memory.update_user_preferences(preferences)
                logger.info(f"提取到用户偏好: {preferences}")

        except Exception as e:
            logger.warning(f"提取用户偏好失败: {e}")

    async def run_react_loop(self, message: str, context: str):
        """执行ReAct循环"""
        try:
            # 获取相关记忆
            relevant_memory = await self.agent.memory_system.get_comprehensive_context(message)

            # 构建完整上下文
            full_context = context + "\n" + self._build_memory_context(relevant_memory)

            # ReAct循环
            messages = [
                ("system", self.agent.system_prompt),
                ("system", full_context),
                ("user", message)
            ]

            max_iterations = 5
            iteration = 0

            while iteration < max_iterations:
                iteration += 1
                logger.info(f"[ReAct] 执行第 {iteration} 步")

                # 调用LLM
                import asyncio
                response = await asyncio.shield(self.agent.llm.ainvoke(messages))

                # 解析工具调用
                from .tool_execution import ToolExecutor
                tool_executor = ToolExecutor(self.agent)
                tool_call = tool_executor.parse_tool_call(response.content)

                if tool_call:
                    # 执行工具
                    result = await tool_executor.execute_tool(tool_call)

                    # 记录工具调用
                    from .core import ToolCall
                    call = ToolCall(tool_call["action"], tool_call, result)
                    self.agent.tool_calls.append(call)

                    # 添加到消息历史
                    messages.append(("assistant", response.content))
                    messages.append(("user", f"[工具执行结果] {result}"))

                else:
                    # 没有更多工具调用，返回最终响应
                    return response.content

            return f"已执行{len(self.agent.tool_calls)}个工具，但未完成分析。请检查工具调用是否正确。"

        except Exception as e:
            logger.error(f"ReAct循环执行失败: {e}")
            return f"处理请求时发生错误: {str(e)}"

    def _build_memory_context(self, memory: Dict[str, Any]) -> str:
        """构建记忆上下文"""
        context_parts = ["=== 记忆上下文 ==="]

        # 添加相关对话
        conversations = memory.get("relevant_conversations", [])
        if conversations:
            context_parts.append("相关历史对话:")
            for conv in conversations[:2]:  # 只取最近2条
                context_parts.append(f"- {conv.get('content', '')[:100]}...")

        # 添加项目上下文
        project_context = memory.get("project_context", {})
        if project_context:
            context_parts.append("项目信息:")
            for key, value in project_context.items():
                context_parts.append(f"- {key}: {str(value)[:50]}...")

        return "\n".join(context_parts)