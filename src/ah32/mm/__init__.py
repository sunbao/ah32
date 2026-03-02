"""Multimodal runtime (v1).

This package provides:
- A provider abstraction (image understanding + image generation).
- A default provider adapter for Bailian (阿里百炼) in OpenAI-compatible mode.
- Thin HTTP APIs under `/agentic/mm/*` (see `ah32.server.mm_api`).

Design goals:
- Provider-pluggable, strict-by-default (no silent downgrade).
- Never embed large base64 blobs into chat/plan JSON; use `asset://<id>` instead.
"""

from __future__ import annotations

from .runtime import get_multimodal_provider

__all__ = ["get_multimodal_provider"]

