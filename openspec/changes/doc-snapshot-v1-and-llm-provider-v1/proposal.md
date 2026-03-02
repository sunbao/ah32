# OpenSpec Change Proposal (Draft)
Date: 2026-02-24  
Branch baseline: `plan-writeback`  

## Context / Why

Current flow sends `frontend_context.active_doc_text_full` inside `/agentic/chat/stream` JSON. In WPS Taskpane this can become a very large in-memory string + very large request body, which correlates with “taskpane reload after a few turns”.

We want:
- Correctness-first (full upload, no truncation for “true document snapshot”).
- Privacy-first (server must not retain private docs; delete immediately after the turn).
- Stability-first (avoid taskpane reload; avoid huge JSON bodies; support chunked upload).
- Future-proof (support images and multiple host apps: Writer/ET/WPP).
- LLM provider can be switched and remains compatible with current system (DeepSeek now; OpenAI-compatible later). No silent downgrade when strict.

## Goals

### G1. Two-step doc snapshot protocol
Split “document upload” and “chat”:
1) Frontend uploads an ephemeral **document snapshot** (supports binary + images) to backend.
2) Frontend calls `/agentic/chat/stream` referencing `snapshot_id` (small JSON).

### G2. Strong deletion guarantees
- A snapshot is deleted after the turn completes OR is cancelled OR SSE disconnect is detected.
- A short TTL cleanup exists only as crash-safety (not “retention”).

### G3. Model provider switching (strict by default)
- Server chooses provider/model by config.
- DeepSeek uses `langchain-deepseek` when provider is `deepseek` (reasoning support).
- Strict mode: do not silently fall back to `ChatOpenAI` when `langchain-deepseek` is required/missing.

## Non-goals (v1)
- Do not ingest private docs into RAG (no embedding, no `data/rag/*` writes for these snapshots).
- Do not implement Anthropic provider.
- Do not change plan writeback semantics here (only ensure doc snapshot supports it later).

---

## Proposed API (v1)

### 1) Doc Snapshot API (ephemeral, per-turn)

Prefix: `/agentic`

#### Snapshot acquisition modes (v1)
We want a **fully automatic** flow without the user manually uploading files.

Reality constraints:
- Backend parsing needs a file-like binary (`doc_file`) to extract images/structure/positions.
- If the user edited the document but did not save, backend cannot see the latest state by reading `FullName` alone.

Therefore, prefer this acquisition order:
1) **client_export_ooxml + http_upload_bytes (recommended)**: frontend asks WPS to export/copy the currently-open doc into a local temp file as OOXML (`.docx/.xlsx/.pptx`), then uploads bytes to backend. Backend parses + deletes snapshot immediately after the turn.
2) server_read_path: backend reads the original `FullName` path only when backend is colocated with WPS (or the path is accessible).
3) http_upload_bytes (direct): frontend uploads the original bytes without converting (backend may reject if not parseable).

#### `POST /agentic/doc-snapshots/init`
Create a new snapshot “slot” and (optionally) replace any previous live snapshot for the same `(client_id, host_app, doc_id)`.

Request JSON:
```json
{
  "client_id": "string",
  "host_app": "wps|et|wpp",
  "doc_id": "string",
  "doc_name": "string|null",
  "replace_previous": true,
  "source": {
    "mode": "client_export_path|server_read_path|http_upload_bytes",
    "doc_path": "string|null"
  }
}
```

Response JSON:
```json
{
  "snapshot_id": "uuid-or-random",
  "replaced_snapshot_id": "string|null",
  "created_at": "iso",
  "expires_in_sec": 1800,
  "export": {
    "required": true,
    "target_ext": "docx|xlsx|pptx",
    "notes": "string|null"
  }
}
```

Notes:
- Frontend chooses a local temp path (overwrite each time; no history) and uploads bytes via `PUT .../parts`.
- Backend must not require any shared filesystem.

#### `PUT /agentic/doc-snapshots/{snapshot_id}/parts`
Upload snapshot parts by **multipart/form-data** (preferred) or raw bytes with headers.

Part model (conceptual):
- `manifest` (JSON, required once)
- `doc_file` (binary, optional): the native file bytes (`.docx/.xlsx/.pptx/...`)
- `extracted_text` (UTF-8, optional): full text
- `attachments[]` (binary, optional): images or other blobs

`manifest` example:
```json
{
  "schema": "ah32.doc_snapshot.v1",
  "host_app": "wps|et|wpp",
  "doc_id": "string",
  "doc_name": "string|null",
  "content_types": ["doc_file", "extracted_text", "attachments"],
  "source": {
    "frontend_build": "string|null",
    "capabilities": {}
  }
}
```

Notes:
- Supports chunked uploads by allowing repeated calls with `Content-Range` (or `offset` query).
- Backend must log only sizes/hashes, never raw content.

Owner preference (current): avoid this mode if possible; prefer `client_export_path`.

#### `POST /agentic/doc-snapshots/{snapshot_id}/finalize`
Validate + mark ready.

Request JSON:
```json
{
  "expected_total_bytes": 123,
  "sha256": "hex|null"
}
```

Response JSON:
```json
{
  "ready": true,
  "total_bytes": 123,
  "sha256": "hex",
  "parts": {"doc_file": true, "extracted_text": true, "attachments": 3}
}
```

#### `DELETE /agentic/doc-snapshots/{snapshot_id}`
Hard delete immediately. Idempotent.

