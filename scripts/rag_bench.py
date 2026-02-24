#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Lightweight RAG smoke/perf bench (local-only).

Prerequisites:
- Have an embedding model configured in `.env` (AH32_EMBEDDING_MODEL)
- Run ingestion first: `ah32-ingest ingest --data-dir data/rag`

This script does NOT require a running backend server.
"""

from __future__ import annotations

import logging
import sys
import time

logger = logging.getLogger(__name__)


SAMPLE_QUERIES = [
    "政府采购法 公开招标",
    "招标投标法 实施条例",
    "本地供应商 属地化 管理 是否违规",
    "指定品牌 独家代理 评分标准",
    "施工合同 工期 变更 结算",
]


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        logger.debug("[rag_bench] stdout/stderr reconfigure failed", exc_info=True)

    logging.basicConfig(level=logging.INFO)

    try:
        from ah32.knowledge.ingest import query_rag
    except Exception as e:
        logger.error("import failed: %s", e, exc_info=True)
        return 1

    # Smoke: show top hits for sample queries.
    for q in SAMPLE_QUERIES:
        t0 = time.perf_counter()
        hits = query_rag(q=q, k=5, filter_type=None)
        dt_ms = (time.perf_counter() - t0) * 1000
        print("\n" + "=" * 80)
        print(f"Q: {q} (elapsed={dt_ms:.1f}ms)")
        if not hits:
            print("No hits. Did you run ingestion?")
            continue
        for i, h in enumerate(hits, start=1):
            print(f"{i}. score={h.get('score')} type={h.get('type')} source={h.get('source')}")
            print(f"   {h.get('content_preview')}")

    # Perf: repeated queries (warm cache).
    loops = 10
    t0 = time.perf_counter()
    total_hits = 0
    for _ in range(loops):
        for q in SAMPLE_QUERIES:
            total_hits += len(query_rag(q=q, k=3, filter_type=None))
    dt = time.perf_counter() - t0
    per_q_ms = (dt / (loops * len(SAMPLE_QUERIES))) * 1000
    print("\n" + "-" * 80)
    print(f"Perf: loops={loops} queries={loops*len(SAMPLE_QUERIES)} total_hits={total_hits} avg={per_q_ms:.1f}ms/query")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

