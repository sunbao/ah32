# Spec — Ephemeral Asset Store (v1)

## Summary

Provide an ephemeral asset store (initially images) to support multimodal generation and writeback without embedding base64 in chat/plan payloads.

## Requirements

- APIs:
  - `POST /agentic/assets/init`
  - `PUT /agentic/assets/{asset_id}/content`
  - `GET /agentic/assets/{asset_id}/content`
  - `DELETE /agentic/assets/{asset_id}`
  - optional `GET /agentic/assets/{asset_id}/status`
- Access control: must be scoped/bound (at least by `client_id` + `session_id` in v1).
- Logging: sizes/hashes only; never bytes.
- Deletion:
  - after successful writeback
  - on cancel/disconnect
  - TTL sweeper as crash-safety

