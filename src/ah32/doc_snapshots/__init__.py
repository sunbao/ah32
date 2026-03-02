"""Ephemeral document snapshot store (v1).

Doc snapshots are short-lived, per-turn artifacts used to let a remote backend
read the user's currently-open document without embedding huge payloads in chat
JSON bodies.

Policy:
- Never persist snapshots into RAG.
- Delete snapshots immediately after the turn (chat stream) completes or is cancelled.
- TTL cleanup exists only as crash-safety.
"""

from __future__ import annotations

from .store import DocSnapshotStore, get_doc_snapshot_store

__all__ = ["DocSnapshotStore", "get_doc_snapshot_store"]

