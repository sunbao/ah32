"""Ah32基础Agent工具 - Agent化架构核心组件"""



from __future__ import annotations



import http.client

import json

import logging

import os

import re

import time

from pathlib import Path

from typing import Any, Dict, List, Optional



from langchain.tools import BaseTool as LangChainBaseTool



from ...core.prompts import (

    get_image_analysis_prompt,

)

# 导入统一管理

from ...core.tools import register_tool, ToolCategory, ToolMetadata



logger = logging.getLogger(__name__)





class BaseTool(LangChainBaseTool):

    """改进的工具基类，统一LLM参数处理机制 - Agent化架构核心"""

    

    # 工具元数据 - 子类可覆盖

    tool_metadata: ToolMetadata = ToolMetadata(

        name="base_tool",

        description="基础工具基类",

        category="system"

    )

    

    def _ensure_llm(self, llm=None):

        """确保获取到LLM实例"""

        if llm is not None:

            return llm

        # 从环境或上下文获取LLM实例

        if hasattr(self, '_llm') and self._llm is not None:

            return self._llm

        return None



    def _format_structured_result(self, success: bool, data: Any = None, message: str = "", error: str = None) -> dict:

        """统一的结果格式化"""

        result = {

            "success": success,

            "timestamp": str(int(time.time())),

            "tool_name": self.__class__.__name__

        }

        

        if success:

            result.update({

                "data": data,

                "message": message or "操作成功"

            })

        else:

            result.update({

                "error": error or message or "操作失败",

                "data": data

            })

        

        return result

    

    def _get_agentic_intent(self, query: str) -> str:

        """分析用户的Agentic意图，支持Vibe Coding模式"""

        query_lower = query.lower().strip()



        # 文档相关意图

        if any(keyword in query_lower for keyword in ["读取", "打开", "查看", "显示", "读"]):

            return "read_document"

        

        # 分析意图

        elif any(keyword in query_lower for keyword in ["分析", "检查", "评估"]):

            if "风险" in query_lower:

                return "assess_risks"

            elif "质量" in query_lower:

                return "assess_quality"

            elif "章节" in query_lower:

                return "analyze_chapters"

            else:

                return "analyze_document"

        

        # 建议意图

        elif any(keyword in query_lower for keyword in ["建议", "优化", "改进", "提高"]):

            return "generate_suggestions"

        

        # 匹配检查意图

        elif any(keyword in query_lower for keyword in ["匹配", "符合", "对照"]):

            return "match_requirements"

        

        # 默认返回未知意图

        return "unknown_intent"

    

    def _validate_agentic_capability(self, intent: str) -> bool:

        """验证工具是否支持指定的Agentic意图"""

        if not hasattr(self, 'tool_metadata') or not self.tool_metadata.agentic_capable:

            return False

        

        # 根据工具类型和意图进行匹配验证

        class_name = self.__class__.__name__

        

        # 文档工具

        if intent in ["read_document", "list_documents"]:

            return any(keyword in class_name for keyword in ["Document", "List"])

        

        # 分析工具

        elif intent in ["analyze_document", "analyze_chapters", "assess_quality", "assess_risks"]:

            return any(keyword in class_name for keyword in ["Analyze", "Assess"])

        

        # 建议工具

        elif intent == "generate_suggestions":

            return "Suggest" in class_name



        # 匹配工具

        elif intent == "match_requirements":

            return "Match" in class_name

        

        # 通用分析工具

        return True

    

    def run(self, tool_input: str, **kwargs) -> str:

        """标准run接口 - 支持LLM和记忆系统参数"""

        query = tool_input

        llm = kwargs.get('llm', None)

        memory_system = kwargs.get('memory_system', None)

        

        # Agentic模式：分析意图后执行

        if hasattr(self, '_run_agentic'):

            return self._run_agentic(query, llm, memory_system)

        else:

            # 回退到标准run方法

            return self._run(query, **kwargs)



    async def arun(self, tool_input: str, **kwargs) -> str:

        """标准arun接口 - 支持LLM和记忆系统参数"""

        query = tool_input

        llm = kwargs.get('llm', None)

        memory_system = kwargs.get('memory_system', None)

        

        # Agentic模式：分析意图后执行

        if hasattr(self, '_arun_agentic'):

            return await self._arun_agentic(query, llm, memory_system)

        else:

            # 回退到标准arun方法

            return await self._arun(query, **kwargs)

    

    def _run(self, tool_input: str) -> str:

        """子类需要实现的具体执行逻辑"""

        raise NotImplementedError("子类必须实现_run方法")

    

    async def _arun(self, tool_input: str) -> str:

        """子类需要实现的异步执行逻辑"""

        return self._run(tool_input)





# 后端服务地址配置

BACKEND_HOST = "127.0.0.1"

BACKEND_PORT = 5123





def get_synced_documents() -> List[Dict]:

    """从 documents.json 获取同步的文档列表（同步调用）"""

    try:

        sync_file = Path.home() / ".ah32" / "sync" / "documents.json"

        if not sync_file.exists():

            logger.debug(f"同步文档文件不存在: {sync_file}")

            return []



        with open(sync_file, "r", encoding="utf-8") as f:

            data = json.load(f)



        docs = data  # documents.json 直接是数组格式

        logger.info(f"[get_synced_documents] 获取到 {len(docs)} 个文档")

        for doc in docs:

            logger.info(f"  - doc: name={doc.get('name')}, path={doc.get('path')}, id={doc.get('id')}")

        return docs

    except Exception as e:

        logger.debug(f"读取同步文档失败: {e.with_traceback()}")

        return []







