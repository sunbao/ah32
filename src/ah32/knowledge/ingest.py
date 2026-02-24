"""RAG library ingestion CLI: `data/rag/` -> Chroma vector store.

This closes the loop between:
- Repo/runtime data files under `data/rag/`
- Backend vector store used by RAG retrieval (`settings.embeddings_path`)

Usage:
  ah32-ingest ingest --data-dir data/rag
  ah32-ingest query --q "政府采购 法" --k 5 --filter-type policy
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from langchain_core.documents import Document

from ah32.config import settings
from ah32.core.text_splitter import split_document
from ah32.knowledge.chroma_utils import make_collection_name
from ah32.knowledge.embeddings import resolve_embedding
from ah32.knowledge.store import LocalVectorStore
from ah32.runtime_paths import runtime_root

logger = logging.getLogger(__name__)


def _configure_utf8_stdio() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        logger.debug("[ingest] stdout/stderr reconfigure failed (ignored)", exc_info=True)


def _compute_file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _source_key(path: Path) -> str:
    root = runtime_root()
    try:
        rel = path.resolve().relative_to(root.resolve())
        return str(rel).replace("\\", "/")
    except Exception:
        return str(path.resolve()).replace("\\", "/")


def _doc_type_for_path(path: Path) -> str:
    parts = [p.lower() for p in path.parts]
    if "policies" in parts:
        return "policy"
    if "contracts" in parts:
        return "contract"
    if "cases" in parts:
        return "case"
    if "sensitive_words" in parts:
        return "sensitive_words"
    return (path.parent.name or "rag").lower()


def _build_text_from_json(doc_type: str, obj: Any, *, fallback_title: str) -> str:
    if not isinstance(obj, dict):
        try:
            return json.dumps(obj, ensure_ascii=False, indent=2)
        except Exception:
            return str(obj)

    title = str(obj.get("policy_name") or obj.get("title") or obj.get("name") or fallback_title).strip()
    lines: List[str] = []
    if title:
        lines.append(title)
        lines.append("")

    # Common fields
    for key in ("document_number", "issued_by", "issue_date", "effective_date", "category"):
        v = obj.get(key)
        if v:
            lines.append(f"{key}: {v}")
    if lines and lines[-1] != "":
        lines.append("")

    key_points = obj.get("key_points")
    if isinstance(key_points, list) and key_points:
        lines.append("key_points:")
        for kp in key_points[:50]:
            s = str(kp or "").strip()
            if s:
                lines.append(f"- {s}")
        lines.append("")

    full_text = obj.get("full_text") or obj.get("content") or obj.get("text")
    if isinstance(full_text, str) and full_text.strip():
        lines.append(full_text.strip())
        lines.append("")

    # Fallback: store the json itself.
    if not lines or len("".join(lines).strip()) < 40:
        try:
            lines = [json.dumps(obj, ensure_ascii=False, indent=2)]
        except Exception:
            lines = [str(obj)]

    return "\n".join(lines).strip()


def _load_sensitive_words_txt(path: Path) -> List[Tuple[str, str]]:
    """Return [(category, text)] chunks."""
    current = "未分类"
    groups: Dict[str, List[str]] = {current: []}
    try:
        for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("##"):
                current = line.lstrip("#").strip() or "未分类"
                groups.setdefault(current, [])
                continue
            groups.setdefault(current, []).append(line)
    except Exception as e:
        logger.warning("[ingest] read sensitive words failed: %s err=%s", path, e, exc_info=True)
        return []

    out: List[Tuple[str, str]] = []
    for cat, words in groups.items():
        words = [w for w in words if w]
        if not words:
            continue
        text = f"{cat}\n" + "\n".join(words)
        out.append((cat, text))
    return out


def _build_vector_store() -> Tuple[LocalVectorStore, Dict[str, Any]]:
    embedding = resolve_embedding(settings)
    embedding_dim: Optional[int] = None
    try:
        embedding_dim = len(embedding.embed_query("dimension_probe"))
    except Exception as e:
        logger.warning("[ingest] embedding dim probe failed (fallback to model-only collection): %s", e)

    collection_name = make_collection_name("ah32_rag", settings.embedding_model, embedding_dim=embedding_dim)
    store = LocalVectorStore(
        persist_path=settings.embeddings_path,
        embedding=embedding,
        config={
            "collection_name": collection_name,
            "collection_metadata": {"embedding_model": settings.embedding_model, "embedding_dim": embedding_dim},
        },
    )
    return store, {"collection_name": collection_name, "embedding_dim": embedding_dim}


@dataclass(frozen=True)
class IngestSummary:
    total_sources: int
    ingested_sources: int
    skipped_sources: int
    error_sources: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_sources": self.total_sources,
            "ingested_sources": self.ingested_sources,
            "skipped_sources": self.skipped_sources,
            "error_sources": self.error_sources,
        }


def ingest_rag_library(
    *,
    data_dir: Path,
    force: bool = False,
    dry_run: bool = False,
    only_types: Optional[List[str]] = None,
    chunk_size: int = 1200,
    chunk_overlap: int = 120,
) -> IngestSummary:
    store, meta = _build_vector_store()
    logger.info("[ingest] vector store ready: persist=%s collection=%s", settings.embeddings_path, meta["collection_name"])

    data_dir = Path(data_dir)
    if not data_dir.exists():
        raise FileNotFoundError(f"data dir not found: {data_dir}")

    only = {t.strip().lower() for t in (only_types or []) if t and str(t).strip()}

    sources: List[Path] = []
    for p in sorted(data_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.name.lower() == "readme.md":
            continue
        if p.suffix.lower() == ".json":
            sources.append(p)
        elif p.suffix.lower() == ".txt" and p.name.lower() == "sensitive_words.txt":
            sources.append(p)

    ingested = 0
    skipped = 0
    errors = 0

    splitter_config = {"splitter_type": "simple", "chunk_size": int(chunk_size), "chunk_overlap": int(chunk_overlap)}

    for path in sources:
        doc_type = _doc_type_for_path(path)
        if only and doc_type not in only:
            continue

        source = _source_key(path)
        try:
            file_hash = _compute_file_hash(path)
            existing = store.get_documents_by_source(source, limit=1) or []
            existing_hash = None
            if existing and isinstance(existing[0], dict):
                md = existing[0].get("metadata") or {}
                if isinstance(md, dict):
                    existing_hash = md.get("file_hash")
            if (not force) and existing_hash and str(existing_hash) == file_hash:
                skipped += 1
                continue

            base_meta: Dict[str, Any] = {
                "source": source,
                "type": doc_type,
                "file_hash": file_hash,
                "file_mtime": float(path.stat().st_mtime),
                "created_at": float(time.time()),
            }

            documents: List[Document] = []
            if path.suffix.lower() == ".txt":
                for category, text in _load_sensitive_words_txt(path):
                    md = dict(base_meta)
                    md["category"] = category
                    chunks = split_document(text, metadata=md, config=splitter_config)
                    for c in chunks:
                        documents.append(Document(page_content=str(c.get("content") or ""), metadata=dict(c.get("metadata") or {})))
            else:
                obj = json.loads(path.read_text(encoding="utf-8") or "{}")
                text = _build_text_from_json(doc_type, obj, fallback_title=path.stem)
                chunks = split_document(text, metadata=base_meta, config=splitter_config)
                for c in chunks:
                    documents.append(Document(page_content=str(c.get("content") or ""), metadata=dict(c.get("metadata") or {})))

            if dry_run:
                ingested += 1
                continue

            # Upsert by source: delete old, then add.
            try:
                store.delete_by_filter({"source": source})
            except Exception:
                logger.warning("[ingest] delete existing failed (ignored): %s", source, exc_info=True)

            store.add_documents(documents)
            ingested += 1
        except Exception as e:
            errors += 1
            logger.warning("[ingest] ingest failed source=%s err=%s", source, e, exc_info=True)

    return IngestSummary(
        total_sources=len(sources),
        ingested_sources=ingested,
        skipped_sources=skipped,
        error_sources=errors,
    )


def query_rag(
    *,
    q: str,
    k: int = 5,
    filter_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    store, meta = _build_vector_store()
    flt = {"type": filter_type} if filter_type else None
    hits = store.similarity_search(str(q or ""), k=int(k), filter=flt)
    out: List[Dict[str, Any]] = []
    for doc, score in hits:
        out.append(
            {
                "score": float(score) if isinstance(score, (int, float)) else 0.0,
                "source": (doc.metadata or {}).get("source"),
                "type": (doc.metadata or {}).get("type"),
                "category": (doc.metadata or {}).get("category"),
                "content_preview": (doc.page_content or "")[:280],
            }
        )
    return out


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ah32-ingest", description="Ingest/query local RAG library (data/rag).")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_ingest = sub.add_parser("ingest", help="Ingest data/rag into Chroma vector store")
    try:
        from ah32.knowledge.rag_library import get_rag_data_dir

        default_data_dir = str(get_rag_data_dir())
    except Exception:
        default_data_dir = str(runtime_root() / "data" / "rag")
    p_ingest.add_argument(
        "--data-dir",
        type=str,
        default=default_data_dir,
        help="RAG data directory (default: AH32_RAG_DATA_DIR or <runtime_root>/data/rag)",
    )
    p_ingest.add_argument("--force", action="store_true", help="Re-ingest even when file_hash matches")
    p_ingest.add_argument("--dry-run", action="store_true", help="Do not write to vector store")
    p_ingest.add_argument(
        "--only-types",
        type=str,
        default="",
        help="Comma-separated types to ingest (policy,contract,case,sensitive_words)",
    )
    p_ingest.add_argument("--chunk-size", type=int, default=1200)
    p_ingest.add_argument("--chunk-overlap", type=int, default=120)
    p_ingest.add_argument("--json", action="store_true", help="Output summary as JSON")

    p_query = sub.add_parser("query", help="Query vector store for quick verification")
    p_query.add_argument("--q", type=str, required=True, help="Query text")
    p_query.add_argument("--k", type=int, default=5, help="Top-k results")
    p_query.add_argument("--filter-type", type=str, default="", help="Metadata filter: type=...")
    p_query.add_argument("--json", action="store_true", help="Output results as JSON")

    return p


def main(argv: Optional[List[str]] = None) -> int:
    _configure_utf8_stdio()
    logging.basicConfig(level=logging.INFO)

    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        if args.cmd == "ingest":
            only = [x.strip() for x in str(args.only_types or "").split(",") if x.strip()]
            summary = ingest_rag_library(
                data_dir=Path(args.data_dir),
                force=bool(args.force),
                dry_run=bool(args.dry_run),
                only_types=only,
                chunk_size=int(args.chunk_size),
                chunk_overlap=int(args.chunk_overlap),
            )
            if args.json:
                print(json.dumps({"ok": True, "summary": summary.to_dict()}, ensure_ascii=False))
            else:
                logger.info("[ingest] done: %s", summary.to_dict())
            return 0 if summary.error_sources == 0 else 2

        if args.cmd == "query":
            hits = query_rag(q=str(args.q), k=int(args.k), filter_type=str(args.filter_type or "").strip() or None)
            if args.json:
                print(json.dumps({"ok": True, "hits": hits}, ensure_ascii=False))
            else:
                for i, h in enumerate(hits, start=1):
                    print(f"{i}. score={h.get('score')} type={h.get('type')} source={h.get('source')}")
                    print(f"   {h.get('content_preview')}")
            return 0

        parser.print_help()
        return 1
    except Exception as e:
        logger.error("[ingest] failed: %s", e, exc_info=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
