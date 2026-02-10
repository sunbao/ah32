"""
简化记忆分类系统 - 基于关键词匹配的记忆管理

替代复杂的LLM分类，用简单高效的关键词匹配实现三层记忆架构
"""

import logging
from typing import Dict, Any
from enum import Enum

logger = logging.getLogger(__name__)


class StorageLevel(Enum):
    """存储层级"""
    P0_GLOBAL = "P0_全局记忆"
    P1_SESSION = "P1_会话记忆"
    P2_CROSS_SESSION = "P2_跨会话记忆"


class ConfidenceLevel(Enum):
    """置信度等级"""
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ClassificationCategory(Enum):
    """分类类别"""
    IDENTITY = "identity"
    QUALIFICATION = "qualification"
    PREFERENCE = "preference"
    PROJECT = "project"
    TECHNICAL = "technical"
    COMMERCIAL = "commercial"
    EVALUATION = "evaluation"
    TIMELINE = "timeline"
    DOCUMENT = "document"
    REGULAR = "regular"


class MemoryClassificationResult:
    """记忆分类结果（通用办公场景）"""

    def __init__(self, data: Dict[str, Any]):
        self.storage_level = StorageLevel(data.get("storage_level", "P1_会话记忆"))
        self.confidence = ConfidenceLevel(data.get("confidence", "medium"))
        self.reasoning = data.get("reasoning", "")
        self.keywords_detected = data.get("keywords_detected", [])
        self.category = ClassificationCategory(data.get("category", "regular"))
        self.should_promote = data.get("should_promote", False)
        self.promote_reason = data.get("promote_reason", "")

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "storage_level": self.storage_level.value,
            "confidence": self.confidence.value,
            "reasoning": self.reasoning,
            "keywords_detected": self.keywords_detected,
            "category": self.category.value,
            "should_promote": self.should_promote,
            "promote_reason": self.promote_reason
        }

    def __str__(self) -> str:
        import json
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)


# Backward-compatible alias (older code may still import this name).
BiddingClassificationResult = MemoryClassificationResult


