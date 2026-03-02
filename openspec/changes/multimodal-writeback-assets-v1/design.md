# Design (Draft) — Multimodal Writeback Assets (v1)

## Overview

Introduce an ephemeral backend asset store (initially images) and a plan-friendly reference mechanism (`asset://<id>`) for writeback.

## Insertion strategy (pragmatic)

1) Download bytes from backend by `asset_id`
2) Prefer clipboard-based insertion where supported
3) Otherwise fallback to temp-file + host API path insertion (when possible)

## Open questions

1) Auth: bind asset access to `(client_id, session_id)` only, or require per-request short token?
2) Size caps: safe defaults for each host_app (wps/et/wpp)?
3) Writer strategy: clipboard-first vs temp-file-first?

