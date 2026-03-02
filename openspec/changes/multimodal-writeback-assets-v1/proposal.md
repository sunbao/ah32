# OpenSpec Change Proposal (Draft) — Multimodal Writeback Assets (v1)
Date: 2026-02-24  
Branch baseline: `plan-writeback`  

## Context / Why

We want the system to support **LLM-generated multimodal outputs** (primarily images) and write them back into WPS documents in a controlled, privacy-safe way.

Provider note:
- Default multimodal provider is 阿里百炼 (Bailian), but the asset/writeback mechanism is provider-agnostic.
- Provider adapter + config is specified in `openspec/changes/bailian-multimodal-provider-v1/`.

Constraints:
- WPS automation APIs often prefer **local file paths** for image insertion (e.g., `AddPicture(path)`).
- Taskpane runtimes are memory-sensitive; we should avoid embedding huge base64 blobs inside chat messages or Plan JSON.
- The project rule requires:
  - Do not leak backend JSON (or internal payloads) into chat/document.
  - Private document data and generated assets must be **ephemeral** and **deleted immediately** (no backups).

## Goals

### G1. Unified “Asset” abstraction
Introduce an ephemeral backend asset store to hold generated images (and later other media) for the duration of a turn/session.

### G2. Plan-friendly references
Plan JSON references assets by `asset_id` (or `asset://<id>`), not by raw base64, to keep plans small and stable.

### G3. Host coverage
Support inserting images into:
- Writer (wps)
- ET (et) — optional in v1 (often better as charts or pasted images)
- WPP (wpp)

### G4. Strict deletion semantics
Assets are deleted:
- immediately after successful insertion/writeback, OR
- on cancel/disconnect, OR
- via short TTL sweeper as crash-safety.

## Non-goals (v1)
- Audio/video insertion
- Anthropic provider support (LLM provider switching handled elsewhere)
- Persisting assets into RAG / long-term storage

---

## Proposed API (v1)

Prefix: `/agentic`

### `POST /agentic/assets/init`
Creates an asset slot.

Request JSON:
```json
{
  "kind": "image",
  "mime": "image/png",
  "suggested_name": "diagram.png",
  "ttl_sec": 600,
  "replace_previous": true,
  "scope": {
    "client_id": "string",
    "session_id": "string|null",
    "host_app": "wps|et|wpp",
    "doc_id": "string|null"
  }
}
```

Response JSON:
```json
{
  "asset_id": "string",
  "upload_url": "/agentic/assets/{asset_id}/content",
  "status_url": "/agentic/assets/{asset_id}/status",
  "delete_url": "/agentic/assets/{asset_id}"
}
```

### `PUT /agentic/assets/{asset_id}/content`
Uploads asset bytes (supports multipart and/or raw body).

Rules:
- Backend logs only sizes/hashes, never content.
- Support chunking by `Content-Range` or `offset` query.

### `GET /agentic/assets/{asset_id}/content`
Frontend downloads bytes for insertion.

Notes:
- For privacy, require a per-request token or at least bind to `(client_id, session_id)` in v1.

### `DELETE /agentic/assets/{asset_id}`
Deletes the asset immediately. Idempotent.

### `GET /agentic/assets/{asset_id}/status` (optional)
For UI/debug.

---

## Plan Schema / Writeback Changes (v1)

### Option A (minimal): reuse existing image ops with extended `path`
Allow image `path` to accept:
- local path (existing behavior)
- http(s) url
- `asset://<asset_id>`

Frontend resolves `asset://...` by downloading bytes from backend and inserting via:
- WPP: existing “data_url clipboard paste” fallback (already implemented)
- Writer/ET: add a similar clipboard-paste fallback OR (if supported) write temp file and call `AddPicture(tempPath)`

### Option B (cleaner): add explicit fields
Add to image actions:
```json
{
  "op": "add_image",
  "asset_id": "string|null",
  "url": "string|null",
  "path": "string|null"
}
```
and require exactly one of them.

Owner preference: avoid proliferating new ops; keep it minimal and consistent.

---

## Frontend Insertion Strategy (pragmatic)

Because local filesystem access is unreliable in taskpane runtimes, we prefer:
1) Download asset bytes from backend.
2) Convert to `data:` URL (bounded).
3) Paste via clipboard into the target selection/slide when possible.
4) If clipboard paste is unavailable, fall back to local-path insertion when we have a path (same-machine deployments).

Telemetry requirement:
- Record which branch was used (`path` / `url_clipboard` / `data_url_clipboard` / fallback failure).

---

## Privacy & Logging Rules

- Never store assets under `data/` or any repo-tracked directory.
- Never write asset bytes into logs.
- On success: delete asset immediately.
- On failure: keep it only until the user retries/cancels, then delete.

---

## Decisions Needed (Ask Owner)

### D1. Supported asset kinds in v1
Only `image/*` for now, or also allow `application/pdf` (as preview images), etc?

### D2. Maximum asset size
Set conservative default limits per host to avoid taskpane crash (configurable).

### D3. Writer insertion fallback
Do we accept “clipboard paste” for Writer as the primary approach, or require a temp-file approach when possible?
