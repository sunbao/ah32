# Tasks: bailian-multimodal-provider-v1

## 1. Scaffolding

- [x] 1.1 Define `MultimodalProvider` interface + result models
- [x] 1.2 Wire provider selection via `AH32_MM_PROVIDER`
- [x] 1.3 Add strictness flag `AH32_MM_STRICT` behavior (default true)

## 2. Bailian adapter (v1)

- [x] 2.1 Implement Bailian client (keys/base_url/models)
- [x] 2.2 Implement `analyze_image`
- [x] 2.3 Implement `generate_image` -> Asset store `asset_id`

## 3. APIs

- [x] 3.1 Add `POST /agentic/mm/analyze-image` (prefer `asset_id`; cap `data_url`)
- [x] 3.2 Add `POST /agentic/mm/generate-image` (return `asset_id`, no base64)

## 4. Validation

- [ ] 4.1 Unit tests for config/strictness and provider selection
- [ ] 4.2 Manual test checklist (taskpane stability: no huge payloads)

