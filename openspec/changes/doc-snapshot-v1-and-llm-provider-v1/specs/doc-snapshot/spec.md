# Spec — Doc Snapshot Protocol (v1)

## Summary

Define an ephemeral document snapshot protocol to decouple large document payloads from chat requests.

## Requirements

- Snapshot API under `/agentic/doc-snapshots/*`
- Upload supports binary + extracted text + attachments (images)
- Chat references `doc_snapshot_id` (no full doc content in chat JSON)
- Strong deletion semantics (success/cancel/disconnect/TTL crash-safety)

