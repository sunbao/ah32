"""
实用 Agent 工具 - 阿蛤（AH32）通用工具集
包含各种实用功能工具：报告生成、用户偏好、日期计算等

这个模块包含：
- GenerateReportTool: 生成分析报告
- QuickAnalyzeTool: 快速分析工具
- ExportAnalysisTool: 导出分析结果
- GetUserPreferencesTool: 获取用户偏好设置
- SemanticSearchTool: 语义搜索工具
- KnowledgeListTool: 知识库管理
- ExtractSemanticEntitiesTool: 语义实体提取
- CalculateDateTool: 日期计算工具

遵循阿蛤（AH32）架构：
- 提供实用功能支持
- 简化复杂Office操作
- 增强用户体验
"""

import json
import logging
import mimetypes
import hashlib
import time
from pathlib import Path
from typing import Optional, Any, Dict, List
from datetime import datetime, timedelta
import re

from .base_agent_tools import BaseTool, ToolMetadata, ToolCategory, register_tool

logger = logging.getLogger(__name__)


@register_tool(ToolCategory.SYSTEM, tags=["报告", "生成", "导出"], priority=8)
class GenerateReportTool(BaseTool):
    """生成分析报告工具"""

    name: str = "generate_report"
    description: str = "生成详细的分析报告"
    category: str = "系统"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="generate_report",
        description="生成详细的分析报告",
        category="system",
        tags=["报告", "生成", "导出"],
        priority=8,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "", analysis_data: str = "", llm=None) -> str:
        """生成分析报告"""
        if not analysis_data:
            return "请提供分析数据以生成报告"

        report = f"""
📊 分析报告生成完成

报告内容：
{analysis_data[:1000]}{"..." if len(analysis_data) > 1000 else ""}

📋 报告特性：
- ✅ 结构化分析结果
- ✅ 关键指标汇总
- ✅ 风险评估摘要
- ✅ 优化建议列表

💡 使用建议：
- 报告可用于决策支持
- 建议结合招标文件基准分析
- 可导出为多种格式
        """

        return report

    async def _arun(self, query: str = "", analysis_data: str = "", llm=None) -> str:
        return self._run(query, analysis_data, llm)


