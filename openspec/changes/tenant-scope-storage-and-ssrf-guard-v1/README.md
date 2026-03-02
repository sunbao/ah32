# 2026-02-27-tenant-scope-storage-and-ssrf-guard-v1

这个 change 用来补齐云端后端（multi-tenant）形态下的两类“硬底座”，不新增业务功能：

1) **Tenant-scope Storage / Vector Stores**：所有落盘与向量库都必须按 `tenant_id` 做物理隔离，避免“串租”。
2) **SSRF Guard + Tenant Audit Logs**：所有后端主动出网（抓取/浏览器/RAG ingest URL/下载等）必须走统一 guard，并按 tenant 记审计日志。

关键约束（按你当前的总则更新）：

- **不允许缺省 tenant**：任何会落盘/会出网的接口/工具调用都必须明确 `tenant_id`。
- **后端出网默认通行**：对 `http/https` 默认允许（无论公网/内网/本机/metadata）；只要命中黑名单才拒绝。
- **不做“默认拒绝/allowlist”**：你的部署环境（云端/银行内网）已经有网络策略与防火墙；软件层只做黑名单管控 + 审计追踪。

Artifacts:
- `design.md`
- `proposal.md`
- `review.md`
- `tasks.md`
- `specs/tenant-scope-storage/spec.md`
- `specs/ssrf-guard/spec.md`
