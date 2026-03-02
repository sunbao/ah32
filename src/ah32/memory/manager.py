"""Ah32记忆管理器 - 简化版记忆管理

基于三层记忆架构（会话、跨会话、全局），使用简化关键词分类
"""

from __future__ import annotations

import asyncio
import logging
import os
import json
import re
import threading
from datetime import datetime
from typing import Dict, List, Any, Optional

from ah32.config import settings
from ah32.tenancy.context import get_tenant_id

from ..services.memory import get_memory_manager, get_global_user_memory, get_task_memory

logger = logging.getLogger(__name__)


# Tenant-scoped vector store cache
_vector_store_cache_by_tenant: Dict[str, Any] = {}
_vector_store_write_lock = threading.Lock()

# Default: do NOT block chat/macro responses on embedding/vector DB I/O.
_memory_vector_write_sync = os.getenv("AH32_MEMORY_VECTOR_WRITE_SYNC", "").lower() in ("1", "true", "yes")
# Default: only vectorize cross-session/global memory, not every session turn.
_memory_vectorize_session = os.getenv("AH32_MEMORY_VECTORIZE_SESSION", "").lower() in ("1", "true", "yes")
_memory_vector_max_chars = int(os.getenv("AH32_MEMORY_VECTOR_MAX_CHARS", "2000") or "2000")

_PLAN_SCHEMA_VERSION = "ah32.plan.v1"
_PLAN_JSON_FENCE_RE = re.compile(r"```json\\s*([\\s\\S]*?)```", re.IGNORECASE)


def _maybe_parse_plan_response(text: str) -> Optional[Dict[str, Any]]:
    s = str(text or "").strip()
    if not s:
        return None

    blob = None
    m = _PLAN_JSON_FENCE_RE.search(s)
    if m:
        blob = (m.group(1) or "").strip()
    elif s.startswith("{") and s.endswith("}"):
        blob = s
    if not blob:
        return None

    try:
        obj = json.loads(blob)
    except Exception:
        return None

    if not isinstance(obj, dict):
        return None
    if obj.get("schema_version") != _PLAN_SCHEMA_VERSION:
        return None
    return obj


def _summarize_plan_for_memory(plan: Dict[str, Any]) -> str:
    try:
        host = str(plan.get("host_app") or "").strip()
        actions = plan.get("actions") if isinstance(plan.get("actions"), list) else []
        action_count = len(actions)

        ops: List[str] = []
        block_ids: List[str] = []

        def walk(xs: Any) -> None:
            if not isinstance(xs, list):
                return
            for a in xs:
                if not isinstance(a, dict):
                    continue
                op = a.get("op")
                if isinstance(op, str) and op.strip():
                    ops.append(op.strip())
                bid = a.get("block_id")
                if isinstance(bid, str) and bid.strip():
                    block_ids.append(bid.strip())
                walk(a.get("actions"))

        walk(actions)

        ops_uniq = sorted(set(ops))[:12]
        blocks_uniq = sorted(set(block_ids))[:6]

        extras: List[str] = []
        if ops_uniq:
            extras.append(f"ops={','.join(ops_uniq)}")
        if blocks_uniq:
            extras.append(f"blocks={','.join(blocks_uniq)}")
        extra_text = (" " + " ".join(extras)) if extras else ""

        return f"[plan] schema={_PLAN_SCHEMA_VERSION} host={host or '?'} actions={action_count}{extra_text}"
    except Exception as e:
        logger.debug("[memory] summarize plan failed (ignored): %s", e, exc_info=True)
        return f"[plan] schema={_PLAN_SCHEMA_VERSION}"


def _truncate_for_embedding(text: str, max_chars: int) -> str:
    if not text:
        return ""
    if max_chars <= 0:
        return text
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...[truncated]..."


def _log_task_exception(task: asyncio.Task, *, desc: str) -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception as e:
        logger.warning(f"[memory] background task '{desc}' status unknown: {e}")
        return
    if exc is not None:
        logger.warning(f"[memory] background task '{desc}' failed: {exc}")


