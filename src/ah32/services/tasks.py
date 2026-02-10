"""Task persistence layer."""

from __future__ import annotations

import copy
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Optional, List, Any

class TaskRepository:
    """Persist analysis task metadata, sections, requirements and drafts."""

    def __init__(self, store_path: Path) -> None:
        self.store_path = store_path
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._data = self._load()

    def _load(self) -> dict:
        if not self.store_path.exists():
            return {"tasks": {}}
        try:
            return json.loads(self.store_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"tasks": {}}

    def _persist(self) -> None:
        self.store_path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def save_task(self, task_id: str, task_data: dict) -> str:
        """
        直接保存任务数据（Agent 架构兼容接口）
        
        Args:
            task_id: 任务ID
            task_data: {
                "sections": [SectionModel, ...],
                "requirements": [RequirementModel, ...],
                "drafts": [DraftModel, ...],
                "total_tokens": {...}
            }
        
        Returns:
            task_id
        """
        with self._lock:
            self._data.setdefault("tasks", {})
            now = time.time()
            
            # 转换为存储格式
            self._data["tasks"][task_id] = {
                "created_at": now,
                "updated_at": now,
                "status": "drafted",
                "sections": [
                    {
                        "order": s.order,
                        "section_id": s.section_id,
                        "title": s.title,
                        "level": s.level,
                        "text": s.text,
                        "raw_style": s.raw_style,
                        "formatting": s.formatting
                    }
                    for s in task_data["sections"]
                ],
                "requirements": {
                    req.section_id: {
                        "section_id": req.section_id,
                        "order": req.order,
                        "title": req.title,
                        "level": req.level,
                        "requirement": req.requirement,
                        "formatting": req.formatting
                    }
                    for req in task_data["requirements"]
                },
                "drafts": {
                    draft.section_id: {
                        "section_id": draft.section_id,
                        "title": draft.title,
                        "content": draft.content,
                        "source": draft.source,
                        "token_usage": draft.token_usage,
                        "review_data": draft.review_data,
                        "intermediate_steps": draft.intermediate_steps  # Agent 推理步骤
                    }
                    for draft in task_data["drafts"]
                },
            }
            self._persist()
        return task_id

    def list_tasks(self) -> List[dict]:
        with self._lock:
            tasks = self._data.get("tasks", {})
            return [
                {
                    "task_id": task_id,
                    "created_at": payload.get("created_at"),
                    "sections": len(payload.get("sections", [])),
                    "status": payload.get("status"),
                    "updated_at": payload.get("updated_at"),
                }
                for task_id, payload in tasks.items()
            ]

    def get_task(self, task_id: str) -> Optional[dict]:
        with self._lock:
            task = self._data.get("tasks", {}).get(task_id)
            return copy.deepcopy(task) if task else None

    def list_sections(self, task_id: str) -> List[dict]:
        task = self.get_task(task_id)
        if not task:
            return []
        return task.get("sections", [])

    def get_section(self, task_id: str, section_id: str) -> Optional[dict]:
        for section in self.list_sections(task_id):
            if section.get("section_id") == section_id:
                return section
        return None

    def get_requirement(self, task_id: str, section_id: str) -> Optional[dict]:
        task = self.get_task(task_id)
        if not task:
            return None
        return task.get("requirements", {}).get(section_id)

    def get_draft(self, task_id: str, section_id: str) -> Optional[dict]:
        task = self.get_task(task_id)
        if not task:
            return None
        return task.get("drafts", {}).get(section_id)

    def update_draft(self, task_id: str, section_id: str, draft_data: dict) -> None:
        """
        更新草稿（Agent 架构兼容接口）
        
        Args:
            task_id: 任务ID
            section_id: 章节ID
            draft_data: {
                "section_id": str,
                "title": str,
                "content": str,
                "source": str,
                "token_usage": dict | None,
                "review_data": dict | None,
                "intermediate_steps": list | None
            }
        """
        with self._lock:
            tasks = self._data.setdefault("tasks", {})
            task = tasks.get(task_id)
            if not task:
                return
            task.setdefault("drafts", {})
            task["drafts"][section_id] = draft_data
            task["updated_at"] = time.time()
            self._persist()

    def update_status(self, task_id: str, status: str) -> None:
        with self._lock:
            tasks = self._data.setdefault("tasks", {})
            task = tasks.get(task_id)
            if not task:
                return
            task["status"] = status
            task["updated_at"] = time.time()
            self._persist()

class ConversationRepository:
    """Separate storage for conversation history per task/section."""

    def __init__(self, store_path: Path) -> None:
        self.store_path = store_path
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._data = self._load()

    def _load(self) -> dict:
        if not self.store_path.exists():
            return {}
        try:
            return json.loads(self.store_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def _persist(self) -> None:
        self.store_path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def append_message(
        self,
        task_id: str,
        section_id: str,
        *,
        role: str,
        content: str,
        source: str | None = None,
    ) -> None:
        record = {
            "role": role,
            "content": content,
            "source": source or role,
            "timestamp": time.time(),
        }
        with self._lock:
            task_log = self._data.setdefault(task_id, {})
            history = task_log.setdefault(section_id, [])
            history.append(record)
            self._persist()

    def get_history(self, task_id: str, section_id: str) -> List[dict]:
        with self._lock:
            history = self._data.get(task_id, {}).get(section_id, [])
            return copy.deepcopy(history)

    def list_all(self, task_id: str) -> dict:
        with self._lock:
            return copy.deepcopy(self._data.get(task_id, {}))
