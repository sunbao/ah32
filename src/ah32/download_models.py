#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Model pre-download utility.

Use this to download the embedding model onto this machine once, so the system can
run fully offline for embeddings afterwards.

Privacy note:
- This script only downloads model files from the model hub; it does NOT upload
  your documents.
"""

from __future__ import annotations

import logging
import sys

logger = logging.getLogger(__name__)


def download_embedding_model() -> bool:
    """Download embedding model according to Ah32 settings (env can override)."""
    try:
        from ah32.config import settings
        from ah32.knowledge.embeddings import (
            download_embedding_model as _download_embedding_model,
            get_model_cache_dir,
        )

        cache_dir = get_model_cache_dir(settings)
        logger.info("Embedding model download")
        logger.info(f"- embedding_model: {settings.embedding_model}")
        logger.info(f"- cache_dir: {cache_dir}")

        ok = _download_embedding_model(settings)
        if ok:
            logger.info("OK: embedding model downloaded (subsequent runs can be offline)")
        return ok
    except Exception as e:
        logger.error(f"ERROR: embedding model download failed: {e}", exc_info=True)
        return False


def download_llm_model() -> bool:
    """Placeholder: by default this project uses online LLM endpoints."""
    logger.info("LLM model download: skipped (current config uses online LLM)")
    return True


def main() -> int:
    reconfigure_exc_info = None
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        reconfigure_exc_info = sys.exc_info()
    logging.basicConfig(level=logging.INFO)
    if reconfigure_exc_info:
        logger.warning(
            "[download_models] stdout/stderr reconfigure failed (ignored)",
            exc_info=reconfigure_exc_info,
        )
        reconfigure_exc_info = None

    if sys.version_info < (3, 11):
        logger.error("Python 3.11+ required")
        return 1

    ok = True
    if not download_embedding_model():
        ok = False
    if not download_llm_model():
        ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

