"""
Project-scoped RAG index (local-only).

We keep the vector store global (one Chroma collection) to avoid re-embedding the
same files for multiple projects. Project scoping is implemented as a lightweight
mapping: project_id -> allowed source paths, plus a global library.

This file is persisted next to the Chroma persist directory so it travels with
the local knowledge base.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

GLOBAL_PROJECT_ID = "global"
INDEX_FILENAME = "project_rag_index.json"

# Heuristics for "project root" discovery. Keep the list small and stable.
PROJECT_ROOT_MARKERS = (
    "ah32.project.json",
    ".git",
    "pyproject.toml",
    "package.json",
    "go.mod",
)


def _norm_path(p: str) -> str:
    try:
        # Resolve for stability when possible.
        return str(Path(p).expanduser().resolve())
    except Exception:
        return str(p or "")


def _project_id_from_root(root: str) -> str:
    digest = hashlib.sha1(_norm_path(root).lower().encode("utf-8")).hexdigest()[:12]
    return f"proj_{digest}"


def find_project_root(path_or_dir: str) -> Optional[Path]:
    """Best-effort project root discovery from a file/dir path.

    Returns the nearest ancestor containing a known marker; falls back to the
    containing directory.
    """
    raw = str(path_or_dir or "").strip()
    if not raw:
        return None

    p = Path(raw)
    try:
        if p.exists():
            p = p.resolve()
    except Exception as e:
        logger.debug(f"[rag-index] resolve path failed: {e}", exc_info=True)

    # If it's a file path (or looks like one), start from its parent.
    try:
        if p.suffix or p.is_file():
            start = p.parent
        else:
            start = p
    except Exception:
        logger.debug("[rag-index] detect file/dir failed; fallback to parent", exc_info=True)
        start = p.parent

    if not str(start):
        return None

    cur = start
    for parent in (cur, *cur.parents):
        for marker in PROJECT_ROOT_MARKERS:
            try:
                if (parent / marker).exists():
                    return parent
            except Exception:
                continue
    return start


@dataclass(frozen=True)
class ProjectContext:
    project_id: str
    root: str
    label: str


def derive_project_context(path_or_dir: str) -> Optional[ProjectContext]:
    root = find_project_root(path_or_dir)
    if not root:
        return None
    root_str = str(root)
    return ProjectContext(
        project_id=_project_id_from_root(root_str),
        root=root_str,
        label=root.name or root_str,
    )


class ProjectRagIndex:
    """Maintains project/global -> source path membership without duplicating vectors."""

    def __init__(self, persist_dir: Path) -> None:
        self.persist_dir = Path(persist_dir)
        self.index_path = self.persist_dir / INDEX_FILENAME
        self._lock = threading.RLock()

        self._global_sources: Set[str] = set()
        self._projects: Dict[str, Dict[str, Any]] = {}
        self._source_projects: Dict[str, Set[str]] = {}

    @classmethod
    def load(cls, persist_dir: Path) -> "ProjectRagIndex":
        inst = cls(persist_dir)
        inst._load()
        return inst

    def _load(self) -> None:
        with self._lock:
            self._global_sources.clear()
            self._projects.clear()
            self._source_projects.clear()

            if not self.index_path.exists():
                return

            try:
                data = json.loads(self.index_path.read_text(encoding="utf-8") or "{}")
            except Exception:
                return

            global_sources = data.get("global_sources") or []
            if isinstance(global_sources, list):
                self._global_sources = {str(x) for x in global_sources if x}

            projects = data.get("projects") or {}
            if isinstance(projects, dict):
                for pid, meta in projects.items():
                    if not pid or not isinstance(meta, dict):
                        continue
                    sources = meta.get("sources") or []
                    src_set = {str(x) for x in sources if x} if isinstance(sources, list) else set()
                    self._projects[str(pid)] = {
                        "label": str(meta.get("label") or ""),
                        "root": str(meta.get("root") or ""),
                        "sources": src_set,
                        "updated_at": float(meta.get("updated_at") or 0.0),
                    }
                    for s in src_set:
                        self._source_projects.setdefault(s, set()).add(str(pid))

    def save(self) -> None:
        with self._lock:
            payload = {
                "version": 1,
                "updated_at": time.time(),
                "global_sources": sorted(self._global_sources),
                "projects": {
                    pid: {
                        "label": meta.get("label") or "",
                        "root": meta.get("root") or "",
                        "updated_at": float(meta.get("updated_at") or 0.0),
                        "sources": sorted(list(meta.get("sources") or [])),
                    }
                    for pid, meta in sorted(self._projects.items(), key=lambda x: x[0])
                },
            }
            try:
                self.persist_dir.mkdir(parents=True, exist_ok=True)
                self.index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                # Best-effort; this is a local-only optimization.
                logger.warning(
                    "[project_rag_index] save index failed path=%s",
                    str(self.index_path),
                    exc_info=True,
                )

    def is_empty(self) -> bool:
        """Return True if the index has no global sources and no project sources.

        This is used for backward-compatible bootstrapping when an empty index file
        exists on disk but the vector store already contains embeddings.
        """
        with self._lock:
            if self._global_sources:
                return False
            for meta in (self._projects or {}).values():
                src = (meta or {}).get("sources") or set()
                try:
                    if len(src) > 0:
                        return False
                except Exception:
                    # If an unexpected type slips in, treat it as non-empty to avoid destructive bootstraps.
                    return False
            return True

    def bootstrap_all_as_global(self, sources: Iterable[str]) -> None:
        """One-time bootstrap: mark all existing sources as global to keep backward compatibility."""
        with self._lock:
            for s in sources:
                if s:
                    self._global_sources.add(str(s))

    def add_global(self, source: str) -> None:
        with self._lock:
            if source:
                self._global_sources.add(str(source))

    def add_project(self, source: str, ctx: ProjectContext) -> None:
        if not source or not ctx:
            return
        with self._lock:
            pid = str(ctx.project_id)
            meta = self._projects.get(pid)
            if not meta:
                meta = {"label": ctx.label, "root": ctx.root, "sources": set(), "updated_at": 0.0}
                self._projects[pid] = meta
            meta["label"] = meta.get("label") or ctx.label
            meta["root"] = meta.get("root") or ctx.root
            meta["sources"].add(str(source))
            meta["updated_at"] = time.time()
            self._source_projects.setdefault(str(source), set()).add(pid)

    def remove_source_everywhere(self, source: str) -> None:
        if not source:
            return
        s = str(source)
        with self._lock:
            self._global_sources.discard(s)
            pids = list(self._source_projects.get(s, set()))
            for pid in pids:
                meta = self._projects.get(pid)
                if meta and isinstance(meta.get("sources"), set):
                    meta["sources"].discard(s)
            self._source_projects.pop(s, None)

    def get_project_label(self, project_id: str) -> str:
        with self._lock:
            meta = self._projects.get(str(project_id)) or {}
            return str(meta.get("label") or "")

    def get_global_sources(self) -> List[str]:
        with self._lock:
            return sorted(self._global_sources)

    def get_project_sources(self, project_id: str) -> List[str]:
        with self._lock:
            meta = self._projects.get(str(project_id)) or {}
            src = meta.get("sources") or set()
            if isinstance(src, set):
                return sorted(src)
            return sorted({str(x) for x in src if x})

    def get_allowed_sources(self, project_id: Optional[str], include_global: bool = True) -> List[str]:
        """Return allowed source paths for retrieval/listing."""
        pid = str(project_id or "").strip()
        if not pid:
            return []
        if pid == GLOBAL_PROJECT_ID:
            return self.get_global_sources()
        proj = set(self.get_project_sources(pid))
        if include_global:
            proj |= set(self.get_global_sources())
        return sorted(proj)

    def get_scope_for_source(self, source: str) -> str:
        """Return 'global' | 'project' | 'both' | 'unscoped'."""
        s = str(source or "")
        if not s:
            return "unscoped"
        with self._lock:
            in_g = s in self._global_sources
            in_p = bool(self._source_projects.get(s))
        if in_g and in_p:
            return "both"
        if in_g:
            return "global"
        if in_p:
            return "project"
        return "unscoped"

    def get_projects_for_source(self, source: str) -> List[str]:
        s = str(source or "")
        if not s:
            return []
        with self._lock:
            return sorted(self._source_projects.get(s, set()))


_CACHE_LOCK = threading.RLock()
_CACHE: Dict[str, ProjectRagIndex] = {}


def get_project_rag_index(persist_dir: Path) -> ProjectRagIndex:
    """Process-local cache for the membership index."""
    key = _norm_path(str(persist_dir))
    with _CACHE_LOCK:
        inst = _CACHE.get(key)
        if inst is None:
            inst = ProjectRagIndex.load(Path(persist_dir))
            _CACHE[key] = inst
        return inst