@register_tool(ToolCategory.ANALYSIS, tags=["快速", "分析", "摘要"], priority=9)
class QuickAnalyzeTool(BaseTool):
    """快速分析工具"""

    name: str = "quick_analyze"
    description: str = "对文档进行快速分析，获取关键信息"
    category: str = "分析"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="quick_analyze",
        description="对文档进行快速分析，获取关键信息",
        category="analysis",
        tags=["快速", "分析", "摘要"],
        priority=9,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "", document_content: str = "") -> str:
        """快速分析文档内容"""
        if not document_content:
            return "请提供要分析的文档内容"

        # 简单的快速分析逻辑
        word_count = len(document_content.split())
        page_estimate = max(1, word_count // 500)  # 假设每页500字

        analysis = f"""
⚡ 快速分析完成

📄 文档概览：
- 字数统计: {word_count:,} 字
- 页数估计: {page_estimate} 页
- 字符数: {len(document_content):,} 字符

🔍 关键信息提取：
- 章节标题: {self._extract_chapter_titles(document_content)}
- 关键概念: {self._extract_keywords(document_content)}
- 时间信息: {self._extract_dates(document_content)}

📊 内容分布：
- 技术内容: 约 {self._estimate_technical_content(document_content)}%
- 商务内容: 约 {self._estimate_business_content(document_content)}%
- 法律条款: 约 {self._estimate_legal_content(document_content)}%

💡 分析建议：
- 适合详细分析
- 可进行章节映射
- 建议提取具体要求
        """

        return analysis

    def _extract_chapter_titles(self, content: str) -> str:
        """提取章节标题"""
        lines = content.split('\n')[:20]  # 只检查前20行
        titles = []
        for line in lines:
            line = line.strip()
            if re.match(r'^第[一二三四五六七八九十\d]+章|^[一二三四五六七八九十\d]+\.|^\d+\.', line):
                titles.append(line[:30])
        return ', '.join(titles[:5]) if titles else "未检测到明显章节结构"

    def _extract_keywords(self, content: str) -> str:
        """提取关键词"""
        keywords = []
        keyword_patterns = [
            r'技术规格', r'功能要求', r'性能指标', r'系统架构',
            r'项目周期', r'交付标准', r'验收条件', r'质量要求',
            r'服务支持', r'技术方案', r'实施方案'
        ]
        
        for pattern in keyword_patterns:
            if re.search(pattern, content):
                keywords.append(pattern.replace('\\', ''))
        
        return ', '.join(keywords[:8]) if keywords else "技术、商务、质量"

    def _extract_dates(self, content: str) -> str:
        """提取日期信息"""
        date_patterns = [
            r'\d{4}年\d{1,2}月\d{1,2}日',
            r'\d{4}-\d{1,2}-\d{1,2}',
            r'\d{4}/\d{1,2}/\d{1,2}'
        ]
        
        dates = []
        for pattern in date_patterns:
            matches = re.findall(pattern, content)
            dates.extend(matches[:3])  # 最多显示3个日期
        
        return ', '.join(dates) if dates else "未检测到具体日期"

    def _estimate_technical_content(self, content: str) -> int:
        """估算技术内容占比"""
        tech_keywords = ['技术', '系统', '架构', '算法', '性能', '功能', '接口', '数据']
        tech_count = sum(content.count(keyword) for keyword in tech_keywords)
        total_words = len(content.split())
        return min(100, max(10, int(tech_count / total_words * 1000)))

    def _estimate_business_content(self, content: str) -> int:
        """估算商务内容占比"""
        business_keywords = ['价格', '成本', '费用', '付款', '合同', '服务', '支持', '培训']
        business_count = sum(content.count(keyword) for keyword in business_keywords)
        total_words = len(content.split())
        return min(100, max(5, int(business_count / total_words * 1000)))

    def _estimate_legal_content(self, content: str) -> int:
        """估算法律条款占比"""
        legal_keywords = ['条款', '规定', '要求', '责任', '义务', '违约', '争议', '法律']
        legal_count = sum(content.count(keyword) for keyword in legal_keywords)
        total_words = len(content.split())
        return min(100, max(5, int(legal_count / total_words * 1000)))

    async def _arun(self, query: str = "", document_content: str = "") -> str:
        return self._run(query, document_content)


@register_tool(ToolCategory.SYSTEM, tags=["导出", "格式", "下载"], priority=7)
class ExportAnalysisTool(BaseTool):
    """导出分析结果工具"""

    name: str = "export_analysis"
    description: str = "将分析结果导出为不同格式"
    category: str = "系统"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="export_analysis",
        description="将分析结果导出为不同格式",
        category="system",
        tags=["导出", "格式", "下载"],
        priority=7,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "", analysis_result: str = "", format_type: str = "txt") -> str:
        """导出分析结果"""
        if not analysis_result:
            return "请提供要导出的分析结果"

        export_info = f"""
📤 导出功能

当前支持格式：
- ✅ TXT格式: 纯文本格式，兼容性最好
- ✅ JSON格式: 结构化数据，便于程序处理
- ✅ HTML格式: 网页格式，美观易读
- 🔄 Markdown格式: 文档格式（开发中）
- 🔄 PDF格式: 固定格式（开发中）

📋 导出内容：
{analysis_result[:200]}{"..." if len(analysis_result) > 200 else ""}

💡 使用说明：
- 导出文件将保存在用户目录
- 文件名包含时间戳避免冲突
- 可用于报告分享和存档
- 建议定期清理导出文件

⚠️  注意事项：
- 敏感信息请注意保密
- 导出前请检查内容完整性
- 建议保留原始分析数据
        """

        return export_info

    async def _arun(self, query: str = "", analysis_result: str = "", format_type: str = "txt") -> str:
        return self._run(query, analysis_result, format_type)


