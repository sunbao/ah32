# Design: tenant-scope-storage-and-ssrf-guard-v1

## Context（大白话）

现在后端会做两件“危险但必要”的事：

1) **落盘**：把向量库、快照、图片等写到 `storage/`。
2) **出网**：去抓网页、跑浏览器、把 URL 入 RAG。

云端 multi-tenant 时，如果不把“谁的数据”与“谁能出网”绑住，就会出现：

- A 租户的数据被 B 租户读到（串租）
- 出网被利用去打内网/本机/云 metadata（SSRF）

本 change 的目标就是把两件事做成“统一入口 + 必须可归属到某个 tenant/user + 可追踪”。

## Goals

- 所有落盘/向量库都按 `tenant_id` 物理隔离（路径/集合名包含 tenant）。
- 所有后端主动出网都走统一 `ssrf_guard`，并写 tenant 审计日志。
- 每次操作都能通过 `trace_id` 在日志/审计里追到。

## Non-Goals

- 不在本 change 里做完整的租户管理后台/配额计费中心。
- 不在本 change 里决定“什么时候抓取/抓哪些网站”的业务策略（属于 skill/产品）。

## Decisions（关键决策）

### Decision 1: 任何落盘/出网都必须能落到 tenant（允许默认 tenant），且 user_id 必填

- 统一从请求头解析 `tenant_id`；当缺失时使用 `default_tenant_id`（用于“互联网体验用户”）。
- `user_id` 必填（用于同租户内的用户隔离、审计归属；避免同租户内“谁干了什么”不可追踪）。
- 鉴权最小闭环：
  - 租户级：`X-AH32-Api-Key`（用于证明“你属于哪个 tenant”）
  - 用户级：`Authorization: Bearer <JWT>`（用于证明“你是哪个 user”；推荐，优先于 api-key）

建议 header（实现时定死名字）：

- `X-AH32-Tenant-Id`: 可选（缺失则走 `default_tenant_id`）
- `X-AH32-User-Id`: 必填
- `X-AH32-Api-Key`: 可选（当未提供 JWT 时用于租户级鉴权；默认 tenant 可按配置允许匿名）
- `Authorization: Bearer <JWT>`: 可选（用户级鉴权；推荐）

### Decision 2: tenant-scope storage root

统一 root：

`storage/tenants/<tenant_id>/<subsystem>/...`

至少包含：

- `rag/`
- `skills_vectors/`
- `memory/`（若启用）
- `doc_snapshots/`
- `assets/`
- `audit/`

### Decision 3: SSRF guard 的“默认通行”是什么意思

你问的“统一入口 / 默认拒绝”可以理解为：

- **统一入口**：所有出网都必须先过同一个检查函数（否则你永远找不齐哪里出网、也补不齐规则）。
- **默认拒绝**（旧写法）：没在 allowlist 里就拒绝。

按你现在的总则，这里改成：

- **http/https 默认允许**：不要求先配 allowlist；只要命中黑名单才拒绝。
- **不区分公网/内网/本机/metadata 的“默认放行”**：部署环境（云端或银行内网）已有网络策略与防火墙；软件层只做黑名单管控 + 审计追踪。

### Decision 4: SSRF guard 的最小算法（v1）

对每次出网请求（v1）：

1) 解析 URL 并规范化（只允许 `http/https`；禁止 `user:pass@host` 这种 userinfo）。
2) DNS 解析 hostname 得到 IP 列表（IPv4/IPv6），用于：
   - 让黑名单里的 IP/CIDR 规则生效
   - 记录审计字段（例如 resolved_ips）
3) 命中 tenant 黑名单（domain/IP/CIDR/URL pattern）则拒绝；否则放行（不做“默认拒绝内网/本机/metadata”）。
5) 如果允许 redirect：每一跳的 `Location` 都重复 1~4（逐跳校验）。
6) 记录一条审计日志（允许/拒绝都写），关联 `tenant_id + trace_id`。

## Audit Log（JSONL）

落盘：

- `storage/tenants/<tenant_id>/audit/ssrf.jsonl`

字段（最少）：

- `ts`, `tenant_id`, `trace_id`, `tool`, `url`, `decision`, `reason`, `elapsed_ms`

建议补充：

- `resolved_ips`, `final_url`, `status_code`, `bytes_read`, `redirect_hops`

## Open Questions（需要你拍板）

1) 黑名单的最小规则你希望“必须支持”哪几类？（host 通配 / ip(cidr) / url_prefix 三类里是否都要？）
2) 默认 tenant（互联网体验）是否允许“匿名访问”（不带 api-key / JWT）？还是也必须带一个 public api-key？