def _get_vector_store():
    """获取租户级向量存储（懒加载；按 tenant_id 分区）"""
    tenant_id = (
        str(get_tenant_id() or "").strip()
        or str(getattr(settings, "default_tenant_id", "public") or "public").strip()
    )

    store = _vector_store_cache_by_tenant.get(tenant_id)
    if store is None:
        try:
            from ..knowledge.store import ChromaDBStore
            from ..knowledge.chroma_utils import make_collection_name
            from ..knowledge.embeddings import resolve_embedding

            persist_path = _get_storage_path()
            embedding = resolve_embedding(settings)
            embedding_dim = None
            try:
                embedding_dim = len(embedding.embed_query("dimension_probe"))
            except Exception as e:
                logger.warning(f"[embedding] dimension probe failed for memory store: {e}")
            collection_name = make_collection_name(
                "ah32_memory",
                settings.embedding_model,
                embedding_dim=embedding_dim,
            )
            store = ChromaDBStore(
                persist_path=persist_path,
                embedding=embedding,
                reset=False,
                config={
                    "collection_name": collection_name,
                    "collection_metadata": {
                        "tenant_id": tenant_id,
                        "embedding_model": settings.embedding_model,
                        "embedding_dim": embedding_dim,
                    },
                },
            )
            _vector_store_cache_by_tenant[tenant_id] = store
            logger.info(f"向量存储初始化成功: {persist_path} (tenant={tenant_id}, collection={collection_name})")
        except Exception as e:
            logger.error(f"向量存储初始化失败: {e}")
            return None
    return store


def _get_storage_path():
    """获取向量存储路径"""
    tenant_id = (
        str(get_tenant_id() or "").strip()
        or str(getattr(settings, "default_tenant_id", "public") or "public").strip()
    )
    # Tenant-scoped storage unit: storage/tenants/<tenant_id>/memory/
    return settings.storage_root / "tenants" / tenant_id / "memory"