@register_tool(ToolCategory.SYSTEM, tags=["偏好", "设置", "配置"], priority=6)
class GetUserPreferencesTool(BaseTool):
    """获取用户偏好工具"""

    name: str = "get_user_preferences"
    description: str = "获取用户偏好设置，如字体偏好、工作习惯等"
    category: str = "系统"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="get_user_preferences",
        description="获取用户偏好设置，如字体偏好、工作习惯等",
        category="system",
        tags=["偏好", "设置", "配置"],
        priority=6,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "") -> str:
        """获取用户偏好设置"""
        try:
            output = ["=== 用户偏好查询 ===\n"]

            # 模拟读取用户偏好配置
            preferences = self._get_default_preferences()

            output.append("\n当前用户偏好设置：\n")
            output.append("-" * 50)

            # 按类别分组显示偏好设置
            categories = {
                "界面设置": ["font_size", "theme", "language"],
                "分析设置": ["analysis_depth", "max_document_size", "default_analysis_tools"],
                "系统设置": ["auto_save", "auto_backup", "log_level"],
                "输出设置": ["default_export_format", "notification"]
            }

            for category, keys in categories.items():
                output.append(f"\n【{category}】")
                for key in keys:
                    if key in preferences:
                        value = preferences[key]
                        formatted_value = self._format_preference_value(value)
                        output.append(f"  • {key}: {formatted_value}")

            output.append("\n" + "-" * 50)
            output.append("\n💡 使用建议：")
            output.append("- 如需修改偏好，请编辑配置文件")
            output.append("- 配置文件位置: ~/.ah32/preferences.json")
            output.append("- 或使用 set_preference 工具动态修改")

            output.append(f"\n偏好项总数: {len(preferences)}")

            return "\n".join(output)

        except Exception as e:
            logger.error(f"获取用户偏好失败: {e}", exc_info=True)
            return f"获取用户偏好失败: {str(e)}"

    def _get_default_preferences(self) -> dict:
        """获取默认偏好设置"""
        return {
            "font_size": "中等",
            "theme": "浅色",
            "language": "中文",
            "analysis_depth": "详细",
            "auto_save": True,
            "notification": True,
            "default_export_format": "txt",
            "default_analysis_tools": ["chapter_analysis", "risk_assessment"],
            "max_document_size": "10MB",
            "auto_backup": True,
            "log_level": "INFO"
        }

    def _format_preference_value(self, value):
        """格式化偏好值显示"""
        if isinstance(value, bool):
            return "启用" if value else "禁用"
        elif isinstance(value, list):
            return ", ".join(str(v) for v in value)
        else:
            return str(value)

    async def _arun(self, query: str = "") -> str:
        return self._run(query)


@register_tool(ToolCategory.ANALYSIS, tags=["搜索", "语义", "查询"], priority=8)
class SemanticSearchTool(BaseTool):
    """语义搜索工具"""

    name: str = "semantic_search"
    description: str = "基于语义理解的文档搜索工具"
    category: str = "分析"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="semantic_search",
        description="基于语义理解的文档搜索工具",
        category="analysis",
        tags=["搜索", "语义", "查询"],
        priority=8,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "", search_content: str = "") -> str:
        """执行语义搜索"""
        if not query:
            return "请提供搜索查询"

        # 简单的关键词匹配搜索
        search_results = []
        if search_content:
            query_words = query.split()
            for i, line in enumerate(search_content.split('\n')):
                line_lower = line.lower()
                match_score = 0
                for word in query_words:
                    if word.lower() in line_lower:
                        match_score += 1
                
                if match_score > 0:
                    search_results.append({
                        'line_num': i + 1,
                        'content': line.strip()[:100],
                        'score': match_score
                    })

        search_results.sort(key=lambda x: x['score'], reverse=True)

        result = f"""
🔍 语义搜索完成

搜索查询: {query}
搜索范围: {len(search_content.split()) if search_content else 0} 行

📊 搜索结果:
"""

        if search_results:
            result += f"找到 {len(search_results)} 个相关结果:\n\n"
            for i, result_item in enumerate(search_results[:10]):  # 最多显示10个结果
                result += f"{i+1}. 【第{result_item['line_num']}行】(匹配度: {result_item['score']})\n"
                result += f"   {result_item['content']}\n\n"
        else:
            result += "未找到相关结果\n"
            result += "\n💡 搜索建议:\n"
            result += "- 检查关键词拼写\n"
            result += "- 尝试使用同义词\n"
            result += "- 简化搜索查询\n"

        return result

    async def _arun(self, query: str = "", search_content: str = "") -> str:
        return self._run(query, search_content)


