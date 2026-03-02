# Proposal: remote-backend-gapfix-v1

## Why now

这批能力（tenant + SSRF + skills 托管 + doc snapshot/asset）已经落地在后端代码里，但“真实链路”仍断在：

- doc snapshot 虽已接入，但目前主要上传 `extracted_text`（有上限），尚未实现“全量二进制/OOXML 上传”与图片/定位能力。
- 非 `/agentic` 的落盘 API 没有 tenancy/auth 绑定，存在串租与不可观测问题。
- 前端关键路径有吞错/headers 不全，导致排障困难、功能“看起来偶发失效”。
 - 存在把文档正文落盘到服务端 HOME 目录并回传服务端路径的端点（隐私/越权风险）。

## What to change

### 1) 非 agentic 路由 tenancy 化

- 给 `/api/documents/*` 与 `/memory/*` 增加统一 tenancy/auth 依赖（与 `/api/rag` 一致）。
- 迁移落盘路径到 `storage/tenants/<tenant_id>/...`，并对 memory 引入 user-scope。

### 2) doc snapshot 客户端两步走接入

- 对话前：`init → upload(parts) → finalize`
- 对话中：只引用 `doc_snapshot_id`（在 `frontend_context` 或 top-level）
- 对话结束：后端已在 turn end 删除；前端在失败场景可补一个 best-effort delete（可选）

补充约束（与 Owner 的“全量上传”口径一致）：

- `extracted_text` 仅作为兜底/调试信息，不得替代原文二进制上传。
- 优先 OOXML（`.docx/.xlsx/.pptx`）；非 OOXML 必须给出明确的导出提示。

### 3) 前端鉴权头与错误上报补齐

- `asset://` 下载必须补全 tenant/auth headers。
- skills catalog 拉取失败不可静默：最少一次上报（可采样/节流）。

### 4) 禁用/迁移服务端 HOME 文档缓存端点

- 移除或 dev-only gate 任何会把文档正文写入 `Path.home()/.ah32/...` 的端点。
- 若确需“保存文档正文供后端读取”，必须走 doc snapshot 的 tenant-scope 临时目录，并禁止向前端回传服务端路径。

## Rollout / Migration

- 研发阶段允许不兼容旧客户端（已在现有 change 中确认）。
- 先在默认租户（public）验证链路，再在非默认租户验证“必须带 user_id + 正确鉴权”。
