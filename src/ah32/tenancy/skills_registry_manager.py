from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

from ah32.skills.registry import SkillRegistry
from ah32.skills.seed import seed_builtin_skills

logger = logging.getLogger(__name__)


class TenantSkillsRegistryManager:
    """Tenant-scoped SkillRegistry cache.

    Policy (R&D stage):
    - Skills are server-managed per tenant.
    - Each tenant has its own on-disk skill folder:
        storage/tenants/<tenant_id>/skills/
    - If the tenant folder is empty/missing, seed built-in example skills.
    """

    def __init__(
        self,
        *,
        storage_root: Path,
        max_total_chars: int = 12000,
        tenant_dirname: str = "tenants",
        skills_dirname: str = "skills",
        tenant_vector_stores: object | None = None,
    ) -> None:
        self._storage_root = Path(storage_root)
        self._tenant_dirname = str(tenant_dirname or "tenants").strip() or "tenants"
        self._skills_dirname = str(skills_dirname or "skills").strip() or "skills"
        self._max_total_chars = int(max_total_chars or 12000)
        self._tenant_vector_stores = tenant_vector_stores

        self._lock = threading.RLock()
        self._by_tenant: dict[str, SkillRegistry] = {}

    def _tenant_skills_dir(self, tenant_id: str) -> Path:
        tid = str(tenant_id or "").strip() or "public"
        return self._storage_root / self._tenant_dirname / tid / self._skills_dirname

    def get(self, tenant_id: str) -> Optional[SkillRegistry]:
        tid = str(tenant_id or "").strip() or "public"
        with self._lock:
            existing = self._by_tenant.get(tid)
            if existing is not None:
                return existing

            root_dir = self._tenant_skills_dir(tid)
            try:
                root_dir.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                logger.error(
                    "[skills] ensure tenant skills dir failed tenant_id=%s dir=%s err=%s",
                    tid,
                    root_dir,
                    e,
                    exc_info=True,
                )
                return None

            # Seed built-ins (non-destructive) when the folder looks empty.
            try:
                has_any = any(p.is_dir() for p in root_dir.iterdir())
            except Exception:
                has_any = False
            if not has_any:
                try:
                    created = seed_builtin_skills(root_dir)
                    logger.info("[skills] seeded builtin skills tenant_id=%s created=%s dir=%s", tid, created, root_dir)
                except Exception as e:
                    logger.warning(
                        "[skills] seed builtin skills failed tenant_id=%s dir=%s err=%s",
                        tid,
                        root_dir,
                        e,
                        exc_info=True,
                    )

            try:
                reg = SkillRegistry(root_dir=root_dir, max_total_chars=self._max_total_chars)
            except Exception as e:
                logger.error(
                    "[skills] init SkillRegistry failed tenant_id=%s dir=%s err=%s",
                    tid,
                    root_dir,
                    e,
                    exc_info=True,
                )
                return None

            # Attach tenant-scoped routing vector store (if available).
            try:
                if self._tenant_vector_stores is not None and hasattr(reg, "set_routing_vector_store"):
                    store = getattr(self._tenant_vector_stores, "get_skills_routing_store")(tid)
                    reg.set_routing_vector_store(store)
            except Exception as e:
                logger.warning(
                    "[skills] attach tenant routing vector store failed tenant_id=%s err=%s",
                    tid,
                    e,
                    exc_info=True,
                )

            self._by_tenant[tid] = reg
            return reg