class SimpleClassificationStrategy:
    """简化的记忆分类策略 - 基于关键词匹配"""

    # P0 全局记忆关键词
    IDENTITY_KEYWORDS = [
        "我叫", "我是", "我的名字", "姓名", "公司", "部门", "职位",
        "我在", "我在X公司", "我是X职位", "联系人", "电话", "邮箱"
    ]

    QUALIFICATION_KEYWORDS = [
        "我们公司有", "具有X资质", "营业执照", "资质证书",
        "我们公司成立于", "主营业务是", "专业领域是",
        "注册资金", "企业规模", "资质", "认证"
    ]

    PREFERENCE_KEYWORDS = [
        "我喜欢", "我希望", "我偏好", "我习惯用", "我通常采用",
        "我的风格是", "我倾向于", "写作风格", "文档格式",
        "字体", "格式", "偏好", "喜欢", "希望", "使用"
    ]

    # P2 跨会话记忆关键词
    PROJECT_KEYWORDS = [
        "这个项目", "项目名称", "项目编号", "项目ID",
        "项目预算", "项目金额", "项目投资", "项目工期", "交付时间",
        "属于X项目", "与X项目相关", "项目", "工期", "预算"
    ]

    TECHNICAL_KEYWORDS = [
        "技术要求", "技术规格", "技术参数", "性能指标",
        "技术标准", "验收标准", "功能要求", "配置要求",
        "技术方案", "技术路线", "技术栈"
    ]

    COMMERCIAL_KEYWORDS = [
        "报价要求", "价格要求", "资质要求", "准入条件",
        "业绩要求", "项目经验", "付款方式", "结算条件",
        "质保要求", "售后服务"
    ]

    EVALUATION_KEYWORDS = [
        "评标方法", "评分标准", "技术分权重", "商务分权重",
        "最低价中标", "综合评分法", "评标委员会", "评标程序",
        "评标", "评分", "打分", "权重"
    ]

    TIMELINE_KEYWORDS = [
        "报名时间", "报名截止", "投标截止时间", "递交截止",
        "开标时间", "开标日期", "评标时间", "定标时间",
        "截止", "时间", "日期"
    ]

    DOCUMENT_KEYWORDS = [
        "合同", "合同文本", "协议", "报价单", "方案", "报告", "简历",
        "纪要", "邮件", "通知", "公文", "文档", "文件"
    ]

    @staticmethod
    def classify_message(message: str) -> BiddingClassificationResult:
        """基于关键词匹配分类消息"""
        logger.debug(f"开始分类消息: {message[:50]}...")

        # P0 全局记忆检查
        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.IDENTITY_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P0_全局记忆",
                "confidence": "high",
                "reasoning": "包含身份关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.IDENTITY_KEYWORDS),
                "category": "identity",
                "should_promote": True,
                "promote_reason": "包含用户身份信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.QUALIFICATION_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P0_全局记忆",
                "confidence": "high",
                "reasoning": "包含公司资质关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.QUALIFICATION_KEYWORDS),
                "category": "qualification",
                "should_promote": True,
                "promote_reason": "包含公司资质信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.PREFERENCE_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P0_全局记忆",
                "confidence": "high",
                "reasoning": "包含偏好设置关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.PREFERENCE_KEYWORDS),
                "category": "preference",
                "should_promote": True,
                "promote_reason": "包含用户偏好设置"
            })

        # P2 跨会话记忆检查
        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.PROJECT_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含项目关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.PROJECT_KEYWORDS),
                "category": "project",
                "should_promote": True,
                "promote_reason": "包含项目信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.TECHNICAL_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含技术要求关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.TECHNICAL_KEYWORDS),
                "category": "technical",
                "should_promote": True,
                "promote_reason": "包含技术规格信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.COMMERCIAL_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含商务条件关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.COMMERCIAL_KEYWORDS),
                "category": "commercial",
                "should_promote": True,
                "promote_reason": "包含商务条件信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.EVALUATION_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含评标标准关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.EVALUATION_KEYWORDS),
                "category": "evaluation",
                "should_promote": True,
                "promote_reason": "包含评标标准信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.TIMELINE_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含时间节点关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.TIMELINE_KEYWORDS),
                "category": "timeline",
                "should_promote": True,
                "promote_reason": "包含时间节点信息"
            })

        if SimpleClassificationStrategy._check_keywords(message, SimpleClassificationStrategy.DOCUMENT_KEYWORDS):
            return BiddingClassificationResult({
                "storage_level": "P2_跨会话记忆",
                "confidence": "high",
                "reasoning": "包含文档关键词",
                "keywords_detected": SimpleClassificationStrategy._get_matched_keywords(message, SimpleClassificationStrategy.DOCUMENT_KEYWORDS),
                "category": "document",
                "should_promote": True,
                "promote_reason": "包含文档信息"
            })

        # 默认归类为P1会话记忆
        return BiddingClassificationResult({
            "storage_level": "P1_会话记忆",
            "confidence": "medium",
            "reasoning": "默认归类为会话记忆",
            "keywords_detected": [],
            "category": "regular",
            "should_promote": False,
            "promote_reason": "常规对话内容"
        })

    @staticmethod
    def _check_keywords(message: str, keywords: list) -> bool:
        """检查消息是否包含关键词"""
        return any(keyword in message for keyword in keywords)

    @staticmethod
    def _get_matched_keywords(message: str, keywords: list) -> list:
        """获取匹配到的关键词"""
        return [keyword for keyword in keywords if keyword in message]


# 全局简分类策略实例
simple_strategy = SimpleClassificationStrategy()


def create_classification_strategy() -> SimpleClassificationStrategy:
    """创建简化的记忆分类策略"""
    return SimpleClassificationStrategy()


def classify_conversation(message: str) -> BiddingClassificationResult:
    """简化版对话分类"""
    return SimpleClassificationStrategy.classify_message(message)


def get_storage_level(result: BiddingClassificationResult) -> str:
    """获取存储层级"""
    return result.storage_level.value


def should_update_global_memory(result: BiddingClassificationResult) -> bool:
    """判断是否应该更新全局记忆"""
    return result.should_promote and result.storage_level == StorageLevel.P0_GLOBAL


def should_update_cross_session_memory(result: BiddingClassificationResult) -> bool:
    """判断是否应该更新跨会话记忆"""
    return result.should_promote and result.storage_level == StorageLevel.P2_CROSS_SESSION
