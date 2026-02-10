"""
阿蛤（AH32）文档记忆管理工具
这个模块包含记忆系统相关的工具
"""

import time
from typing import Any, Dict, List, Optional

from ...core.prompts import get_image_analysis_prompt
from ...core.tools import register_tool, ToolCategory
from .base_agent_tools import BaseTool
from .base_agent_tools import logger


@register_tool(ToolCategory.ANALYSIS, tags=["记忆", "基准", "状态"], priority=10)
class DocumentMemoryTool(BaseTool):
    """文档记忆管理工具 - 基于现有MemorySystem扩展"""

    name: str = "document_memory"
    description: str = "管理文档业务的专用记忆，包括基准建立、状态跟踪等"
    category: str = "记忆"
    memory_key_prefix: str = "document_business"

    def _run(self, query: str, memory_system=None, llm=None) -> str:
        """记忆管理主逻辑"""
        if not memory_system:
            return "需要提供记忆系统实例"

        query_lower = query.lower()

        if "建立基准" in query or "establish baseline" in query_lower:
            return self._establish_baseline(query, memory_system, llm)
        elif "查询状态" in query or "check status" in query_lower:
            return self._check_status(query, memory_system)
        elif "记录修改" in query or "record modification" in query_lower:
            return self._record_modification(query, memory_system, llm)
        elif "符合性检查" in query or "compliance check" in query_lower:
            return self._compliance_check(query, memory_system, llm)
        else:
            return "支持的记忆操作：建立基准、查询状态、记录修改、符合性检查"

    async def _arun(self, query: str, memory_system=None, llm=None) -> str:
        return self._run(query, memory_system, llm)

    def _establish_baseline(self, query: str, memory_system, llm) -> str:
        """建立参考文档基准"""
        try:
            # 提取基准内容
            baseline_content = ""
            if llm and "content:" in query:
                content_part = query.split("content:", 1)[1].strip()
                baseline_content = content_part
            elif "分析:" in query:
                content_part = query.split("分析:", 1)[1].strip()
                baseline_content = content_part

            if not baseline_content:
                return "请提供基准内容，格式：建立基准 内容: [基准分析内容]"

            # 使用LLM优化基准内容
            if llm:
                optimization_prompt = f"""
优化这个参考文档基准分析，确保结构化和可检索：

原始基准：
{baseline_content}

请提取并结构化为：
1. 文档基本信息
2. 核心内容要点
3. 关键数据指标
4. 格式规范要求
5. 注意事项

返回优化后的基准内容。
                """
                try:
                    optimized_baseline = llm.invoke([("human", optimization_prompt)]).content
                    baseline_content = optimized_baseline
                except Exception as e:
                    logger.warning(f"LLM优化基准失败: {e}")

            # 存储到记忆系统
            memory_system.store_conversation(
                session_id="reference_baseline",
                user_message="建立参考文档基准",
                assistant_response=baseline_content,
                metadata={
                    "type": "reference_baseline",
                    "key": f"{self.memory_key_prefix}_baseline",
                    "timestamp": str(int(time.time()))
                }
            )

            return f"✅ 参考文档基准建立完成\n\n{baseline_content}"

        except Exception as e:
            logger.error(f"建立基准失败: {e}")
            return f"❌ 建立基准失败: {str(e)}"

    def _check_status(self, query: str, memory_system) -> str:
        """查询当前状态"""
        try:
            # 查询基准状态
            baseline_data = memory_system.search_memory(
                query="文档基准",
                memory_type="global_memory"
            )

            # 查询修改历史
            modification_data = memory_system.search_memory(
                query="修改记录",
                memory_type="session_memory"
            )

            status_info = "📊 文档记忆状态\n\n"

            if baseline_data:
                status_info += "✅ 文档基准：已建立\n"
                status_info += f"   内容长度：{len(str(baseline_data[0])) if isinstance(baseline_data, list) else len(str(baseline_data))} 字符\n"
            else:
                status_info += "❌ 文档基准：未建立\n"

            if modification_data:
                status_info += f"📝 修改记录：{len(modification_data)} 条\n"
            else:
                status_info += "📝 修改记录：无\n"

            status_info += "\n💡 建议：先建立参考文档基准，再进行目标文档优化"

            return status_info

        except Exception as e:
            logger.error(f"查询状态失败: {e}")
            return f"❌ 查询状态失败: {str(e)}"

    def _record_modification(self, query: str, memory_system, llm) -> str:
        """记录修改"""
        try:
            if "内容:" not in query:
                return "请提供修改内容，格式：记录修改 内容: [修改内容]"

            content_part = query.split("内容:", 1)[1].strip()

            # 记录修改
            memory_system.store_conversation(
                session_id="modification_history",
                user_message="记录文档修改",
                assistant_response=content_part,
                metadata={
                    "type": "document_modification",
                    "key": f"{self.memory_key_prefix}_modification",
                    "timestamp": str(int(time.time()))
                }
            )

            return f"✅ 修改记录已保存\n\n{content_part}"

        except Exception as e:
            logger.error(f"记录修改失败: {e}")
            return f"❌ 记录修改失败: {str(e)}"

    def _compliance_check(self, query: str, memory_system, llm) -> str:
        """符合性检查"""
        try:
            # 获取基准
            baseline_data = memory_system.search_memory(
                query="文档基准",
                memory_type="global_memory"
            )

            if not baseline_data:
                return "❌ 请先建立参考文档基准"

            baseline_content = str(baseline_data[0]) if isinstance(baseline_data, list) else str(baseline_data)

            # 如果提供了目标内容，进行对比分析
            if llm and "目标内容:" in query:
                target_content = query.split("目标内容:", 1)[1].strip()

                compliance_prompt = f"""
【参考文档基准】
{baseline_content}

【目标文档内容】
{target_content}

请进行符合性检查，分析：
1. ✅ 已满足的要求
2. ❌ 缺失或不符合的地方
3. 🔧 需要修改的地方
4. 📈 优化建议

请用自然语言详细回答。
                """

                try:
                    compliance_result = llm.invoke([("human", compliance_prompt)]).content

                    # 存储检查结果
                    memory_system.store_conversation(
                        session_id="compliance_check",
                        user_message="文档符合性检查",
                        assistant_response=compliance_result,
                        metadata={
                            "type": "compliance_check",
                            "key": f"{self.memory_key_prefix}_compliance",
                            "timestamp": str(int(time.time()))
                        }
                    )

                    return f"📊 符合性检查完成\n\n{compliance_result}"
                except Exception as e:
                    logger.warning(f"LLM符合性检查失败: {e}")

            return f"📊 基准检查完成\n参考文档基准已建立，可用于后续符合性分析"

        except Exception as e:
            logger.error(f"符合性检查失败: {e}")
            return f"❌ 符合性检查失败: {str(e)}"
