"""工具执行模块 - 负责ReAct Agent的工具调用和执行"""

from typing import Dict, List, Any, Optional
import logging
from .core import ToolCall

logger = logging.getLogger(__name__)


class ToolExecutor:
    """工具执行器 - 负责管理工具的调用和执行"""

    def __init__(self, agent_instance):
        self.agent = agent_instance
        self._tool_cache = getattr(agent_instance, '_tool_cache', {})
        self._tool_call_counts = getattr(agent_instance, '_tool_call_counts', {})

    async def execute_tool(self, tool_call: Dict[str, Any]) -> str:
        """执行工具调用 - 增加会话级缓存以避免重复外部调用"""
        tool_name = tool_call["action"]
        tool_input = tool_call.get("input", "")

        # 构造缓存键，尽量规范化输入以便比较
        try:
            import json as _json
            key_input = _json.dumps(tool_input, sort_keys=True, ensure_ascii=False)
        except Exception:
            key_input = str(tool_input)
        cache_key = (tool_name, key_input)

        # increment call counter for observability
        self._tool_call_counts[cache_key] = self._tool_call_counts.get(cache_key, 0) + 1

        # 返回缓存的结果（如果存在）
        if cache_key in self._tool_cache:
            logger.info(f"使用缓存的工具结果: {tool_name} (input fingerprint)")
            return self._tool_cache[cache_key]

        try:
            tool = self.agent.tools.get(tool_name)
            if not tool:
                return f"错误：未找到工具 '{tool_name}'"

            # 执行工具（传递LLM实例给需要的工具）
            if tool_name in [
                "analyze_chapter", "extract_requirements", "extract_responses",
                "match_requirements", "assess_quality", "assess_risks", "answer_question"
            ]:
                # 传递LLM实例进行结构化分析
                if hasattr(tool, 'arun'):
                    result = await tool.arun(tool_input, llm=self.agent.llm)
                else:
                    result = tool.run(tool_input, llm=self.agent.llm)
            else:
                # 其他工具不传递LLM
                if hasattr(tool, 'arun'):
                    result = await tool.arun(tool_input)
                else:
                    result = tool.run(tool_input)

            result_str = str(result)

            # 将结果写入缓存并返回
            try:
                self._tool_cache[cache_key] = result_str
            except Exception:
                logger.debug("无法缓存工具结果（可能不可序列化）")

            return result_str

        except Exception as e:
            logger.error(f"执行工具 {tool_name} 失败: {e}")
            return f"错误：执行工具 '{tool_name}' 失败 - {str(e)}"

    def parse_tool_call(self, llm_response: str) -> Optional[Dict[str, Any]]:
        """解析LLM返回的工具调用"""
        try:
            cleaned = llm_response.strip()
            if cleaned.startswith("{{") and cleaned.endswith("}}"):
                cleaned = cleaned[1:-1].strip()

            # Only parse when the entire response is a JSON object. This prevents
            # mis-detecting `{ ... }` blocks inside JS macro code as tool calls.
            if not cleaned.startswith("{"):
                return None

            import json

            tool_call = json.loads(cleaned)

            # 验证工具调用格式
            if "action" in tool_call and tool_call["action"] in self.agent.tools:
                return tool_call

        except Exception as e:
            logger.debug(f"解析工具调用失败: {e}")
            # 记录到错误日志，便于调试
            logger.error(f"工具调用解析失败，LLM响应: {llm_response[:200]}", exc_info=True)

        return None

    def format_result_for_user(self, tool_name: str, result: Any) -> str:
        """将工具结果转换为用户友好的描述"""
        if not result:
            return ""

        # 根据工具类型进行不同的格式化
        if tool_name == "list_open_documents":
            # 文档列表工具
            if "没有打开的文档" in str(result) or "No documents" in str(result):
                return "目前没有打开的WPS文档。"
            else:
                return "已获取到当前打开的文档列表。"
        elif tool_name in ["read_document"]:
            # 文档读取工具
            if "错误" in str(result) or "Error" in str(result):
                return f"读取文档时遇到问题：{result}"
            else:
                return "已成功读取文档内容。"
        elif tool_name == "analyze_chapter":
            # 章节分析工具
            return "已完成章节分析。"
        elif tool_name == "extract_requirements":
            # 需求提取工具
            return "已提取到相关需求信息。"
        elif tool_name == "extract_responses":
            # 响应提取工具
            return "已提取到相关响应信息。"
        elif tool_name == "match_requirements":
            # 需求匹配工具
            return "已完成需求匹配分析。"
        elif tool_name == "assess_quality":
            # 质量评估工具
            return "已完成质量评估。"
        elif tool_name == "assess_risks":
            # 风险评估工具
            return "已完成风险评估。"
        elif tool_name == "import_documents":
            # 导入工具
            return "已处理文档导入。"
        else:
            # 其他工具，通用格式化
            if len(str(result)) > 100:
                return f"已完成{tool_name}操作。"
            else:
                return str(result)


