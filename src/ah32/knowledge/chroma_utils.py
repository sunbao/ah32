"""ChromaDB helper utilities.

We use model-specific collection names to avoid Chroma dimension conflicts when
switching embedding models (e.g. 384 -> 1024). Chroma collections are strict
about embedding dimensionality once created.
"""

from __future__ import annotations

import hashlib
import re


_SAFE_CHARS_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def _slugify(value: str) -> str:
    value = (value or "").strip()
    value = _SAFE_CHARS_RE.sub("-", value).strip("-").lower()
    return value or "default"


def make_collection_name(
    prefix: str,
    embedding_model: str,
    embedding_dim: int | None = None,
    max_len: int = 63,
) -> str:
    """Make a stable, ASCII-safe Chroma collection name.

    Chroma collections are persisted under a directory and their dimensionality
    cannot change. When users switch embedding models, using a model-specific
    collection name prevents hard failures like:
      "expecting embedding with dimension of 384, got 1024"
    """
    prefix_slug = _slugify(prefix)
    model_slug = _slugify(embedding_model)
    # Include embedding_dim in the fingerprint so a silent dimension change (same model id,
    # different underlying encoder) won't corrupt the collection.
    digest_input = f"{embedding_model or ''}|{embedding_dim or ''}"
    digest = hashlib.sha1(digest_input.encode("utf-8")).hexdigest()[:8]

    dim_slug = f"d{embedding_dim}" if isinstance(embedding_dim, int) and embedding_dim > 0 else ""

    # Keep both prefix and a short hash stable; trim the model slug if needed.
    reserved = len(prefix_slug) + 2 + len(digest)  # "{prefix}_{model}_{hash}"
    if dim_slug:
        reserved += 1 + len(dim_slug)  # plus "_d{dim}"
    available = max_len - reserved
    if available <= 0:
        # Extremely long prefix; fall back to prefix+hash.
        return f"{prefix_slug}_{digest}"[:max_len]

    model_slug = model_slug[:available]
    if dim_slug:
        return f"{prefix_slug}_{model_slug}_{dim_slug}_{digest}"
    return f"{prefix_slug}_{model_slug}_{digest}"
