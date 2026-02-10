"""阿蛤（AH32）记忆系统 - 三层记忆架构

根据 docs/AH32_DESIGN.md 设计：
- 全局记忆（Global Memory）：用户身份和偏好
- 跨会话记忆（Cross-Session）：项目上下文和共享经验
- 会话记忆（Session Memory）：对话历史和临时状态

优先级：
- P0：全局记忆（最高优先级，用户身份和偏好）
- P2：跨会话记忆（高优先级，项目上下文）
- P1：会话记忆（中优先级，对话内容）
- P3：会话记忆（低优先级，工具执行历史）
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

MAX_IN_MEMORY_CONVERSATION_HISTORY = 200


class UserPreferences(BaseModel):
    """用户偏好（P0优先级）"""
    output_style: str = "详细"  # 简洁/详细
    language: str = "中文"  # 中文/中英混合
    focus_areas: List[str] = Field(default_factory=list)
    created_at: Optional[float] = None
    updated_at: Optional[float] = None


class SessionMemory(BaseModel):
    """会话记忆（P1/P3优先级）"""
    conversation_history: List[Dict[str, Any]] = Field(default_factory=list)
    session_settings: Dict[str, Any] = Field(default_factory=dict)
    temporary_state: Dict[str, Any] = Field(default_factory=dict)


class CrossSessionMemory(BaseModel):
    """跨会话记忆（P2优先级）"""
    project_context: Dict[str, Any] = Field(default_factory=dict)
    shared_experiences: List[Dict[str, Any]] = Field(default_factory=list)
    referenced_files: List[str] = Field(default_factory=list)


class ConversationMessage(BaseModel):
    """对话消息"""
    timestamp: float = Field(default_factory=time.time)
    role: str  # user/assistant
    message: str
    section_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ProjectContext(BaseModel):
    """项目上下文"""
    project_name: str = ""
    project_type: str = ""
    industry: str = ""
    budget: str = ""
    timeline: str = ""
    key_requirements: List[str] = Field(default_factory=list)


class UserProfile(BaseModel):
    """用户档案"""
    name: Optional[str] = None
    company: Optional[str] = None
    role: Optional[str] = None
    email: Optional[str] = None
    created_at: Optional[float] = None
    updated_at: Optional[float] = None


class UserPreference(BaseModel):
    """用户偏好"""
    writing_style: str = "formal"  # formal/casual
    preferred_formats: Dict[str, str] = Field(default_factory=dict)
    language: str = "中文"
    focus_areas: List[str] = Field(default_factory=list)


class SectionRelationship(BaseModel):
    """章节关联关系"""
    section_id: str
    related_sections: List[str] = Field(default_factory=list)


class TaskMemory:
    """任务记忆系统 - 三层架构简化版
    """

    def __init__(self, task_id: str, storage_root: Path):
        self.task_id = task_id
        self.storage_root = Path(storage_root)
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.vector_store = None  # 可选的向量存储
        self._lock = threading.RLock()

        # 初始化内存缓存
        self._memory_data = {
            "task_id": self.task_id,
            "created_at": time.time(),
            "updated_at": time.time(),
            "user_profile": {},  # P0：用户档案
            "user_preferences": {},  # P0：用户偏好
            "project_context": {},  # P2：项目上下文
            "cross_session_memory": {},  # P2：跨会话记忆
            "conversation_history": [],  # P1：对话历史
            # Total count for long-running sessions (history itself is stored in JSONL).
            "conversation_count_total": 0,
            "section_relationships": {},  # 章节关联
            "intermediate_results": {}  # P3：中间结果
        }

        # 从磁盘加载已有记忆数据
        self._load()

    def _get_storage_path(self, memory_type: str = "memory") -> Path:
        """获取记忆存储路径"""
        return self.storage_root / f"{self.task_id}_{memory_type}.json"

    def _get_conversation_log_path(self) -> Path:
        """Append-only conversation log for long sessions (JSONL)."""
        return self.storage_root / f"{self.task_id}_conversation.jsonl"

    def _append_conversation_log(self, item: Dict[str, Any]) -> None:
        """Append one JSON object to the conversation log."""
        path = self._get_conversation_log_path()
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.warning(f"[记忆] 写入对话日志失败: {e}")

    def _maybe_migrate_history_to_log(self) -> None:
        """One-time migration: move in-file conversation_history to JSONL, keep only a tail in memory.json."""
        path = self._get_conversation_log_path()
        if path.exists():
            return
        history = self._memory_data.get("conversation_history", [])
        if not isinstance(history, list) or not history:
            return
        try:
            for h in history:
                if isinstance(h, dict):
                    self._append_conversation_log(h)
            self._memory_data["conversation_count_total"] = int(self._memory_data.get("conversation_count_total") or len(history) or 0)
            self._memory_data["conversation_history"] = history[-MAX_IN_MEMORY_CONVERSATION_HISTORY:]
        except Exception as e:
            logger.warning(f"[记忆] 迁移对话历史到JSONL失败(忽略): {e}")

    def _save(self):
        """保存记忆数据到磁盘文件"""
        try:
            # Keep history bounded in the JSON snapshot; full history lives in JSONL.
            with self._lock:
                self._memory_data["updated_at"] = time.time()
                snapshot = dict(self._memory_data)
                history = snapshot.get("conversation_history", [])
                if isinstance(history, list) and len(history) > MAX_IN_MEMORY_CONVERSATION_HISTORY:
                    snapshot["conversation_history"] = history[-MAX_IN_MEMORY_CONVERSATION_HISTORY:]

            # 保存记忆快照到单个文件
            storage_path = self._get_storage_path("memory")
            with open(storage_path, 'w', encoding='utf-8') as f:
                json.dump(snapshot, f, ensure_ascii=False, indent=2)

            logger.debug(f"记忆保存成功: {self.task_id}")
            return True
        except Exception as e:
            logger.error(f"记忆保存失败: {str(e)}")
            return False

    def _load(self):
        """从磁盘文件加载记忆数据"""
        try:
            storage_path = self._get_storage_path("memory")
            if storage_path.exists():
                with open(storage_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    # 合并加载的数据，保留默认值
                    for key, value in data.items():
                        if key in self._memory_data:
                            self._memory_data[key] = value

            # Backfill total counter for older snapshots.
            if not isinstance(self._memory_data.get("conversation_count_total"), int) or self._memory_data.get("conversation_count_total", 0) <= 0:
                hist = self._memory_data.get("conversation_history", [])
                if isinstance(hist, list):
                    self._memory_data["conversation_count_total"] = len(hist)

            # One-time migration for old large snapshots.
            self._maybe_migrate_history_to_log()

            logger.debug(f"记忆加载成功: {self.task_id}")
            return True
        except Exception as e:
            logger.error(f"记忆加载失败: {str(e)}")
            return False

    def add_conversation(self, role: str, message: str, section_id: Optional[str] = None,
                        storage_type: str = "session_memory", classification_result: Dict[str, Any] = None):
        """添加对话记录（增强版：同时存入ChromaDB向量数据库）

        Args:
            role: 角色（user/assistant）
            message: 消息内容
            section_id: 章节ID（可选）
            storage_type: 存储类型（session_memory/cross_session_memory/global_memory）
            classification_result: LLM分类结果（可选）
        """
        # 添加记忆等级信息
        memory_level = "P1_SESSION"  # 默认等级
        if storage_type == "global_memory":
            memory_level = "P0_IDENTITY"
        elif storage_type == "cross_session_memory":
            memory_level = "P2_HISTORY"
        else:
            # 会话记忆，根据分类结果确定等级
            if classification_result and classification_result.get("category") == "tool_call":
                memory_level = "P3_TOOLS"
        
        # 创建ConversationMessage，将记忆等级存储在metadata中
        msg = ConversationMessage(
            timestamp=time.time(),
            role=role,
            message=message,
            section_id=section_id,
            metadata={
                "memory_level": memory_level
            }
        )

        msg_dict = msg.model_dump()
        # 同时将记忆等级直接存储在字典中，方便后续检索
        msg_dict["memory_level"] = memory_level

        # Write to append-only log first, then keep a bounded tail in snapshot to avoid huge rewrites.
        log_item = dict(msg_dict)
        log_item["storage_type"] = storage_type
        if classification_result:
            # Keep the full dict in JSONL (ok), but snapshot stays bounded anyway.
            log_item["classification"] = classification_result
        
        with self._lock:
            self._maybe_migrate_history_to_log()
            self._append_conversation_log(log_item)
            self._memory_data["conversation_count_total"] = int(self._memory_data.get("conversation_count_total") or 0) + 1
            self._memory_data["conversation_history"].append(msg_dict)
            if len(self._memory_data["conversation_history"]) > MAX_IN_MEMORY_CONVERSATION_HISTORY:
                self._memory_data["conversation_history"] = self._memory_data["conversation_history"][-MAX_IN_MEMORY_CONVERSATION_HISTORY:]

        # 存储到ChromaDB向量数据库（传递存储类型和分类结果）
        try:
            self._store_to_vector_db(msg_dict, storage_type, classification_result)
        except Exception as e:
            logger.warning(f"[对话存储] 存储到向量数据库失败: {e}")

        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        
        # 保存到磁盘
        self._save()

    def _store_to_vector_db(self, msg_dict: Dict[str, Any], storage_type: str = "session_memory",
                           classification_result: Dict[str, Any] = None):
        """存储对话到ChromaDB向量数据库（支持智能分类存储）

        Args:
            msg_dict: 对话消息字典
            storage_type: 存储类型（session_memory/cross_session_memory/global_memory）
            classification_result: LLM分类结果
        """
        if not hasattr(self, 'vector_store') or self.vector_store is None:
            return

        # 准备文档内容
        content = f"[{msg_dict['role']}] {msg_dict['message']}"

        # 准备元数据（包含存储类型、记忆等级和分类信息）
        metadata = {
            "type": storage_type,  # 关键：区分存储类型
            "memory_level": msg_dict.get("memory_level", "P1_SESSION"),  # 添加记忆等级
            "session_id": self.task_id,
            "role": msg_dict['role'],
            "timestamp": msg_dict['timestamp'],
            "section_id": msg_dict.get('section_id'),
            "message_type": "conversation"
        }

        # 添加LLM分类结果到元数据
        if classification_result:
            # 添加分类相关的元数据字段，只存储简单类型
            if "category" in classification_result:
                metadata["category"] = classification_result["category"]
            if "confidence" in classification_result:
                metadata["confidence"] = classification_result["confidence"]
            if "keywords_detected" in classification_result:
                # 将列表转换为字符串
                metadata["keywords"] = ",".join(classification_result["keywords_detected"]) if classification_result["keywords_detected"] else ""
            if "storage_level" in classification_result:
                metadata["storage_level"] = classification_result["storage_level"]

        # 创建Document
        from langchain_core.documents import Document
        doc = Document(
            page_content=content,
            metadata=metadata
        )

        # 添加到向量数据库
        self.vector_store.add_documents([doc])
    def get_conversation_history(self, limit: int = 10, section_id: Optional[str] = None) -> List[ConversationMessage]:
        """获取对话历史（默认从 JSONL 读取，避免长会话加载/写盘瓶颈）"""
        limit = int(limit or 0)
        if limit <= 0:
            return []

        log_path = self._get_conversation_log_path()
        items: List[Dict[str, Any]] = []

        if log_path.exists():
            # Tail-read a bounded number of lines from the end.
            want = max(limit * 5, limit)
            try:
                with open(log_path, "rb") as f:
                    f.seek(0, 2)
                    end = f.tell()
                    buf = b""
                    step = 4096
                    while end > 0 and buf.count(b"\n") <= want:
                        read_size = min(step, end)
                        end -= read_size
                        f.seek(end)
                        buf = f.read(read_size) + buf
                        if len(buf) > 4 * 1024 * 1024:  # cap memory use on extremely long logs
                            break
                lines = [l for l in buf.splitlines() if l.strip()]
                tail = lines[-want:]
                for raw in tail:
                    try:
                        d = json.loads(raw.decode("utf-8"))
                        if isinstance(d, dict):
                            items.append(d)
                    except Exception:
                        continue
            except Exception as e:
                logger.warning(f"[记忆] 读取对话日志失败(降级为快照): {e}")

        if not items:
            # Fallback to in-memory snapshot (bounded tail).
            history = self._memory_data.get("conversation_history", [])
            if isinstance(history, list):
                items = [h for h in history if isinstance(h, dict)]

        # If specified, filter by section_id.
        if section_id:
            items = [h for h in items if h.get("section_id") == section_id]

        items = items[-limit:]
        return [ConversationMessage(**h) for h in items]

    def update_project_context(self, context: ProjectContext):
        """更新项目上下文"""
        self._memory_data["project_context"] = context.model_dump()
        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        # 保存到磁盘
        self._save()

    def get_project_context(self) -> ProjectContext:
        """获取项目上下文"""
        data = self._memory_data.get("project_context", {})
        return ProjectContext(**data)

    def update_user_preferences(self, preferences: UserPreference):
        """更新用户偏好"""
        self._memory_data["user_preferences"] = preferences.model_dump()
        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        # 保存到磁盘
        self._save()

    def get_user_preferences(self) -> UserPreference:
        """获取用户偏好"""
        data = self._memory_data.get("user_preferences", {})
        return UserPreference(**data)

    def update_user_profile(self, profile: UserProfile):
        """更新用户基本信息"""
        profile_data = profile.model_dump()
        # 设置创建时间和更新时间
        if not profile_data.get("created_at"):
            profile_data["created_at"] = time.time()
        profile_data["updated_at"] = time.time()

        self._memory_data["user_profile"] = profile_data

        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        
        # 保存到磁盘
        self._save()

        return True

    def get_user_profile(self) -> UserProfile:
        """获取用户基本信息"""
        data = self._memory_data.get("user_profile", {})
        if not data:
            return UserProfile()
        return UserProfile(**data)

    def extract_user_info_from_conversation(self, user_message: str) -> Optional[UserProfile]:
        """从用户消息中提取用户信息（需要LLM辅助）

        这个方法需要结合LLM才能准确提取用户信息。
        目前只是预留接口，实际使用时需要传入LLM实例。
        """
        # 注意：这里需要LLM辅助才能准确提取用户信息
        # 直接用正则表达式容易误判，建议在Agent中调用LLM处理
        logger.info("用户信息提取需要LLM辅助，建议在Agent中实现")

        return None

    def add_section_relationship(self, section_id: str, related_sections: List[str]):
        """添加章节关联关系"""
        if section_id not in self._memory_data["section_relationships"]:
            self._memory_data["section_relationships"][section_id] = SectionRelationship(
                section_id=section_id
            ).model_dump()

        rel = self._memory_data["section_relationships"][section_id]
        existing = set(rel.get("related_sections", []))
        existing.update(related_sections)
        rel["related_sections"] = list(existing)

        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        
        # 保存到磁盘
        self._save()

    def get_section_relationships(self, section_id: str) -> Optional[SectionRelationship]:
        """获取章节关联关系"""
        data = self._memory_data["section_relationships"].get(section_id)
        if data:
            return SectionRelationship(**data)
        return None

    def get_all_related_sections(self, section_id: str) -> List[str]:
        """获取所有相关章节（包括传递闭包）"""
        related = set()
        visited = set()
        queue = [section_id]

        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            rel = self.get_section_relationships(current)
            if rel:
                for related_id in rel.related_sections:
                    if related_id not in visited:
                        related.add(related_id)
                        queue.append(related_id)

        return list(related)

    def add_cross_session_memory(self, cross_session_id: str, key: str, value: Any, metadata: Dict[str, Any] = None):
        """添加跨会话记忆
        
        Args:
            cross_session_id: 跨会话记忆的标识符
            key: 记忆键
            value: 记忆值
            metadata: 元数据
        """
        if cross_session_id not in self._memory_data["cross_session_memory"]:
            self._memory_data["cross_session_memory"][cross_session_id] = {}
        
        self._memory_data["cross_session_memory"][cross_session_id][key] = {
            "value": value,
            "metadata": metadata or {},
            "created_at": time.time(),
            "updated_at": time.time()
        }
        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        
        # 保存到磁盘
        self._save()
    
    def get_cross_session_memory(self, cross_session_id: str, key: str = None) -> Any:
        """获取跨会话记忆
        
        Args:
            cross_session_id: 跨会话记忆的标识符
            key: 记忆键（可选，不提供则返回所有）
            
        Returns:
            记忆值或所有记忆
        """
        if cross_session_id not in self._memory_data["cross_session_memory"]:
            return None if key else {}
        
        if key:
            return self._memory_data["cross_session_memory"][cross_session_id].get(key)
        else:
            return self._memory_data["cross_session_memory"][cross_session_id]
    
    def update_cross_session_memory(self, cross_session_id: str, key: str, value: Any, metadata: Dict[str, Any] = None):
        """更新跨会话记忆
        
        Args:
            cross_session_id: 跨会话记忆的标识符
            key: 记忆键
            value: 记忆值
            metadata: 元数据（可选，不提供则保留原有）
        """
        if cross_session_id not in self._memory_data["cross_session_memory"]:
            self.add_cross_session_memory(cross_session_id, key, value, metadata)
        elif key in self._memory_data["cross_session_memory"][cross_session_id]:
            existing = self._memory_data["cross_session_memory"][cross_session_id][key]
            existing["value"] = value
            if metadata:
                existing["metadata"] = metadata
            existing["updated_at"] = time.time()
            # 更新内存缓存
            self._memory_data["updated_at"] = time.time()
            
            # 保存到磁盘
            self._save()
    
    def delete_cross_session_memory(self, cross_session_id: str, key: str = None):
        """删除跨会话记忆
        
        Args:
            cross_session_id: 跨会话记忆的标识符
            key: 记忆键（可选，不提供则删除所有）
        """
        if cross_session_id in self._memory_data["cross_session_memory"]:
            if key:
                if key in self._memory_data["cross_session_memory"][cross_session_id]:
                    del self._memory_data["cross_session_memory"][cross_session_id][key]
            else:
                del self._memory_data["cross_session_memory"][cross_session_id]
            # 更新内存缓存
            self._memory_data["updated_at"] = time.time()
            
            # 保存到磁盘
            self._save()

    def store_intermediate_result(self, key: str, value: Any):
        """存储中间结果"""
        self._memory_data["intermediate_results"][key] = value
        # 更新内存缓存
        self._memory_data["updated_at"] = time.time()
        
        # 保存到磁盘
        self._save()

    def get_intermediate_result(self, key: str, default: Any = None) -> Any:
        """获取中间结果"""
        return self._memory_data["intermediate_results"].get(key, default)

    def clear(self):
        """清空记忆（保留用户基本信息）"""
        with self._lock:
            user_profile = self._memory_data.get("user_profile", {})
            # Best-effort clear the append-only log as well.
            try:
                p = self._get_conversation_log_path()
                if p.exists():
                    p.unlink()
            except Exception as e:
                logger.warning(f"[memory] failed to clear conversation log: {e}", exc_info=True)

            self._memory_data = {
                "task_id": self.task_id,
                "created_at": time.time(),
                "updated_at": time.time(),
                "user_profile": user_profile,  # 保留用户信息
                "user_preferences": {},
                "project_context": {},
                "cross_session_memory": {},
                "conversation_history": [],
                "conversation_count_total": 0,
                "section_relationships": {},
                "intermediate_results": {},
            }

        # 持久化清空后的快照，避免重载时历史回流。
        self._save()

    def get_summary(self) -> Dict[str, Any]:
        """获取记忆摘要"""
        user_profile = self._memory_data.get("user_profile", {})
        return {
            "task_id": self.task_id,
            "created_at": self._memory_data.get("created_at"),
            "updated_at": self._memory_data.get("updated_at"),
            "conversation_count": int(self._memory_data.get("conversation_count_total") or len(self._memory_data.get("conversation_history", [])) or 0),
            "sections_count": len(self._memory_data.get("section_relationships", {})),
            "has_project_context": bool(self._memory_data.get("project_context")),
            "has_user_preferences": bool(self._memory_data.get("user_preferences")),
            "has_user_profile": bool(user_profile),
            "user_name": user_profile.get("name"),
            "user_company": user_profile.get("company"),
        }


class MemoryManager:
    """记忆管理器"""

    def __init__(self, storage_root: Path):
        self.storage_root = Path(storage_root)
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self._memories: Dict[str, TaskMemory] = {}

    def get_memory(self, task_id: str) -> TaskMemory:
        """获取任务记忆"""
        if task_id not in self._memories:
            self._memories[task_id] = TaskMemory(task_id, self.storage_root)
        return self._memories[task_id]

    def delete_memory(self, task_id: str):
        """删除任务记忆"""
        if task_id in self._memories:
            del self._memories[task_id]

    def list_memories(self) -> List[Dict[str, Any]]:
        """列出所有记忆"""
        memories = []
        
        # 1. 从内存中获取所有会话记忆
        for task_id, memory in self._memories.items():
            memories.append(memory.get_summary())
        
        # 2. 从磁盘文件中获取未加载到内存的记忆
        for memory_file in self.storage_root.glob("*_memory.json"):
            task_id = memory_file.stem.replace("_memory", "")
            # 跳过已在内存中的记忆
            if task_id not in self._memories:
                # 创建临时Memory实例来获取摘要
                temp_memory = TaskMemory(task_id, self.storage_root)
                memories.append(temp_memory.get_summary())

        # 按更新时间排序
        memories.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
        return memories


# 全局记忆管理器实例
_memory_manager = None
_global_user_profile_cache = None  # 全局用户档案缓存



def get_memory_manager(storage_root: Optional[Path] = None) -> MemoryManager:
    """获取全局记忆管理器"""
    global _memory_manager
    if _memory_manager is None:
        if storage_root is None:
            # 修复：使用统一配置，从项目根目录的storage获取
            from ..config import settings
            storage_root = settings.storage_root / "memory"
        _memory_manager = MemoryManager(storage_root)
    return _memory_manager



def get_global_user_memory() -> TaskMemory:
    """获取全局用户记忆（跨所有会话共享）

    这里存储的是用户的个人信息、偏好等全局信息，
    不依赖具体的session_id。
    """
    manager = get_memory_manager()
    return manager.get_memory("__GLOBAL_USER__")



def get_task_memory(session_id: str) -> TaskMemory:
    """获取特定任务的记忆（与特定任务相关）

    这里存储的是与特定任务、文档、项目相关的信息，
    每次session_id不同会有不同的记忆空间。
    """
    # 确保session_id不为空
    if not session_id:
        # 生成格式：session_<时间戳>_<随机数>，与设计文档的session_<投标文件唯一标识>_<时间戳>兼容
        # 投标文件唯一标识由上层业务逻辑提供，这里使用时间戳和随机数确保唯一性
        import uuid
        timestamp = int(time.time())
        random_suffix = uuid.uuid4().hex[:8]
        session_id = f"session_{timestamp}_{random_suffix}"

    manager = get_memory_manager()
    return manager.get_memory(session_id)



def verify_global_user_memory() -> Dict[str, Any]:
    """验证全局用户记忆的保存状态（调试用）

    Returns:
        包含验证结果的字典，包含以下字段：
        - file_exists: 全局用户记忆文件是否存在
        - file_size: 文件大小（字节）
        - can_load: 是否可以成功加载
        - user_profile: 用户档案信息
        - last_updated: 最后更新时间
        - issues: 发现的问题列表
    """
    try:
        from ..config import settings
        storage_root = settings.storage_root / "memory"
        global_memory_file = storage_root / "__GLOBAL_USER___memory.json"

        result = {
            "file_exists": False,
            "file_size": 0,
            "can_load": False,
            "user_profile": {},
            "last_updated": None,
            "issues": []
        }

        # 检查文件是否存在
        if global_memory_file.exists():
            result["file_exists"] = True
            result["file_size"] = global_memory_file.stat().st_size

            # 尝试加载文件内容
            try:
                with open(global_memory_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    result["can_load"] = True
                    result["user_profile"] = data.get("user_profile", {})
                    result["last_updated"] = data.get("updated_at")

                    # 检查用户档案是否为空
                    if not result["user_profile"]:
                        result["issues"].append("用户档案为空")

            except Exception as e:
                result["issues"].append(f"加载失败: {e}")
        else:
            result["issues"].append("全局用户记忆文件不存在")

        # 检查记忆管理器状态
        try:
            manager = get_memory_manager()
            result["memory_manager_exists"] = True
        except Exception as e:
            result["issues"].append(f"记忆管理器初始化失败: {e}")

        return result

    except Exception as e:
        return {
            "error": f"验证过程发生异常: {e}",
            "file_exists": False,
            "can_load": False,
            "issues": [str(e)]
        }



def get_memory_system_status() -> Dict[str, Any]:
    """获取整个记忆系统的状态信息（调试用）

    Returns:
        包含记忆系统完整状态的字典
    """
    try:
        # 获取全局用户记忆验证结果
        global_memory_status = verify_global_user_memory()

        # 获取记忆管理器信息
        manager = get_memory_manager()
        all_memories = manager.list_memories()

        # 统计信息
        total_memories = len(all_memories)
        global_memory_count = sum(1 for m in all_memories if m.get("task_id") == "__GLOBAL_USER__")

        return {
            "timestamp": datetime.now().isoformat(),
            "global_user_memory": global_memory_status,
            "memory_manager": {
                "storage_root": str(manager.storage_root),
                "total_memories": total_memories,
                "global_memory_count": global_memory_count
            },
            "all_memories": all_memories[:10],  # 只返回前10个
            "status": "healthy" if not global_memory_status.get("issues") else "issues_found"
        }

    except Exception as e:
        return {
            "timestamp": datetime.now().isoformat(),
            "error": f"获取记忆系统状态失败: {e}",
            "status": "error"
        }
