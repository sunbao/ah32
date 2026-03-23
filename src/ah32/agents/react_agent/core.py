"""ReAct Agent 核心模块"""



from __future__ import annotations



import asyncio

import json

import os

import logging

import re

import time

from typing import Dict, List, Any, Optional

from datetime import datetime



from ah32.memory.manager import Ah32MemorySystem

from ah32.core.prompts import get_react_system_prompt

from ah32.services.docx_extract import maybe_extract_active_docx, maybe_extract_active_doc_text_full

from ah32.plan.schema import PLAN_SCHEMA_ID


# 预编译常用正则表达式以提高性能

STRICT_PLAN_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*\n([\s\S]*?)```", re.IGNORECASE)


logger = logging.getLogger(__name__)



from ah32.knowledge.project_rag_index import derive_project_context, get_project_rag_index

from ah32.telemetry import RunContext, get_telemetry





class ToolCall:

    """工具调用记录"""



    def __init__(self, tool_name: str, arguments: Dict[str, Any], result: str = None):

        self.tool_name = tool_name

        self.arguments = arguments

        self.result = result

        self.timestamp = datetime.now().isoformat()



    def to_dict(self) -> Dict[str, Any]:

        return {

            "tool": self.tool_name,

            "arguments": self.arguments,

            "result": self.result,

            "timestamp": self.timestamp,

        }





def _should_stop_iteration(result: str, iteration: int, max_iterations: int) -> bool:
    """判断是否应该停止ReAct迭代"""
    # 如果工具调用返回明确的结束信号
    if "分析完成" in result or "处理完毕" in result:
        return True



    # 如果达到最大迭代次数

    if iteration >= max_iterations:

        return True



    # 其他情况继续迭代
    return False


def _extract_json_payload(text: str) -> str:
    """Extract a JSON object string from a model response (fenced or raw)."""
    if not text:
        return ""
    m = STRICT_PLAN_CODE_BLOCK_RE.search(text)
    if m and m.group(1):
        return m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end >= 0 and end > start:
        return text[start : end + 1].strip()
    return text.strip()




def _extract_run_context(frontend_context: Optional[dict], session_id: str, *, mode: str) -> RunContext:

    """Best-effort extract RunContext from frontend_context (never throws)."""

    base: Dict[str, Any] = {}

    host: str = ""

    try:

        if isinstance(frontend_context, dict):

            rc = frontend_context.get("run_context") or frontend_context.get("runContext")

            if isinstance(rc, dict):

                base.update(rc)

            host = str(frontend_context.get("host_app") or frontend_context.get("hostApp") or "").strip()

            active = frontend_context.get("activeDocument") or frontend_context.get("document") or {}

            if isinstance(active, dict):

                if not host:

                    host = str(active.get("hostApp") or active.get("host_app") or "").strip()

                base.setdefault("doc_id", str(active.get("id") or active.get("docId") or active.get("doc_id") or "").strip())

                base.setdefault("doc_key", str(active.get("docKey") or active.get("doc_key") or "").strip())

    except Exception:

        base = {}



    base.setdefault("session_id", str(session_id or "").strip())

    base.setdefault("mode", str(mode or "").strip())

    if host:

        base.setdefault("host_app", host)

    return RunContext.from_any(base)





def _is_user_info_query(message: str) -> bool:

    """检查是否为用户信息查询"""

    user_info_keywords = ["我", "我的", "个人信息", "用户", "偏好", "设置", "配置"]

    return any(keyword in message for keyword in user_info_keywords)





def _format_result_for_user(tool_name: str, result: Any) -> str:

    """将工具结果转换为用户友好的自然语言描述



    Args:

        tool_name: 工具名称（不向用户显示）

        result: 工具执行结果



    Returns:

        str: 用户友好的自然语言描述

    """

    try:

        # 工具特定的转换逻辑

        if tool_name == "list_open_documents":

            # 文档列表结果转换

            if isinstance(result, list):

                doc_list = "\n".join([f"- {doc}" for doc in result])

                return f"我注意到您打开了以下文档：\n{doc_list}"

            return f"我检查了您打开的文档。"



        elif tool_name in ["read_document"]:

            # 文档读取结果转换

            if isinstance(result, dict):

                if "content" in result:

                    # 提取文档关键信息

                    content = result["content"]

                    if len(content) > 200:

                        # 如果内容太长，提取关键信息

                        return f"我已分析该文档，内容包括：\n{content[:200]}..."

                    else:

                        return f"我已分析该文档，内容为：\n{content}"

            return "我已分析该文档。"



        elif tool_name == "analyze_chapter":

            # 章节分析结果转换

            if isinstance(result, dict):

                if "analysis" in result:

                    return f"该章节的关键信息包括：\n{result['analysis']}"

                elif "content" in result:

                    return f"我已分析该章节，内容为：\n{result['content'][:200]}..."

            return "我已分析该章节。"



        elif tool_name in ["extract_requirements", "extract_responses"]:

            # 需求/响应提取结果转换

            if isinstance(result, list):

                items = "\n".join([f"- {item}" for item in result[:5]])  # 只显示前5项

                return f"我提取到以下要点：\n{items}\n..."

            return "我已提取相关内容。"



        elif tool_name in ["match_requirements", "map_chapters"]:

            # 匹配/映射结果转换

            if isinstance(result, dict):

                if "matches" in result:

                    return f"我发现了以下匹配项：\n{result['matches']}"

                elif "mapping" in result:

                    return f"我已完成章节映射。"

            return "我已完成分析。"



        elif tool_name in ["assess_quality", "assess_risks"]:

            # 质量/风险评估结果转换

            if isinstance(result, dict):

                if "assessment" in result:

                    return f"评估结果：\n{result['assessment']}"

                elif "risks" in result:

                    return f"风险评估：\n{result['risks']}"

            return "我已完成评估。"



        elif tool_name == "answer_question":

            # 问答结果转换

            if isinstance(result, dict):

                if "answer" in result:

                    return result["answer"]

            return "我已经找到相关信息。"



        # 默认处理：直接返回结果字符串的一部分

        result_str = str(result)

        if len(result_str) > 200:

            return f"我已处理该信息，内容为：\n{result_str[:200]}..."

        else:

            return f"我已处理该信息，内容为：\n{result_str}"



    except Exception as e:

        logger.error(f"格式化工具结果失败: {e}")

        return "我已处理该信息，但无法显示详细内容。"





class ReActAgent:

    """ReAct Agent - 思考-行动-观察循环"""



    def __init__(

        self,

        llm,

        tools: List[Any],

        memory_system: Ah32MemorySystem,

        vector_store: Any = None,

        skills_registry: Any = None,

    ):

        self.llm = llm

        self.tools = {tool.name: tool for tool in tools}

        self.memory_system = memory_system

        self.tool_calls: List[ToolCall] = []

        # Optional RAG knowledge base (e.g. LocalVectorStore). If provided, we retrieve

        # relevant snippets per user turn and inject them into the LLM context.

        self.vector_store = vector_store

        # Optional hot-loaded skills registry (prompt-only for now).

        self.skills_registry = skills_registry

        # Skill manifest tools (skill.json.tools -> scripts/*.py) are deprecated:
        # client skills will be executed on the frontend (JS), not on the backend.
        self._skill_tool_executor = None

        # Skills selected for current turn (used to resolve skill tools)
        self._selected_skills: List[Any] = []



        # cache for tool results within a single agent session to avoid duplicate external calls

        # key: (tool_name, normalized_input) -> result string

        self._tool_cache: dict = {}

        # simple counts to detect repeated requests (for observability)

        self._tool_call_counts: dict = {}



        # Track reasoning content for incremental streaming

        self._last_reasoning_content: Optional[str] = None

        # Debug: last RAG retrieval summary for this turn.

        self._last_rag_debug: Optional[dict] = None



        # LLM分类结果缓存 - 避免重复调用LLM进行相同消息的分类

        # key: message_hash -> classification_result

        self._classification_cache: Dict[str, Any] = {}



        # 缓存统计

        self._classification_cache_hits = 0

        self._classification_cache_misses = 0



        # ReAct系统提示

        self.system_prompt = self._create_react_prompt()



        # 初始化记忆管理

        self.global_memory = memory_system



        # 初始化语义匹配（Ah32MemorySystem 支持语义匹配）

        self.semantic_matcher = memory_system



    def _accumulate_token_usage(self, obj: object) -> None:

        """Best-effort token usage accounting across providers.



        Used by MacroBench budgeting/observability. Missing usage is acceptable.

        """

        try:

            acc = getattr(self, "_token_usage_acc", None)

            if not isinstance(acc, dict):

                acc = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

                self._token_usage_acc = acc



            md = getattr(obj, "response_metadata", None) or {}

            usage = None

            if isinstance(md, dict):

                usage = md.get("token_usage") or md.get("usage") or md.get("usage_metadata")

            if usage is None:

                usage = getattr(obj, "usage_metadata", None)

            if not usage or not isinstance(usage, dict):

                return



            def _pick(*keys: str) -> int:

                for k in keys:

                    try:

                        v = usage.get(k)

                        if v is not None:

                            return int(v or 0)

                    except Exception:

                        continue

                return 0



            pt = _pick("prompt_tokens", "input_tokens")

            ct = _pick("completion_tokens", "output_tokens")

            tt = _pick("total_tokens") or (pt + ct if (pt or ct) else 0)



            acc["prompt_tokens"] = int(acc.get("prompt_tokens") or 0) + max(0, pt)

            acc["completion_tokens"] = int(acc.get("completion_tokens") or 0) + max(0, ct)

            acc["total_tokens"] = int(acc.get("total_tokens") or 0) + max(0, tt)

        except Exception:

            return



    def _build_rag_context(self, user_message: str, at_reference_paths: Optional[List[str]] = None) -> str:

        """Best-effort RAG retrieval against the knowledge base (if configured)."""

        if not self.vector_store:

            return ""



        def _iter_docs_and_scores(raw):

            if not raw:

                return []

            out = []

            for item in raw:

                if isinstance(item, tuple) and len(item) == 2:

                    out.append(item)

                else:

                    out.append((item, None))

            return out



        # Chroma score is typically a distance (lower is more similar). In practice the

        # absolute scale depends on the embedding model; be permissive and keep a minimum

        # number of top results so RAG is actually usable.

        max_distance = 2.0

        min_keep = 3

        per_source_k = 2

        general_k = 5



        # Query rewrite/decomposition (lightweight, heuristic):

        # Long user messages often mix multiple sub-questions; splitting improves recall without changing business logic.

        queries: List[str] = []

        query_rewrites: List[str] = []

        try:

            t = (user_message or "").strip()

            queries = [t] if t else []

            if t and len(t) > 120:

                parts = re.split(r"[。！？!?；;\n]+", t)

                parts = [p.strip() for p in parts if len(p.strip()) >= 6]

                picked: List[str] = []

                for p in parts:

                    if p not in picked:

                        picked.append(p)

                    if len(picked) >= 3:

                        break

                if picked:

                    query_rewrites = picked[:3]

                    # Keep the original query first, then a couple of shorter sub-queries.

                    queries = [t] + picked[:2]

        except Exception:

            queries = [str(user_message or "").strip()] if str(user_message or "").strip() else []

            query_rewrites = []



        raw_results = []

        t_retrieve0 = time.perf_counter()

        try:

            if at_reference_paths:

                for path in at_reference_paths[:5]:

                    raw_results.extend(

                        _iter_docs_and_scores(

                            self.vector_store.similarity_search(

                                user_message, k=per_source_k, filter={"source": path}

                            )

                        )

                    )

                # Fallback: if per-source retrieval yields nothing (path mismatch), do a general search.

                if not raw_results:

                    for q in (queries or [user_message])[:3]:

                        raw_results.extend(

                            _iter_docs_and_scores(

                                self.vector_store.similarity_search(

                                    q, k=general_k, filter=getattr(self, "_rag_source_filter", None)

                                )

                            )

                        )

            else:

                for q in (queries or [user_message])[:3]:

                    raw_results.extend(

                        _iter_docs_and_scores(

                            self.vector_store.similarity_search(

                                q, k=general_k, filter=getattr(self, "_rag_source_filter", None)

                            )

                        )

                    )

        except Exception as e:

            retrieve_ms = int((time.perf_counter() - t_retrieve0) * 1000)

            try:

                self._last_rag_debug = {

                    "triggered": True,

                    "raw": 0,

                    "kept": 0,

                    "queries": (queries or [])[:3],

                    "query_rewrites": (query_rewrites or [])[:3],

                    "retrieve_ms": retrieve_ms,

                    "error": str(e)[:200],

                }

            except Exception:

                self._last_rag_debug = None

            logger.debug(f"[RAG] retrieval failed: {e}", exc_info=True)

            return ""

        retrieve_ms = int((time.perf_counter() - t_retrieve0) * 1000)



        # Filter + de-dup by (source, chunk_index, content hash)

        seen = set()

        kept = []

        for doc, score in raw_results:

            try:

                meta = getattr(doc, "metadata", {}) or {}

                key = (

                    meta.get("source", "unknown"),

                    meta.get("chunk_index"),

                    hash(getattr(doc, "page_content", "")),

                )

            except Exception:

                key = (id(doc),)

            if key in seen:

                continue

            seen.add(key)



            # Keep top results even if distance is large; we also keep all results under threshold.

            if score is None or score <= max_distance or len(kept) < min_keep:

                kept.append((doc, score))



        if not kept:

            # Keep a lightweight debug summary even when RAG retrieval returns 0 hits.
            try:
                self._last_rag_debug = {
                    "triggered": True,
                    "raw": len(raw_results),
                    "kept": 0,
                    "queries": (queries or [])[:3],
                    "query_rewrites": (query_rewrites or [])[:3],
                    "retrieve_ms": retrieve_ms,
                    "sources": [],
                }
            except Exception:
                self._last_rag_debug = None

            # Skill-scoped hint: only emit explicit "RAG 0-hit" signal when a selected
            # skill declares it needs the hint (avoid polluting generic chats).
            selected = getattr(self, "_selected_skills", None) or []
            wants_hint = False
            try:
                for s in selected:
                    if bool(getattr(s, "rag_missing_hint", False)):
                        wants_hint = True
                        break
            except Exception:
                wants_hint = False

            if wants_hint:
                return (
                    "RAG检索结果：本轮未命中任何片段（0条）。\n"
                    "提示：如果用户需要“合同/案例/模板/政策/法规”等资料支撑结论，请明确告知当前知识库未找到，"
                    "并引导用户上传/导入资料入库，或提供网页URL以便后续抓取入库后再检索；"
                    "若URL抓取失败/不可访问，请用户直接复制粘贴原文（纯文字）再继续。"
                )

            return ""



        # Prefer lower distance (more similar), and avoid stuffing too many chunks from the same source.

        try:

            kept.sort(key=lambda x: (x[1] if isinstance(x[1], (int, float)) else 999999))

            per_source_limit = 2

            max_total = 8

            by_source = {}

            filtered = []

            for doc, score in kept:

                meta = getattr(doc, "metadata", {}) or {}

                source = meta.get("source", "unknown")

                by_source[source] = by_source.get(source, 0) + 1

                if by_source[source] > per_source_limit:

                    continue

                filtered.append((doc, score))

                if len(filtered) >= max_total:

                    break

            kept = filtered or kept

        except Exception as e:

            logger.debug(f"[RAG] sort/filter kept docs failed: {e}", exc_info=True)



        try:

            preview_sources = []

            for doc, score in kept[:5]:

                meta = getattr(doc, "metadata", {}) or {}

                preview_sources.append((meta.get("source", "unknown"), score))

            logger.debug(f"[RAG] kept={len(kept)} sources={preview_sources}")

        except Exception as e:

            logger.debug(f"[RAG] build preview sources failed: {e}", exc_info=True)



        # Keep a lightweight debug summary for optional UI/logging/telemetry.

        try:

            scores = [float(score) for _doc, score in kept if isinstance(score, (int, float))]

            scores_sorted = sorted(scores)

            def _pct(p: float) -> Optional[float]:

                if not scores_sorted:

                    return None

                idx = int(round((len(scores_sorted) - 1) * p))

                idx = max(0, min(len(scores_sorted) - 1, idx))

                return float(scores_sorted[idx])



            self._last_rag_debug = {

                "triggered": True,

                "raw": len(raw_results),

                "kept": len(kept),

                "queries": (queries or [])[:3],

                "query_rewrites": (query_rewrites or [])[:3],

                "retrieve_ms": retrieve_ms,

                "scores": {

                    "min": min(scores) if scores else None,

                    "p50": _pct(0.50),

                    "p90": _pct(0.90),

                    "max": max(scores) if scores else None,

                },

                "sources": [

                    {

                        "source": (getattr(doc, "metadata", {}) or {}).get("source", "unknown"),

                        "score": score,

                    }

                    for doc, score in kept[:5]

                ],

            }

        except Exception:

            self._last_rag_debug = None



        max_total_chars = 2400

        max_snippet_chars = 260

        lines = [

            "RAG命中片段（来自知识库检索结果）：如果下面有片段，你必须优先基于片段回答。"
            "默认不要在正文/写回内容中展示 source/URL（避免影响排版）；仅当用户明确要求“出处/来源/引用/链接”时，"
            "才在回答末尾用“来源：”列出最少必要的 source/URL。"
            "不要声称“知识库/已打开文档均未包含相关信息”。"

        ]

        used_chars = len(lines[0])

        truncated = False



        for idx, (doc, score) in enumerate(kept[:8], 1):

            meta = getattr(doc, "metadata", {}) or {}

            source = meta.get("source", "unknown")

            method = meta.get("import_method")

            snippet = (getattr(doc, "page_content", "") or "").strip().replace("\r", " ").replace("\n", " ")

            if len(snippet) > max_snippet_chars:

                snippet = snippet[:max_snippet_chars] + "..."

            score_text = f"{score:.4f}" if isinstance(score, (int, float)) else "n/a"



            header = f"[{idx}] source={source}"

            if method:

                header += f" method={method}"

            header += f" score={score_text}"

            entry = f"{header}\n{snippet}"



            if used_chars + len(entry) + 2 > max_total_chars:

                truncated = True

                break

            lines.append(entry)

            used_chars += len(entry) + 2



        out = "\n\n".join(lines)

        try:

            if isinstance(self._last_rag_debug, dict):

                self._last_rag_debug["injected_chars"] = len(out)

                self._last_rag_debug["truncated"] = bool(truncated)

        except Exception as e:
            # Best-effort: never crash the main flow on debug-metadata updates, but keep it observable.
            logger.debug("[rag] update debug stats failed (ignored): %s", e, exc_info=True)

        return out



    def _is_writeback_intent(self, user_message: str, *, context: str = "") -> bool:
        """Heuristic: user wants the result written into the host document (not just chatted)."""

        t = (user_message or "").strip()
        if not t:
            return False

        try:
            if re.search("(\u5199\u56de|\u5199\u5230|\u5199\u5165|\u63d2\u5165|\u751f\u6210).{0,12}(\u6587\u672b|\u672b\u5c3e|\u6587\u6863|\u6b63\u6587|\u5f53\u524d\u6587\u6863|\u5757|\u4ea4\u4ed8\u5757|\u62a5\u544a\u5757)", t):
                return True
            if ("Plan JSON" in t or "ah32.plan.v1" in t) and re.search(
                "(\u5199\u56de|\u5199\u5230|\u5199\u5165|\u63d2\u5165|\u6587\u672b|\u672b\u5c3e|\u6587\u6863|\u6b63\u6587)",
                t,
            ):
                return True
        except Exception as e:
            logger.debug("[writeback] shortcut writeback detect failed (ignored): %s", e, exc_info=True)

        # NOTE: Keep this generic (no business/scenario keywords). We only detect *writeback intent*.
        # Use \u-escapes to avoid editor/console encoding issues on Windows.
        write_verbs_strong = (
            "\u5199\u5165",  # ??
            "\u5199\u5230",  # ??
            "\u5199\u8fdb",  # ??
            "\u5199\u56de",  # ??
            "\u63d2\u5165",  # ??
            "\u8ffd\u52a0",  # ??
            "\u66ff\u6362",  # ??
            "\u66f4\u65b0",  # ??
            "\u7c98\u8d34",  # ??
            "\u5e94\u7528\u5199\u56de",  # ????
            "\u5e94\u7528",  # ???????/????????
        )
        write_verbs_soft = (
            "\u751f\u6210",  # ??
            "\u521b\u5efa",  # ??
            "\u5236\u4f5c",  # ??
            "\u8f93\u51fa",  # 输出
            "\u505a\u4e00\u4e2a",  # ???
            "\u505a\u4e2a",  # ??
            "\u753b",  # ?
            "\u7ed8\u5236",  # ??
            "\u6574\u7406",  # ??
            "\u6392\u7248",  # ??
            "\u6da6\u8272",  # ??
            "\u6539\u5199",  # ??
            "\u6539\u6210",  # 改成（常见：把上面那张表格…改成…）
            "\u6539\u4e3a",  # 改为
            "\u4fee\u6539",  # 修改
            "\u8c03\u6574",  # 调整
            "\u4f18\u5316",  # 优化
            "\u5b8c\u5584",  # 完善
            "\u5347\u7ea7",  # 升级（常见：把上面的…升级为…）
            "\u8865\u5145",  # 补充
            "\u8865\u5168",  # 补全
        )
        doc_targets = (
            "\u6587\u6863",  # ??
            "WPS",
            "\u6b63\u6587",  # ??
            "\u6807\u9898",  # ??
            "\u76ee\u5f55",  # ??
            "\u7ae0\u8282",  # ??
            "\u5149\u6807",  # ??
            "\u5f53\u524d\u4f4d\u7f6e",  # ????
            "\u672b\u5c3e",  # ??
            "\u6587\u672b",  # ??
            "\u8868\u683c",  # ??
            "\u8868",  # ?
            "Sheet",
            "Excel",
            "PPT",
            "Slide",
            "\u5b57\u4f53",  # ??
            "\u989c\u8272",  # ??
            "\u683c\u5f0f",  # ??
            "\u6837\u5f0f",  # ??
            "\u6bb5\u843d",  # ??
        )

        chart_targets = (
            "\u56fe\u8868",  # 图表
            "\u67f1\u5f62\u56fe",  # 柱形图
            "\u6761\u5f62\u56fe",  # 条形图
            "\u6298\u7ebf\u56fe",  # 折线图
            "\u997c\u56fe",  # 饼图
            "\u6563\u70b9\u56fe",  # 散点图
            "\u9762\u79ef\u56fe",  # 面积图
            "chart",
        )

        # Explicit: strong write verbs + an explicit target/location => writeback.
        if any(v in t for v in write_verbs_strong) and any(x in t for x in doc_targets):
            return True

        # Chart intents in sheets are almost always writeback operations.
        # Accept both explicit write verbs and common soft verbs like "输出/画/生成".
        if any(k in t for k in chart_targets) and (
            any(v in t for v in write_verbs_strong) or any(v in t for v in write_verbs_soft)
        ):
            return True

        # Continuation/confirmation should inherit writeback mode when we were just doing writeback.
        try:
            c = str(context or "")
            has_prior_writeback = (
                (PLAN_SCHEMA_ID in c)
                or ("schema_version" in c and PLAN_SCHEMA_ID in c)
                or ("upsert_block" in c)
                or ("```javascript" in c or "```js" in c)
                or ("BID.upsertBlock" in c)
                or ("[[AH32:" in c)
            )

            cont_prefixes = (
                "\u7ee7\u7eed",  # ??
                "\u63a5\u7740",  # ??
                "\u518d\u6765",  # ??
                "\u518d\u505a",  # ??
                "\u4e0b\u4e00\u6b65",  # ???
                "\u7ee7\u7eed\u6267\u884c",  # ????
                "\u63a5\u7740\u6267\u884c",  # ????
                "\u6309\u4e0a\u6b21",  # ???
                "\u540c\u4e0a",  # ??
            )
            if has_prior_writeback and any(t.startswith(p) for p in cont_prefixes):
                return True

            confirm_signals = (
                "\u6211\u786e\u8ba4",  # 我确认
                "\u5c31\u662f\u8fd9\u4e2a\u610f\u601d",  # 就是这个意思
                "\u5bf9",  # 对
                "\u662f\u7684",  # 是的
                "\u6ca1\u9519",  # 没错
                "\u5c31\u6309\u8fd9\u4e2a",  # 就按这个
                "\u6309\u8fd9\u4e2a\u6267\u884c",  # 按这个执行
                "\u76f4\u63a5\u6267\u884c",  # 直接执行
            )
            is_short_confirmation = len(t) <= 24 and any(s in t for s in confirm_signals)
            if has_prior_writeback and is_short_confirmation:
                return True
        except Exception as e:
            logger.debug("[writeback] continuation heuristic failed (ignored): %s", e, exc_info=True)

        # Generic fallback: unambiguous write verbs imply writeback even if the user omitted explicit targets.
        # Keep it conservative: require a strong verb OR (soft verb + doc-ish noun).
        if any(v in t for v in write_verbs_strong):
            return True
        if any(v in t for v in write_verbs_soft) and any(x in t for x in doc_targets):
            return True

        # Host-aware fallback: in ET context, short chart requests should default to writeback.
        try:
            c = str(context or "")
            in_et_host = ('"host_app": "et"' in c) or ("'host_app': 'et'" in c)
            has_chart_word = any(k in t for k in chart_targets)
            if in_et_host and has_chart_word and len(t) <= 24:
                return True
        except Exception as e:
            logger.debug("[writeback] host-aware chart heuristic failed (ignored): %s", e, exc_info=True)

        return False

    def _is_chat_only_intent(self, user_message: str) -> bool:
        """Heuristic: this turn is pure chat/QA and should not auto-writeback.

        Strategy (default-writeback mode):
        - In Office hosts, most actionable turns should write back.
        - Only suppress writeback for clearly conversational/explanatory turns.
        """

        t = (user_message or "").strip()
        if not t:
            return True

        tl = t.lower()

        explicit_write_request = False
        try:
            verbs = (
                "写到",
                "写回",
                "插入",
                "追加",
                "输出到",
                "生成到",
                "生成",
                "创建",
                "制作",
                "做",
                "写入到",
                "写进",
                "填到",
                "画",
                "绘制",
                "排版",
                "润色",
                "改写",
                "整理",
            )
            targets = (
                "文档",
                "正文",
                "光标",
                "当前位置",
                "此处",
                "这里",
                "表格",
                "单元格",
                "工作表",
                "工作簿",
                "幻灯片",
                "ppt",
                "slide",
            )
            explicit_write_request = any(v in tl for v in verbs) and any(x in tl for x in targets)
        except Exception as e:
            logger.debug("[writeback] explicit write request detect failed (ignored): %s", e, exc_info=True)
            explicit_write_request = False

        try:
            if (not explicit_write_request) and self._is_writeback_intent(t):
                explicit_write_request = True
        except Exception as e:
            logger.debug("[writeback] fallback explicit write detect failed (ignored): %s", e, exc_info=True)

        source_preserve_writeback = False
        try:
            source_preserve_writeback = bool(
                explicit_write_request
                and re.search("(\u4e0d\u8981|\u4e0d\u6539|\u52ff\u6539|\u4e0d\u4fee\u6539).{0,8}(\u539f\u6587|\u9898\u5e72|\u6b63\u6587|\u539f\u59cb\u6750\u6599)", t)
            )
        except Exception as e:
            logger.debug("[writeback] source-preserve detect failed (ignored): %s", e, exc_info=True)
            source_preserve_writeback = False

        # Explicitly non-writeback instructions.
        explicit_no_write = (
            "不要写回",
            "不用写回",
            "不写回",
            "仅回答",
            "只回答",
            "先别改",
            "不要改文档",
            "不用改文档",
            "只聊天",
            "先解释",
        )
        if any(k in t for k in explicit_no_write) and (not explicit_write_request) and (not source_preserve_writeback):
            return True

        # "Text-only / do not create" instructions (common in PPT outline requests).
        # Treat them as chat-only unless the user also explicitly asked to write into the document.
        if not explicit_write_request:
            try:
                no_create_ppt = re.search(
                    r"(不需要|不必|无需|不要|不用).{0,10}(直接)?(创建|生成|制作|做成).{0,10}(ppt|幻灯片|演示|slide)",
                    tl,
                    flags=re.IGNORECASE,
                )
                no_plan = re.search(r"(不需要|不必|无需|不要|不用).{0,10}(可执行)?\\s*(plan|json)", tl, flags=re.IGNORECASE)
                if no_create_ppt or no_plan:
                    return True
            except Exception as e:
                logger.debug("[writeback] chat-only no-create detect failed (ignored): %s", e, exc_info=True)

        # Tiny small-talk/ack turns should stay in chat mode.
        # Normalize by stripping spaces/punctuation/emojis so "很好👍" also matches.
        compact = ""
        try:
            compact = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", tl)
        except Exception as e:
            logger.debug("[writeback] normalize chat-only ack failed (ignored): %s", e, exc_info=True)
            compact = tl

        tiny_chat = {
            "你好",
            "您好",
            "在吗",
            "谢谢",
            "辛苦了",
            "收到",
            "明白了",
            "懂了",
            "ok",
            "okay",
            "好",
            "好的",
            "可以",
            "行",
            "很好",
            "不错",
            "棒",
            "赞",
            "完美",
            "没问题",
            "没事",
            "hi",
            "hello",
            "nice",
            "great",
            "thanks",
            "thankyou",
        }
        if len(compact) <= 12 and compact in tiny_chat:
            return True
        try:
            # Multi-ack combos like "好的谢谢" / "okthanks".
            ack_tokens = sorted([re.escape(x) for x in tiny_chat], key=len, reverse=True)
            ack_re = r"^(?:%s)+$" % "|".join(ack_tokens)
            if len(compact) <= 12 and re.fullmatch(ack_re, compact):
                return True
        except Exception as e:
            logger.debug("[writeback] chat-only ack regex failed (ignored): %s", e, exc_info=True)

        # Explanatory/QA turns should stay in chat mode by default (even if "文档/表格" is mentioned),
        # unless the user explicitly asks to apply changes into the document.
        has_question = ("?" in t) or ("？" in t)

        explain_signals = (
            "是什么",
            "什么意思",
            "怎么理解",
            "为什么",
            "介绍",
            "解释",
            "总结",
            "区别",
            "优缺点",
            "原理",
            "怎么回事",
        )
        howto_signals = (
            "如何",
            "怎么",
            "怎样",
            "怎么做",
        )

        if any(k in t for k in explain_signals):
            return True

        # Special-case: "是否" is ambiguous. It's common in table headers ("凭证是否齐全") and
        # should NOT force chat-only when the user is clearly asking for a document action.
        # But for plain yes/no questions ("是否合规") we still treat it as chat-only.
        if ("是否" in t) and (not explicit_write_request):
            return True
        if has_question or any(k in t for k in howto_signals):
            return False if explicit_write_request else True

        # If user clearly asks for document actions, do not classify as chat-only.
        write_or_doc_signals = (
            "写入",
            "写到",
            "写回",
            "插入",
            "追加",
            "替换",
            "更新",
            "应用",
            "生成",
            "创建",
            "输出",
            "文档",
            "正文",
            "标题",
            "目录",
            "段落",
            "表格",
            "图表",
            "单元格",
            "工作表",
            "工作簿",
            "wps",
            "excel",
            "sheet",
            "ppt",
            "slide",
        )
        if any(k in tl for k in write_or_doc_signals) or any(k in t for k in write_or_doc_signals):
            return False

        return False

    def _force_chat_only_by_skill_tool_hints(self, message: str, selected_skills: list) -> bool:
        """Force chat-only mode for background tasks declared by skill tool hints.

        This keeps business "what/when to trigger" inside skill manifests, while the core
        only implements a generic orchestration rule: background jobs should not go through
        the writeback fast-path.
        """
        msg = (message or "").strip()
        if not msg:
            return False

        # If user explicitly wants to write into the office document, do not force chat-only.
        # Examples: "把结果写到文档/光标处/正文里"。
        try:
            verbs = (
                "写到",
                "写回",
                "插入",
                "追加",
                "输出到",
                "生成到",
                "写入到",
                "写进",
                "填到",
            )
            targets = (
                "文档",
                "正文",
                "光标",
                "当前位置",
                "此处",
                "这里",
                "表格",
                "标题",
                "目录",
                "段落",
            )
            if any(v in msg for v in verbs) and any(t in msg for t in targets):
                return False
        except Exception:
            logger.debug("[writeback] explicit write intent detect failed (ignored)", exc_info=True)

        for s in (selected_skills or []):
            if not s:
                continue
            tools = ()
            try:
                tools = getattr(s, "tools", None) or ()
            except Exception:
                tools = ()
            for tool in tools or ():
                hints = {}
                try:
                    hints = getattr(tool, "hints", None) or {}
                except Exception:
                    hints = {}
                if not isinstance(hints, dict) or not hints:
                    continue
                mode = str(hints.get("turn_mode") or hints.get("mode") or "").strip().lower()
                if mode not in ("background", "no_writeback", "chat_only"):
                    continue
                triggers = hints.get("triggers") or hints.get("trigger") or []
                if isinstance(triggers, str):
                    triggers = [triggers]
                if not isinstance(triggers, list):
                    triggers = []
                for k in triggers:
                    try:
                        kk = str(k or "").strip()
                    except Exception:
                        kk = ""
                    if not kk:
                        continue
                    if kk in msg:
                        return True
        return False

    def _writeback_anchor(self, user_message: str) -> str:

        """Return 'end' when user explicitly requests writing at document end/summary; otherwise 'cursor'."""

        t = (user_message or "").strip()

        if re.search(r"(文末|末尾|最后|汇总|附录|资料引用|参考资料|来源|出处)", t):

            return "end"

        return "cursor"



    def _is_compare_table_delivery_intent(self, user_message: str) -> bool:

        """Heuristic: user is asking for review/rewrite suggestions (default deliverable: compare table).



        Keep it conservative: do not force compare-table delivery for simple formatting/template tasks.

        """

        t = (user_message or "").strip()

        if not t:

            return False

        return bool(

            re.search(

                r"(审阅|风险|改写|替换|修改建议|建议修改|建议改写|对照表|修订|合规|条款|风险点)",

                t,

            )

        )



    def _build_writeback_directive(self, user_message: str) -> str:
        """Instruction appended to the LLM context when we want to write back into the office document."""
        anchor = self._writeback_anchor(user_message)
        anchor_hint = (
            "默认写入当前光标处（upsert_block.anchor='cursor'）。"
            if anchor != "end"
            else "用户要求写到文末/汇总区：请将 upsert_block.anchor 设置为 \"end\"（执行器会自动锚定到文末，无需 EndKey/GoTo）。"
        )
        return "\n".join(
            [
                "【写回文档指令】用户意图是将结果写入当前 WPS 文档/表格/演示。",
                "请输出一个可执行的 ```json``` Plan 代码块（仅包含 JSON，不要输出 HTML/解释文本）。",
                f"schema_version 必须是 {PLAN_SCHEMA_ID}，host_app 必须与当前宿主一致。",
                anchor_hint,
                "仅写入用户明确要求的文档内容；不要把客套话/完成提示写入正文（例如：不客气、已完成、随时告诉我），除非用户明确要求写入。",
                "要求：优先使用 op=upsert_block 保证幂等，并设置稳定 block_id；多段落用 \\n。",
            ]
        )


    def _selected_default_writeback_delivery(self, selected_skills: list) -> str:

        """Pick the default writeback delivery mode from selected skills (highest priority wins)."""

        best_mode = ""

        best_pri = -10_000

        for s in (selected_skills or []):

            if not s:

                continue

            try:

                mode = str(getattr(s, "default_writeback", "") or "").strip().lower()

            except Exception:

                mode = ""

            if not mode:

                continue

            try:

                pri = int(getattr(s, "priority", 0) or 0)

            except Exception:

                pri = 0

            if pri >= best_pri:

                best_pri = pri

                best_mode = mode

        return best_mode

    def _load_writeback_plan_llm(self):
        """Prefer a faster dedicated model for Plan generate/repair paths."""
        try:
            from ah32.config import settings
            from ah32.services.models import load_plan_llm

            llm, plan_model, plan_temp = load_plan_llm(settings)
            return llm, str(plan_model or ""), plan_temp, False
        except Exception as e:
            logger.warning("[writeback] load dedicated plan llm failed; fallback to chat llm: %s", e, exc_info=True)
            model_name = ""
            try:
                model_name = str(
                    getattr(self.llm, "model_name", "")
                    or getattr(self.llm, "model", "")
                    or getattr(self.llm, "model_id", "")
                    or ""
                ).strip()
            except Exception:
                model_name = ""
            return self.llm, model_name, None, True

    def _plan_llm_timeout_seconds(self, *, kind: str = "") -> float:
        kind_lower = str(kind or "").strip().lower()
        env_name = "AH32_PLAN_REPAIR_TIMEOUT_SECONDS" if "repair" in kind_lower else "AH32_PLAN_TIMEOUT_SECONDS"
        raw = (os.getenv(env_name) or "").strip()
        if not raw:
            return 75.0 if "repair" in kind_lower else 130.0
        try:
            value = float(raw)
            if value > 0:
                return value
            return 75.0 if "repair" in kind_lower else 130.0
        except Exception:
            logger.warning("[writeback] invalid %s=%r; fallback to default", env_name, raw)
            return 75.0 if "repair" in kind_lower else 130.0

    async def _invoke_writeback_plan_llm(self, llm, messages, *, kind: str):
        timeout_s = self._plan_llm_timeout_seconds(kind=kind)
        try:
            return await asyncio.wait_for(llm.ainvoke(messages), timeout=timeout_s)
        except asyncio.TimeoutError:
            logger.error("[writeback] %s timed out after %.1fs without a first result", kind, timeout_s)
            raise

    def _truncate_prompt_text(self, text: str, *, max_chars: int) -> str:
        value = str(text or "").strip()
        if not value or max_chars <= 0:
            return ""
        if len(value) <= max_chars:
            return value
        return value[:max_chars] + "\n...(truncated)"

    def _build_writeback_doc_excerpt(
        self,
        *,
        frontend_context: Optional[dict],
        max_chars: int = 6000,
    ) -> str:
        """Return a bounded document excerpt for Plan generation/repair prompts."""
        text = ""
        try:
            text = str(getattr(self, "_turn_active_doc_text", "") or "").strip()
        except Exception:
            text = ""

        if (not text) and isinstance(frontend_context, dict):
            try:
                text = str(maybe_extract_active_doc_text_full(frontend_context) or "").strip()
            except Exception as e:
                logger.debug("[writeback] extract active_doc_text_full failed (ignored): %s", e, exc_info=True)
                text = ""
            if not text:
                try:
                    text = str(maybe_extract_active_docx(frontend_context, max_chars=max_chars) or "").strip()
                except Exception as e:
                    logger.debug("[writeback] extract active_doc_text preview failed (ignored): %s", e, exc_info=True)
                    text = ""

        if not text:
            return ""

        return self._truncate_prompt_text(text, max_chars=max_chars)



    def _build_compare_table_writeback_directive(self, user_message: str) -> str:
        """Special writeback directive for review-like scenarios (default: deliver compare table)."""
        anchor = self._writeback_anchor(user_message)
        anchor_hint = (
            "默认写到文末/汇总区：请将 upsert_block.anchor 设置为 \"end\"（执行器会自动锚定到文末）。"
            if anchor == "end"
            else "默认写入当前光标处（upsert_block.anchor='cursor'）。"
        )
        return "\n".join(
            [
                "【审阅交付指令】这是“合同/制度”类审阅交付。默认不要直接改正文（避免误改），而是先交付“对照表”。",
                "请输出一个可执行的 ```json``` Plan 代码块（仅包含 JSON，不要输出 HTML/解释文本）：插入/刷新“对照表交付”表格。",
                f"schema_version 必须是 {PLAN_SCHEMA_ID}，host_app 必须与当前宿主一致。",
                "对照表列必须包含：原文要点 / 建议改写 / 理由 / 风险等级 / 是否应用。至少写 3 行示例；“是否应用”默认填“否”。",
                "注意：系统会在宏卡片上提供“一键应用（生成修订稿）”按钮（读取对照表中“是否应用=是”的行生成汇总，不改原正文）。你无需在本宏里自行实现“应用”。",
                anchor_hint,
                "要求：优先使用 op=upsert_block 保证幂等，并设置稳定 block_id；多段落用 \\n。",
            ]
        )




    def _response_has_strict_plan_block(self, text: str, host_app: str) -> bool:
        """Return True if text contains a valid Plan JSON fenced block."""
        if not text:
            return False
        plan, _err = self._extract_plan_from_text(text, host_app)
        return plan is not None

    def _selected_skill_ids_for_plan_contracts(self) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        try:
            for skill in getattr(self, "_selected_skills", None) or []:
                if isinstance(skill, str):
                    skill_id = skill
                else:
                    skill_id = str(getattr(skill, "skill_id", "") or getattr(skill, "id", "") or "")
                skill_id = skill_id.strip().lower()
                if not skill_id or skill_id in seen:
                    continue
                seen.add(skill_id)
                out.append(skill_id)
        except Exception:
            return []
        return out

    def _selected_skill_plan_guidance(self, *, max_skills: int = 3) -> str:
        items: list[dict[str, Any]] = []
        try:
            for skill in (getattr(self, "_selected_skills", None) or [])[:max_skills]:
                if isinstance(skill, str):
                    skill_id = str(skill or "").strip()
                    if not skill_id:
                        continue
                    items.append({"id": skill_id})
                    continue

                skill_id = str(getattr(skill, "skill_id", "") or getattr(skill, "id", "") or "").strip()
                if not skill_id:
                    continue
                name = str(getattr(skill, "name", "") or skill_id).strip()
                description = str(getattr(skill, "description", "") or "").strip()
                default_writeback = str(getattr(skill, "default_writeback", "") or "").strip()
                output_schema = str(getattr(skill, "output_schema", "") or "").strip()
                markers = [
                    str(x or "").strip()
                    for x in (getattr(skill, "markers", ()) or ())
                    if str(x or "").strip()
                ][:8]

                item: dict[str, Any] = {"id": skill_id}
                if name:
                    item["name"] = name
                if description:
                    item["description"] = description
                if default_writeback:
                    item["default_writeback"] = default_writeback
                if output_schema:
                    item["output_schema"] = output_schema
                if markers:
                    item["markers"] = markers
                items.append(item)
        except Exception:
            return ""

        if not items:
            return ""
        try:
            return json.dumps(items, ensure_ascii=False, indent=2, default=str)
        except Exception:
            return ""

    def _extract_plan_from_text(self, text: str, host_app: str) -> tuple[Optional[dict], str]:
        payload = _extract_json_payload(text or "")
        if not payload:
            return None, "empty_plan_payload"
        host = (host_app or "wps").strip().lower()
        if host not in ("wps", "et", "wpp"):
            host = "wps"
        try:
            from pydantic import ValidationError
            from ah32.plan.schema import Plan
            from ah32.plan.normalize import normalize_plan_payload

            obj = json.loads(payload)
            # Safety: do not allow embedding base64/data URLs into Plan JSON. Use asset:// instead.
            try:
                raw = json.dumps(obj, ensure_ascii=False, default=str)
                if "data:image/" in raw.lower() or ";base64," in raw.lower():
                    return None, "invalid_plan:base64_data_url_not_allowed"
            except Exception:
                pass
            plan = Plan.model_validate(normalize_plan_payload(obj, host_app=host))
            plan_json = plan.model_dump(mode="json")
            from ah32.plan.skill_contracts import validate_plan_contract

            validate_plan_contract(plan_json, self._selected_skill_ids_for_plan_contracts())
        except ValidationError as e:
            return None, f"invalid_plan:{e.errors(include_url=False)}"
        except Exception as e:
            return None, f"invalid_plan:{e}"
        if plan.host_app != host:
            return None, f"host_app mismatch: request={host!r} plan={plan.host_app!r}"
        return plan_json, ""

    def _apply_writeback_plan_overrides(self, plan: dict, *, block_id: str, anchor: str) -> dict:
        if not isinstance(plan, dict):
            return plan
        target_anchor = anchor if anchor in ("cursor", "end") else ""

        def _walk(actions: list) -> bool:
            for action in actions:
                if not isinstance(action, dict):
                    continue
                if action.get("op") == "answer_mode_apply":
                    if block_id:
                        action["block_id"] = block_id
                    return True
                if action.get("op") == "upsert_block":
                    if block_id:
                        action["block_id"] = block_id
                    if target_anchor:
                        action["anchor"] = target_anchor
                    return True
                nested = action.get("actions")
                if isinstance(nested, list) and _walk(nested):
                    return True
            return False

        try:
            actions = plan.get("actions")
            if isinstance(actions, list):
                _walk(actions)
        except Exception:
            return plan
        return plan

    async def _auto_repair_missing_writeback_plan(
        self,
        *,
        user_query: str,
        rag_context: str,
        session_id: str,
        anchor: str,
        delivery: str,
        original_plan: Optional[dict] = None,
        original_plan_text: str = "",
        error_type: str = "missing_plan",
        error_message: str = "",
    ) -> Optional[dict]:
        """Retry once to obtain a Plan when writeback intent is detected but the model didn't output one."""
        if not self.llm:
            return None

        host_app = ""
        try:
            host_app = str(getattr(getattr(self, "_turn_run_context", None), "host_app", "") or "").strip().lower()
        except Exception:
            host_app = ""
        host = host_app if host_app in ("wps", "et", "wpp") else "wps"

        try:
            from ah32.services.plan_prompts import get_plan_repair_prompt

            sys_prompt = get_plan_repair_prompt(host)
        except Exception as e:
            logger.error(f"[writeback] build plan repair prompt failed: {e}", exc_info=True)
            return None

        try:
            block_id = f"wb_{self._get_message_hash((session_id or '') + '|' + (user_query or ''))}"
        except Exception:
            block_id = "ah32_writeback"

        delivery_hint = "compare_table" if str(delivery or "").strip().lower() == "compare_table" else ""
        original_text = json.dumps(original_plan or {}, ensure_ascii=False, default=str)
        original_plan_text = self._truncate_prompt_text(original_plan_text, max_chars=6000)
        selected_skill_guidance = self._selected_skill_plan_guidance()
        doc_excerpt = self._build_writeback_doc_excerpt(frontend_context=None)

        user_prompt = (
            f"User request:\n{(user_query or '').strip()}\n\n"
            f"Writeback anchor: {anchor}\n"
            f"Delivery: {delivery_hint}\n"
            f"Suggested block_id: {block_id}\n\n"
            + (
                "Selected skill guidance (honor these contracts; if only one skill is selected, "
                "do not blend other scenarios):\n"
                f"{selected_skill_guidance}\n\n"
                if selected_skill_guidance
                else ""
            )
            + (f"Document excerpt:\n{doc_excerpt}\n\n" if doc_excerpt else "")
            + (f"Relevant context:\n{(rag_context or '').strip()}\n\n" if (rag_context or "").strip() else "")
            + "Original plan:\n"
            + f"{original_text}\n\n"
            + (f"Original model output:\n{original_plan_text}\n\n" if original_plan_text else "")
            + f"Error: {error_type}\n"
            + f"Error message: {error_message}\n"
        ).strip()

        llm, plan_model, _plan_temp, fallback_used = self._load_writeback_plan_llm()
        t0 = time.perf_counter()
        resp = await self._invoke_writeback_plan_llm(
            llm,
            [("system", sys_prompt), ("user", user_prompt)],
            kind="plan_repair_fast_path",
        )
        self._accumulate_token_usage(resp)
        ms = int((time.perf_counter() - t0) * 1000)
        try:
            self._turn_llm_total_ms = int(getattr(self, "_turn_llm_total_ms", 0) or 0) + ms
            if not getattr(self, "_turn_first_llm_ms", None):
                self._turn_first_llm_ms = ms
            tsvc = get_telemetry()
            if tsvc:
                tsvc.emit(
                    "chat.llm_call",
                    {
                        "iteration": 1,
                        "llm_ms": ms,
                        "kind": "plan_repair_fast_path",
                        "model": plan_model,
                        "fallback_to_chat_llm": bool(fallback_used),
                    },
                    ctx=getattr(self, "_turn_run_context", None),
                )
        except Exception as e:
            logger.debug(f"[telemetry] emit chat.llm_call (plan_repair_fast_path) failed: {e}", exc_info=True)
        raw = getattr(resp, "content", "") or str(resp)
        plan, _err = self._extract_plan_from_text(raw, host)
        if not plan:
            snippet = self._truncate_prompt_text(raw, max_chars=600)
            logger.warning(
                "[writeback] plan_repair_fast_path returned invalid plan: %s (raw_len=%s, raw_preview=%r)",
                _err,
                len(raw or ""),
                snippet,
            )
            return None
        plan = self._apply_writeback_plan_overrides(plan, block_id=block_id, anchor=anchor)
        logger.info(
            "[writeback] plan_repair_fast_path succeeded host=%s session_id=%s block_id=%s",
            host,
            session_id,
            block_id,
        )
        return plan


    async def _generate_writeback_plan_fast_path(
        self,
        *,
        user_query: str,
        context: str,
        session_id: str,
        document_name: Optional[str],
        frontend_context: Optional[dict],
        anchor: str,
        delivery: str = "",
    ) -> Optional[dict]:
        """Generate a Plan with a dedicated prompt + (usually) a faster model.

        This is used for document writeback intents to improve the 0-repair success rate and reduce latency,
        while keeping the normal ReAct/tool loop for analysis-only turns.
        """
        if not self.llm:
            return None

        host_app = ""
        try:
            host_app = str(getattr(getattr(self, "_turn_run_context", None), "host_app", "") or "").strip().lower()
        except Exception:
            host_app = ""
        host = host_app if host_app in ("wps", "et", "wpp") else "wps"

        llm, plan_model, _plan_temp, fallback_used = self._load_writeback_plan_llm()

        # Capabilities (best-effort): small, host-filtered, deterministic JSON for prompt guidance.
        caps_text = ""
        try:
            caps = {}
            if isinstance(frontend_context, dict):
                caps = frontend_context.get("capabilities") or {}
                if not isinstance(caps, dict):
                    caps = {}
            if caps:
                caps_text = json.dumps(caps, ensure_ascii=False, indent=2, default=str)
                if len(caps_text) > 1800:
                    caps_text = caps_text[:1800] + "\n... (truncated)"
        except Exception as e:
            logger.debug(f"[writeback] normalize capabilities failed: {e}", exc_info=True)
            caps_text = ""

        try:
            block_id = f"wb_{self._get_message_hash((session_id or '') + '|' + (user_query or ''))}"
        except Exception:
            block_id = "ah32_writeback"

        delivery_hint = "compare_table" if str(delivery or "").strip().lower() == "compare_table" else ""
        selected_skill_guidance = self._selected_skill_plan_guidance()
        doc_excerpt = self._build_writeback_doc_excerpt(frontend_context=frontend_context)

        try:
            from ah32.services.plan_prompts import get_plan_generation_prompt

            system = get_plan_generation_prompt(host)
        except Exception as e:
            logger.error(f"[writeback] build plan prompt failed: {e}", exc_info=True)
            return None

        skill_guidance_full = self._truncate_prompt_text(selected_skill_guidance, max_chars=1600)
        skill_guidance_compact = self._truncate_prompt_text(selected_skill_guidance, max_chars=700)
        doc_excerpt_full = self._truncate_prompt_text(doc_excerpt, max_chars=6000)
        doc_excerpt_compact = self._truncate_prompt_text(doc_excerpt, max_chars=2200)
        user_query_full = self._truncate_prompt_text(user_query, max_chars=2200)
        user_query_compact = self._truncate_prompt_text(user_query, max_chars=900)

        attempts: list[tuple[str, str]] = []
        attempts.append(
            (
                "plan_fast_path",
                (
                    f"session_id: {session_id}\n"
                    f"document_name: {document_name or ''}\n"
                    f"host_app: {host}\n"
                    f"capabilities: {caps_text}\n"
                    f"writeback_anchor: {anchor}\n"
                    f"delivery: {delivery_hint}\n"
                    f"suggested_block_id: {block_id}\n\n"
                    + (
                        "selected_skill_guidance:\n"
                        f"{skill_guidance_full}\n\n"
                        "Honor every selected skill contract. If exactly one skill is selected, "
                        "do not mix in other scenario templates or plain-text explanations.\n\n"
                        if skill_guidance_full
                        else ""
                    )
                    + (f"Document excerpt:\n{doc_excerpt_full}\n\n" if doc_excerpt_full else "")
                    + f"User request:\n{user_query_full}\n"
                ),
            )
        )
        attempts.append(
            (
                "plan_fast_path_compact",
                (
                    f"host_app: {host}\n"
                    f"writeback_anchor: {anchor}\n"
                    f"delivery: {delivery_hint}\n"
                    f"suggested_block_id: {block_id}\n"
                    "Goal: output a minimal valid ah32.plan.v1 JSON that writes one idempotent delivery block.\n"
                    "Prefer a single upsert_block with plain text paragraphs. Avoid extra actions unless required.\n\n"
                    + (
                        "selected_skill_guidance_compact:\n"
                        f"{skill_guidance_compact}\n\n"
                        if skill_guidance_compact
                        else ""
                    )
                    + (f"Document excerpt:\n{doc_excerpt_compact}\n\n" if doc_excerpt_compact else "")
                    + f"User request:\n{user_query_compact}\n"
                ),
            )
        )

        last_error = "empty_plan_payload"
        last_error_type = "missing_plan"
        last_raw = ""

        for attempt_index, (kind, user) in enumerate(attempts, start=1):
            prompt_chars = len(system) + len(user)
            logger.info(
                "[writeback] %s attempt=%s host=%s session_id=%s prompt_chars=%s",
                kind,
                attempt_index,
                host,
                session_id,
                prompt_chars,
            )
            t0 = time.perf_counter()
            try:
                resp = await self._invoke_writeback_plan_llm(
                    llm,
                    [("system", system), ("user", user)],
                    kind=kind,
                )
            except asyncio.CancelledError:
                logger.info("[writeback] plan generation cancelled")
                raise
            except Exception as e:
                last_error = str(e or "").strip() or e.__class__.__name__
                last_error_type = "llm_timeout" if isinstance(e, asyncio.TimeoutError) else "llm_error"
                logger.warning(
                    "[writeback] %s attempt=%s failed: %s",
                    kind,
                    attempt_index,
                    last_error,
                    exc_info=True,
                )
                if attempt_index == 1:
                    break
                continue

            self._accumulate_token_usage(resp)
            ms = int((time.perf_counter() - t0) * 1000)
            try:
                self._turn_llm_total_ms = int(getattr(self, "_turn_llm_total_ms", 0) or 0) + ms
                if not getattr(self, "_turn_first_llm_ms", None):
                    self._turn_first_llm_ms = ms
                tsvc = get_telemetry()
                if tsvc:
                    tsvc.emit(
                        "chat.llm_call",
                        {
                            "iteration": attempt_index,
                            "llm_ms": ms,
                            "kind": kind,
                            "model": plan_model,
                            "fallback_to_chat_llm": bool(fallback_used),
                        },
                        ctx=getattr(self, "_turn_run_context", None),
                    )
            except Exception as e:
                logger.debug(f"[telemetry] emit chat.llm_call ({kind}) failed: {e}", exc_info=True)

            raw = getattr(resp, "content", "") or str(resp)
            last_raw = raw
            plan, err = self._extract_plan_from_text(raw, host)
            if plan:
                plan = self._apply_writeback_plan_overrides(plan, block_id=block_id, anchor=anchor)
                return plan

            last_error = err or "invalid_plan"
            last_error_type = "invalid_plan"
            logger.warning(
                "[writeback] %s attempt=%s returned invalid plan: %s (raw_len=%s)",
                kind,
                attempt_index,
                last_error,
                len(raw or ""),
            )
            if attempt_index == 1:
                continue
            break

        if last_error_type in ("llm_timeout", "llm_error") and not str(last_raw or "").strip():
            logger.warning(
                "[writeback] skip repair fallback after %s because no model output was returned",
                last_error_type,
            )
            return None

        try:
            self._turn_writeback_repair_attempted = True
        except Exception:
            pass

        try:
            repaired = await self._auto_repair_missing_writeback_plan(
                user_query=user_query,
                rag_context=context or "",
                session_id=session_id,
                anchor=anchor,
                delivery=delivery,
                original_plan=None,
                original_plan_text=last_raw,
                error_type=last_error_type,
                error_message=last_error,
            )
            if repaired:
                return self._apply_writeback_plan_overrides(repaired, block_id=block_id, anchor=anchor)
        except asyncio.CancelledError:
            logger.info("[writeback] plan repair fallback cancelled")
            raise
        except Exception as e:
            logger.error("[writeback] internal repair fallback failed: %s", e, exc_info=True)

        return None


    def _create_react_prompt(self) -> str:

        """创建ReAct系统提示"""

        # 获取基础ReAct提示词

        base_prompt = get_react_system_prompt()



        # 获取用户信息查询的特殊处理提示

        from ah32.core.prompts import get_prompt



        user_info_prompt = get_prompt("user_info_context")



        # 添加工具描述

        tools_desc = []

        for name, tool in self.tools.items():

            desc = getattr(tool, "description", f"Tool: {name}")

            tools_desc.append(f"- {name}: {desc}")



        # 添加文档读取的特殊说明（精简版，降低 tokens）

        file_path_note = (

            "文档读取：read_document 输入支持 文件路径 / 已打开文档名 / 已打开文档序号(如\"1\"). "

            "优先按用户给的路径读取；支持 docx/doc/wps/txt/md/pdf/rtf。"

        )



        # 将工具描述替换到基础提示词的{tools}占位符中

        tools_section = f"{chr(10).join(tools_desc)}\n{file_path_note}"

        prompt = base_prompt.replace("{tools}", tools_section) + user_info_prompt



        return prompt



    def _get_message_hash(self, message: str) -> str:

        """生成消息的唯一哈希值，用于缓存"""

        import hashlib



        # 使用MD5哈希，截取前16位作为缓存键

        return hashlib.md5(message.encode("utf-8")).hexdigest()[:16]



    def get_tool_calls_summary(self) -> List[Dict[str, Any]]:

        """获取工具调用汇总"""

        return [call.to_dict() for call in self.tool_calls]



    def clear_tool_calls(self):

        """清空工具调用记录"""

        self.tool_calls.clear()

        self._tool_cache.clear()

        self._tool_call_counts.clear()



    def get_classification_cache_stats(self) -> Dict[str, Any]:

        """获取LLM分类缓存统计信息"""

        total_requests = self._classification_cache_hits + self._classification_cache_misses

        hit_rate = (

            (self._classification_cache_hits / total_requests * 100) if total_requests > 0 else 0

        )



        return {

            "hits": self._classification_cache_hits,

            "misses": self._classification_cache_misses,

            "total_requests": total_requests,

            "hit_rate": f"{hit_rate:.2f}%",

            "cache_size": len(self._classification_cache),

        }



    def clear_classification_cache(self):

        """清空LLM分类缓存"""

        self._classification_cache.clear()

        self._classification_cache_hits = 0

        self._classification_cache_misses = 0

        logger.debug("[缓存] 已清空LLM分类缓存")



    async def _extract_and_store_user_info(

        self, message: str, session_id: str, classification_result=None

    ):

        """提取和存储用户信息"""

        try:

            if classification_result and hasattr(classification_result, "identity_info"):

                user_info = {

                    "identity_info": classification_result.identity_info,

                    "confidence": classification_result.confidence,

                    "timestamp": datetime.now().isoformat(),

                }

            else:

                user_info = {"message": message, "timestamp": datetime.now().isoformat()}



            # 存储到全局记忆

            await self.memory_system.update_global_user_info(

                session_id=session_id, user_info=user_info

            )

            logger.debug("[记忆] 已更新用户信息")

        except Exception as e:

            logger.error(f"[记忆] 用户信息提取失败: {e}")



    async def _extract_and_store_user_preferences(

        self, message: str, session_id: str, classification_result=None

    ):

        """提取和存储用户偏好"""

        try:

            if classification_result and hasattr(classification_result, "preferences"):

                user_prefs = {

                    "preferences": classification_result.preferences,

                    "confidence": classification_result.confidence,

                    "timestamp": datetime.now().isoformat(),

                }

            else:

                user_prefs = {"message": message, "timestamp": datetime.now().isoformat()}



            if user_prefs.get("preferences"):

                prefs_dict = user_prefs["preferences"]

                if isinstance(prefs_dict, dict) and prefs_dict:

                    first_key = list(prefs_dict.keys())[0]

                    first_value = prefs_dict[first_key]

                    await self.memory_system.learn_user_preference(

                        session_id=session_id,

                        preference_type=first_key,

                        preference_value=str(first_value),

                        feedback=message[:100],

                    )

            logger.debug("[记忆] 已更新用户偏好")

        except Exception as e:

            logger.error(f"[记忆] 用户偏好提取失败: {e}")



    def _parse_tool_call(self, llm_response: str) -> Optional[Dict[str, Any]]:

        """解析LLM返回的工具调用（处理双花括号格式）.

        兼容两类格式：
        1) 旧格式: {"action": "tool_name", "input": ...}
        2) 新格式: {"name": "tool_name", "arguments": {...}}

        安全策略：
        - 优先仅在“整个响应就是 JSON 对象”时解析（避免把宏代码里的 `{...}` 误判为工具 JSON）。
        - 若严格解析失败，再尝试从“响应末尾”提取最后一个工具 JSON（常见于模型先说一句话再给 JSON）。
        """

        try:

            # 处理双花括号格式 {{...}}

            cleaned = str(llm_response or "").strip()

            # 去掉外层花括号

            if cleaned.startswith("{{") and cleaned.endswith("}}"):

                cleaned = cleaned[1:-1].strip()



            def _is_tool_call_obj(obj: Any) -> bool:
                if not isinstance(obj, dict):
                    return False
                if "action" in obj and isinstance(obj.get("action"), str):
                    return True
                if "name" in obj and isinstance(obj.get("name"), str):
                    return True
                return False

            def _get_tool_name(obj: Dict[str, Any]) -> str:
                if "name" in obj and isinstance(obj.get("name"), str):
                    return str(obj.get("name") or "").strip()
                return str(obj.get("action") or "").strip()

            def _is_known_tool(name: str) -> bool:
                if not name:
                    return False

                # Built-in tools
                try:
                    tools = getattr(self, "tools", None)
                    if isinstance(tools, dict) and name in tools:
                        return True
                except Exception:
                    logger.debug("[tools] check built-in tools failed (ignored)", exc_info=True)

                # Skill tools (declared by selected skills)
                try:
                    reg = getattr(self, "skills_registry", None)
                    selected = getattr(self, "_selected_skills", None) or []
                    if reg is not None and selected:
                        for skill in selected:
                            try:
                                if reg.find_tool(skill.skill_id, name) is not None:
                                    return True
                            except Exception:
                                continue
                except Exception:
                    logger.debug("[tools] check skill tools failed (ignored)", exc_info=True)
                return False



            # 1) 严格解析：仅当整个响应就是 JSON 对象时才尝试解析工具调用。

            # 否则像 JS 宏代码里的 `{ ... }`（for/try/catch 块）会被误识别为工具 JSON。

            if cleaned.startswith("{"):

                try:
                    tool_call = json.loads(cleaned)
                except Exception as e:
                    logger.debug(f"解析工具调用失败: {e}")
                    tool_call = None

                if _is_tool_call_obj(tool_call):
                    tool_name = _get_tool_name(tool_call)
                    if _is_known_tool(tool_name):
                        return tool_call



            # 2) 宽松解析：从响应末尾提取最后一个工具 JSON（常见于“先说一句再给 JSON”）。

            # 仅接受：解析出的 JSON 必须是工具调用对象，且 JSON 之后只允许空白字符。

            tail = cleaned[-10000:] if len(cleaned) > 10000 else cleaned
            if "```" in tail:
                # 避免从 fenced code block 中误提取
                tail = self._strip_fenced_code_blocks(tail)

            tool_start_re = re.compile(r'\{\s*"(?:name|action)"\s*:')
            matches = list(tool_start_re.finditer(tail))
            if not matches:
                return None

            def _is_ignorable_trailing_text(s: str) -> bool:
                """Allow minor punctuation after a tool-call JSON.

                Some models emit: `{...}。` or `{...}.` which is still clearly a tool call, but would
                fail the strict "JSON must be the last token" rule.
                """
                try:
                    rest = str(s or "")
                except Exception:
                    rest = ""
                if not rest.strip():
                    return True
                # Only allow whitespace and common punctuation (including Chinese punctuation).
                return bool(re.fullmatch(r"[\s\.,!\?;:\-–—、，。；：…（）()\[\]【】]*", rest))

            decoder = json.JSONDecoder()
            for m in reversed(matches):
                start = m.start()
                try:
                    obj, end = decoder.raw_decode(tail[start:])
                except json.JSONDecodeError:
                    continue
                except Exception:
                    logger.debug("解析工具调用失败（宽松解析异常）", exc_info=True)
                    continue

                if not _is_tool_call_obj(obj):
                    continue

                # Ensure the extracted JSON is the last meaningful content.
                # (Allow trailing punctuation like "。"/".", etc.)
                if not _is_ignorable_trailing_text(tail[start + end :]):
                    continue

                tool_name = _get_tool_name(obj)
                if _is_known_tool(tool_name):
                    logger.debug("[tools] parsed tool call from tail: %s", tool_name)
                    return obj



        except Exception as e:

            logger.debug(f"解析工具调用失败: {e}")



        return None


    def _looks_truncated_text(self, text: str) -> bool:
        """Heuristic: detect frontend/backend capped document text markers."""
        try:
            s = str(text or "")
            if not s:
                return False
            if "truncated_by_max_chars" in s:
                return True
            if "...(truncated)" in s:
                return True
            if s.rstrip().endswith("...(truncated)"):
                return True
            return False
        except Exception:
            logger.debug("[doc_text] truncated marker check failed (ignored)", exc_info=True)
            return False



    async def _execute_tool(self, tool_call: Dict[str, Any]) -> str:

        """执行工具调用 - 增加会话级缓存以避免重复外部调用"""

        is_skill_format = ("name" in tool_call)
        tool_name = str(tool_call.get("name") if is_skill_format else tool_call.get("action") or "").strip()
        tool_input = tool_call.get("arguments") if is_skill_format else tool_call.get("input", "")



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

            logger.debug(f"使用缓存的工具结果: {tool_name} (input fingerprint)")

            return self._tool_cache[cache_key]

        # Remote-friendly: `read_document` can fall back to frontend-provided active doc text.
        # Why: on remote backends, synced document paths often point to client-local Windows paths
        # (e.g. C:\\Users\\...), which do not exist on the server.
        #
        # Privacy policy for chat:
        # - Prefer *ephemeral* per-request active doc payload (active_doc_text_full/active_doc_text)
        # - Do NOT fetch the active document content from RAG as an implicit "backup"
        try:
            if tool_name == "read_document":
                requested = ""
                if isinstance(tool_input, dict):
                    requested = str(
                        tool_input.get("file_path")
                        or tool_input.get("path")
                        or tool_input.get("source_path")
                        or tool_input.get("query")
                        or ""
                    ).strip()
                else:
                    requested = str(tool_input or "").strip()

                ctx = getattr(self, "_turn_frontend_context", None)
                if requested and isinstance(ctx, dict):
                    active = ctx.get("activeDocument") or ctx.get("document") or {}
                    active_id = str(active.get("id") or active.get("docId") or active.get("doc_id") or "").strip()
                    active_name = str(active.get("name") or "").strip()
                    active_path = str(active.get("fullPath") or active.get("path") or "").strip()

                    rc = ctx.get("run_context") or ctx.get("runContext") or {}
                    doc_key = str(rc.get("doc_key") or rc.get("docKey") or "").strip()

                    direct_text = (
                        ctx.get("active_doc_text")
                        or ctx.get("activeDocText")
                        or ctx.get("active_document_text")
                        or ctx.get("activeDocumentText")
                    )
                    direct_full = (
                        ctx.get("active_doc_text_full")
                        or ctx.get("activeDocTextFull")
                        or ctx.get("active_document_text_full")
                        or ctx.get("activeDocumentTextFull")
                    )

                    same_doc = requested in (active_id, active_name, active_path, doc_key)
                    if not same_doc and doc_key:
                        # Common case: requested="doc_xxx", doc_key="wps:doc_xxx"
                        same_doc = doc_key.endswith(requested) or requested.endswith(doc_key)

                    if same_doc:
                        # Prefer full active doc payload when available (ephemeral per request).
                        if isinstance(direct_full, str) and direct_full.strip():
                            name = active_name or requested
                            content_full = str(direct_full or "")
                            # Cap tool output to avoid blowing up the LLM context.
                            content = content_full
                            if len(content) > 60_000:
                                content = content[: 60_000 - 20] + "\n...(truncated)"
                            char_count = len(content_full)
                            line_count = content_full.count("\n") + 1 if content_full else 0

                            rendered = "\n".join(
                                [
                                    f"=== 文档内容(前端提取): {name} ===\n",
                                    f"【统计】字符: {char_count}, 行数: {line_count}",
                                    "来源: frontend_context.active_doc_text_full\n",
                                    "=" * 50,
                                    "",
                                    content,
                                    "",
                                    "=" * 50,
                                    f"读取完成：{name}",
                                ]
                            )
                            self._tool_cache[cache_key] = rendered
                            return rendered

                        # Fall back to frontend-provided text preview (bounded).
                        if isinstance(direct_text, str) and direct_text.strip():
                            doc_text = maybe_extract_active_docx(ctx, max_chars=60_000)
                            if doc_text:
                                name = active_name or requested
                                content = str(doc_text or "")
                                char_count = len(content)
                                line_count = content.count("\n") + 1 if content else 0

                                rendered = "\n".join(
                                    [
                                        f"=== 文档内容(前端提取): {name} ===\n",
                                        f"【统计】字符: {char_count}, 行数: {line_count}",
                                        (
                                            "NOTE: document snapshot is missing; this is a client-provided preview and may be incomplete."
                                            if str(ctx.get("doc_context_mode") or "").strip().lower() == "preview_only"
                                            else ""
                                        ),
                                        "来源: frontend_context.active_doc_text\n",
                                        "=" * 50,
                                        "",
                                        content,
                                        "",
                                        "=" * 50,
                                        f"读取完成：{name}",
                                    ]
                                )
                                self._tool_cache[cache_key] = rendered
                                return rendered

                        # Doc snapshot (v1): when the backend cannot read client-local paths, the frontend can upload
                        # an ephemeral snapshot and pass `doc_snapshot_id` in frontend_context.
                        try:
                            sid = str(
                                ctx.get("doc_snapshot_id")
                                or ctx.get("docSnapshotId")
                                or ctx.get("doc_snapshot")
                                or ctx.get("docSnapshot")
                                or ""
                            ).strip()
                        except Exception:
                            sid = ""
                        if sid:
                            try:
                                content_full = str(maybe_extract_active_doc_text_full(ctx) or "")
                            except Exception:
                                content_full = ""
                            if content_full.strip():
                                name = active_name or requested
                                content = content_full
                                if len(content) > 60_000:
                                    content = content[: 60_000 - 20] + "\n...(truncated)"
                                char_count = len(content_full)
                                line_count = content_full.count("\n") + 1 if content_full else 0

                                rendered = "\n".join(
                                    [
                                        f"=== 文档内容(快照): {name} ===\n",
                                        f"【统计】字符: {char_count}, 行数: {line_count}",
                                        f"来源: doc_snapshot_id={sid}\n",
                                        "=" * 50,
                                        "",
                                        content,
                                        "",
                                        "=" * 50,
                                        f"读取完成：{name}",
                                    ]
                                )
                                self._tool_cache[cache_key] = rendered
                                return rendered
        except Exception as e:
            logger.debug("[read_document] active_doc_text fast path failed (ignored): %s", e, exc_info=True)



        try:

            # First try built-in ReAct tools
            tool = self.tools.get(tool_name)

            # Then try skill-declared tools (name/arguments)
            if tool is None and self._skill_tool_executor is not None and self.skills_registry is not None:
                selected = tuple(self._selected_skills or [])
                matches = []
                for skill in selected:
                    skill_tool = self.skills_registry.find_tool(skill.skill_id, tool_name)
                    if skill_tool is not None:
                        matches.append((skill, skill_tool))

                if len(matches) > 1:
                    rendered = (
                        "错误：技能工具名冲突（多个已选技能提供同名工具）。"
                        f"tool={tool_name} candidates={','.join([s.skill_id for s, _ in matches])}"
                    )
                    self._tool_cache[cache_key] = rendered
                    return rendered

                if len(matches) == 1:
                    _, skill_tool = matches[0]
                    try:
                        if not isinstance(tool_input, dict):
                            return f"错误：工具参数必须为对象（dict）。tool={tool_name}"

                        tool_args = dict(tool_input)
                        try:
                            props = (
                                skill_tool.parameters.get("properties")
                                if isinstance(getattr(skill_tool, "parameters", None), dict)
                                else {}
                            )
                            if isinstance(props, dict) and "doc_text" in props:
                                if not str(tool_args.get("doc_text") or "").strip():
                                    active_doc_text = str(getattr(self, "_turn_active_doc_text", "") or "")
                                    # Ensure the tool call always includes doc_text when the schema declares it.
                                    # Some skill tool scripts define `doc_text` as a positional arg without default;
                                    # passing an empty string keeps execution deterministic and avoids TypeError.
                                    use_text = active_doc_text if active_doc_text else ""

                                    # If preview is truncated/missing, try to use the full active doc payload
                                    # from frontend_context (ephemeral per request; not persisted).
                                    if (not str(use_text or "").strip()) or self._looks_truncated_text(use_text):
                                        try:
                                            ctx = getattr(self, "_turn_frontend_context", None)
                                            full_text = maybe_extract_active_doc_text_full(ctx)
                                            if full_text and str(full_text).strip():
                                                use_text = str(full_text or "")
                                        except Exception as e:
                                            logger.debug("[tools] inject doc_text from frontend_context failed (ignored): %s", e, exc_info=True)

                                    tool_args["doc_text"] = use_text if use_text else ""

                            # Inject active document path when the tool schema declares it.
                            # This enables project-scoped ingestion APIs (derive project from contextDocumentPath).
                            if isinstance(props, dict) and (
                                ("context_document_path" in props) or ("contextDocumentPath" in props)
                            ):
                                snake_key = "context_document_path"
                                camel_key = "contextDocumentPath"
                                needs_snake = ("context_document_path" in props) and (not str(tool_args.get(snake_key) or "").strip())
                                needs_camel = ("contextDocumentPath" in props) and (not str(tool_args.get(camel_key) or "").strip())
                                if needs_snake or needs_camel:
                                    try:
                                        ctx = getattr(self, "_turn_frontend_context", None) or {}
                                        active = (ctx or {}).get("activeDocument") or {}
                                        p = (active.get("fullPath") or active.get("path") or "").strip()
                                        if p:
                                            if needs_snake:
                                                tool_args[snake_key] = p
                                            if needs_camel:
                                                tool_args[camel_key] = p
                                    except Exception as e:
                                        logger.debug(
                                            "[tools] inject context_document_path from frontend_context failed (ignored): %s",
                                            e,
                                            exc_info=True,
                                        )
                        except Exception as e:
                            logger.debug(f"[tools] inject active doc text failed (ignored): {e}", exc_info=True)

                        ok, err = self._skill_tool_executor.validate_tool_arguments(skill_tool, tool_args)
                        if not ok:
                            return f"错误：工具参数校验失败。tool={tool_name} err={err}"
                        # Run skill tools in a dedicated thread to avoid blocking the asyncio loop.
                        # This is required for integrations like Playwright Sync API.
                        from ah32.skills.tool_executor import get_skill_tool_thread_pool

                        loop = asyncio.get_running_loop()
                        exec_result = await loop.run_in_executor(
                            get_skill_tool_thread_pool(),
                            self._skill_tool_executor.execute_tool,
                            skill_tool,
                            tool_args,
                        )
                        rendered = self._skill_tool_executor.render_tool_result_for_llm(skill_tool, exec_result)
                        self._tool_cache[cache_key] = rendered
                        return rendered
                    except Exception as e:
                        logger.error(f"执行技能工具 {tool_name} 失败: {e}", exc_info=True)
                        return f"错误：工具执行失败。tool={tool_name} err={str(e)}"

            if not tool:

                return f"错误：未找到工具 '{tool_name}'"

            tool_input_for_builtin = tool_input
            if not isinstance(tool_input_for_builtin, str):
                try:
                    tool_input_for_builtin = json.dumps(tool_input_for_builtin, ensure_ascii=False)
                except Exception:
                    tool_input_for_builtin = str(tool_input_for_builtin)



            # 执行工具（传递LLM实例给需要的工具）

            if tool_name in [

                "analyze_chapter",

                "extract_requirements",

                "extract_responses",

                "match_requirements",

                "assess_quality",

                "assess_risks",

                "answer_question",


            ]:

                # 传递LLM实例进行结构化分析

                if hasattr(tool, "arun"):

                    result = await tool.arun(tool_input_for_builtin, llm=self.llm)

                else:

                    result = tool.run(tool_input_for_builtin, llm=self.llm)

            else:

                # 其他工具不传递LLM

                if hasattr(tool, "arun"):

                    result = await tool.arun(tool_input_for_builtin)

                else:

                    result = tool.run(tool_input_for_builtin)



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



    def _build_context(

        self,

        memory: Dict[str, Any],

        session_id: Optional[str],

        query_message: str = "",

        classification_result=None,

    ) -> str:

        """构建对话上下文（使用策略模式）



        Args:

            memory: 检索到的记忆

            session_id: 会话ID

            query_message: 用户查询消息（用于动态判断查询类型）

            classification_result: LLM分类结果（可选）

        """

        context_parts = []



        # 使用LLM分类结果动态构建优先级

        priority_order = None

        query_type = "regular"



        # 动态判断是否是用户信息查询（根据消息内容）

        user_info_keywords = ["我是", "我叫", "我的名字", "我是谁", "记住", "个人信息", "用户信息"]

        user_info_query = any(kw in query_message for kw in user_info_keywords)



        try:

            from ah32.strategies.context_strategy import InfoPriority, context_strategy



            # 如果有分类结果，使用简化分类来推断查询类型

            if classification_result:

                try:

                    from ah32.strategies.llm_driven_strategy import StorageLevel



                    # 基于分类结果推断查询类型

                    if classification_result.category.value == "identity":

                        query_type = "user_info"

                    elif classification_result.category.value == "preference":

                        query_type = "user_info"

                    elif classification_result.category.value in ["technical", "commercial", "project", "timeline"]:

                        query_type = "analysis"



                    logger.debug(f"[上下文构建] 使用简化关键词分类结果构建上下文")

                    logger.debug(f"[上下文构建] 分类类别: {classification_result.category.value}")

                    logger.debug(f"[上下文构建] 存储级别: {classification_result.storage_level.value}")

                    logger.debug(f"[上下文构建] 查询类型: {query_type}")



                    # 根据存储级别确定优先级（始终包含@引用处理）

                    if classification_result.storage_level == StorageLevel.P0_GLOBAL:

                        priority_order = [InfoPriority.P0_AT_REFERENCE, InfoPriority.P0_IDENTITY, InfoPriority.P2_HISTORY, InfoPriority.P1_SESSION]

                    elif classification_result.storage_level == StorageLevel.P2_CROSS_SESSION:

                        priority_order = [InfoPriority.P0_AT_REFERENCE, InfoPriority.P2_HISTORY, InfoPriority.P0_IDENTITY, InfoPriority.P1_SESSION]

                    else:

                        priority_order = [InfoPriority.P0_AT_REFERENCE, InfoPriority.P1_SESSION, InfoPriority.P2_HISTORY, InfoPriority.P0_IDENTITY]



                except Exception as e:

                    logger.warning(f"[上下文构建] 使用简化分类结果构建优先级失败: {e}")

                    priority_order = None



            # 如果没有LLM分类结果，使用原有策略模式（始终包含@引用处理）

            if not priority_order:

                # 判断查询类型

                query_type = "user_info" if user_info_query else "regular"

                if "分析" in query_message or "评估" in query_message:

                    query_type = "analysis"



                # 使用 context_strategy 的 get_info_source_for_query 方法

                base_priority_order = context_strategy.get_info_source_for_query(

                    query_message, query_type

                )



                # 确保@引用处理始终在优先级列表中

                if InfoPriority.P0_AT_REFERENCE not in base_priority_order:

                    # 在最前面插入@引用处理

                    priority_order = [InfoPriority.P0_AT_REFERENCE] + list(base_priority_order)

                else:

                    priority_order = list(base_priority_order)



                logger.debug(f"[上下文构建] 使用关键词策略构建上下文，查询类型: {query_type}")



            # 根据优先级添加上下文信息

            for info_type in priority_order:

                if info_type == InfoPriority.P0_IDENTITY:

                    # 添加全局记忆信息（用户身份、公司、偏好等）

                    if "global_memory" in memory and memory["global_memory"]:

                        global_mem = memory["global_memory"]

                        if isinstance(global_mem, dict):

                            if global_mem.get("user_profile"):

                                context_parts.append(f"用户身份信息:\n{global_mem['user_profile']}")

                            if global_mem.get("user_preferences"):

                                context_parts.append(

                                    f"用户偏好信息:\n{global_mem['user_preferences']}"

                                )

                        else:

                            context_parts.append(f"全局记忆信息:\n{global_mem}")



                elif info_type == InfoPriority.P1_SESSION:

                    # 添加当前会话记忆（对话历史）

                    if "session_memory" in memory and memory["session_memory"]:

                        session_mem = memory["session_memory"]

                        if isinstance(session_mem, list) and session_mem:

                            # 格式化对话历史，使用更清晰的格式让LLM更容易识别

                            history_text = "对话历史:\n\n"

                            def _sanitize_history_text(s: str) -> str:

                                try:

                                    text = str(s or "")

                                    # Avoid "old signature" pollution: older sessions may include deprecated API calls.

                                    if "upsertBlock({" in text or "BID.upsertBlock({" in text:

                                        text = text.replace("BID.upsertBlock({", "BID.upsertBlock(")

                                        text = text.replace("upsertBlock({", "upsertBlock(")

                                        text += (

                                            "\n\n[系统提示] 注意：历史里可能出现过期签名。当前版本正确签名是 "

                                            "BID.upsertBlock(blockId, function(){...}, opts?)，不要使用 upsertBlock({id, content})。"

                                        )

                                    return text

                                except Exception:

                                    return str(s or "")

                            for msg in session_mem[-10:]:  # 只取最近10条

                                role = msg.get("role", "unknown")

                                message = _sanitize_history_text(msg.get("message", ""))

                                # 使用更清晰的对话格式，让LLM更容易识别

                                history_text += f"**{role}**: {message}\n\n"

                            context_parts.append(history_text)

                            logger.debug(f"[上下文构建] 包含 {len(session_mem)} 条对话历史")

                        elif isinstance(session_mem, str):

                            context_parts.append(f"会话记忆:\n{session_mem}")



                elif info_type == InfoPriority.P2_HISTORY:

                    # 添加跨会话记忆（历史检索结果）

                    if "cross_session_memory" in memory and memory["cross_session_memory"]:

                        cross_mem = memory["cross_session_memory"]

                        if isinstance(cross_mem, list) and cross_mem:

                            history_text = "相关历史对话:\n"

                            for item in cross_mem[:3]:  # 只取前3条

                                content = item.get("content", "")

                                history_text += f"- {content[:200]}\n"

                            context_parts.append(history_text)

                        elif isinstance(cross_mem, str):

                            context_parts.append(f"历史记忆:\n{cross_mem}")



                elif info_type == InfoPriority.P3_TOOLS:

                    # 工具执行历史已通过 self.tool_calls 在循环中传递

                    pass



                elif info_type == InfoPriority.P0_AT_REFERENCE:

                    # 🔧 新增：添加@引用处理结果

                    if "at_reference_context" in memory and memory["at_reference_context"]:

                        at_context = memory["at_reference_context"]

                        if isinstance(at_context, dict):

                            # 添加@引用处理状态

                            processed_count = len(at_context.get("at_references_processed", []))

                            errors_count = len(at_context.get("at_references_errors", []))

                            paths_count = len(at_context.get("at_references_paths", []))



                            if processed_count > 0:

                                context_parts.append(f"✅ @引用文档处理状态:\n- 成功处理: {processed_count} 个文档\n- 文件路径: {paths_count} 个\n- 错误数量: {errors_count}")



                                # 如果有处理成功的文档，列出它们

                                if at_context.get("at_references_processed"):

                                    processed_files = at_context["at_references_processed"]

                                    context_parts.append("✅ 已处理的@引用文件:")

                                    for i, file_info in enumerate(processed_files[:3], 1):  # 只显示前3个

                                        if isinstance(file_info, dict):

                                            filename = file_info.get("filename", "未知文件")

                                            context_parts.append(f"  {i}. {filename}")

                                        else:

                                            context_parts.append(f"  {i}. {str(file_info)}")



                                # 如果有错误，列出它们

                                if at_context.get("at_references_errors"):

                                    errors = at_context["at_references_errors"]

                                    context_parts.append(f"⚠️ @引用处理错误 ({len(errors)} 个):")

                                    for i, error in enumerate(errors[:3], 1):  # 只显示前3个

                                        context_parts.append(f"  {i}. {str(error)[:100]}...")



                            elif paths_count > 0:

                                # 有路径但处理失败

                                context_parts.append(f"⚠️ @引用文档处理状态:\n- 检测到: {paths_count} 个引用文件\n- 处理失败: {errors_count} 个\n- 错误信息:")

                                if at_context.get("at_references_errors"):

                                    errors = at_context["at_references_errors"]

                                    for i, error in enumerate(errors[:2], 1):  # 只显示前2个

                                        context_parts.append(f"  {i}. {str(error)[:80]}...")

                            else:

                                # 完全没有任何@引用

                                context_parts.append("ℹ️ @引用文档处理状态: 未检测到@引用文件")



                        logger.debug(f"[上下文构建] @引用上下文: {at_context}")



                else:

                    # 其他信息类型

                    logger.debug(f"[上下文构建] 未知信息类型: {info_type}")

                    pass



            # 添加当前会话信息

            context_parts.append(f"当前会话ID: {session_id}")



            # 添加查询类型信息

            context_parts.append(f"查询类型: {query_type}")



            # 拼接所有上下文部分

            context = "\n\n".join(context_parts)



            logger.debug(f"[上下文构建] 上下文长度: {len(context)} 字符")

            return context



        except Exception as e:

            logger.error(f"[上下文构建] 构建上下文失败: {e}")

            # 返回基本上下文

            return f"当前会话ID: {session_id}"



    async def stream_chat(

        self,

        message: str,

        session_id: str = None,

        document_name: str = None,

        frontend_context: dict = None,

        rule_files: Optional[List[str]] = None,

        show_rag_hits: bool = False,

    ):

        """流式聊天 - 实时返回响应内容



        Args:

            message: 用户消息

            session_id: 会话ID（必须由前端提供）

            document_name: 当前打开的文档名（用于错误处理）

            frontend_context: 动态感知数据（光标、选区、格式等，来自前端）



        Yields:

            dict: 包含type和content的事件

                - type: "thinking" | "tool_call" | "tool_result" | "content" | "done"

                - content: 对应的内容

        """

        self.tool_calls = []

        # Best-effort token usage accounting (for MacroBench maxCost and observability).

        # Not all providers populate this; missing data is acceptable.

        self._token_usage_acc = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}



        # Token usage accumulation helper: use self._accumulate_token_usage(obj)



        # Some legacy clients append a "动态感知" block into the user message.

        # That harms RAG retrieval and bloats tokens; strip it and rely on structured frontend_context instead.

        normalized_message = (message or "").strip()

        if "【动态感知】" in normalized_message:

            normalized_message = normalized_message.split("【动态感知】", 1)[0].strip()

        # Also strip common separators.

        if "\n---" in normalized_message:

            normalized_message = normalized_message.split("\n---", 1)[0].strip()

        # Per-turn writeback bookkeeping (used by output guard / repair).
        # Keep these best-effort and never crash the main flow.
        try:
            self._turn_user_query = normalized_message
        except Exception:
            pass
        try:
            self._turn_rag_context = ""
        except Exception:
            pass
        try:
            self._turn_writeback_anchor = "cursor"
        except Exception:
            pass
        try:
            self._turn_writeback_delivery = ""
        except Exception:
            pass
        try:
            self._turn_writeback_repair_attempted = False
        except Exception:
            pass



        # 重置推理内容跟踪器

        self._last_reasoning_content = None



        # 强制要求提供有效的session_id，不再内部生成

        if not session_id:

            raise ValueError(

                f"Session ID is required and must be provided by the frontend. Document name: {document_name}"

            )



        # 动态感知：记录并注入前端上下文（结构化数据，不污染 user message）

        bench_mode = False

        if frontend_context:

            # Keep raw frontend context for tool execution fallbacks (e.g. remote read_document).
            # This is per-request; the agent instance is created per request in agentic_chat_api.
            try:
                self._turn_frontend_context = frontend_context if isinstance(frontend_context, dict) else None
            except Exception:
                self._turn_frontend_context = None

            try:

                logger.debug(

                    f"[动态感知] 收到前端上下文: {frontend_context.get('activeDocument', {}) or frontend_context.get('document', {})}"

                )

            except Exception as e:

                logger.debug(f"[动态感知] log frontend context failed: {e}", exc_info=True)

            try:

                bench_mode = bool(frontend_context.get("bench"))

            except Exception:

                bench_mode = False



        # Telemetry: per-turn run context + timers (best-effort; must not break chat).

        self._turn_started_at_perf = time.perf_counter()

        self._turn_llm_total_ms = 0

        self._turn_first_llm_ms = None

        try:

            self._turn_run_context = _extract_run_context(frontend_context, session_id, mode="chat")

        except Exception:

            self._turn_run_context = RunContext(session_id=str(session_id or "").strip(), mode="chat")

        try:

            tsvc = get_telemetry()

            if tsvc:

                tsvc.emit(

                    "chat.turn_start",

                    {

                        "message_len": len(normalized_message or ""),

                        "bench": bool(bench_mode),

                        "has_frontend_context": bool(frontend_context),

                        "has_rule_files": bool(rule_files),

                    },

                    ctx=getattr(self, "_turn_run_context", None),

                )

        except Exception as e:

            logger.debug(f"[telemetry] emit chat.turn_start failed: {e}", exc_info=True)



        # Project-scoped RAG: compute allowed sources for this turn (project + global).

        # This is a read-only filter; importing/linking is handled by the RAG ingestion API.

        self._rag_source_filter = None

        try:

            if self.vector_store and frontend_context:

                active = frontend_context.get("activeDocument") or {}

                doc_path = (active.get("fullPath") or active.get("path") or "").strip()

                ctx = derive_project_context(doc_path) if doc_path else None

                if ctx:

                    persist_dir = getattr(self.vector_store, "persist_path", None)

                    if persist_dir:

                        rag_index = get_project_rag_index(persist_dir)

                        # First-run bootstrap: keep legacy behavior by treating all existing sources as global.

                        try:

                            if not rag_index.index_path.exists() and hasattr(self.vector_store, "get_all_metadatas"):

                                metas = self.vector_store.get_all_metadatas() or []

                                sources = sorted({(m or {}).get("source") for m in metas if (m or {}).get("source")})

                                if sources:

                                    rag_index.bootstrap_all_as_global(sources)

                                    rag_index.save()

                        except Exception as e:

                            logger.debug(f"[RAG] project index bootstrap failed: {e}", exc_info=True)

                        # If the index hasn't been initialized yet, don't enforce a filter (keeps legacy behavior).

                        allowed = rag_index.get_allowed_sources(ctx.project_id, include_global=True)

                        if allowed:

                            self._rag_source_filter = {"source": {"$in": allowed[:5000]}}

        except Exception:

            self._rag_source_filter = None



        # 1. 检索相关记忆

        relevant_memory = await self.memory_system.get_comprehensive_context(normalized_message, session_id)



        # 1.5. 使用LLM驱动策略智能分类会话内容

        classification_result = None

        try:

            from ah32.strategies.llm_driven_strategy import classify_conversation



            # 生成消息哈希并检查缓存

            message_hash = self._get_message_hash(normalized_message)



            if message_hash in self._classification_cache:

                # 缓存命中

                classification_result = self._classification_cache[message_hash]

                logger.debug(f"[LLM分类] 流式聊天缓存命中，使用之前的分类结果")

            else:

                # 缓存未命中，调用简化关键词分类

                classification_result = classify_conversation(normalized_message)

                self._classification_cache[message_hash] = classification_result

                logger.info(

                    f"[LLM分类] 流式聊天分类完成，类别: {classification_result.category.value}, 置信度: {classification_result.confidence.value}"

                )

        except Exception as e:

            logger.warning(f"[LLM分类] 流式聊天分类失败: {e}")



        # 2. 构建对话上下文

        context = self._build_context(relevant_memory, session_id, normalized_message, classification_result)



        # Inject structured frontend_context for this turn.

        if frontend_context:

            try:

                import json as _json

                # Privacy: never dump active document text into the prompt.
                safe_frontend_context = frontend_context
                try:
                    if isinstance(frontend_context, dict):
                        safe_frontend_context = dict(frontend_context)
                        for k in (
                            "active_doc_text",
                            "activeDocText",
                            "active_document_text",
                            "activeDocumentText",
                            "active_doc_text_full",
                            "activeDocTextFull",
                            "active_document_text_full",
                            "activeDocumentTextFull",
                            "active_et_meta",
                            "activeEtMeta",
                            "active_et_header_map",
                            "activeEtHeaderMap",
                        ):
                            safe_frontend_context.pop(k, None)
                except Exception:
                    safe_frontend_context = frontend_context

                compact = _json.dumps(safe_frontend_context, ensure_ascii=False)

                if len(compact) > 1500:

                    compact = compact[:1500] + "...(truncated)"

                context = f"{context}\n\n【动态感知(前端)】\n{compact}"

            except Exception as e:

                logger.debug(f"[动态感知] inject compact frontend context failed: {e}", exc_info=True)



        skills_used_payload = None

        selected_skills = []

        self._selected_skills = []

        skills_injected_chars = 0

        skills_truncated = False

        lazy_stats_before = None

        lazy_stats_after = None

        lazy_calls_delta = 0

        lazy_cache_hits_delta = 0

        lazy_total_ms_delta = 0.0

        lazy_activated_skills: List[str] = []



        # Inject hot-loaded skills (prompt-only) for this turn.

        try:

            from ah32.config import settings



            if settings.skills_enabled and settings.enable_dynamic_skills and self.skills_registry is not None:

                # Skill routing should be stable across follow-up turns that omit domain keywords

                # (e.g. "再细一点"). Use lightweight hints from the active document + recent context

                # ONLY for routing, not for LLM prompting.

                host = None

                try:

                    if isinstance(frontend_context, dict):

                        host = (

                            frontend_context.get("host_app")

                            or frontend_context.get("hostApp")

                            or (frontend_context.get("activeDocument") or {}).get("hostApp")

                        )

                except Exception:

                    host = None

                # Frontend-led skill routing (deterministic, no LLM on client):
                # - If frontend is confident (>= accept_threshold) or explicit switch, force primary skill.
                # - Else, optionally constrain backend routing to the frontend candidate set.
                allow_skill_ids = None
                forced_front_skill_id = ""
                front_router_metrics = None
                try:
                    sel = None
                    if isinstance(frontend_context, dict):
                        sel = (
                            frontend_context.get("client_skill_selection")
                            or frontend_context.get("clientSkillSelection")
                            or None
                        )
                    if isinstance(sel, dict) and self.skills_registry is not None:
                        front_primary = str(
                            sel.get("primary_skill_id")
                            or sel.get("primarySkillId")
                            or sel.get("primary")
                            or ""
                        ).strip()
                        try:
                            front_score = float(sel.get("primary_score") or sel.get("primaryScore") or 0.0)
                        except Exception:
                            front_score = 0.0
                        try:
                            front_threshold = float(sel.get("accept_threshold") or sel.get("acceptThreshold") or 0.0)
                        except Exception:
                            front_threshold = 0.0
                        try:
                            front_explicit = bool(sel.get("explicit"))
                        except Exception:
                            front_explicit = False

                        cand_ids: list[str] = []
                        try:
                            cands = sel.get("candidates")
                            if isinstance(cands, list):
                                for c in cands[:12]:
                                    if not isinstance(c, dict):
                                        continue
                                    cid = str(c.get("id") or c.get("skill_id") or c.get("skillId") or "").strip()
                                    if cid:
                                        cand_ids.append(cid)
                        except Exception:
                            cand_ids = []

                        try:
                            front_router_metrics = {
                                "explicit": bool(front_explicit),
                                "primary_skill_id": str(front_primary or ""),
                                "primary_score": float(front_score or 0.0),
                                "accept_threshold": float(front_threshold or 0.0),
                                "candidates": list(cand_ids[:8]),
                            }
                        except Exception:
                            front_router_metrics = None

                        if front_primary and (front_explicit or (front_threshold > 0.0 and front_score >= front_threshold)):
                            forced = None
                            try:
                                for s in self.skills_registry.list_skills():
                                    if not getattr(s, "enabled", False):
                                        continue
                                    if str(getattr(s, "skill_id", "") or "") == front_primary:
                                        forced = s
                                        break
                            except Exception:
                                forced = None
                            if forced is not None:
                                forced_front_skill_id = str(forced.skill_id or "").strip()
                                selected_skills = [forced]
                                skills_used_payload = [
                                    {
                                        "id": forced.skill_id,
                                        "name": forced.name,
                                        "version": forced.version,
                                        "priority": forced.priority,
                                        "score": round(float(front_score or 0.0), 3),
                                        "source": "frontend",
                                    }
                                ]
                        elif cand_ids:
                            allow_skill_ids = cand_ids
                except Exception as e:
                    logger.debug(f"[skills] parse/apply frontend skill selection failed (ignored): {e}", exc_info=True)
                    allow_skill_ids = None
                    front_router_metrics = None

                # Auto-select relevant skills for this turn to keep prompts small and fast.

                try:

                    from ah32.knowledge.embeddings import resolve_embedding

                    from ah32.skills.router import SkillRouter, SkillRoutingHints



                    embedder = resolve_embedding(settings)

                    router = SkillRouter(self.skills_registry)



                    routing_doc_name = ""

                    routing_extra: list[str] = []

                    routing_recent_user: tuple[str, ...] = ()

                    try:

                        if document_name:

                            routing_doc_name = str(document_name).strip()

                    except Exception:

                        routing_doc_name = ""



                    try:

                        if isinstance(frontend_context, dict):

                            active = frontend_context.get("activeDocument") or frontend_context.get("document") or {}

                            if isinstance(active, dict):

                                dn = str(active.get("name") or active.get("document_name") or "").strip()

                                dp = str(active.get("fullPath") or active.get("path") or "").strip()

                                if dn and (not routing_doc_name or dn != routing_doc_name):

                                    routing_extra.append(f"active_doc_name: {dn}")

                                if dp:

                                    # Path is used only as a lexical hint (it often contains business keywords).

                                    routing_extra.append(f"active_doc_path: {dp}")

                    except Exception:

                        routing_extra = []



                    # If the user message is short/generic, append a tiny slice of session memory for routing.

                    # This keeps skill selection "sticky" to the current topic without hard-coded fallbacks.

                    try:

                        msg0 = (normalized_message or "").strip()

                        if len(msg0) < 24 and isinstance(relevant_memory, dict):

                            mems = relevant_memory.get("session_memory")

                            if isinstance(mems, list) and mems:

                                recent: list[str] = []

                                for m in mems[:6]:

                                    if not isinstance(m, dict):

                                        continue

                                    u = (

                                        m.get("user_message")

                                        or m.get("user")

                                        or m.get("query")

                                        or m.get("content")

                                        or ""

                                    )

                                    u = str(u or "").strip()

                                    if not u:

                                        continue

                                    recent.append(u)

                                    if len(recent) >= 2:

                                        break

                                if recent:

                                    routing_recent_user = tuple(recent)

                    except Exception:

                        routing_recent_user = ()



                    ranked = []
                    if not selected_skills:
                        ranked = router.select_for_message(

                            normalized_message,

                            embedder=embedder,

                            hints=SkillRoutingHints(

                                host=str(host).strip() if host else None,

                                document_name=routing_doc_name,

                                recent_user_messages=routing_recent_user,

                                extra=tuple(routing_extra),

                            ),

                            host=host,

                            allow_skill_ids=allow_skill_ids,

                            top_k=settings.skills_top_k,

                            min_score=settings.skills_min_score,

                        )

                        selected_skills = [x.get("skill") for x in ranked if x.get("skill")]

                        skills_used_payload = [

                            {

                                "id": x["skill"].skill_id,

                                "name": x["skill"].name,

                                "version": x["skill"].version,

                                "priority": x["skill"].priority,

                                "score": round(float(x.get("score") or 0.0), 3),

                            }

                            for x in ranked

                            if x.get("skill") is not None

                        ]

                    if forced_front_skill_id:
                        selected_skills = [
                            s
                            for s in (selected_skills or [])
                            if str(getattr(s, "skill_id", "") or getattr(s, "id", "") or "").strip()
                            == forced_front_skill_id
                        ]
                        if selected_skills:
                            skills_used_payload = [
                                item
                                for item in (skills_used_payload or [])
                                if str((item or {}).get("id") or "").strip() == forced_front_skill_id
                            ]

                except Exception:

                    # Embeddings may be unavailable (offline bootstrap). Fall back to lexical routing.

                    from ah32.skills.router import SkillRouter, SkillRoutingHints



                    router = SkillRouter(self.skills_registry)

                    ranked = []
                    if not selected_skills:
                        ranked = router.select_for_message(

                            normalized_message,

                            embedder=None,

                            hints=SkillRoutingHints(host=str(host).strip() if host else None),

                            host=host,

                            allow_skill_ids=allow_skill_ids,

                            top_k=settings.skills_top_k,

                            min_score=settings.skills_min_score,

                        )

                        selected_skills = [x.get("skill") for x in ranked if x.get("skill")]

                        skills_used_payload = [

                            {

                                "id": x["skill"].skill_id,

                                "name": x["skill"].name,

                                "version": x["skill"].version,

                                "priority": x["skill"].priority,

                                "score": round(float(x.get("score") or 0.0), 3),

                            }

                            for x in ranked

                            if x.get("skill") is not None

                        ]

                    if forced_front_skill_id:
                        selected_skills = [
                            s
                            for s in (selected_skills or [])
                            if str(getattr(s, "skill_id", "") or getattr(s, "id", "") or "").strip()
                            == forced_front_skill_id
                        ]
                        if selected_skills:
                            skills_used_payload = [
                                item
                                for item in (skills_used_payload or [])
                                if str((item or {}).get("id") or "").strip() == forced_front_skill_id
                            ]



                # Skill-driven attachment: some skills require reading the active document text.

                # Best-effort and bounded; if extraction fails we just proceed without it.

                try:

                    # Cache active doc text for skill tools (auto-injected).
                    #
                    # IMPORTANT (privacy + token budget):
                    # - Tools may need the full doc text to parse questions reliably.
                    # - The LLM prompt should only receive a bounded preview.
                    #
                    # `self._turn_active_doc_text` is kept per-request (agent is per request in agentic_chat_api).
                    self._turn_active_doc_text = ""

                    need_doc = [

                        s for s in (selected_skills or []) if getattr(s, "needs_active_doc_text", False)

                    ]

                    if frontend_context and need_doc:

                        preview_max_chars = 40_000

                        try:

                            cap_max = max(int(getattr(s, "active_doc_max_chars", 0) or 0) for s in need_doc)

                            if cap_max > 0:

                                preview_max_chars = min(200_000, cap_max)

                        except Exception as e:
                            logger.debug(
                                "[docx] compute active_doc_max_chars failed (ignored): %s",
                                e,
                                exc_info=True,
                            )

                        # Full text for tools (ephemeral; do NOT persist).
                        full_text = maybe_extract_active_doc_text_full(frontend_context)
                        if full_text:
                            self._turn_active_doc_text = str(full_text or "")

                        # Bounded preview for the LLM prompt.
                        preview_text = maybe_extract_active_docx(frontend_context, max_chars=preview_max_chars)
                        if not preview_text and full_text:
                            preview_text = str(full_text)[:preview_max_chars]
                            if len(str(full_text)) > preview_max_chars:
                                preview_text = preview_text + "\n...(truncated)"

                        if preview_text:
                            context = f"{context}\n\n【当前文档内容】\n{preview_text}"

                except Exception as e:

                    logger.debug(f"[docx] attach active doc text failed (ignored): {e}", exc_info=True)



                skills_text = self.skills_registry.render_for_prompt(selected=selected_skills)

                if skills_text:

                    skills_injected_chars = len(skills_text)

                    skills_truncated = "...truncated..." in skills_text or "[...truncated...]" in skills_text

                    context = f"{context}\n\n{skills_text}"

                # Render tools from selected skills (if any have tools)
                tools_text = ""
                if self.skills_registry is not None and hasattr(self.skills_registry, "get_lazy_activation_stats"):
                    try:
                        lazy_stats_before = self.skills_registry.get_lazy_activation_stats()
                    except Exception as e:
                        logger.debug(f"[skills] lazy stats(before) failed (ignored): {e}", exc_info=True)
                # NOTE: do not expose skill.json.tools to the backend LLM; client skills run on frontend (JS).
                if self.skills_registry is not None and hasattr(self.skills_registry, "get_lazy_activation_stats"):
                    try:
                        lazy_stats_after = self.skills_registry.get_lazy_activation_stats()
                    except Exception as e:
                        logger.debug(f"[skills] lazy stats(after) failed (ignored): {e}", exc_info=True)

                try:
                    if isinstance(lazy_stats_before, dict) and isinstance(lazy_stats_after, dict):
                        lazy_calls_delta = int(lazy_stats_after.get("calls", 0)) - int(lazy_stats_before.get("calls", 0))
                        lazy_cache_hits_delta = int(lazy_stats_after.get("cache_hits", 0)) - int(
                            lazy_stats_before.get("cache_hits", 0)
                        )
                        lazy_total_ms_delta = float(lazy_stats_after.get("total_ms", 0.0)) - float(
                            lazy_stats_before.get("total_ms", 0.0)
                        )
                        per_before = lazy_stats_before.get("per_skill") if isinstance(lazy_stats_before.get("per_skill"), dict) else {}
                        per_after = lazy_stats_after.get("per_skill") if isinstance(lazy_stats_after.get("per_skill"), dict) else {}
                        skill_ids = set(per_before.keys()) | set(per_after.keys())
                        activated: List[str] = []
                        for sid in sorted(skill_ids):
                            cb = int((per_before.get(sid) or {}).get("calls", 0))
                            ca = int((per_after.get(sid) or {}).get("calls", 0))
                            if ca > cb:
                                activated.append(sid)
                        lazy_activated_skills = activated
                except Exception as e:
                    logger.debug(f"[skills] lazy stats delta calc failed (ignored): {e}", exc_info=True)

                if tools_text:
                    context = f"{context}\n\n{tools_text}"

                if skills_used_payload is None:

                    skills_used_payload = []

                self._selected_skills = list(selected_skills or [])

        except Exception as e:

            logger.debug(f"[skills] inject skills failed (ignored): {e}", exc_info=True)



        # Telemetry: record routing decision (even if none matched).

        try:

            enabled_dynamic = True

            try:

                from ah32.config import settings as _settings



                enabled_dynamic = bool(getattr(_settings, "enable_dynamic_skills", True))

            except Exception:

                enabled_dynamic = True

            tsvc = get_telemetry()

            if tsvc:

                tsvc.emit(

                    "skills.selected",

                    {

                        "skills": list(skills_used_payload or []),

                        "injected_chars": int(skills_injected_chars or 0),

                        "truncated": bool(skills_truncated),

                        "enabled_dynamic": bool(enabled_dynamic),

                        "lazy_activation_calls": int(max(0, lazy_calls_delta)),

                        "lazy_activation_cache_hits": int(max(0, lazy_cache_hits_delta)),

                        "lazy_activation_ms": float(max(0.0, lazy_total_ms_delta)),

                        "lazy_activated_skills": list(lazy_activated_skills),

                    },

                    ctx=getattr(self, "_turn_run_context", None),

                )

        except Exception as e:

            logger.debug(f"[telemetry] emit skills.selected failed: {e}", exc_info=True)



        # Inject user-provided rule files (Claude.md-like), loaded each turn.

        # Rules should override Skills when conflicts arise, so inject them after Skills.

        try:

            from ah32.config import settings

            from ah32.services.conversation_rules import load_rule_files, render_rules_for_prompt

            from pathlib import Path



            rule_paths = (

                [Path(p) for p in (rule_files or []) if p]

                if rule_files

                else settings.get_conversation_rule_file_paths()

            )

            rules = load_rule_files(rule_paths, max_total_chars=settings.conversation_rule_files_max_chars)

            rules_text = render_rules_for_prompt(rules)

            if rules_text:

                context = f"{context}\n\n{rules_text}"

        except Exception as e:

            logger.debug(f"[rules] inject rule files failed (ignored): {e}", exc_info=True)



        # Inject RAG snippets (knowledge base) into the context for this turn.

        at_paths = []

        try:

            at_paths = (relevant_memory.get("at_reference_context") or {}).get("at_references_paths") or []

        except Exception:

            at_paths = []

        rag_context = self._build_rag_context(

            normalized_message, at_paths if isinstance(at_paths, list) else None

        )

        if rag_context:

            context = f"{context}\n\n{rag_context}"

        try:
            self._turn_rag_context = str(rag_context or "")
        except Exception:
            pass

        try:

            tsvc = get_telemetry()

            if tsvc:

                dbg = self._last_rag_debug

                if not isinstance(dbg, dict):

                    dbg = {

                        "triggered": bool(self.vector_store),

                        "raw": 0,

                        "kept": 0,

                        "injected_chars": len(rag_context or ""),

                        "truncated": False,

                    }

                tsvc.emit("rag.retrieve", dbg, ctx=getattr(self, "_turn_run_context", None))

        except Exception as e:

            logger.debug(f"[telemetry] emit rag.retrieve failed: {e}", exc_info=True)



        want_writeback = False

        writeback_anchor = "cursor"

        writeback_delivery = ""



        # If user intent is to write the result into the WPS document, instruct the LLM

        # to include an executable Plan JSON (the frontend will run it automatically).

        #

        # IMPORTANT: do NOT gate this on RAG. Many writeback tasks (tables/formatting/cover pages)

        # do not require retrieval, but still must produce runnable plans (MacroBench relies on this).

        host_app = ""

        try:

            host_app = str(getattr(getattr(self, "_turn_run_context", None), "host_app", "") or "").strip().lower()

        except Exception:

            host_app = ""

        is_office_host = host_app in ("wps", "writer", "et", "wpp")
        chat_only_turn = False
        try:
            chat_only_turn = self._is_chat_only_intent(normalized_message)
        except Exception as e:
            logger.debug(f"[writeback] chat-only detect failed (ignored): {e}", exc_info=True)
            chat_only_turn = False
        # Skill tools may declare "background" tasks (e.g. crawling/ingestion). When the user intent
        # matches those triggers, we should not go through the writeback Plan fast-path.
        try:
            if (not chat_only_turn) and is_office_host:
                if self._force_chat_only_by_skill_tool_hints(normalized_message, selected_skills or []):
                    chat_only_turn = True
        except Exception as e:
            logger.debug(f"[writeback] skill tool chat-only override failed (ignored): {e}", exc_info=True)

        explicit_writeback_intent = False
        try:
            explicit_writeback_intent = self._is_writeback_intent(normalized_message, context=context)
        except Exception as e:
            logger.debug("[writeback] explicit intent detect failed (ignored): %s", e, exc_info=True)
            explicit_writeback_intent = False

        skill_default_writeback = ""
        try:
            skill_default_writeback = str(self._selected_default_writeback_delivery(selected_skills or []) or "").strip()
        except Exception as e:
            logger.debug("[writeback] skill default delivery detect failed (ignored): %s", e, exc_info=True)
            skill_default_writeback = ""

        # Routing rule (project invariant):
        # - "Writeback" means: frontend JS will execute a Plan JSON to mutate the WPS document.
        # - Default is CHAT (no writeback). Only write back when:
        #   1) user explicitly asks to write into the document, OR
        #   2) the selected skill declares a default writeback delivery.
        should_writeback = False
        if is_office_host:
            should_writeback = (not chat_only_turn) and (explicit_writeback_intent or bool(skill_default_writeback))
        else:
            # Non-office hosts: never default-writeback; require explicit intent.
            should_writeback = (not chat_only_turn) and bool(explicit_writeback_intent)

        if should_writeback:

            try:

                want_writeback = True

                writeback_anchor = self._writeback_anchor(normalized_message)



                # Skill-driven delivery mode: some scenarios prefer "compare table first" instead of direct rewrite.

                delivery = ""

                try:

                    delivery = skill_default_writeback or self._selected_default_writeback_delivery(selected_skills or [])

                except Exception:

                    delivery = ""



                # Safety default: review compare tables should go to document end unless user explicitly says "光标/当前位置".

                if delivery == "compare_table" and self._is_compare_table_delivery_intent(normalized_message):

                    writeback_delivery = "compare_table"

                    try:

                        if not re.search(r"(光标|当前位置|当前光标|此处|这里)", normalized_message):

                            writeback_anchor = "end"

                    except Exception:

                        writeback_anchor = "end"

                    context = f"{context}\n\n{self._build_compare_table_writeback_directive(normalized_message)}"

                else:

                    writeback_delivery = ""

                    context = f"{context}\n\n{self._build_writeback_directive(normalized_message)}"

            except Exception as e:

                logger.debug(f"[writeback] build writeback directive failed (ignored): {e}", exc_info=True)

        logger.debug(
            "[writeback] decision host_app=%r office=%s chat_only=%s explicit=%s skill_default=%s want=%s anchor=%s delivery=%s",
            host_app,
            is_office_host,
            chat_only_turn,
            explicit_writeback_intent,
            skill_default_writeback,
            want_writeback,
            writeback_anchor,
            writeback_delivery,
        )

        # Persist per-turn decision so downstream post-processing can reliably decide whether
        # to keep/strip executable fenced blocks from model output.
        self._turn_want_writeback = bool(want_writeback)
        try:
            self._turn_writeback_anchor = str(writeback_anchor or "cursor")
        except Exception:
            pass
        try:
            self._turn_writeback_delivery = str(writeback_delivery or "")
        except Exception:
            pass

        if show_rag_hits:

            try:

                dbg = self._last_rag_debug or {}

                kept = int(dbg.get("kept") or 0)

                sources = dbg.get("sources") or []

                preview = ", ".join([str(s.get("source")) for s in sources[:3] if isinstance(s, dict)])

                yield {

                    "type": "rag",

                    "content": f"RAG命中: {kept}，sources: {preview}" if preview else f"RAG命中: {kept}",

                    "session_id": session_id,

                }

            except Exception as e:

                logger.debug(f"[RAG] emit rag debug event failed: {e}", exc_info=True)



        # Skill hint (early): show which skills were selected for prompt injection for this turn.

        # This makes the UI immediately reflect the routing decision, even before the model responds.

        if skills_used_payload is not None and self.skills_registry is not None:

            try:

                selected_payload = list(skills_used_payload or [])[:4]

                names = [s.get("name") for s in selected_payload if isinstance(s, dict) and s.get("name")]

                if names:

                    yield {

                        "type": "skills",

                        "content": "已选择技能: " + "、".join(names[:4]),

                        "skills": selected_payload,

                        "skills_kind": "selected",

                        "skills_phase": "selected",

                        "skills_metrics": {
                            "lazy_activation_calls": int(max(0, lazy_calls_delta)),
                            "lazy_activation_cache_hits": int(max(0, lazy_cache_hits_delta)),
                            "lazy_activation_ms": float(max(0.0, lazy_total_ms_delta)),
                            "lazy_activated_skills": list(lazy_activated_skills),
                            "front_router": front_router_metrics,
                            "front_allow_skill_ids": list(allow_skill_ids or []),
                        },

                        "session_id": session_id,

                    }

                else:

                    yield {

                        "type": "skills",

                        "content": "未命中场景技能",

                        "skills": [],

                        "skills_kind": "none",

                        "skills_phase": "selected",

                        "skills_metrics": {
                            "lazy_activation_calls": int(max(0, lazy_calls_delta)),
                            "lazy_activation_cache_hits": int(max(0, lazy_cache_hits_delta)),
                            "lazy_activation_ms": float(max(0.0, lazy_total_ms_delta)),
                            "lazy_activated_skills": list(lazy_activated_skills),
                            "front_router": front_router_metrics,
                            "front_allow_skill_ids": list(allow_skill_ids or []),
                        },

                        "session_id": session_id,

                    }

            except Exception as e:

                logger.debug(f"[skills] emit selected skills event failed: {e}", exc_info=True)



        # 3. 发送开始事件

        yield {"type": "start", "content": "", "session_id": session_id}



        if want_writeback:
            # Fast path: writeback intents should produce runnable plans deterministically.
            # Falling back to the full ReAct loop is still allowed (for compatibility),
            # but we prefer a dedicated plan prompt + faster model to reduce repair loops.
            try:
                yield {"type": "thinking", "content": "正在生成可执行 Plan...", "session_id": session_id}
                plan = await self._generate_writeback_plan_fast_path(
                    user_query=normalized_message,
                    context=context,
                    session_id=session_id,
                    document_name=document_name,
                    frontend_context=frontend_context,
                    anchor=writeback_anchor,
                    delivery=writeback_delivery,
                )
                if plan:
                    # IMPORTANT: do NOT embed executable plan JSON in user-visible chat content.
                    # Deliver the plan via a dedicated SSE event (frontend will render a plan card and
                    # gate writeback execution on this event only).
                    try:
                        self._turn_last_plan = plan
                    except Exception:
                        pass
                    yield {"type": "plan", "plan": plan, "session_id": session_id}

                    msg = "已生成可执行计划。请在计划卡片中点击“应用写回”。"
                    self._last_response = msg
                    yield {"type": "content", "content": msg, "session_id": session_id}
                else:
                    msg = "未能生成可执行计划（Plan JSON）。请重试。"
                    self._last_response = msg
                    yield {"type": "content", "content": msg, "session_id": session_id}
            except Exception as e:
                logger.error(f"[writeback] plan fast path failed: {e}", exc_info=True)
                msg = "生成可执行计划失败。请重试（或缩小改动范围）。"
                self._last_response = msg
                yield {"type": "content", "content": msg, "session_id": session_id}
        else:

            # 6. 执行ReAct循环（流式版本）

            async for event in self._stream_react_loop(normalized_message, context, session_id):

                yield event



        # 7. 存储对话到记忆

        final_response = getattr(self, "_last_response", "")

        

        # 调试日志：显示完整响应内容

        logger.debug(f"[记忆存储] 开始存储对话")

        logger.debug(f"[记忆存储] user_message: {message[:100]}...")

        logger.debug(f"[记忆存储] final_response: '{final_response[:200] if final_response else '(empty)'}...'")

        logger.debug(f"[记忆存储] _last_response属性值: '{getattr(self, '_last_response', 'NOT_SET')}'")

        logger.debug(f"[记忆存储] session_id: {session_id}")



        # Writeback guard: if we instructed the model to output a Plan but it did not,
        # retry once and/or surface an explicit hint (do not pretend success).
        already_repaired = False
        try:
            already_repaired = bool(getattr(self, "_turn_writeback_repair_attempted", False))
        except Exception:
            already_repaired = False
        if want_writeback and (not already_repaired) and (not getattr(self, "_turn_last_plan", None)):
            try:
                host = host_app if host_app in ("wps", "et", "wpp") else "wps"
                plan_obj, plan_err = self._extract_plan_from_text(final_response or "", host)
                if (not final_response) or (not self._response_has_strict_plan_block(final_response, host)):
                    repaired = await self._auto_repair_missing_writeback_plan(
                        user_query=normalized_message,
                        rag_context=rag_context or "",
                        session_id=session_id,
                        anchor=writeback_anchor,
                        delivery=writeback_delivery,
                        original_plan=plan_obj,
                        error_type="missing_plan" if (not plan_err or plan_err == "empty_plan_payload") else "invalid_plan",
                        error_message=plan_err or "",
                    )
                    if repaired:
                        try:
                            self._turn_last_plan = repaired
                        except Exception:
                            pass
                        yield {"type": "plan", "plan": repaired, "session_id": session_id}
                    else:
                        # Do not pretend success; tell the user clearly what went wrong.
                        msg = (
                            "\n\n【系统提示】本轮需要写入文档，但未生成可执行的 Plan JSON（模型可能输出了 HTML/纯文本）。"
                            "请点击重试，或在提问中明确“只输出 Plan JSON 代码块”。"
                        )
                        final_response = (final_response or "") + msg
                        self._last_response = final_response
                        yield {"type": "content", "content": msg, "session_id": session_id}
            except Exception as e:
                logger.error(f"[writeback] auto-repair missing plan failed: {e}", exc_info=True)
        # NOTE: Persisting to vector DB can be slow (embeddings + Chroma upsert).

        # Don't block the SSE 'done' event on this, otherwise the frontend will

        # appear "stuck" even after content is already rendered.

        if final_response:

            import asyncio



            async def _persist():

                try:

                    meta = {

                        # NOTE: tool_calls can include verbose implementation details.

                        # For bench runs, keep them out of long-lived memories to avoid polluting future sessions.

                        "tool_calls": [] if bench_mode else [call.to_dict() for call in self.tool_calls],

                        "streaming": True,

                        "bench": bench_mode,

                    }

                    await self.memory_system.store_conversation(

                        session_id=session_id,

                        user_message=normalized_message,

                        assistant_response=final_response,

                        metadata=meta,

                    )

                except Exception as e:

                    logger.error(f"[记忆存储] 异步持久化失败: {e}", exc_info=True)



            asyncio.create_task(_persist())

        else:

            logger.warning(f"[记忆存储] 未找到最终响应，跳过记忆存储，session_id: {session_id}")



        # Post-hoc skill hint: show skills that appear to be applied in the final output (heuristic).

        # This makes the UI display more accurate than "selected for prompt injection".

        if skills_used_payload is not None and self.skills_registry is not None:

            try:

                applied = self.skills_registry.detect_applied_skills(

                    final_response,

                    selected=selected_skills or None,

                )

                applied_ids = {x["skill"].skill_id for x in (applied or []) if isinstance(x, dict) and x.get("skill")}

                applied_payload = [s for s in (skills_used_payload or []) if isinstance(s, dict) and s.get("id") in applied_ids]

                try:

                    tsvc = get_telemetry()

                    if tsvc:

                        tsvc.emit(

                            "skills.applied",

                            {

                                "applied_ids": sorted(list(applied_ids)),

                                "selected_ids": sorted(

                                    [str(s.get("id")) for s in (skills_used_payload or []) if isinstance(s, dict) and s.get("id")]

                                ),

                            },

                            ctx=getattr(self, "_turn_run_context", None),

                        )

                except Exception as e:

                    logger.debug(f"[telemetry] emit skills.applied failed: {e}", exc_info=True)



                # Skill hint (late): after the response is produced, report whether the output actually

                # applied a skill template/structure. If not, still echo the selected skills so the UI

                # doesn't look "wrong" for topic-focused chats.

                selected_payload = list(skills_used_payload or [])[:4]



                if applied_payload:

                    payload = applied_payload

                    names = [s.get("name") for s in payload if isinstance(s, dict) and s.get("name")]

                    msg = ("命中技能: " + "、".join(names[:4])) if names else "未命中场景技能"

                    kind = "applied"

                elif selected_payload:

                    # "实事求是": do not pretend the skill was applied. Report selection in hint only.

                    names = [s.get("name") for s in selected_payload if isinstance(s, dict) and s.get("name")]

                    msg = ("输出未显式应用技能模板（已选择: " + "、".join(names[:4]) + "）") if names else "未命中场景技能"

                    kind = "applied_none"

                    payload = []

                else:

                    payload = []

                    msg = "未命中场景技能"

                    kind = "none"



                yield {

                    "type": "skills",

                    "content": msg,

                    "skills": payload,

                    "skills_kind": kind,

                    "skills_phase": "applied",

                    "session_id": session_id,

                }

            except Exception as e:

                logger.debug(f"[skills] emit applied skills event failed: {e}", exc_info=True)



        # 清理推理内容跟踪器

        self._last_reasoning_content = None



        done_payload = {"type": "done", "content": "", "session_id": session_id}

        # Frontend may auto-enqueue writeback on `done`. Provide an explicit, authoritative
        # server-side decision to avoid spurious "写回失败" on pure chat turns (e.g. "你好").
        try:
            done_payload["want_writeback"] = bool(getattr(self, "_turn_want_writeback", False))
        except Exception as e:
            logger.debug("[output-guard] attach want_writeback failed (ignored): %s", e, exc_info=True)

        try:

            acc = getattr(self, "_token_usage_acc", None)

            if isinstance(acc, dict):

                done_payload["token_usage"] = dict(acc)

        except Exception as e:

            logger.debug(f"[token] attach token_usage failed (ignored): {e}", exc_info=True)

        try:

            tsvc = get_telemetry()

            if tsvc:

                t0 = getattr(self, "_turn_started_at_perf", None)

                chat_ms = int((time.perf_counter() - float(t0)) * 1000) if t0 else 0

                tsvc.emit(

                    "chat.turn_done",

                    {

                        "ok": True,

                        "chat_ms": chat_ms,

                        "first_token_ms": getattr(self, "_turn_first_llm_ms", None),

                        "llm_total_ms": getattr(self, "_turn_llm_total_ms", 0),

                        "token_usage": done_payload.get("token_usage"),

                    },

                    ctx=getattr(self, "_turn_run_context", None),

                )

        except Exception as e:

            logger.debug(f"[telemetry] emit chat.turn_done failed: {e}", exc_info=True)

        yield done_payload



    async def _stream_react_loop(self, message: str, context: str, session_id: str):

        """流式ReAct循环



        Yields:

            dict: 事件流

        """

        max_iterations = 5

        iteration = 0



        # 构建完整的消息历史，包括之前的对话历史

        logger.debug(f"[上下文内容] 上下文长度: {len(context)} 字符")

        if "对话历史" in context:

            logger.debug(f"[上下文内容] 包含对话历史")

        logger.debug(f"[上下文内容] 前200字符: {context[:200]}...")



        # 获取JS宏历史错误警告（用于生成阶段）
        # TODO: 接入持久化的宏错误记录后再填充这里。
        js_macro_history_warning = ""

        # 构建最终的系统提示（包含历史错误警告）
        final_system_prompt = self.system_prompt
        if js_macro_history_warning:
            insertion = "\n\n" + js_macro_history_warning.strip()
            # 如果系统提示仍包含 {tools} 占位符，则把警告拼接到工具列表后，
            # 以便后续填充工具列表时一起生效。
            if "{tools}" in final_system_prompt:
                final_system_prompt = final_system_prompt.replace("{tools}", "{tools}" + insertion)
            else:
                final_system_prompt += insertion
        # If the user explicitly signals "go ahead", treat it as authorization to

        # proceed with the previously suggested next step, instead of asking again.

        # This reduces manual confirmation loops in a dev/testing environment.

        auto_exec_keywords = (

            "接受建议",

            "继续",

            "继续执行",

            "开始执行",

            "按你推荐",

            "就按你说的",

            "同意",

            "直接执行",

            "不用确认",

            "执行吧",

            "就这么办",

            "OK",

            "ok",

        )

        auto_exec_numeric_choice = (message or "").strip() in ("1", "2", "3")

        if any(k in (message or "") for k in auto_exec_keywords) or auto_exec_numeric_choice:

            final_system_prompt += (

                "\n\n【自动执行模式】用户已明确授权你直接执行你建议的下一步。"

                "除非你无法确定目标文档/写入位置或存在明显破坏性操作，否则不要反问让用户二选一；"

                "请直接产出可执行的交付物并完成该步：优先输出可执行 Plan JSON；仅当用户明确要求“JS宏/JavaScript”时才输出 JS 宏。"

            )


        # Per-turn output mode guard:
        # - When we do NOT intend to write back, explicitly forbid any fenced code blocks.
        #   This prevents Skills (or stale chat history) from accidentally emitting JS/Plan payloads,
        #   which would trigger frontend auto-writeback and surface "写回失败" for harmless chat like "你好".
        # - When we DO intend to write back, require a single Plan JSON block (no JS macros).
        # NOTE: _stream_react_loop doesn't compute writeback intent itself; stream_chat sets
        # `self._turn_want_writeback` after routing/intent detection.
        want_writeback = bool(getattr(self, "_turn_want_writeback", False))

        turn_directive = (
            "【本轮输出模式】本轮不需要写回文档：只用自然语言回答（简洁优先）；不要输出任何 fenced 代码块（不要 ```json``` / ```javascript```）；不要粘贴/复述文档原文（如需引用，最多1句且<=50字）。"
            if not want_writeback
            else f"【本轮输出模式】本轮需要写回文档：请只输出 1 个 ```json``` 代码块（仅 JSON），schema_version 必须是 {PLAN_SCHEMA_ID}；不要输出 JS 宏。"
        )

        # IMPORTANT: Put dynamic context (skills/rules/RAG hints) *before* the core system prompt,
        # and put the turn directive last so it remains authoritative.
        messages = [("system", context), ("system", final_system_prompt), ("system", turn_directive), ("user", message)]



        while iteration < max_iterations:

            iteration += 1



            # 发送思考中事件

            yield {

                "type": "thinking",

                "content": f"正在分析... (步骤 {iteration})",

                "session_id": session_id,

            }



            # 重置推理内容跟踪器（每个迭代步骤独立）

            self._last_reasoning_content = None



            # 调用LLM获取思考和行动

            llm_start_time = time.time()

            logger.info(f"[LLM监控] 第 {iteration} 步LLM调用开始时间: {datetime.fromtimestamp(llm_start_time).strftime('%Y-%m-%d %H:%M:%S')}")



            try:
                response = await self.llm.ainvoke(messages)
            except asyncio.CancelledError:
                logger.info("[LLM监控] 第 %s 步LLM调用被取消", iteration)
                raise

            self._accumulate_token_usage(response)



            llm_end_time = time.time()

            llm_duration = llm_end_time - llm_start_time

            logger.info(f"[LLM监控] 第 {iteration} 步LLM调用结束时间: {datetime.fromtimestamp(llm_end_time).strftime('%Y-%m-%d %H:%M:%S')}")

            logger.info(f"[LLM监控] 第 {iteration} 步LLM响应时间: {llm_duration:.2f}秒")

            try:

                ms = int(max(0.0, float(llm_duration)) * 1000)

                self._turn_llm_total_ms = int(getattr(self, "_turn_llm_total_ms", 0) or 0) + ms

                if iteration == 1 and not getattr(self, "_turn_first_llm_ms", None):

                    self._turn_first_llm_ms = ms

                tsvc = get_telemetry()

                if tsvc:

                    tsvc.emit(

                        "chat.llm_call",

                        {"iteration": iteration, "llm_ms": ms},

                        ctx=getattr(self, "_turn_run_context", None),

                    )

            except Exception as e:

                logger.debug(f"[telemetry] emit chat.llm_call failed: {e}", exc_info=True)



            # 处理DeepSeek思考模式的reasoning_content

            reasoning = None

            if hasattr(response, "additional_kwargs") and response.additional_kwargs:

                reasoning = response.additional_kwargs.get("reasoning_content")



            if reasoning:

                logger.debug(f"[推理] 步骤 {iteration} - reasoning_content: {reasoning[:200]}...")

                yield {"type": "reasoning", "content": reasoning, "session_id": session_id}

            else:

                logger.debug(f"[推理] 步骤 {iteration} - 未获取到 reasoning_content")



            tool_call = self._parse_tool_call(response.content)



            if tool_call:

                tool_name = str(tool_call.get("action") or tool_call.get("name") or "unknown")

                tool_input = tool_call.get("input") if "action" in tool_call else tool_call.get("arguments", {})



                # 记录工具调用（不发送给用户）

                logger.debug(f"=== 工具调用 ===")

                logger.debug(f"工具名称: {tool_name}")

                logger.debug(f"输入参数: {tool_input}")

                # 不yield tool_call事件，避免暴露内部实现



                # 执行工具

                result = await self._execute_tool(tool_call)



                # 记录工具调用

                call = ToolCall(tool_name, tool_call, result)

                self.tool_calls.append(call)



                # 将结果转换为自然语言描述（不暴露工具名称和JSON格式）

                # 这里需要根据工具类型转换

                if tool_name == "import_documents":

                    # 导入工具的结果，直接作为系统提示

                    pass  # 工具结果会在最终响应中处理

                elif tool_name in ["list_open_documents", "read_document"]:

                    # 文档操作工具，提取关键信息

                    pass  # 工具结果会在最终响应中处理

                else:

                    # 其他工具，结果在最终响应中处理

                    pass  # 工具结果会在最终响应中处理



                # 不发送tool_result事件，避免暴露内部实现

                # 工具结果会在最终响应中以自然语言形式呈现



                # 添加到消息历史（用于内部处理）- 传递实际结果让LLM决定下一步

                messages.append(("assistant", response.content))

                messages.append(("user", f"TOOL_RESULT: {result}"))



            else:

                # 没有工具调用，生成最终响应

                logger.info(f"[ReAct] 无工具调用，tool_calls数量: {len(self.tool_calls)}")

                if self.tool_calls:

                    # 有工具调用结果，流式生成最终响应

                    async for event in self._stream_final_response(message, messages, session_id):

                        yield event

                else:

                    # 无工具调用：避免再次调用LLM生成“最终答案”。

                    # 这里的 response.content 已经是带上下文的最终回复（且已通过 tool_call 解析确认不是工具调用）。

                    full_response = getattr(response, "content", None)

                    if full_response is None:

                        full_response = str(response)



                    processed_response = await self._send_response_with_code_check(full_response, session_id)

                    if processed_response:

                        yield {"type": "content", "content": processed_response, "session_id": session_id}

                    else:

                        # Never end a turn without any visible output; otherwise the UI/bench sees "no assistant message".

                        logger.warning("[ReAct] processed_response为空，发送可见错误提示（避免静默失败）")

                        hint = "【系统提示】本轮模型没有返回可显示内容（可能是模型/网络异常）。请重试。"

                        yield {"type": "content", "content": hint, "session_id": session_id}

                        processed_response = hint



                    # 保存最终响应以供后续记忆存储（优先保存用户实际看到的内容）

                    self._last_response = processed_response or (full_response or "")

                return



        # 超过最大迭代次数

        yield {

            "type": "content",

            "content": f"已执行{len(self.tool_calls)}个工具，分析完成。",

            "session_id": session_id,

        }



    async def _stream_final_response(self, message: str, messages: List, session_id: str):

        """流式生成最终响应



        Yields:

            dict: content事件

        """

        # 构建分析结果（转换为自然语言描述）

        analysis_result = ""

        for call in self.tool_calls:

            if call.result:

                # 转换工具结果为自然语言描述

                result = _format_result_for_user(call.tool_name, call.result)

                analysis_result += result + "\n\n"



        # 获取智能建议

        final_info = analysis_result.strip()



        # 在 messages 基础上添加最终响应提示

        messages.append(

            (

                "system",

                "\n请根据以上工具执行结果直接回复用户。\n\n要求：\n1. 直接回答用户问题\n2. 语言自然、简洁\n3. 以专业顾问的口吻\n4. 不要提及工具调用过程",

            )

        )



        # 使用包含工具结果的 messages 生成最终响应



        # 使用流式响应

        full_response = ""



        # 兼容性检查：确保 astream 返回异步生成器

        astream_result = self.llm.astream(messages)



        # 检查是否是异步生成器

        import inspect

        if inspect.isasyncgen(astream_result):

            # 标准异步生成器，使用 async for 迭代

            async for chunk in astream_result:

                # 处理DeepSeek思考模式（累积显示）

                reasoning = None

                if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:

                    reasoning = chunk.additional_kwargs.get("reasoning_content")



                if reasoning:

                    # 每次都发送完整的 reasoning_content（前端累积显示）

                    logger.debug(f"[推理] 流式响应 - reasoning_content: {reasoning[:200]}...")

                    yield {"type": "reasoning", "content": reasoning, "session_id": session_id}

                else:

                    logger.debug(f"[推理] 流式响应 - 未获取到 reasoning_content")



                # 收集响应内容，但先不发送给前端

                if hasattr(chunk, "content") and chunk.content:

                    content = chunk.content

                    full_response += content

        else:

            # 如果不是异步生成器，说明是普通响应对象，直接获取 content

            if hasattr(astream_result, "content"):

                full_response = astream_result.content

            else:

                full_response = str(astream_result)



        # 统一处理响应发送（含代码质量检查）

        logger.debug(f"[ReAct] 开始发送最终响应，原始响应长度: {len(full_response)}")

        processed_response = await self._send_response_with_code_check(full_response, session_id)

        logger.debug(f"[ReAct] 代码检查完成，处理后响应长度: {len(processed_response) if processed_response else 0}")



        # 发送处理后的响应

        if processed_response:

            logger.debug(f"[ReAct] 发送content事件，响应长度: {len(processed_response)}")

            yield {"type": "content", "content": processed_response, "session_id": session_id}

        else:

            # Never end a turn without any visible output; otherwise the UI/bench sees "no assistant message".

            logger.warning("[ReAct] processed_response为空，发送可见错误提示（避免静默失败）")

            hint = "【系统提示】本轮模型没有返回可显示内容（可能是模型/网络异常）。请重试。"

            yield {"type": "content", "content": hint, "session_id": session_id}

            processed_response = hint



        # 保存最终响应以供后续使用

        # 确保即使空响应也被保存；优先保存用户实际看到的（可能已自动改写代码）。

        final_to_store = processed_response or full_response or ""

        self._last_response = final_to_store

        logger.debug(f"[记忆存储] _last_response 已设置为: '{final_to_store[:100] if final_to_store else '(empty)'}...'")



    async def _stream_direct_response(self, message: str, context: str, session_id: str):

        """流式直接响应（无工具调用）



        Args:

            message: 用户消息

            context: 对话上下文

            session_id: 会话ID



        Yields:

            dict: content事件

        """

        # 构建直接响应消息，包含上下文

        # Same ordering rationale as the main loop: keep dynamic context first and the core
        # system prompt last so it remains authoritative.
        #
        # Also apply a per-turn output mode guard. We don't have `want_writeback` here, so infer it
        # from the injected context directives.
        inferred_writeback = False
        try:
            c = str(context or "")
            inferred_writeback = ("【写回文档指令】" in c) or ("schema_version" in c and PLAN_SCHEMA_ID in c)
        except Exception as e:
            logger.debug("[output-guard] infer writeback failed (ignored): %s", e, exc_info=True)
            inferred_writeback = False
        turn_directive = (
            "【本轮输出模式】本轮不需要写回文档：只用自然语言回答；不要输出任何 fenced 代码块（不要 ```json``` / ```javascript```）；不要粘贴/复述文档原文（如需引用，最多1句且<=50字）。"
            if not inferred_writeback
            else f"【本轮输出模式】本轮需要写回文档：请只输出 1 个 ```json``` 代码块（仅 JSON），schema_version 必须是 {PLAN_SCHEMA_ID}；不要输出 JS 宏。"
        )
        messages = [
            ("system", context),  # 使用传入的上下文
            ("system", self.system_prompt),
            ("system", turn_directive),
            ("user", message),
        ]



        # 使用流式响应

        full_response = ""

        reasoning_content = ""



        # 兼容性检查：确保 astream 返回异步生成器

        astream_result = self.llm.astream(messages)



        import inspect

        if inspect.isasyncgen(astream_result):

            # 标准异步生成器，使用 async for 迭代

            async for chunk in astream_result:

                self._accumulate_token_usage(chunk)

                # 处理DeepSeek思考模式

                if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:

                    reasoning = chunk.additional_kwargs.get("reasoning_content")

                    if reasoning:

                        reasoning_content += reasoning



                # 收集响应内容，但先不发送给前端

                if hasattr(chunk, "content") and chunk.content:

                    content = chunk.content

                    full_response += content

        else:

            # 如果不是异步生成器，说明是普通响应对象，直接获取 content

            if hasattr(astream_result, "content"):

                full_response = astream_result.content

            else:

                full_response = str(astream_result)



        # 🔍 发送思考过程（如果有）

        if reasoning_content:

            yield {"type": "reasoning", "content": reasoning_content, "session_id": session_id}



        # 统一处理响应发送（含代码质量检查）

        logger.debug(f"[ReAct] 开始发送最终响应，原始响应长度: {len(full_response)}")

        processed_response = await self._send_response_with_code_check(full_response, session_id)

        logger.debug(f"[ReAct] 代码检查完成，处理后响应长度: {len(processed_response) if processed_response else 0}")



        # 发送处理后的响应

        if processed_response:

            logger.debug(f"[ReAct] 发送content事件，响应长度: {len(processed_response)}")

            yield {"type": "content", "content": processed_response, "session_id": session_id}

        else:

            logger.warning(f"[ReAct] processed_response为空，不发送content事件")



        # 保存最终响应以供后续使用

        # 确保即使空响应也被保存；优先保存用户实际看到的（可能已自动改写代码）。

        final_to_store = processed_response or full_response or ""

        self._last_response = final_to_store

        logger.debug(f"[记忆存储] _last_response 已设置为: '{final_to_store[:100] if final_to_store else '(empty)'}...'")



    @staticmethod
    def _strip_fenced_code_blocks(text: str) -> str:
        """Remove triple-backtick fenced blocks from a model response (best-effort).

        Frontend auto-detects fenced blocks and may enqueue writeback execution. For turns that
        are not intended to write back, we keep outputs strictly non-executable.
        """
        s = str(text or "")
        if "```" not in s:
            return s
        try:
            # Remove any fenced blocks (```...```), including language tags.
            s2 = re.sub(r"```[\w.-]*\s*[\s\S]*?```", "", s)
            # If the model leaked stray fences, strip them too.
            s2 = s2.replace("```", "")
            # Normalize whitespace so the UI doesn't show large gaps.
            s2 = re.sub(r"\n{3,}", "\n\n", s2).strip()
            return s2
        except Exception as e:
            logger.debug("[output-guard] strip fenced blocks failed (ignored): %s", e, exc_info=True)
            return s

    @staticmethod
    def _keep_single_plan_fence(text: str) -> str:
        """Keep only one executable Plan JSON fence in a response (best-effort).

        Some models may emit multiple ```json``` fences. Frontend will detect and execute each fenced plan,
        which can accidentally pollute the document (e.g., a second "reply user" plan inserting chatty text).
        """
        s = str(text or "")
        if "```" not in s:
            return s

        try:
            plan_re = re.compile(r"```(?:json|plan|ah32[-_.]?plan(?:\.v1)?)\s*([\s\S]*?)```", re.IGNORECASE)
            matches = list(plan_re.finditer(s))
            if len(matches) <= 1:
                return s

            def _is_plan_candidate(body: str) -> bool:
                try:
                    t = str(body or "").strip()
                    if not t:
                        return False

                    # Handle malformed captures like "json\\n{...}" or accidental wrappers.
                    nl = t.find("\n")
                    if 0 < nl <= 20:
                        first = t[:nl].strip().lower()
                        rest = t[nl + 1 :].strip()
                        if (
                            first == "json" or first == "plan" or first.startswith("ah32")
                        ) and rest.startswith("{"):
                            t = rest

                    try:
                        obj = json.loads(t)
                    except json.JSONDecodeError:
                        obj = None
                    except Exception as e:
                        logger.debug(
                            "[output-guard] json.loads(t) failed unexpectedly (ignored): %s",
                            e,
                            exc_info=True,
                        )
                        obj = None
                    if isinstance(obj, dict) and obj.get("schema_version") == PLAN_SCHEMA_ID:
                        return True

                    fb = t.find("{")
                    lb = t.rfind("}")
                    if fb < 0 or lb <= fb:
                        return False
                    try:
                        obj = json.loads(t[fb : lb + 1])
                        return isinstance(obj, dict) and obj.get("schema_version") == PLAN_SCHEMA_ID
                    except json.JSONDecodeError:
                        return False
                    except Exception as e:
                        logger.debug(
                            "[output-guard] json.loads(slice) failed unexpectedly (ignored): %s",
                            e,
                            exc_info=True,
                        )
                        return False
                except Exception as e:
                    logger.debug(
                        "[output-guard] plan candidate scan failed (ignored): %s",
                        e,
                        exc_info=True,
                    )
                    return False

            keep_idx = None
            for idx, m in enumerate(matches):
                if _is_plan_candidate(m.group(1)):
                    keep_idx = idx
                    break
            if keep_idx is None:
                keep_idx = 0

            out_parts = []
            cursor = 0
            for idx, m in enumerate(matches):
                out_parts.append(s[cursor : m.start()])
                if idx == keep_idx:
                    out_parts.append(s[m.start() : m.end()])
                cursor = m.end()
            out_parts.append(s[cursor:])
            return "".join(out_parts).strip()
        except Exception as e:
            logger.debug("[output-guard] keep single plan fence failed (ignored): %s", e, exc_info=True)
            return s

    def _is_known_tool_name(self, name: str) -> bool:
        """Best-effort: check if a tool name is known (built-in or selected-skill tool)."""
        tool = str(name or "").strip()
        if not tool:
            return False
        try:
            tools = getattr(self, "tools", None)
            if isinstance(tools, dict) and tool in tools:
                return True
        except Exception:
            logger.debug("[tools] check built-in tools failed (ignored)", exc_info=True)

        try:
            reg = getattr(self, "skills_registry", None)
            selected = getattr(self, "_selected_skills", None) or []
            if reg is not None and selected:
                for skill in selected:
                    try:
                        if reg.find_tool(skill.skill_id, tool) is not None:
                            return True
                    except Exception:
                        continue
        except Exception:
            logger.debug("[tools] check skill tools failed (ignored)", exc_info=True)
        return False

    def _strip_internal_json_objects(self, text: str) -> str:
        """Strip internal JSON payloads from user-visible output (best-effort).

        We must never leak:
        - Tool-call JSON objects (e.g. {"name": "read_document", ...})
        - Plan JSON objects (schema_version=ah32.plan.v1) on non-writeback turns

        This is a safety net; the primary mechanism is routing + tool parsing.
        """
        s = str(text or "")
        if "{" not in s:
            return s
        try:
            start_re = re.compile(r'\{\s*"(?:schema_version|name|action|error)"\s*:')
            matches = list(start_re.finditer(s))
            if not matches:
                return s

            decoder = json.JSONDecoder()
            spans: list[tuple[int, int]] = []
            for m in matches:
                start = m.start()
                try:
                    obj, end = decoder.raw_decode(s[start:])
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    logger.debug("[output-guard] raw_decode internal json failed (ignored): %s", e, exc_info=True)
                    continue

                if not isinstance(obj, dict):
                    continue

                is_plan = obj.get("schema_version") == PLAN_SCHEMA_ID
                is_tool_call = False
                is_error = False
                try:
                    if "name" in obj and isinstance(obj.get("name"), str):
                        is_tool_call = self._is_known_tool_name(obj.get("name"))
                    elif "action" in obj and isinstance(obj.get("action"), str):
                        is_tool_call = self._is_known_tool_name(obj.get("action"))
                    elif "error" in obj:
                        is_error = True
                except Exception as e:
                    logger.debug("[output-guard] check internal tool-call failed (ignored): %s", e, exc_info=True)
                    is_tool_call = False

                if is_plan or is_tool_call or is_error:
                    spans.append((start, start + int(end)))

            if not spans:
                return s

            # Merge overlapping spans (defensive).
            spans.sort()
            merged: list[tuple[int, int]] = []
            for a, b in spans:
                if not merged or a > merged[-1][1]:
                    merged.append((a, b))
                else:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], b))

            out = s
            for a, b in reversed(merged):
                out = out[:a] + out[b:]
            out = re.sub(r"\n{3,}", "\n\n", out).strip()
            return out
        except Exception as e:
            logger.debug("[output-guard] strip internal json objects failed (ignored): %s", e, exc_info=True)
            return s


    async def _send_response_with_code_check(self, full_response: str, session_id: str):
        """Send response without JS macro review (plan-only).

        Also strip any fenced blocks on non-writeback turns to prevent accidental auto-writeback.
        """
        try:
            if re.search(r"```(?:javascript|js)\s*\n", full_response or "", re.IGNORECASE):
                logger.warning("[plan-only] JS macro block detected in response; skipping macro review.")
        except Exception as e:
            logger.debug("[plan-only] macro block scan failed (ignored): %s", e, exc_info=True)

        want_writeback = False
        try:
            want_writeback = bool(getattr(self, "_turn_want_writeback", False))
        except Exception as e:
            logger.debug("[output-guard] read _turn_want_writeback failed (ignored): %s", e, exc_info=True)
            want_writeback = False

        if not want_writeback:
            stripped = self._strip_fenced_code_blocks(full_response)
            stripped2 = self._strip_internal_json_objects(stripped)
            try:
                # Redact accidental data URLs (they can be huge and should never appear in chat).
                stripped2 = re.sub(
                    r"data:image/[^;\\s]+;base64,[a-zA-Z0-9+/=\\s]{200,}",
                    "[data:image;base64 omitted]",
                    stripped2,
                    flags=re.IGNORECASE,
                )
            except Exception as e:
                logger.debug("[output-guard] redact data urls failed (ignored): %s", e, exc_info=True)
            if stripped2 != (stripped or ""):
                logger.info(
                    "[output-guard] stripped internal json (non-writeback) session_id=%s len_before=%s len_after=%s",
                    session_id,
                    len(stripped or ""),
                    len(stripped2 or ""),
                )
            if stripped != (full_response or ""):
                logger.info(
                    "[output-guard] stripped fenced blocks (non-writeback) session_id=%s len_before=%s len_after=%s",
                    session_id,
                    len(full_response or ""),
                    len(stripped or ""),
                )
            return stripped2

        host_app = ""
        try:
            host_app = str(getattr(getattr(self, "_turn_run_context", None), "host_app", "") or "").strip().lower()
        except Exception:
            host_app = ""
        host = host_app if host_app in ("wps", "et", "wpp") else "wps"

        # Writeback invariant: return a single executable Plan JSON fence and nothing else.
        plan = None
        plan_err = ""
        try:
            plan, plan_err = self._extract_plan_from_text(full_response or "", host)
            if plan is not None:
                return f"```json\n{json.dumps(plan, ensure_ascii=False, default=str)}\n```"
        except Exception as e:
            logger.debug("[output-guard] extract plan for canonicalization failed (ignored): %s", e, exc_info=True)
            plan = None
            plan_err = f"invalid_plan:{e}"

        # If we couldn't extract a valid plan, attempt one repair *before* streaming content.
        # This prevents emitting an invalid Plan block and then appending a second repaired Plan later.
        attempted = False
        try:
            attempted = bool(getattr(self, "_turn_writeback_repair_attempted", False))
        except Exception:
            attempted = False

        if not attempted:
            try:
                self._turn_writeback_repair_attempted = True
            except Exception:
                pass
            try:
                user_query = str(getattr(self, "_turn_user_query", "") or "").strip()
                rag_ctx = str(getattr(self, "_turn_rag_context", "") or "")
                anchor = str(getattr(self, "_turn_writeback_anchor", "") or "cursor").strip() or "cursor"
                delivery = str(getattr(self, "_turn_writeback_delivery", "") or "").strip()

                repaired = await self._auto_repair_missing_writeback_plan(
                    user_query=user_query,
                    rag_context=rag_ctx,
                    session_id=session_id,
                    anchor=anchor,
                    delivery=delivery,
                    original_plan=plan,
                    error_type="missing_plan" if (not plan_err or plan_err == "empty_plan_payload") else "invalid_plan",
                    error_message=plan_err or "",
                )
                if repaired is not None:
                    return f"```json\n{json.dumps(repaired, ensure_ascii=False, default=str)}\n```"
            except Exception as e:
                logger.error("[writeback] auto-repair (output-guard) failed: %s", e, exc_info=True)

        # If repair still didn't produce a valid plan, avoid leaking invalid JSON to the frontend executor.
        return "【系统提示】本轮需要写入文档，但未能生成可执行的 Plan JSON。请点击重试，或明确“只输出 Plan JSON”。"

    def _extract_self_check_result(self, response: str) -> Optional[Dict[str, Any]]:

        """从LLM响应中提取自检结果



        Args:

            response: LLM响应内容



        Returns:

            自检结果字典，如果未找到则返回None

        """

        try:

            # 尝试提取JSON格式的自检结果

            json_match = re.search(r'```json\s*\n(.*?)\n```', response, re.DOTALL)

            if json_match:

                json_str = json_match.group(1).strip()

                try:

                    parsed = json.loads(json_str)

                    if "self_check" in parsed:

                        return parsed["self_check"]

                except json.JSONDecodeError:

                    pass



            # 尝试从文本中提取自检信息

            if '"self_check"' in response:

                # 简单的文本匹配，提取关键信息

                if '"result": "pass"' in response:

                    return {

                        "performed": True,

                        "result": "pass",

                        "issues": [],

                        "summary": "LLM自检通过"

                    }

                elif '"result": "fail"' in response:

                    issues = []

                    # 尝试提取问题列表

                    issues_match = re.search(r'"issues":\s*\[(.*?)\]', response, re.DOTALL)

                    if issues_match:

                        issues_str = issues_match.group(1)

                        issues = [issue.strip().strip('"') for issue in issues_str.split(',')]



                    return {

                        "performed": True,

                        "result": "fail",

                        "issues": issues,

                        "summary": "LLM自检发现代码问题"

                    }

        except Exception as e:

            logger.debug(f"提取自检结果失败: {e}")



        return None



    def _quick_js_macro_review(self, code: str) -> Dict[str, Any]:

        """Fast, local-only JS macro review and a few safe rewrites.



        We keep this extremely cheap because it runs inline on the chat request path.

        """

        errors: List[str] = []

        warnings: List[str] = []

        fixed_code = code or ""



        # 1) VBA residue (common failure mode when the model drifts).

        vba_patterns = [

            (r"\bDim\s+\w+", "VBA语法残留: Dim 变量声明"),

            (r"\bSet\s+\w+\s*=", "VBA语法残留: Set 赋值语句"),

            (r"\bEnd\s+\w+\b", "VBA语法残留: End 语句"),

            (r"\bNext\b", "VBA语法残留: Next 循环"),

            (r"\bIf\s+.*\s+Then\b", "VBA语法残留: If ... Then 语句"),

        ]

        for pattern, desc in vba_patterns:

            if re.search(pattern, code or "", re.IGNORECASE):

                errors.append(desc)



        # 2) Known WPS JS pitfalls: some samples use convenience APIs that are not

        # always present. We can safely rewrite a subset to standard Word-like APIs.

        if re.search(r"\bselection\.StartOf\s*\(", code or ""):

            warnings.append("检测到 selection.StartOf()；已自动改写为 selection.HomeKey(6) 以提升兼容性。")

            fixed_code = re.sub(

                r"\bselection\.StartOf\s*\(\s*\)\s*;?",

                "selection.HomeKey(6);",

                fixed_code,

            )

        if re.search(r"\bselection\.EndOf\s*\(", code or ""):

            warnings.append("检测到 selection.EndOf()；已自动改写为 selection.EndKey(6) 以提升兼容性。")

            fixed_code = re.sub(

                r"\bselection\.EndOf\s*\(\s*\)\s*;?",

                "selection.EndKey(6);",

                fixed_code,

            )



        # 3) Soft checks.

        if (code or "").count("(") != (code or "").count(")"):

            errors.append("括号不匹配")



        # Many snippets in prompts use selection.GoTo(line). That API is not guaranteed

        # to exist in WPS JS; we prefer a runtime shim on the frontend.

        if re.search(r"\bselection\.GoTo\s*\(\s*\d+\s*\)", code or ""):

            warnings.append("检测到 selection.GoTo(n) 简写；不同 WPS 版本可能不兼容（建议使用 GoTo 兼容写法或让执行器 shim）。")



        return {"errors": errors, "warnings": warnings, "fixed_code": fixed_code}



    async def _check_and_fix_code(self, response: str, session_id: str) -> str:

        """检测并修正代码质量 - Vibe Coding可视化流程



        Args:

            response: 原始响应

            session_id: 会话ID



        Returns:

            str: 修正后的响应

        """

        # 提取代码块

        code_blocks = re.findall(r'```(?:javascript|js)?\n(.*?)```', response, re.DOTALL)

        if not code_blocks:

            logger.info("🔍 未找到代码块，跳过检测")

            return response



        # 提取原始代码

        original_code = code_blocks[0]

        logger.info(f"🔍 启动JS宏快速自检，代码长度: {len(original_code)}")



        review = self._quick_js_macro_review(original_code)

        fixed_code = review.get("fixed_code", original_code)

        errors = review.get("errors", []) or []

        warnings = review.get("warnings", []) or []



        if warnings:

            logger.info(f"🔎 JS宏自检警告: {warnings[:3]}{'...' if len(warnings) > 3 else ''}")



        # If there are no hard errors, keep it fast: return immediately (with safe rewrites if any).

        if not errors:

            if fixed_code != original_code:

                logger.info("✅ 已应用快速兼容性改写（无需LLM二次检查）")

                return re.sub(

                    r"```(?:javascript|js)?\n(.*?)```",

                    f"```javascript\n{fixed_code}\n```",

                    response,

                    count=1,

                    flags=re.DOTALL,

                )

            return response



        logger.warning(f"⚠️ JS宏自检发现问题: {errors}")



        # Try Vibe Coding workflow (LangGraph) only when we have hard issues.

        # This can be expensive (LLM calls), so keep it conditional.

        if not self.llm:

            logger.warning("⚠️ LLM不可用，无法自动修复JS宏代码，返回原始响应")

            return response



        try:

            from .js_macro_workflow import JSMacroVibeWorkflow

        except Exception as e:

            logger.warning(f"无法导入Vibe Coding工作流: {e}")

            return await self._traditional_llm_check_and_fix(original_code, response, session_id)



        workflow = JSMacroVibeWorkflow(llm=self.llm)

        user_query = (

            "请修复下面的WPS JS宏代码，使其可在WPS免费版中执行。\n"

            "要求：\n"

            "1) 不要使用VBA语法；使用 window.Application/app.Selection 等对象模型。\n"

            "2) 避免使用不确定存在的API（如 StartOf/EndOf/GoTo 的简写），必要时提供兼容写法。\n"

            "3) 不要输出TypeScript/ESM语法（类型注解、interface/type、as断言、非空断言!；不要用 import/export）。\n"

            "4) 推荐优先用 selection.Range.Text 写入文本（避免 TypeText）。\n"

            "5) 可选：你可以使用 BID 助手对象（运行时注入）以更稳定调用 WPS 内置能力：BID.upsertBlock / BID.insertTable / BID.insertChartFromSelection / BID.insertWordArt。\n"

            "6) 保留原意图与行为。\n\n"

            f"已检测到的问题：\n- " + "\n- ".join(errors) + "\n\n"

            "原代码：\n```javascript\n" + original_code.strip() + "\n```"

        )



        logger.info("🚀 启动Vibe Coding工作流进行修复（仅在检测到问题时触发）...")

        final_code: Optional[str] = None

        final_success: Optional[bool] = None

        try:

            async for event in workflow.process_with_visualization(user_query, session_id):

                if event.get("type") == "final_result":

                    result = event.get("result") or {}

                    final_code = (result.get("code") or "").strip() or None

                    final_success = bool(result.get("success", False))

        except Exception as e:

            logger.error(f"Vibe Coding工作流执行失败: {e}")

            return await self._traditional_llm_check_and_fix(original_code, response, session_id)



        if final_code:

            logger.info(f"✅ Vibe Coding修复完成 success={final_success}，新代码长度: {len(final_code)}")

            return re.sub(

                r"```(?:javascript|js)?\n(.*?)```",

                f"```javascript\n{final_code}\n```",

                response,

                count=1,

                flags=re.DOTALL,

            )



        logger.warning("⚠️ Vibe Coding未返回可用代码，返回原始响应")

        return response



    async def _traditional_llm_check_and_fix(self, code: str, response: str, session_id: str) -> str:

        """传统LLM检查和修复流程（回退方案）"""

        # Keep fallback local-only to avoid adding a second long LLM call on the request path.

        logger.info("🔍 启动传统本地检查流程（无LLM回退）...")

        review = self._quick_js_macro_review(code)

        fixed_code = review.get("fixed_code", code)

        if fixed_code != code:

            logger.info("✅ 传统回退流程应用了兼容性改写")

            return re.sub(

                r"```(?:javascript|js)?\n(.*?)```",

                f"```javascript\n{fixed_code}\n```",

                response,

                count=1,

                flags=re.DOTALL,

            )

        logger.info("✅ 传统回退流程完成（无改动）")

        return response