#### `GET /agentic/doc-snapshots/{snapshot_id}/status` (optional)
For UI/debug: bytes received, ready, expires_in.

### 2) Chat API change (minimal)

`POST /agentic/chat/stream` keeps current request shape but `frontend_context` adds:
```json
{
  "doc_snapshot_id": "string|null",
  "doc_snapshot_manifest": {"schema":"ah32.doc_snapshot.v1", "...": "optional-minimal"}
}
```

Rules:
- Chat request must NOT contain full doc bytes/text.
- Backend tool `read_document` uses snapshot when needed.
- Backend may still include a small `active_doc_text` preview for prompting (bounded).

---

## Storage & Deletion Semantics

Backend storage location (ephemeral):
- `storage/doc_snapshots/<snapshot_id>/...` (ignored by git; removable)

Deletion triggers:
1) Normal end of turn (SSE completes) -> delete
2) User cancel (frontend calls DELETE) -> delete + cancel in-flight model/tool operations
3) SSE disconnect / CancelledError -> delete + cancel in-flight
4) TTL sweeper (e.g. every 60s) deletes expired snapshots as crash-safety only

Privacy:
- Never write snapshot content into `data/` or RAG.
- Never include snapshot bytes/text in backend logs.

Automation note:
- When using `client_export_ooxml + http_upload_bytes`, deletion is done by the backend (delete uploaded bytes and any parsed artifacts immediately after the turn).

---

## Host App Considerations (Writer/ET/WPP)

We support different snapshot payloads per host:

### Writer (wps)
- Prefer `doc_file` if frontend can obtain native bytes safely.
- Else `client_export_path` to `.docx` (recommended), so backend can parse images/structure reliably.

### ET (et)
- Prefer `doc_file` (`.xlsx`) for correct full-fidelity.
- Else provide `extracted_text` as a structured dump (TSV/JSON) + metadata:
  - used_range address, rows/cols, header map, selection address.

### WPP (wpp)
- Prefer `doc_file` (`.pptx`).
- Else provide `extracted_text` as slide text + (future) `attachments` as slide renders or extracted pictures.

---

## LLM Provider Switching (v1)

### Config keys
- `AH32_LLM_PROVIDER`: `deepseek` | `openai` | `openai-compatible`
- `AH32_LLM_MODEL`
- `AH32_LLM_TEMPERATURE`
- `AH32_LLM_BASE_URL` (only for `openai-compatible` or explicit override)
- `DEEPSEEK_API_KEY` / `AH32_OPENAI_API_KEY` (project-local only)
- `AH32_LLM_STRICT` (default: true)

### Provider rules
- If `provider=deepseek`:
  - Require `langchain-deepseek` (for `reasoning_content`) when strict.
  - Do not silently downgrade to `ChatOpenAI`.
- If `provider=openai-compatible`:
  - Use `ChatOpenAI(base_url=...)`.
  - Reasoning events are best-effort (may be absent).

### Optional (later): runtime switching
- Add a safe endpoint `POST /agentic/llm/reload` (dev-only) or per-request override gated by env.

---

## Decisions Needed (Ask Owner)

### D1. Snapshot payload baseline (v1) — DECIDED
Owner decision: **Require `doc_file` (binary) as the primary truth**. Frontend should not be responsible for parsing structure/images/positions. Backend parses.

Implication:
- `extracted_text` becomes optional (preview/prompting only).
- Future image/structure support is server-driven.

### D2. Snapshot canonical format (OOXML vs legacy)
Input files may be: `doc/xls/ppt` and WPS proprietary formats (`.wps` etc). For reliable structure + image extraction, we need a canonical format.

Options:
- **A (recommended): Canonicalize to OOXML** (`.docx/.xlsx/.pptx`) before backend parsing. If source is legacy/proprietary, convert first (client SaveAs or backend converter), then parse OOXML only.
- B: Parse each legacy/proprietary format natively on backend (high risk, high effort, poor portability).

Question to owner: accept “OOXML-only parsing” as the backend contract (with conversion step when needed)?

### D3. Image scope
When you say “图片”，priority is:
1) embedded images inside doc/ppt?
2) user-attached images in chat?
3) images from URLs referenced in the doc?

### D4. Snapshot lifecycle per turn vs per session
Do we create one snapshot per chat turn (recommended for correctness), or maintain a single mutable snapshot per doc/session (risk: race between turns)?

### D5. Transport modes (same-machine vs remote)
We must support both:
- backend colocated with WPS (backend can read `FullName` path), and
- backend remote (cannot read client-local paths).

Proposed transport order (best-effort):
1) `server_read_path`: frontend sends `doc_path`, backend reads bytes directly (works for same-machine or shared paths).
2) `client_upload_bytes`: frontend uploads `doc_file` via multipart (works only if taskpane can read file bytes; may require extra capability / local helper).

Question to owner:
- In remote mode, are we allowed to require **shared paths** accessible by backend?
- If not, are we allowed to ship an **optional local helper agent** (runs on WPS machine) to read local files and upload to remote backend?

### D6. ET full fidelity requirement
For ET, “full upload” means:
- the whole `.xlsx` bytes, OR
- full UsedRange cell matrix, OR
- “tool-driven reads” only (no full upload), because plan executor can query ranges on-demand?

### D7. Strict model policy
When `provider=deepseek` and `langchain-deepseek` missing:
- fail fast (recommended), OR
- allow fallback (not recommended)?
