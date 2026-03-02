# Design: remote-backend-gapfix-v1

## Context

现状（已具备）：

- `/agentic/*` 已通过 middleware 绑定 `tenant_id/user_id/trace_id` 与鉴权策略（JWT 优先，其次 tenant api-key；默认租户支持匿名试用）。
- `storage/tenants/<tenant_id>/...` 已作为 doc snapshots / assets / 向量库 / SSRF 审计的落盘前缀。
- 后端提供了 doc snapshot v1（`/agentic/doc-snapshots/*`）与 asset v1（`/agentic/assets/*`）能力底座。

但线上“真实使用链路”仍存在断点：

- Doc Snapshot 已接入，但当前仍以 `extracted_text-only` 兜底为主（有上限、无图片/定位信息），尚未满足“全量二进制/OOXML 上传”的正确性要求。
- 仍存在会把文档内容落盘到服务端 HOME 目录、并把服务端路径回传给前端的端点（属于隐私与越权风险，应禁用/迁移）。

## Goals

1) 远端后端场景下，**文档原文必须走 doc snapshot 两步走**：上传二进制（OOXML 优先）→ chat 只引用 `snapshot_id`。
2) 任意会“落盘/读取落盘/出网审计”的入口都必须 **tenant-scope**，且最小可观测（trace_id）。
3) 前端关键路径 **禁止静默吞错**：可降级，但必须留痕（前端日志 + 上报后端）。

## Non-goals

- 不在本 change 中引入新的“技能市场/分发平台”。
- 不在本 change 中承诺完整的 doc/xls/ppt（非 OOXML）转换实现，只定义行为与错误提示契约。

## Decisions

### D1: Tenancy 绑定不能只覆盖 `/agentic/*`

必须覆盖至少以下两类路由：

- `文档同步`：`/api/documents/*`（当前用于前端“打开文档列表”）
- `记忆`：`/memory/*`（用户确认式写入/读取）

实现方式二选一（推荐 B，改动更小）：

- **A：扩大 middleware 覆盖范围**：除白名单（`/health`、`/api/runtime-config`、`/telemetry/*` 等）外，全部路由都绑定 tenancy。
- **B：为非 agentic router 增加统一 dependency**：复用 `bind_tenancy_for_request`，与 `/api/rag` 一致。

### D2: 落盘路径必须 tenant-scope；涉及个人信息的还要 user-scope

- doc sync 的持久化文件从“服务器 HOME 目录”迁移到 `storage/tenants/<tenant_id>/doc_sync/...`。
- memory 的 JSON/日志从 `storage/memory` 迁移到 `storage/tenants/<tenant_id>/memory/users/<user_id>/...`。

> 说明：向量库已 tenant-scope，但 memory 的 JSON 快照仍需隔离，否则会串租/串用户。

### D3: 默认租户的匿名试用不等于“可写入私密状态”

默认租户允许匿名访问（体验/试用）是 OK 的，但对以下入口建议更严格：

- 会持久化“打开文档路径/文件名”等元数据（doc sync）
- 会持久化“用户画像/偏好/备注”等信息（memory）

建议策略：

- chat 允许 `user_id=anon`（体验池）
- doc sync / memory 若 `user_id=anon`：
  - 要么拒绝并提示前端生成/传递稳定 `X-AH32-User-Id`
  - 要么改为仅 in-memory、并按 `client_id` 做隔离，且不落盘

当前落地口径（与任务清单保持一致）：

- 默认租户（`default_tenant_id`）允许 `user_id=anon` 作为“共享体验池”，允许落盘（不做隔离/保密承诺）。
- 必须在对外说明中明确该口径，并由运维提供定时清理脚本（临时用，不做长期保留）。

### D4: 前端所有 backend 资源访问必须带全量鉴权头

尤其是 `asset://<id>` 下载链路：必须携带与普通 API 一致的 headers：

- `X-AH32-Tenant-Id`
- `X-AH32-User-Id`
- `Authorization: Bearer <token>`（若有）
- `X-AH32-Api-Key` 或 legacy `X-API-Key`（按当前策略）

### D5: 禁止静默吞错（关键路径）

- skills catalog 拉取失败、asset 下载失败、doc snapshot 上传失败，都必须：
  - 对用户：给出可行动提示（例如“网络异常/鉴权失败/请重试/请截图反馈”）
  - 对开发：写入前端日志并上报后端（带 trace_id/boot_id 等）

### D6: 禁止“服务端 HOME 缓存文档正文 + 回传服务端路径”

任何会接收/保存文档正文的端点：

- MUST 走 doc snapshot 的 tenant-scope 临时目录（并按 turn 结束删除/TTL 兜底）。
- MUST NOT 写入 `Path.home()/.ah32/...` 这类“机器级共享目录”。
- MUST NOT 在响应里返回服务端绝对路径/可推导路径（避免路径泄露与引导式攻击）。

## Open questions (need owner confirmation)

1) doc sync 是否还需要落盘？（远端后端多实例部署时，本地文件落盘可能不可靠）
2) doc snapshot 的“非 OOXML 转换”优先级：先做服务端转换，还是先做客户端导出 OOXML？