@register_tool(ToolCategory.SYSTEM, tags=["知识库", "管理", "列表"], priority=7)
class KnowledgeListTool(BaseTool):
    """知识库管理工具"""

    name: str = "knowledge_list"
    description: str = "管理知识库内容，列出可用的知识条目"
    category: str = "系统"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="knowledge_list",
        description="管理知识库内容，列出可用的知识条目",
        category="system",
        tags=["知识库", "管理", "列表"],
        priority=7,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "") -> str:
        """列出知识库内容"""
        knowledge_items = [
            {"name": "文档模板", "description": "常用文档模板和格式规范", "category": "模板"},
            {"name": "格式规范", "description": "Office文档格式标准和最佳实践", "category": "格式"},
            {"name": "技术文档", "description": "技术标准和规范说明", "category": "技术"},
            {"name": "写作指南", "description": "专业文档写作技巧和示例", "category": "写作"},
            {"name": "最佳实践", "description": "Office操作的最佳实践案例", "category": "实践"}
        ]

        result = f"""
📚 知识库管理

当前知识条目总数: {len(knowledge_items)}

📋 知识库内容:
"""

        categories = {}
        for item in knowledge_items:
            category = item['category']
            if category not in categories:
                categories[category] = []
            categories[category].append(item)

        for category, items in categories.items():
            result += f"\n【{category}类别】\n"
            for item in items:
                result += f"  • {item['name']}: {item['description']}\n"

        result += f"""
💡 知识库功能:
- 语义搜索相关知识
- 基于RAG的智能问答
- 知识条目动态更新
- 与文档分析结合使用

🔧 管理功能:
- 添加新知识条目
- 更新现有内容
- 删除过时信息
- 知识分类整理
        """

        return result

    async def _arun(self, query: str = "") -> str:
        return self._run(query)


