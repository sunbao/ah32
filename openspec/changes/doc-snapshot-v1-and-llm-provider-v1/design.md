# Design (Draft) — Doc Snapshot (v1) + LLM Provider (v1)

## Overview

Split large document payload out of `/agentic/chat/stream` into an ephemeral `doc_snapshot_id` flow.

## Key design points

- Two-step protocol:
  1) init snapshot
  2) upload parts + finalize
  3) chat references `doc_snapshot_id`
- Strong deletion triggers:
  - turn complete / cancel / disconnect / TTL crash-safety

## Open questions

1) Frontend export: can we reliably implement `client_export_ooxml` across wps/et/wpp?
2) Upload transport: multipart vs chunked raw body — which is easiest with current frontend stack?
3) Minimum inline context: what should still be included in chat request (preview length, hashes)?

