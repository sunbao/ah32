from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from ah32.knowledge.chroma_utils import make_collection_name
from ah32.knowledge.store import LocalVectorStore

logger = logging.getLogger(__name__)


class TenantVectorStoreRegistry:
    """Cache tenant-scoped vector stores (RAG / skills routing / memory)."""

    def __init__(
        self,
        *,
        storage_root: Path,
        embedding: Any,
        embedding_model: str,
        embedding_dim: int | None,
    ) -> None:
        self._storage_root = Path(storage_root)
        self._embedding = embedding
        self._embedding_model = str(embedding_model or "").strip()
        self._embedding_dim = int(embedding_dim) if isinstance(embedding_dim, int) else None
        self._lock = threading.RLock()
        self._rag: dict[str, Any] = {}
        self._skills: dict[str, Any] = {}
        self._memory: dict[str, Any] = {}

    def _tenant_dir(self, tenant_id: str, subdir: str) -> Path:
        return self._storage_root / "tenants" / str(tenant_id) / subdir

    def get_rag_store(self, tenant_id: str) -> Any:
        key = str(tenant_id or "").strip() or "public"
        with self._lock:
            store = self._rag.get(key)
            if store is not None:
                return store

            persist_path = self._tenant_dir(key, "rag")
            collection_name = make_collection_name(
                "ah32_rag",
                self._embedding_model,
                embedding_dim=self._embedding_dim,
            )
            store = LocalVectorStore(
                persist_path=persist_path,
                embedding=self._embedding,
                config={
                    "collection_name": collection_name,
                    "collection_metadata": {
                        "tenant_id": key,
                        "embedding_model": self._embedding_model,
                        "embedding_dim": self._embedding_dim,
                    },
                },
            )
            self._rag[key] = store
            logger.info(
                "[tenant] init rag vector store tenant_id=%s persist=%s",
                key,
                persist_path,
            )
            return store

    def get_skills_routing_store(self, tenant_id: str) -> Any:
        key = str(tenant_id or "").strip() or "public"
        with self._lock:
            store = self._skills.get(key)
            if store is not None:
                return store

            persist_path = self._tenant_dir(key, "skills_vectors")
            collection_name = make_collection_name(
                "skills",
                self._embedding_model,
                embedding_dim=self._embedding_dim,
            )
            store = LocalVectorStore(
                persist_path=persist_path,
                embedding=self._embedding,
                config={
                    "collection_name": collection_name,
                    "collection_metadata": {
                        "tenant_id": key,
                        "embedding_model": self._embedding_model,
                        "embedding_dim": self._embedding_dim,
                        "hnsw:space": "cosine",
                    },
                },
            )
            self._skills[key] = store
            logger.info(
                "[tenant] init skills routing store tenant_id=%s persist=%s",
                key,
                persist_path,
            )
            return store

    def get_memory_store(self, tenant_id: str) -> Any:
        key = str(tenant_id or "").strip() or "public"
        with self._lock:
            store = self._memory.get(key)
            if store is not None:
                return store

            persist_path = self._tenant_dir(key, "memory")
            collection_name = make_collection_name(
                "ah32_memory",
                self._embedding_model,
                embedding_dim=self._embedding_dim,
            )
            store = LocalVectorStore(
                persist_path=persist_path,
                embedding=self._embedding,
                config={
                    "collection_name": collection_name,
                    "collection_metadata": {
                        "tenant_id": key,
                        "embedding_model": self._embedding_model,
                        "embedding_dim": self._embedding_dim,
                    },
                },
            )
            self._memory[key] = store
            logger.info(
                "[tenant] init memory store tenant_id=%s persist=%s",
                key,
                persist_path,
            )
            return store
