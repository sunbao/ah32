"""Ephemeral asset store (v1).

Assets are short-lived blobs (e.g. generated images) referenced by `asset://<id>`
inside Plan JSON so we don't embed huge base64 strings in chat/plan payloads.
"""

from __future__ import annotations

from .store import AssetStore, get_asset_store

__all__ = ["AssetStore", "get_asset_store"]

