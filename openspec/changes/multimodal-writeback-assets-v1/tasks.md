# Tasks: multimodal-writeback-assets-v1

## 1. Asset store (backend)

- [x] 1.1 Implement asset metadata + storage layout under `storage/`
- [x] 1.2 Implement init/upload/content/status/delete endpoints
- [x] 1.3 Implement deletion on success/cancel/disconnect + TTL sweeper

## 2. Plan integration

- [x] 2.1 Decide Option A vs Option B for `asset://...` in image actions
- [x] 2.2.1 WPP：支持 `asset://<id>` -> 下载 -> 插入（best-effort）
- [x] 2.2.2 Writer/ET：补齐“插图”能力（follow-up：`plan-insert-image-wps-et-v1` 已实现 `insert_image`）
- [x] 2.3 Telemetry: record branch/fallback used

## 3. Validation

- [ ] 3.1 Manual tests across host apps (writeback succeeds + assets deleted)
- [x] 3.2 Ensure no base64 bytes in chat/Plan JSON
