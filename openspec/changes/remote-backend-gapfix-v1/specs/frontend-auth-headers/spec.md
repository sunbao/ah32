# Spec: frontend auth headers (v1)

## Purpose

确保前端在所有访问后端资源（尤其是 Plan 执行阶段的 asset 下载）时，携带与 chat 一致的 tenancy/auth headers，避免出现“聊天能用、写回/插图偶发失败”的割裂体验。

## Requirements

### R1: 必带 headers（当配置存在时）

前端请求后端（至少包括）：

- `/agentic/assets/*`
- `/agentic/doc-snapshots/*`
- `/agentic/skills/catalog`

必须携带：

- `X-AH32-Tenant-Id`（若配置了 tenantId；否则走后端 default_tenant_id）
- `X-AH32-User-Id`（非默认租户必填；默认租户建议也传）
- `Authorization: Bearer <token>`（若已获取 token）
- `X-AH32-Api-Key` 或 legacy `X-API-Key`（按当前后端策略）

### R2: 禁止静默吞错

对关键链路（asset 下载、skills catalog 拉取、doc snapshot 上传）：

- catch/fallback 允许存在，但 MUST 记录可追踪日志/事件并上报后端（可节流）。

