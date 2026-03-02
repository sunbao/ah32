# Spec: tenant-scope-storage (v1)

## Purpose

定义 multi-tenant 形态下的落盘隔离与向量库隔离要求，确保任意 tenant 的数据不会被其他 tenant 读取/命中（防串租）。

## Requirements

### R1: tenant_id 解析规则（允许默认 tenant）

- 系统 MUST 能解析出 `tenant_id`（建议来自请求头 `X-AH32-Tenant-Id`）。
- 当缺失 tenant_id 时，MUST 使用服务端配置的 `default_tenant_id`（用于“互联网体验用户”）。
- 系统 MUST 能解析出 `user_id`（建议来自请求头 `X-AH32-User-Id` 或 JWT `sub`）。
- 对**非默认租户**：`user_id` MUST 为必填；缺失 MUST 直接失败（建议 400，错误码如 `user_required`），并在日志里带 `trace_id` 便于定位。
- 对**默认租户**（体验用户）：`user_id` MAY 缺省，服务端可回落为 `anon`（共享体验池，不做数据安全承诺）。

### R2: 所有落盘必须 tenant-scope

所有会写磁盘的子系统 MUST 以 tenant root 为前缀：

`<storage_root>/tenants/<tenant_id>/<subsystem>/...`

至少覆盖：

- RAG 向量库持久化
- skills routing 向量（若启用）
- memory/会话持久化（若启用）
- doc snapshots（临时/TTL）
- assets（临时/TTL）
- audit logs（SSRF 等）

### R3: 向量库隔离必须可验证

RAG/skills/memory 等向量库 MUST 在“路径 / collection / namespace”至少一个维度包含 `tenant_id`，并保证：

- tenant A 写入的向量，tenant B 查询时不会命中
- 即使传入相同 collection 名，也会被 tenant 维度隔离开

### R4: 资源 id 必须做 tenant 边界校验

对 `snapshot_id` / `asset_id` 等资源：

- 即使是 UUID，也 MUST 结合 tenant root 校验访问边界（防止“猜 id 越权”）。
- tenant A 的资源 id 在 tenant B 的请求中 MUST 返回 404/403（不应泄露“是否存在”）。

### R5: 不得向客户端暴露服务端路径

任何返回给客户端的 status/meta MUST 不包含服务端绝对路径或可推导路径信息。

## Scenarios

### S1: 防串租（doc snapshot）

- GIVEN tenant A 生成一个 `snapshot_id`
- WHEN tenant B 用该 `snapshot_id` 调用 status/download/delete
- THEN MUST 返回 404/403，且日志/审计可追踪（tenant_id/trace_id）

### S2: 防串租（RAG）

- GIVEN tenant A ingest 一段文本到 RAG
- WHEN tenant B 执行 `rag_search`
- THEN MUST 搜不到 tenant A 的数据（不命中、不泄露 metadata）