class StreamProcessor:
    """流式处理器 - 负责流式响应处理"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    async def stream_react_loop(self, message: str, context: str, session_id: str):
        """流式ReAct循环

        Yields:
            dict: 事件流
        """
        max_iterations = 5
        iteration = 0

        messages = [
            ("system", self.agent.system_prompt),
            ("system", context),
            ("user", message)
        ]

        tool_executor = ToolExecutor(self.agent)

        while iteration < max_iterations:
            iteration += 1

            # 发送思考中事件
            yield {"type": "thinking", "content": f"正在分析... (步骤 {iteration})", "session_id": session_id}

            # 重置推理内容跟踪器（每个迭代步骤独立）
            self.agent._last_reasoning_content = None

            # 调用LLM获取思考和行动
            import asyncio
            response = await asyncio.shield(self.agent.llm.ainvoke(messages))

            # 处理DeepSeek思考模式的reasoning_content
            reasoning = None
            if hasattr(response, 'additional_kwargs') and response.additional_kwargs:
                reasoning = response.additional_kwargs.get('reasoning_content')

            if reasoning:
                logger.debug(f"[推理] 步骤 {iteration} - reasoning_content: {reasoning[:200]}...")
                yield {"type": "reasoning", "content": reasoning, "session_id": session_id}
            else:
                logger.debug(f"[推理] 步骤 {iteration} - 未获取到 reasoning_content")

            tool_call = tool_executor.parse_tool_call(response.content)

            if tool_call:
                tool_name = tool_call.get("action", "unknown")
                tool_input = tool_call.get("input", "")

                # 记录工具调用（不发送给用户）
                logger.info(f"=== 工具调用 ===")
                logger.info(f"工具名称: {tool_name}")
                logger.info(f"输入参数: {tool_input}")

                # 执行工具
                result = await tool_executor.execute_tool(tool_call)

                # 记录工具调用
                call = ToolCall(tool_name, tool_call, result)
                self.agent.tool_calls.append(call)

                # 添加到消息历史（用于内部处理）
                messages.append(("assistant", response.content))
                messages.append(("user", f"[内部工具执行结果]"))  # 不包含敏感信息

            else:
                # 没有工具调用，生成最终响应
                if self.agent.tool_calls:
                    # 有工具调用结果，流式生成最终响应
                    async for event in self._stream_final_response(message, messages, session_id):
                        yield event
                else:
                    # 无工具调用，直接流式输出
                    async for event in self._stream_direct_response(message, session_id):
                        yield event
                return

        # 超过最大迭代次数
        yield {"type": "content", "content": f"已执行{len(self.agent.tool_calls)}个工具，分析完成。", "session_id": session_id}

    async def _stream_final_response(self, message: str, messages: List, session_id: str):
        """流式生成最终响应

        Yields:
            dict: content事件
        """
        # 构建分析结果（转换为自然语言描述）
        analysis_result = ""
        tool_executor = ToolExecutor(self.agent)
        
        for call in self.agent.tool_calls:
            if call.result:
                # 转换工具结果为自然语言描述
                result = tool_executor.format_result_for_user(call.tool_name, call.result)
                analysis_result += result + "\n\n"

        # 获取智能建议
        final_info = analysis_result.strip()

        final_messages = [
            ("system", "\n请根据以下信息直接回复用户。不要提及任何执行过程、工具调用或内部操作。\n\n分析结果：\n" + final_info + "\n\n用户问题：" + message + "\n\n要求：\n1. 直接回答问题\n2. 语言自然、简洁\n3. 以专业顾问的口吻\n4. 不要解释你是如何知道的"),
        ]

        # 使用流式响应
        full_response = ""
        try:
            # 兼容性检查：确保 astream 返回异步生成器
            astream_result = self.agent.llm.astream(final_messages)

            import inspect
            if inspect.isasyncgen(astream_result):
                # 标准异步生成器
                async for chunk in astream_result:
                    # 处理DeepSeek思考模式（累积显示）
                    reasoning = None
                    if hasattr(chunk, 'additional_kwargs') and chunk.additional_kwargs:
                        reasoning = chunk.additional_kwargs.get('reasoning_content')

                    if reasoning:
                        # 每次都发送完整的 reasoning_content（前端累积显示）
                        logger.debug(f"[推理] 流式响应 - reasoning_content: {reasoning[:200]}...")
                        yield {"type": "reasoning", "content": reasoning, "session_id": session_id}
                    else:
                        logger.debug(f"[推理] 流式响应 - 未获取到 reasoning_content")

                    # 然后发送最终内容
                    if hasattr(chunk, 'content') and chunk.content:
                        content = chunk.content
                        full_response += content
                        yield {"type": "content", "content": content, "session_id": session_id}
            else:
                # 如果不是异步生成器，直接 await（向后兼容）
                chunk = await astream_result
                if hasattr(chunk, 'content') and chunk.content:
                    full_response = chunk.content
        except Exception as e:
            # 如果流式失败，回退到非流式
            logger.warning(f"流式响应失败，回退到非流式: {e}")
            import asyncio
            response = await asyncio.shield(self.agent.llm.ainvoke(final_messages))

            # 处理非流式响应的reasoning_content
            reasoning = None
            if hasattr(response, 'additional_kwargs') and response.additional_kwargs:
                reasoning = response.additional_kwargs.get('reasoning_content')

            if reasoning:
                logger.debug(f"[推理] 非流式响应 - reasoning_content: {reasoning[:200]}...")
                yield {"type": "reasoning", "content": reasoning, "session_id": session_id}
            else:
                logger.debug(f"[推理] 非流式响应 - 未获取到 reasoning_content")

            full_response = response.content
            yield {"type": "content", "content": full_response, "session_id": session_id}

        # 保存最终响应
        self.agent._last_response = full_response

    async def _stream_direct_response(self, message: str, session_id: str):
        """流式直接响应（无工具调用时）

        Yields:
            dict: content事件
        """
        messages = [
            ("system", self.agent.system_prompt),
            ("user", message)
        ]

        full_response = ""
        try:
            # 兼容性检查：确保 astream 返回异步生成器
            astream_result = self.agent.llm.astream(messages)

            import inspect
            if inspect.isasyncgen(astream_result):
                # 标准异步生成器
                async for chunk in astream_result:
                    # 处理DeepSeek思考模式（增量发送）
                    reasoning = None
                    if hasattr(chunk, 'additional_kwargs') and chunk.additional_kwargs:
                        reasoning = chunk.additional_kwargs.get('reasoning_content')

                    if reasoning:
                        # 每次都发送完整的 reasoning_content（前端累积显示）
                        logger.debug(f"[推理] 直接流式响应 - reasoning_content: {reasoning[:200]}...")
                        yield {"type": "reasoning", "content": reasoning, "session_id": session_id}
                    else:
                        logger.debug(f"[推理] 直接流式响应 - 未获取到 reasoning_content")

                    # 然后发送最终内容
                    if hasattr(chunk, 'content') and chunk.content:
                        content = chunk.content
                        full_response += content
                        yield {"type": "content", "content": content, "session_id": session_id}
            else:
                # 如果不是异步生成器，直接 await（向后兼容）
                chunk = await astream_result
                if hasattr(chunk, 'content') and chunk.content:
                    full_response = chunk.content
        except Exception as e:
            logger.warning(f"流式响应失败，回退到非流式: {e}")
            import asyncio
            response = await asyncio.shield(self.agent.llm.ainvoke(messages))

            # 处理非流式响应的reasoning_content
            reasoning = None
            if hasattr(response, 'additional_kwargs') and response.additional_kwargs:
                reasoning = response.additional_kwargs.get('reasoning_content')

            if reasoning:
                logger.debug(f"[推理] 直接非流式响应 - reasoning_content: {reasoning[:200]}...")
                yield {"type": "reasoning", "content": reasoning, "session_id": session_id}
            else:
                logger.debug(f"[推理] 直接非流式响应 - 未获取到 reasoning_content")

            full_response = response.content
            yield {"type": "content", "content": full_response, "session_id": session_id}

        self.agent._last_response = full_response
