class DualDocAnalyzer:
    """双文档分析器"""

    def __init__(self, agent_instance):
        self.agent = agent_instance

    def analyze_document_pair(self, query: str = "") -> str:
        """分析文档对"""
        try:
            result = self.agent.dual_doc_associator.analyze_both_documents()
            return f"双文档分析完成：\n{result}"
        except Exception as e:
            logger.error(f"双文档分析失败: {e}")
            return f"分析失败：{str(e)}"

    def upload_and_analyze(self, query: str = "") -> str:
        """上传并分析文档"""
        try:
            result = self.agent.dual_doc_associator.upload_and_analyze()
            return f"上传分析完成：\n{result}"
        except Exception as e:
            logger.error(f"上传分析失败: {e}")
            return f"上传分析失败：{str(e)}"

    def auto_match_chapters(self, query: str = "") -> str:
        """自动匹配章节"""
        try:
            result = self.agent.dual_doc_associator.map_chapters()
            return f"章节匹配完成：\n{result}"
        except Exception as e:
            logger.error(f"章节匹配失败: {e}")
            return f"匹配失败：{str(e)}"

    def get_quality_score(self, query: str = "") -> str:
        """获取质量评分"""
        try:
            result = self.agent.dual_doc_associator.get_quality_score()
            return f"质量评分：\n{result}"
        except Exception as e:
            logger.error(f"质量评分失败: {e}")
            return f"评分失败：{str(e)}"

    def check_risks(self, query: str = "") -> str:
        """检查风险"""
        try:
            result = self.agent.risk_assessor.assess_risks()
            return f"风险检查完成：\n{result}"
        except Exception as e:
            logger.error(f"风险检查失败: {e}")
            return f"风险检查失败：{str(e)}"

