# Spec: tenancy for non-agentic APIs (v1)

## Purpose

补齐 `/agentic/*` 之外的 API 在 multi-tenant 形态下的鉴权与落盘隔离，避免“串租/串用户/不可观测”。

## Requirements

### R1: 非 agentic 路由也必须可绑定 tenancy

对以下路由（至少）：

- `/api/documents/*`
- `/memory/*`

后端 MUST：

- 解析并绑定 `tenant_id/user_id/trace_id`（复用现有 `request_context` 规则）
- 在日志中输出 `trace_id`（出现异常时必须带堆栈）

### R2: 所有落盘路径必须 tenant-scope（必要时 user-scope）

- doc sync 相关持久化 MUST 位于 `storage/tenants/<tenant_id>/doc_sync/...`
- memory 相关持久化 MUST 位于 `storage/tenants/<tenant_id>/memory/users/<user_id>/...`

补充约束：

- doc sync 的 in-memory cache MUST 以 tenant 为一级维度隔离（不得用全局单例缓存导致跨 tenant 混写）。
- doc sync/memory MUST NOT 写入 `Path.home()/.ah32/...` 这类机器级共享目录（云端多租户会串）。

### R3: 默认租户匿名策略必须明确

当 `tenant_id=default_tenant_id` 且 `user_id=anon` 时：

- 对会落盘的接口（doc sync / memory）必须明确选择：
  - **拒绝**（要求前端提供稳定 user_id），或
  - **隔离**（按 client_id 等维度隔离，且不与其他 anon 混写），或
  - **不落盘**（只保留 in-memory + TTL）
  - **共享体验池落盘**（允许 anon 混写，但 MUST 明确“不做数据安全承诺”，并提供运维侧定时清理机制）

不得出现“悄悄落盘到共享文件里，导致体验用户互相污染而无人知晓”。
