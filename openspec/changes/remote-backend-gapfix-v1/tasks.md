# Tasks: remote-backend-gapfix-v1

## 1) 非 agentic 路由 tenancy/auth 绑定

- [x] 1.1 `/api/documents/*` 增加 tenancy/auth 依赖（复用 `bind_tenancy_for_request`）
- [x] 1.2 doc sync 落盘迁移到 `storage/tenants/<tenant_id>/doc_sync/...`（去掉 HOME 目录写入）
- [x] 1.3 `/memory/*` 增加 tenancy/auth 依赖
- [x] 1.4 memory JSON/日志迁移到 `storage/tenants/<tenant_id>/memory/users/<user_id>/...`（user-scope）
- [x] 1.5 默认租户 `user_id=anon` 的持久化策略定稿：允许共享体验池落盘；按运维定时脚本清理（临时用，不做长期保留）
- [x] 1.6 禁用/迁移任何“服务端 HOME 目录缓存文档正文”的端点（必须走 doc snapshot 的 tenant-scope 临时目录；禁止回传服务端路径）

## 2) Doc Snapshot 客户端两步走接入（远端后端）

- [x] 2.1 前端：对话前 `init → upload → finalize`，并在 chat 里只传 `doc_snapshot_id`（先用 extracted_text-only 兜底）
- [x] 2.2 前端：Writer/ET/WPP 导出策略（优先 OOXML；失败提示）
- [x] 2.3 后端：缺少 `doc_snapshot_id` 时允许降级（不中断对话），并落最小日志
- [x] 2.4 doc snapshot 必须支持“全量二进制/OOXML 上传”（`extracted_text-only` 仅兜底；不得截断原文上传）

## 3) 前端 headers / 错误可观测

- [x] 3.1 `asset://` 下载补齐 tenant/auth headers
- [x] 3.2 skills catalog 拉取失败：不再静默；至少一次上报后端（可节流/采样）

## 4) 手工验收

- [x] 4.1 两个 tenant 下分别上传 snapshot/生成 asset，互相不可访问（404/403）
- [ ] 4.2 前端连续对话 10 轮不重载（至少不因文档上下文传输/解析导致重载）
- [x] 4.3 任意失败都能从后端日志定位：`trace_id` + `tenant_id` + 失败原因