class Ah32MemorySystem:
    """Ah32记忆系统 - 基于三层记忆架构（会话、跨会话、全局）"""

    def __init__(self, llm=None):
        """初始化记忆系统

        Args:
            llm: LLM实例（不再使用，简化为关键词分类）
        """
        # 初始化记忆管理器
        self.memory_manager = get_memory_manager()

        # 记忆索引
        self.memory_index = {
            "session_memory": "session_memory",
            "cross_session_memory": "cross_session_memory",
            "global_memory": "global_memory"
        }

    async def store_conversation(self, session_id: str, user_message: str,
                                 assistant_response: str, metadata: Dict[str, Any] = None):
        """存储对话到记忆系统（支持智能分类）

        Args:
            session_id: 会话ID
            user_message: 用户消息
            assistant_response: 助手响应
            metadata: 元数据
        """
        logger.debug(f"[记忆存储] 开始存储对话，session_id: {session_id}")
        assistant_response_for_memory = assistant_response
        assistant_is_plan = False
        try:
            plan = _maybe_parse_plan_response(assistant_response)
            if plan is not None:
                assistant_is_plan = True
                assistant_response_for_memory = _summarize_plan_for_memory(plan)
        except Exception as e:
            logger.warning("[memory] detect plan response failed (ignored): %s", e, exc_info=True)
            assistant_response_for_memory = assistant_response
            assistant_is_plan = False

        logger.debug(f"[记忆存储] 用户消息: {user_message[:100]}...")
        logger.debug(f"[记忆存储] 助手响应: {assistant_response_for_memory[:100]}...")
        # 确保session_id不为空
        if not session_id:
            import uuid
            session_id = f"session_{uuid.uuid4().hex[:12]}"
            logger.warning(f"[记忆存储] session_id为空，自动生成: {session_id}")

        timestamp = datetime.now().isoformat()

        # 1. 使用简化的关键词分类
        classification_result = None
        try:
            from ..strategies.llm_driven_strategy import classify_conversation
            classification_result = classify_conversation(user_message)
            logger.debug(f"简化分类结果: {classification_result.to_dict()}")
        except Exception as e:
            logger.warning(f"简化分类失败: {e}")

        # 2. 确定存储类型
        storage_type = "session_memory"  # 默认存储类型
        classification_dict = None
        # Treat Plan JSON writeback as "non-memorable": never promote/vectorize backend execution payloads.
        bench_mode = bool((metadata or {}).get("bench")) or assistant_is_plan

        if classification_result and not bench_mode:
            # 根据分类结果确定存储类型
            if classification_result.storage_level.value == "P0_全局记忆":
                storage_type = "global_memory"
            elif classification_result.storage_level.value == "P2_跨会话记忆":
                storage_type = "cross_session_memory"
            else:
                storage_type = "session_memory"

            # 转换为字典格式
            classification_dict = classification_result.to_dict()
        elif bench_mode and classification_result:
            # Keep the classification for debugging, but never promote bench turns to cross-session/global.
            classification_dict = classification_result.to_dict()

        # 3. 获取会话记忆实例
        session_memory = get_task_memory(session_id)

        # 4. 添加对话到会话记忆（传递存储类型和分类结果）
        session_memory.add_conversation(
            role="user",
            message=user_message,
            section_id=metadata.get("section_id") if metadata else None,
            storage_type=storage_type,
            classification_result=classification_dict
        )
        session_memory.add_conversation(
            role="assistant",
            message=assistant_response_for_memory,
            section_id=metadata.get("section_id") if metadata else None,
            storage_type=storage_type,
            classification_result=classification_dict
        )

        # 5) Vector store (optional):
        # - Do not block interactive UX on embeddings/vector DB I/O by default.
        # - Do not vectorize every session turn by default (cross-session/global only).
        should_vectorize = (
            (not bench_mode)
            and (storage_type in ("cross_session_memory", "global_memory") or _memory_vectorize_session)
        )
        if should_vectorize:
            conversation_text = _truncate_for_embedding(
                f"用户: {user_message}\n助手: {assistant_response}",
                _memory_vector_max_chars,
            )
            document_hash = ""
            try:
                from ..session.session_id_generator import SessionIdGenerator

                document_hash = SessionIdGenerator.get_file_hash(session_id) or ""
            except Exception:
                document_hash = ""

            vector_metadata = {
                "session_id": session_id,
                "document_hash": document_hash,
                "storage_type": storage_type,
                "timestamp": timestamp,
                "source": "conversation_memory",
            }
            if classification_dict:
                vector_metadata.update(classification_dict)

            if _memory_vector_write_sync:
                await self._store_to_vector_db(conversation_text, vector_metadata)
            else:
                task = asyncio.create_task(self._store_to_vector_db(conversation_text, vector_metadata))
                task.add_done_callback(lambda t: _log_task_exception(t, desc="memory_vector_write"))

        return classification_result

    async def _store_to_vector_db(self, content: str, metadata: Dict[str, Any]):
        """存储到向量数据库"""
        try:
            vector_store = _get_vector_store()
            if vector_store is None:
                logger.warning("向量存储未初始化，跳过存储到向量数据库")
                return

            # 生成唯一ID
            doc_id = f"mem_{datetime.now().isoformat()}"

            # 手动过滤复杂的metadata（ChromaDB不支持复杂的嵌套结构）
            # 只保留基本类型：str, bool, int, float
            allowed_types = (str, bool, int, float)
            filtered_metadata = {
                k: v for k, v in metadata.items()
                if isinstance(v, allowed_types)
            }
            # 添加基本元数据
            filtered_metadata["id"] = doc_id
            filtered_metadata["created_at"] = datetime.now().isoformat()

            # 创建Document对象
            from langchain_core.documents import Document
            doc = Document(
                page_content=content,
                metadata=filtered_metadata
            )

            # add_documents() is sync and can be slow (embeddings + disk I/O). Run it in a thread and
            # serialize writes to avoid SQLite/Chroma concurrency issues.
            def _write_one():
                with _vector_store_write_lock:
                    vector_store.add_documents([doc])

            await asyncio.to_thread(_write_one)

            logger.debug(f"已存储到向量数据库: {doc_id}")

        except Exception as e:
            import traceback
            logger.error(f"向量数据库存储失败: {e}")
            logger.error(f"错误类型: {type(e).__name__}")
            logger.error(f"错误详情: {traceback.format_exc()}")

    async def retrieve_relevant_memory(self, query: str, session_id: Optional[str] = None,
                                      memory_types: List[str] = None,
                                      limit: int = 5, filter_by_document: bool = False) -> Dict[str, List[Dict]]:
        """检索相关记忆

        Args:
            query: 查询内容
            session_id: 会话ID（可选，用于过滤特定会话的记忆）
            memory_types: 记忆类型列表 (session_memory, cross_session_memory, global_memory)
            limit: 返回结果数量限制

        Returns:
            包含各类记忆的字典
        """
        if memory_types is None:
            memory_types = ["session_memory", "cross_session_memory", "global_memory"]

        results = {}

        try:
            # 构建过滤条件
            filter_conditions = {}
            doc_hash = None
            if session_id:
                filter_conditions["session_id"] = session_id
                # 提取文档hash用于过滤
                from ..session.session_id_generator import SessionIdGenerator
                doc_hash = SessionIdGenerator.get_file_hash(session_id)
                if doc_hash:
                    filter_conditions["document_hash"] = doc_hash

            # 1. 检索会话记忆（按文档hash过滤，专注当前标书）
            if "session_memory" in memory_types:
                if session_id:
                    session_memory = get_task_memory(session_id)
                    if session_memory:
                        # 获取最近的对话
                        recent_interactions = session_memory.get_conversation_history(limit)
                        # 将 ConversationMessage 对象转换为字典列表
                        results["session_memory"] = [msg.model_dump() for msg in recent_interactions]

                        # 如果有文档hash，记录过滤信息
                        if doc_hash:
                            logger.info(f"[记忆检索] 会话记忆按文档hash过滤: {doc_hash}, 检索到 {len(results['session_memory'])} 条记录")
                    else:
                        results["session_memory"] = []
                else:
                    # session_id 为空时仍返回空列表，避免 KeyError
                    results["session_memory"] = []

            # 2. 检索全局记忆
            if "global_memory" in memory_types:
                global_memory = get_global_user_memory()
                results["global_memory"] = {
                    "user_profile": global_memory.get_user_profile().model_dump(),
                    "user_preferences": global_memory.get_user_preferences().model_dump()
                }

            # 3. 检索跨会话记忆（按session_id隔离，可选按文档hash过滤）
            if "cross_session_memory" in memory_types:
                if session_id:
                    # Cross-session memory should survive multiple sessions for the same document/project.
                    # Use document_hash (derived from session_id) as the stable key.
                    cross_filter: Dict[str, Any] = {"storage_type": "cross_session_memory"}
                    if doc_hash:
                        cross_filter["document_hash"] = doc_hash
                        logger.info(f"[记忆检索] 跨会话记忆按document_hash过滤: {doc_hash}")
                    else:
                        # Fallback when session_id is not in expected format.
                        cross_filter["session_id"] = session_id
                        logger.info(f"[记忆检索] 跨会话记忆按session_id过滤(降级): {session_id}")

                    try:
                        vector_store = _get_vector_store()
                        if vector_store is None:
                            logger.warning("向量存储未初始化，跳过跨会话记忆检索")
                            results["cross_session_memory"] = []
                        else:
                            cross_docs_and_scores = vector_store.similarity_search(
                                query=query,
                                k=limit,
                                filter=cross_filter
                            )
                        results["cross_session_memory"] = [
                            {
                                "content": doc.page_content,
                                "metadata": doc.metadata,
                                "score": score
                            }
                            for doc, score in cross_docs_and_scores
                        ]
                        logger.info(f"[记忆检索] 检索到 {len(results['cross_session_memory'])} 条跨会话记忆")
                    except Exception as e:
                        logger.warning(f"检索跨会话记忆失败: {e}")
                        results["cross_session_memory"] = []
                else:
                    # 如果没有session_id，不返回任何跨会话记忆
                    results["cross_session_memory"] = []
        except Exception as e:
            logger.error(f"检索相关记忆失败: {e}")
            return {}
        return results

    async def get_comprehensive_context(self, query: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """获取综合上下文信息

        Args:
            query: 查询内容
            session_id: 会话ID（可选）

        Returns:
            包含综合上下文的字典
        """
        try:
            # 🔧 新增：处理@引用功能
            at_reference_context = {}
            try:
                vector_store = _get_vector_store()
                if vector_store:
                    # 使用@引用处理器
                    from ..services.at_reference_handler import handle_at_references
                    at_result = await handle_at_references(query, vector_store)
                    at_reference_context = {
                        "at_references_processed": at_result.get("processed", []),
                        "at_references_errors": at_result.get("errors", []),
                        "at_references_paths": at_result.get("paths", [])
                    }
                    logger.debug(f"[@引用] 处理结果: {len(at_result.get('processed', []))} 个文件已处理")
            except Exception as e:
                logger.warning(f"[@引用] 处理失败: {e}")
                at_reference_context = {
                    "at_references_processed": [],
                    "at_references_errors": [str(e)],
                    "at_references_paths": []
                }

            # 获取相关记忆 - 增加limit到10以获取更多对话历史
            all_memories = await self.retrieve_relevant_memory(
                query=query,
                session_id=session_id,
                memory_types=["session_memory", "cross_session_memory", "global_memory"],
                limit=10
            )

            # 获取会话记忆（同步方法）
            session_memory = None
            if session_id:
                session_memory = get_task_memory(session_id)

            # Pull structured per-document context from the task memory snapshot.
            project_context: Dict[str, Any] = {}
            cross_session_notes: List[Dict[str, Any]] = []
            try:
                if session_memory:
                    project_context = session_memory.get_project_context().model_dump()
                    doc_hash = ""
                    try:
                        from ..session.session_id_generator import SessionIdGenerator
                        doc_hash = SessionIdGenerator.get_file_hash(session_id) or ""
                    except Exception:
                        doc_hash = ""
                    if doc_hash:
                        record = session_memory.get_cross_session_memory(doc_hash, "notes")
                        if isinstance(record, dict) and isinstance(record.get("value"), list):
                            cross_session_notes = list(record.get("value") or [])[-20:]
            except Exception as e:
                logger.debug(f"[memory] load structured context failed (ignored): {e}")

            # 构建综合上下文
            context = {
                "query": query,
                "timestamp": datetime.now().isoformat(),
                "session_memory": all_memories.get("session_memory", []),
                "cross_session_memory": all_memories.get("cross_session_memory", []),
                "global_memory": all_memories.get("global_memory", {}),
                "semantic_memory": all_memories.get("semantic_memory", []),
                "project_context": {
                    **(project_context or {}),
                    "notes": cross_session_notes,
                },
                "at_reference_context": at_reference_context,  # 🔧 新增：@引用上下文
                "memory_stats": {
                    "has_session_memory": bool(all_memories.get("session_memory")),
                    "has_global_memory": bool(all_memories.get("global_memory", {}).get("user_profile")),
                    "vector_store_path": str(_get_storage_path()),
                    "embedding_model": settings.embedding_model
                }
            }

            return context

        except Exception as e:
            logger.error(f"获取综合上下文失败: {e}")
            return {
                "query": query,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    def get_memory_stats(self) -> Dict[str, Any]:
        """获取记忆系统统计信息

        Returns:
            包含统计信息的字典
        """
        try:
            # 获取全局记忆统计
            global_memory = get_global_user_memory()
            global_stats = global_memory.get_summary()

            # 获取所有会话记忆统计
            all_memories = self.memory_manager.list_memories()

            return {
                "timestamp": datetime.now().isoformat(),
                "global_memory": {
                    "exists": bool(global_stats.get("has_user_profile")),
                    "user_name": global_stats.get("user_name"),
                    "user_company": global_stats.get("user_company"),
                },
                "session_memories": {
                    "total_count": len(all_memories),
                    "recent_memories": all_memories[:5]
                },
                "vector_store": {
                    "path": str(_get_storage_path()),
                    "embedding_model": settings.embedding_model
                }
            }

        except Exception as e:
            logger.error(f"获取记忆统计失败: {e}")
            return {
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    async def update_global_user_info(self, session_id: str, user_info: Dict[str, Any]):
        """更新全局用户信息

        Args:
            session_id: 会话ID
            user_info: 用户信息字典
        """
        try:
            global_memory = get_global_user_memory()
            profile = global_memory.get_user_profile()

            # 更新字段
            for key, value in user_info.items():
                if hasattr(profile, key):
                    setattr(profile, key, value)

            # 保存
            global_memory.update_user_profile(profile)

            logger.info(f"已更新全局用户信息: {user_info}")

        except Exception as e:
            logger.error(f"更新全局用户信息失败: {e}")

    async def get_session_context(self, session_id: str) -> Dict[str, Any]:
        """获取会话上下文

        Args:
            session_id: 会话ID

        Returns:
            包含会话上下文的字典
        """
        try:
            # 获取会话记忆
            session_memory = get_task_memory(session_id)
            project_context = session_memory.get_project_context()
            user_preferences = session_memory.get_user_preferences()
            conversation_history = session_memory.get_conversation_history(limit=10)

            # 获取相关记忆
            relevant_memories = await self.retrieve_relevant_memory(
                query="",
                session_id=session_id,
                memory_types=["session_memory", "cross_session_memory"],
                limit=5
            )

            return {
                "session_id": session_id,
                "user_info": {
                    "name": None,
                    "company": None,
                },
                "project_context": project_context.model_dump(),
                "user_preferences": user_preferences.model_dump(),
                "conversation_history": [msg.model_dump() for msg in conversation_history],
                "relevant_memories": relevant_memories,
                "timestamp": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"获取会话上下文失败: {e}")
            return {
                "session_id": session_id,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }


# 向后兼容性别名
