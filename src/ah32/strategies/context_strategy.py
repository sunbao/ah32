"""
上下文构建策略 - 明确何时使用哪种信息源

这个模块定义了信息分类和优先级的策略，确保LLM获得最合适的信息。
"""

from enum import Enum
from typing import Dict, Any, List, Optional


class InfoPriority(Enum):
    """信息优先级"""
    P0_IDENTITY = "P0 - 跨会话身份信息"  # 全局用户记忆
    P0_AT_REFERENCE = "P0 - @引用文档处理"  # @引用文档处理
    P1_SESSION = "P1 - 当前会话上下文"    # 短期记忆
    P2_HISTORY = "P2 - 相关历史对话"     # 语义检索
    P3_TOOLS = "P3 - 工具执行历史"       # tool_calls
    # 上下文构建专用优先级
    DOCUMENT_RELEVANT = "文档相关内容"
    USER_PREFERENCES = "用户偏好信息"
    GLOBAL_MEMORY = "全局记忆信息"
    EMPTY = "空上下文"


class ContextStrategy:
    """上下文构建策略类"""

    def __init__(self):
        self.info_sources = {
            InfoPriority.P0_IDENTITY: {
                "name": "全局用户记忆",
                "storage": "services.memory.get_global_user_memory()",
                "update_frequency": "on_user_info_change",
                "cross_session": True,
                "example": "用户姓名、公司、部门、偏好"
            },
            InfoPriority.P1_SESSION: {
                "name": "短期会话记忆",
                "storage": "memory.short_term",
                "update_frequency": "every_interaction",
                "cross_session": False,
                "example": "当前任务进度、最近对话"
            },
            InfoPriority.P2_HISTORY: {
                "name": "语义检索记忆",
                "storage": "memory.semantic.search_conversations()",
                "update_frequency": "on_query",
                "cross_session": True,
                "example": "历史对话、相似问题"
            },
            InfoPriority.P3_TOOLS: {
                "name": "工具执行历史",
                "storage": "self.tool_calls",
                "update_frequency": "on_tool_call",
                "cross_session": False,
                "example": "已执行工具、结果摘要"
            }
        }

    def get_info_source_for_query(self, query: str, query_type: str) -> List[InfoPriority]:
        """根据查询类型返回应该使用的信息源优先级

        Args:
            query: 用户查询内容
            query_type: 查询类型 ("user_info", "regular", "analysis")

        Returns:
            按优先级排序的信息源列表
        """
        if query_type == "user_info":
            # 用户信息查询 - 优先使用跨会话身份信息
            return [
                InfoPriority.P0_IDENTITY,  # 全局用户记忆
                InfoPriority.P2_HISTORY,   # 历史对话中的用户信息
                InfoPriority.P3_TOOLS      # 工具执行历史
            ]
        elif query_type == "analysis":
            # 文档分析 - 优先使用会话上下文
            return [
                InfoPriority.P1_SESSION,   # 当前会话上下文
                InfoPriority.P2_HISTORY,   # 历史分析经验
                InfoPriority.P0_IDENTITY,  # 用户偏好
                InfoPriority.P3_TOOLS      # 工具使用历史
            ]
        else:
            # 常规对话 - 平衡使用各种信息源
            return [
                InfoPriority.P0_IDENTITY,  # 用户身份
                InfoPriority.P2_HISTORY,   # 相关历史
                InfoPriority.P1_SESSION,   # 会话上下文
                InfoPriority.P3_TOOLS      # 工具历史
            ]

    def should_update_global_memory(self, message: str) -> Dict[str, Any]:
        """判断消息是否包含需要更新全局用户记忆的信息（通用办公场景）

        Returns:
            {
                "should_update": bool,
                "update_type": "identity|preference|qualification|none",
                "confidence": "high|medium|low"
            }
        """
        # 身份信息关键词
        identity_keywords = [
            "我叫",
            "我是",
            "我的名字",
            "姓名",
            "公司",
            "部门",
            "职位",
            # 常见关系方/角色（不局限招投标）
            "甲方",
            "乙方",
            "客户",
            "供应商",
            "招标方",
            "投标方",
            "代理机构",
        ]
        # 偏好信息关键词
        preference_keywords = ["希望", "喜欢", "偏好", "使用", "采用", "设置", "字体", "风格"]
        # 公司资质关键词
        qualification_keywords = ["我们公司有", "具有", "资质", "营业执照", "注册资金", "主营业务", "专业领域"]

        if any(kw in message for kw in identity_keywords):
            return {
                "should_update": True,
                "update_type": "identity",
                "confidence": "high"
            }
        elif any(kw in message for kw in qualification_keywords):
            return {
                "should_update": True,
                "update_type": "qualification",
                "confidence": "high"
            }
        elif any(kw in message for kw in preference_keywords):
            return {
                "should_update": True,
                "update_type": "preference",
                "confidence": "medium"
            }
        else:
            return {
                "should_update": False,
                "update_type": "none",
                "confidence": "low"
            }

    def should_update_cross_session_memory(self, message: str) -> Dict[str, Any]:
        """判断消息是否包含需要更新跨会话记忆的信息（通用办公场景）

        Returns:
            {
                "should_update": bool,
                "update_type": "project|technical|commercial|evaluation|timeline|document|none",
                "confidence": "high|medium|low"
            }
        """
        # 项目关联关键词
        project_keywords = ["这个项目", "项目名称", "项目编号", "项目预算", "项目工期", "属于X项目"]
        # 技术要求关键词
        technical_keywords = ["技术要求", "技术规格", "技术参数", "技术标准", "验收标准", "功能要求"]
        # 商务条件关键词
        commercial_keywords = ["报价要求", "价格要求", "资质要求", "业绩要求", "付款方式", "质保要求"]
        # 评标标准关键词
        evaluation_keywords = ["评标方法", "评分标准", "技术分权重", "商务分权重", "综合评分法"]
        # 时间节点关键词
        timeline_keywords = [
            "报名时间",
            "报名截止",
            "投标截止",
            "开标时间",
            "评标时间",
            "定标时间",
            "截止日期",
            "截止时间",
            "里程碑",
            "上线时间",
            "交付时间",
        ]
        # 文档相关关键词
        document_keywords = [
            "招标文件",
            "投标文件",
            "澄清答疑",
            "修改通知",
            "补充文件",
            "中标通知书",
            "合同",
            "协议",
            "方案",
            "报告",
            "会议纪要",
            "制度",
            "台账",
        ]

        if any(kw in message for kw in project_keywords):
            return {
                "should_update": True,
                "update_type": "project",
                "confidence": "high"
            }
        elif any(kw in message for kw in technical_keywords):
            return {
                "should_update": True,
                "update_type": "technical",
                "confidence": "high"
            }
        elif any(kw in message for kw in commercial_keywords):
            return {
                "should_update": True,
                "update_type": "commercial",
                "confidence": "high"
            }
        elif any(kw in message for kw in evaluation_keywords):
            return {
                "should_update": True,
                "update_type": "evaluation",
                "confidence": "high"
            }
        elif any(kw in message for kw in timeline_keywords):
            return {
                "should_update": True,
                "update_type": "timeline",
                "confidence": "high"
            }
        elif any(kw in message for kw in document_keywords):
            return {
                "should_update": True,
                "update_type": "document",
                "confidence": "high"
            }
        else:
            return {
                "should_update": False,
                "update_type": "none",
                "confidence": "low"
            }

    def get_context_template(self, priority_order: List[InfoPriority]) -> str:
        """获取上下文构建模板

        Args:
            priority_order: 按优先级排序的信息源列表

        Returns:
            格式化的上下文模板
        """
        template_parts = []

        for priority in priority_order:
            source_info = self.info_sources[priority]

            if priority == InfoPriority.P0_IDENTITY:
                template_parts.append("=== 当前用户身份 (跨会话共享) ===")
                template_parts.append("这是用户的个人身份信息，在所有会话中保持一致")
                template_parts.append("格式: 姓名: 值, 公司: 值, 部门: 值, 职位: 值")
                template_parts.append("")

            elif priority == InfoPriority.P1_SESSION:
                template_parts.append("=== 当前会话上下文 ===")
                template_parts.append("这是当前会话的上下文信息，只在当前会话中有效")
                template_parts.append("格式: 任务: 值, 进度: 值, 文档: 值")
                template_parts.append("")

            elif priority == InfoPriority.P2_HISTORY:
                template_parts.append("=== 相关历史对话 ===")
                template_parts.append("这是与当前问题相关的历史对话，提供参考信息")
                template_parts.append("格式: 会话ID: 值, 时间: 值, 内容: 值")
                template_parts.append("")

            elif priority == InfoPriority.P3_TOOLS:
                template_parts.append("=== 已执行的工具 ===")
                template_parts.append("这是最近执行的工具及其结果摘要")
                template_parts.append("格式: 工具: 值, 参数: 值, 结果: 值")
                template_parts.append("")

        return "\n".join(template_parts)


# 全局策略实例
context_strategy = ContextStrategy()


def get_query_type(message: str) -> str:
    """根据消息内容判断查询类型（通用办公场景）"""
    user_info_keywords = ["我是谁", "我的名字", "我叫", "记住", "身份",
                         "我们公司", "资质", "甲方", "乙方", "客户", "供应商", "招标方", "投标方"]
    analysis_keywords = ["分析", "评估", "检查", "对比", "匹配", "合同", "条款", "招标文件", "技术条款"]
    project_keywords = ["这个项目", "项目编号", "项目预算", "项目工期", "里程碑", "技术要求", "评标方法"]

    if any(kw in message for kw in user_info_keywords):
        return "user_info"
    elif any(kw in message for kw in project_keywords):
        return "project"
    elif any(kw in message for kw in analysis_keywords):
        return "analysis"
    else:
        return "regular"