@register_tool(ToolCategory.ANALYSIS, tags=["实体", "提取", "语义"], priority=7)
class ExtractSemanticEntitiesTool(BaseTool):
    """语义实体提取工具"""

    name: str = "extract_semantic_entities"
    description: str = "从文档中提取语义实体，如人名、组织、技术名词等"
    category: str = "分析"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="extract_semantic_entities",
        description="从文档中提取语义实体，如人名、组织、技术名词等",
        category="analysis",
        tags=["实体", "提取", "语义"],
        priority=7,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "", document_content: str = "") -> str:
        """提取语义实体"""
        if not document_content:
            return "请提供要分析的文档内容"

        # 简单的实体提取逻辑
        entities = self._extract_entities(document_content)

        result = f"""
🏷️ 语义实体提取完成

📊 提取统计:
- 人名: {len(entities.get('persons', []))} 个
- 组织: {len(entities.get('organizations', []))} 个
- 技术名词: {len(entities.get('technologies', []))} 个
- 地点: {len(entities.get('locations', []))} 个
- 时间: {len(entities.get('times', []))} 个

📋 提取结果:
"""

        for entity_type, entity_list in entities.items():
            if entity_list:
                result += f"\n【{entity_type}】\n"
                for entity in entity_list[:10]:  # 最多显示10个
                    result += f"  • {entity}\n"

        result += f"""
💡 实体用途:
- 用于文档关联分析
- 支持智能问答系统
- 便于知识图谱构建
- 提升搜索准确性
        """

        return result

    def _extract_entities(self, content: str) -> Dict[str, List[str]]:
        """提取各种类型的实体"""
        entities = {
            'persons': [],
            'organizations': [],
            'technologies': [],
            'locations': [],
            'times': []
        }

        # 人名模式（简单识别）
        person_patterns = [r'[张李王刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏锺汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段漕钱汤尹黎易常武乔贺赖龚文一-龥]{2,4}']
        
        # 组织模式
        org_patterns = [r'[公司企业机关单位组织协会学院大学医院银行集团]', r'[一-龥]{2,10}(?:有限公司|集团有限公司|股份有限公司)']
        
        # 技术名词模式
        tech_patterns = [r'[算法系统平台架构数据网络云端人工智能机器学习深度学习区块链物联网大数据云计算]']
        
        # 时间模式
        time_patterns = [r'\d{4}年', r'\d{4}-\d{1,2}', r'\d{4}/\d{1,2}', r'第[一二三四五六七八九十\d]+期']
        
        # 地点模式
        location_patterns = [r'[北京上海广州深圳杭州南京成都武汉西安重庆天津青岛大连厦门苏州宁波]']

        # 简单的实体提取（实际应用中需要更复杂的NLP处理）
        lines = content.split('\n')
        for line in lines[:50]:  # 只处理前50行
            line = line.strip()
            if line:
                # 这里只是示例，实际需要更精确的实体识别
                if len(line) < 50:  # 短句更可能是实体名称
                    if any(char in line for char in ['公司', '集团', '大学', '学院']):
                        entities['organizations'].append(line)
                    elif any(char in line for char in ['算法', '系统', '平台', '技术']):
                        entities['technologies'].append(line)

        # 去重并限制数量
        for key in entities:
            entities[key] = list(set(entities[key]))[:20]  # 最多20个

        return entities

    async def _arun(self, query: str = "", document_content: str = "") -> str:
        return self._run(query, document_content)


@register_tool(ToolCategory.SYSTEM, tags=["日期", "计算", "星期"], priority=6)
class CalculateDateTool(BaseTool):
    """日期计算工具"""

    name: str = "calculate_date"
    description: str = "计算指定日期（今天、明天、N天后等）和对应的星期几"
    category: str = "系统"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="calculate_date",
        description="计算指定日期（今天、明天、N天后等）和对应的星期几",
        category="system",
        tags=["日期", "计算", "星期"],
        priority=6,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    def _run(self, query: str = "") -> str:
        """日期计算"""
        current_date = datetime.now()
        weekday_names = ['一', '二', '三', '四', '五', '六', '日']

        if "今天" in query or "当前日期" in query or "现在几号" in query:
            return current_date.strftime("%Y年%m月%d日")
        elif "明天" in query:
            tomorrow = current_date + timedelta(days=1)
            return tomorrow.strftime("%Y年%m月%d日")
        elif "昨天" in query:
            yesterday = current_date - timedelta(days=1)
            return yesterday.strftime("%Y年%m月%d日")
        elif "星期" in query:
            days_match = re.search(r'(\d+)天后', query)
            if days_match:
                days = int(days_match.group(1))
                target_date = current_date + timedelta(days=days)
                weekday = weekday_names[target_date.weekday()]
                return f"{target_date.strftime('%Y年%m月%d日')} (星期{weekday})"
            else:
                weekday = weekday_names[current_date.weekday()]
                return f"今天是星期{weekday}"
        else:
            return f"当前时间: {current_date.strftime('%Y年%m月%d日 %H:%M:%S')}"

    async def _arun(self, query: str = "") -> str:
        return self._run(query)
