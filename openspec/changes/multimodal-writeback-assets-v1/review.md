# Review (Draft) — multimodal-writeback-assets-v1

## Checklist

- [x] Asset bytes never appear in logs（前端写回日志对 image ref 做脱敏；后端输出护栏会剔除 data_url/base64）
- [x] Deletion triggers cover success/cancel/disconnect + TTL（后端已实现；仍需手工验证）
- [x] Plan JSON stays small (asset references only)（接口返回 asset_id；不回传大段 base64）
- [x] Frontend records fallback branch for debugging（补齐 WPP `add_image` 分支：asset/url/res/data_url/path + placeholder）

## 当前缺口（导致无法归档）

- Writer/ET 侧没有 Plan 的“插图”能力，因此 `asset://<id>` 无法形成三端一致的写回闭环
- 该缺口已转入 follow-up change：`plan-insert-image-wps-et-v1`

## 代码证据（给你定位用）

- 后端 asset store：`src/ah32/assets/store.py`
- 后端 asset API：`src/ah32/server/asset_api.py`
- 生成图片返回 asset_id：`src/ah32/server/mm_api.py`
- WPP 插图支持 asset://：`ah32-ui-next/src/services/plan-executor.ts`（`addImageWpp`）
