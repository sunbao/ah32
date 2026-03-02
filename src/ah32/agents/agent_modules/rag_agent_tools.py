"""Backend RAG tools for LLM tool-calls.

These tools operate on the server-side vector store (Chroma) and are intended to be
exposed via the backend LLM tool allowlist.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _safe_int(v: Any, default: int, *, min_v: int, max_v: int) -> int:
    try:
        n = int(v)
    except Exception:
        return default
    return max(min_v, min(max_v, n))


def _parse_json_args(tool_input: Any) -> Dict[str, Any]:
    if isinstance(tool_input, dict):
        return dict(tool_input)
    if tool_input is None:
        return {}
    if isinstance(tool_input, str):
        s = tool_input.strip()
        if not s:
            return {}
        try:
            obj = json.loads(s)
        except Exception:
            return {"_raw": s}
        if isinstance(obj, dict):
            return obj
        return {"_raw": obj}
    return {"_raw": str(tool_input)}


class RagSearchTool:
    name: str = "rag_search"
    description: str = "在RAG知识库中做语义检索（只读）。输入为JSON参数。"

    def __init__(self, vector_store: Any):
        self._vector_store = vector_store

    def run(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        query = str(args.get("query") or args.get("q") or "").strip()
        k = _safe_int(args.get("k"), 6, min_v=1, max_v=50)
        flt = args.get("filter")
        if not isinstance(flt, dict):
            flt = None

        if not query:
            return json.dumps({"ok": False, "error": "missing query"}, ensure_ascii=False)
        if self._vector_store is None:
            return json.dumps({"ok": False, "error": "vector_store unavailable"}, ensure_ascii=False)

        try:
            hits = self._vector_store.similarity_search(query, k=k, filter=flt)
            out: List[Dict[str, Any]] = []
            for doc, score in hits:
                meta = getattr(doc, "metadata", None) or {}
                text = str(getattr(doc, "page_content", "") or "")
                snippet = text[:400] + ("..." if len(text) > 400 else "")
                out.append(
                    {
                        "score": score,
                        "source": meta.get("source"),
                        "file_name": meta.get("file_name"),
                        "chunk_index": meta.get("chunk_index"),
                        "import_method": meta.get("import_method"),
                        "snippet": snippet,
                        "metadata": meta,
                    }
                )
            return json.dumps(
                {"ok": True, "query": query, "k": k, "filter": flt, "hits": out},
                ensure_ascii=False,
                default=str,
            )
        except Exception as e:
            logger.error("[rag_search] failed: %s", e, exc_info=True)
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)


class RagStatsTool:
    name: str = "rag_stats"
    description: str = "查看RAG知识库统计信息（只读）。输入为JSON参数。"

    def __init__(self, vector_store: Any):
        self._vector_store = vector_store

    def run(self, tool_input: Any) -> str:
        _ = tool_input
        if self._vector_store is None:
            return json.dumps({"ok": False, "error": "vector_store unavailable"}, ensure_ascii=False)
        try:
            stats = self._vector_store.get_stats()
            return json.dumps({"ok": True, "stats": stats}, ensure_ascii=False, default=str)
        except Exception as e:
            logger.error("[rag_stats] failed: %s", e, exc_info=True)
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)


class RagListDocumentsTool:
    name: str = "rag_list_documents"
    description: str = "列出RAG知识库的文档/分块元数据（只读，默认不返回全文）。输入为JSON参数。"

    def __init__(self, vector_store: Any):
        self._vector_store = vector_store

    def run(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        limit = _safe_int(args.get("limit"), 50, min_v=1, max_v=500)
        include_content = bool(args.get("include_content") or False)

        if self._vector_store is None:
            return json.dumps({"ok": False, "error": "vector_store unavailable"}, ensure_ascii=False)
        try:
            docs = self._vector_store.get_all_documents(limit=limit)
            if not include_content:
                for d in docs:
                    if isinstance(d, dict):
                        d.pop("content", None)
            return json.dumps(
                {"ok": True, "limit": limit, "include_content": include_content, "documents": docs},
                ensure_ascii=False,
                default=str,
            )
        except Exception as e:
            logger.error("[rag_list_documents] failed: %s", e, exc_info=True)
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)


class RagIngestUrlTool:
    name: str = "rag_ingest_url"
    description: str = "抓取URL并写入RAG知识库（只支持http/https）。输入为JSON参数。"

    def __init__(self, vector_store: Any):
        self._vector_store = vector_store

    def run(self, tool_input: Any) -> str:
        args = _parse_json_args(tool_input)
        url = str(args.get("url") or "").strip()
        name = str(args.get("name") or "").strip()
        prefer_browser = bool(args.get("prefer_browser") or False)
        max_chars = _safe_int(args.get("max_chars"), 200_000, min_v=1_000, max_v=800_000)

        if not url:
            return json.dumps({"ok": False, "error": "missing url"}, ensure_ascii=False)
        if not (url.startswith("http://") or url.startswith("https://")):
            return json.dumps({"ok": False, "error": "only http/https URLs are allowed"}, ensure_ascii=False)
        if self._vector_store is None:
            return json.dumps({"ok": False, "error": "vector_store unavailable"}, ensure_ascii=False)

        # Fetch text (prefer browser snapshot if requested and available).
        text = ""
        fetch_meta: Dict[str, Any] = {}
        if prefer_browser:
            try:
                from ah32.agents.agent_modules.network_agent_tools import BrowserSnapshotTool

                snap = BrowserSnapshotTool().run(
                    json.dumps({"url": url, "max_chars": max_chars}, ensure_ascii=False)
                )
                snap_obj = json.loads(snap) if isinstance(snap, str) else {}
                if isinstance(snap_obj, dict) and snap_obj.get("ok"):
                    text = str(snap_obj.get("text") or "")
                    fetch_meta = {"method": "browser_snapshot", "final_url": snap_obj.get("final_url")}
            except Exception as e:
                fetch_meta = {"method": "browser_snapshot", "error": str(e)}

        if not text:
            try:
                from ah32.agents.agent_modules.network_agent_tools import WebFetchTool

                raw = WebFetchTool().run(
                    json.dumps({"url": url, "mode": "text", "max_bytes": 2_000_000}, ensure_ascii=False)
                )
                obj = json.loads(raw) if isinstance(raw, str) else {}
                if isinstance(obj, dict) and obj.get("ok"):
                    text = str(obj.get("text") or "")
                    fetch_meta = {
                        "method": "web_fetch",
                        "final_url": obj.get("final_url"),
                        "status": obj.get("status"),
                        "content_type": obj.get("content_type"),
                    }
            except Exception as e:
                return json.dumps({"ok": False, "error": f"fetch failed: {e}"}, ensure_ascii=False)

        if not text.strip():
            return json.dumps({"ok": False, "error": "empty page text", "fetch": fetch_meta}, ensure_ascii=False)

        if len(text) > max_chars:
            text = text[: max_chars - 20] + "\n...(truncated)"

        if not name:
            name = url

        try:
            from ah32.server.rag_api import _upsert_text_to_vector_store

            res = _upsert_text_to_vector_store(
                self._vector_store,
                text=text,
                name=name,
                import_method="web",
                path_alias=url,
                extra_metadata={"url": url},
            )
            return json.dumps(
                {"ok": True, "url": url, "name": name, "fetch": fetch_meta, "ingest": res},
                ensure_ascii=False,
                default=str,
            )
        except Exception as e:
            logger.error("[rag_ingest_url] failed url=%s err=%s", url, e, exc_info=True)
            return json.dumps({"ok": False, "url": url, "fetch": fetch_meta, "error": str(e)}, ensure_ascii=False)

    async def arun(self, tool_input: Any) -> str:
        return await asyncio.to_thread(self.run, tool_input)

