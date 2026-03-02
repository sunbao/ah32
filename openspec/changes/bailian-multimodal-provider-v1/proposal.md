# OpenSpec Change Proposal (Draft) — Bailian Multimodal Provider (v1)
Date: 2026-02-24  
Branch baseline: `plan-writeback`  

## Context / Why

We want **multimodal** capabilities (image understanding + image generation) and the ability to **write images back** into WPS documents.

Owner decision: use **阿里百炼** as the default multimodal provider, but keep the architecture **provider-pluggable** to support other platforms later (OpenAI-compatible, etc.).

Project rules / constraints:
- Default output is **chat-only**; only output Plan JSON when a writeback is intended.
- Do **not** leak backend JSON/tool payloads to chat or document.
- Privacy-first: user documents and generated assets must be **ephemeral** (delete immediately; TTL only as crash-safety).
- Stability-first: avoid huge base64 in chat/plan payloads (taskpane is memory-sensitive).

Related changes (dependencies):
- `openspec/changes/multimodal-writeback-assets-v1/` (ephemeral Asset store + `asset://<id>` reference)
- `openspec/changes/doc-snapshot-v1-and-llm-provider-v1/` (doc snapshot transport; later provides images as attachments)

## Goals

### G1. Provider-pluggable multimodal runtime
Introduce a backend “Multimodal Provider” abstraction with a stable internal API:
- `analyze_image(...) -> {text, structured?}`
- `generate_image(...) -> asset_id` (bytes stored in ephemeral Asset store)

### G2. Default provider = 阿里百炼
Implement Bailian adapter as the default provider for multimodal workloads.

### G3. Minimal, Plan-friendly writeback
Never embed image bytes/base64 in Plan JSON.
Plans reference generated images via `asset://<asset_id>` (resolved by frontend).

### G4. Strict mode (no silent downgrade)
If the configured provider is Bailian but key/model is missing or unsupported, fail clearly.
No silent fallback to other providers.

## Non-goals (v1)
- Video/audio generation or insertion
- Persisting generated assets into RAG
- Trying to make “every provider supports every multimodal feature”

---

## Proposed Configuration (v1)

Environment variables (all optional unless required by selected provider):

### Select provider
- `AH32_MM_PROVIDER=bailian|openai-compatible|disabled` (default: `bailian`)

### Bailian credentials / models
- `AH32_BAILIAN_API_KEY=...` (required when `AH32_MM_PROVIDER=bailian`)
- `AH32_BAILIAN_BASE_URL=` (optional; default uses official endpoint)
- `AH32_BAILIAN_VISION_MODEL=` (image understanding model id)
- `AH32_BAILIAN_IMAGE_MODEL=` (image generation model id)

### OpenAI-compatible multimodal (optional)
- `AH32_MM_BASE_URL=...`
- `AH32_MM_API_KEY=...`
- `AH32_MM_VISION_MODEL=...`
- `AH32_MM_IMAGE_MODEL=...`

### Strictness
- `AH32_MM_STRICT=true|false` (default: `true`)
  - `true`: missing deps/keys/models -> error
  - `false`: allow “capability unavailable” responses (still must be observable/logged; no silent swaps)

Notes:
- We intentionally avoid using unprefixed global keys (e.g. `OPENAI_API_KEY`) to prevent host env pollution.
- All provider selection is server-side; frontend never sees provider keys.

---

## Proposed Backend Interface (internal)

### `MultimodalProvider` (conceptual)

Methods:
- `analyze_image(prompt: str, image_bytes: bytes, mime: str, *, opts) -> AnalysisResult`
- `generate_image(prompt: str, *, opts) -> GeneratedAsset`

`GeneratedAsset`:
- `asset_id: str`
- `mime: str` (e.g. `image/png`)
- `bytes: int`
- `provider: str` / `model: str`

Observability:
- Must log: provider/model, bytes, duration, branch/fallback (never log content).
- Must emit telemetry events (if enabled) for latency and failures.

---

## Proposed Backend APIs (v1)

We reuse the Asset API from `multimodal-writeback-assets-v1`:
- `POST /agentic/assets/init`
- `PUT /agentic/assets/{asset_id}/content`
- `GET /agentic/assets/{asset_id}/content`
- `DELETE /agentic/assets/{asset_id}`

Add 2 multimodal endpoints (thin wrappers around the provider):

### 1) `POST /agentic/mm/analyze-image`
Request (JSON + base64 is allowed only for small images; otherwise upload via Asset first):
```json
{
  "prompt": "string",
  "image": {
    "asset_id": "string|null",
    "data_url": "string|null",
    "mime": "image/png"
  }
}
```
Response:
```json
{
  "ok": true,
  "text": "string",
  "provider": "bailian",
  "model": "string"
}
```

Rules:
- Prefer `asset_id` input to avoid huge JSON bodies.
- If `data_url` is used, enforce strict size caps and return a clear error when exceeded.

### 2) `POST /agentic/mm/generate-image`
Request:
```json
{
  "prompt": "string",
  "size": "1024x1024",
  "style": "optional",
  "ttl_sec": 600,
  "scope": {
    "client_id": "string",
    "session_id": "string|null"
  }
}
```
Response:
```json
{
  "ok": true,
  "asset_id": "string",
  "mime": "image/png",
  "bytes": 12345,
  "provider": "bailian",
  "model": "string"
}
```

Rules:
- Backend immediately stores bytes into the Asset store (ephemeral).
- Backend returns only `asset_id` (no base64).

---

## Plan / Writeback Integration (v1)

### Plan references
Writeback plans insert images via:
- `path="asset://<asset_id>"` (preferred)

Frontend resolves `asset://...` by:
1) Downloading bytes from backend `GET /agentic/assets/{asset_id}/content`
2) Inserting into document using host-specific method
3) On success (or cancel), backend deletes the asset

Host notes:
- WPP already supports inserting images via `data:` URL clipboard paste; reuse that path.
- Writer/ET insertion likely needs a new best-effort branch:
  - clipboard paste, or
  - temp file + `AddPicture(tempPath)` (if filesystem access is available)
Both must record which branch ran.

---

## Deletion / Privacy Semantics

Generated assets are ephemeral:
- Delete immediately after successful writeback, OR
- On user cancel / SSE disconnect, OR
- TTL sweeper as crash-safety only

Never:
- store generated images under `data/`
- embed into RAG by default
- log raw bytes/base64

---

## Decisions Needed (Owner)

1) Bailian model names:
   - Vision: `AH32_BAILIAN_VISION_MODEL=?`
   - Image generation: `AH32_BAILIAN_IMAGE_MODEL=?`
2) Size limits:
   - Default max bytes per generated image?
3) Writer insertion strategy:
   - Prefer clipboard paste first, or require temp-file insertion when possible?

