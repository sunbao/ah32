"""API集成模块 - 负责整合所有外部API功能"""

from typing import Dict, Any, Optional, List
import logging

logger = logging.getLogger(__name__)


class MemoryManager:
    """记忆管理器 - 来自memory_api.py"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def store_project_context(self, query: str = "") -> str:
        """存储项目上下文

        功能说明：
        - 存储当前项目的上下文信息

        使用场景：
        - 用户说："保存当前项目信息"
        - 用户说："记录项目背景"
        """
        try:
            result = self.agent.global_memory.store_project_context(query)
            return f"项目上下文存储：\n{result}"
        except Exception as e:
            logger.error(f"存储项目上下文失败: {e}")
            return f"存储失败：{str(e)}"

    def get_user_preferences(self, query: str = "") -> str:
        """获取用户偏好

        功能说明：
        - 获取用户偏好设置（如字体偏好等）

        使用场景：
        - 用户说："我的偏好是什么"
        - 用户说："记住我的偏好了吗"
        - 用户说："查看我的偏好设置"
        """
        try:
            result = self.agent.global_memory.get_user_preferences()
            return f"用户偏好：\n{result}"
        except Exception as e:
            logger.error(f"获取用户偏好失败: {e}")
            return f"获取偏好失败：{str(e)}"

    def store_conversation_history(self, query: str = "") -> str:
        """存储对话历史

        功能说明：
        - 存储对话到历史记录

        使用场景：
        - 系统内部调用
        - 用户说："保存这次对话"
        """
        try:
            result = self.agent.global_memory.store_conversation_history(query)
            return f"对话历史存储：\n{result}"
        except Exception as e:
            logger.error(f"存储对话历史失败: {e}")
            return f"存储失败：{str(e)}"

    def manage_section_relationship(self, query: str = "") -> str:
        """管理章节关系

        功能说明：
        - 管理文档章节之间的关系

        使用场景：
        - 用户说："建立章节关联"
        - 用户说："管理章节关系"
        """
        try:
            result = self.agent.global_memory.manage_section_relationship(query)
            return f"章节关系管理：\n{result}"
        except Exception as e:
            logger.error(f"管理章节关系失败: {e}")
            return f"管理失败：{str(e)}"


class RiskAssessor:
    """风险评估器 - 来自risk_api.py"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def assess_bidding_risks(self, query: str = "") -> str:
        """评估投标风险

        功能说明：
        - 全面评估投标文档风险
        - 识别废标风险和失分风险

        使用场景：
        - 用户说："评估投标风险"
        - 用户说："检查废标风险"
        - 用户说："有什么风险需要关注"
        """
        try:
            result = self.agent.risk_assessor.assess_risks()
            return f"风险评估结果：\n{result}"
        except Exception as e:
            logger.error(f"风险评估失败: {e}")
            return f"风险评估失败：{str(e)}"

    def check_compliance_risks(self, query: str = "") -> str:
        """检查合规风险

        功能说明：
        - 检查合规性风险

        使用场景：
        - 用户说："检查合规风险"
        - 用户说："合规性评估"
        """
        try:
            result = self.agent.risk_assessor.check_compliance()
            return f"合规风险检查：\n{result}"
        except Exception as e:
            logger.error(f"合规风险检查失败: {e}")
            return f"合规检查失败：{str(e)}"

    def get_risk_recommendations(self, query: str = "") -> str:
        """获取风险建议

        功能说明：
        - 获取风险缓解建议

        使用场景：
        - 用户说："风险建议"
        - 用户说："如何降低风险"
        """
        try:
            result = self.agent.risk_assessor.get_recommendations()
            return f"风险建议：\n{result}"
        except Exception as e:
            logger.error(f"获取风险建议失败: {e}")
            return f"获取建议失败：{str(e)}"


class SemanticMatcher:
    """语义匹配器 - 来自semantic_match_api.py"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def match_requirements(self, query: str = "") -> str:
        """匹配招标要求

        功能说明：
        - 语义匹配招标要求和投标响应

        使用场景：
        - 用户说："匹配招标要求"
        - 用户说："检查要求对应"
        - 用户说："看看响应是否满足要求"
        """
        try:
            result = self.agent.semantic_matcher.match_requirements()
            return f"要求匹配结果：\n{result}"
        except Exception as e:
            logger.error(f"要求匹配失败: {e}")
            return f"匹配失败：{str(e)}"

    def semantic_search(self, query: str) -> str:
        """语义搜索

        功能说明：
        - 语义搜索相关内容

        使用场景：
        - 用户说："搜索相关内容"
        - 用户说："找到相似内容"
        """
        try:
            result = self.agent.semantic_matcher.semantic_search(query)
            return f"语义搜索结果：\n{result}"
        except Exception as e:
            logger.error(f"语义搜索失败: {e}")
            return f"搜索失败：{str(e)}"

    def extract_semantic_entities(self, query: str = "") -> str:
        """提取语义实体

        功能说明：
        - 提取文档中的关键实体

        使用场景：
        - 用户说："提取关键实体"
        - 用户说："分析实体关系"
        """
        try:
            result = self.agent.semantic_matcher.extract_entities()
            return f"语义实体提取：\n{result}"
        except Exception as e:
            logger.error(f"提取语义实体失败: {e}")
            return f"提取失败：{str(e)}"


class ExportManager:
    """导出管理器 - 来自export_api.py"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def export_analysis(self, query: str = "") -> str:
        """导出分析结果

        功能说明：
        - 导出分析结果到文件

        使用场景：
        - 用户说："导出分析结果"
        - 用户说："保存报告"
        """
        try:
            result = self.agent.dual_doc_associator.export_analysis()
            return f"导出完成：\n{result}"
        except Exception as e:
            logger.error(f"导出失败: {e}")
            return f"导出失败：{str(e)}"


class AnalysisReport:
    """分析报告生成器"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def generate_comprehensive_report(self, query: str = "") -> str:
        """生成综合分析报告

        功能说明：
        - 生成完整的双文档分析报告

        使用场景：
        - 用户说："生成分析报告"
        - 用户说："输出报告"
        """
        try:
            result = self.agent.dual_doc_associator.generate_report()
            return f"分析报告：\n{result}"
        except Exception as e:
            logger.error(f"生成报告失败: {e}")
            return f"报告生成失败：{str(e)}"


# 便捷函数
async def react_chat(llm, tools: List[Any], memory_system,
                     message: str, session_id: Optional[str] = None) -> Dict[str, Any]:
    """便捷的ReAct聊天函数（流式收集结果）"""
    from .core import ReActAgent
    # Vector store is optional; API integration can pass it when available.
    agent = ReActAgent(llm, tools, memory_system)

    # 收集流式结果
    result_text = ""
    tool_calls = []
    async for event in agent.stream_chat(message, session_id):
        if event["type"] == "content":
            result_text += event["content"]
        elif event["type"] == "done":
            tool_calls = event.get("tool_calls", [])

    return {
        "status": "success",
        "response": result_text,
        "tool_calls": tool_calls
    }
