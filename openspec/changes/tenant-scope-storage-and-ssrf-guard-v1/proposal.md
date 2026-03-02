# Proposal: tenant-scope-storage-and-ssrf-guard-v1

## Why（为什么要做）

系统现在已经具备“会落盘 / 会主动出网”的能力，比如：

- RAG ingest / search（向量库会写入 `storage/`）
- Playwright 抓取 / 浏览器快照（会出网，也可能落盘缓存/trace）
- doc snapshots / assets（会落盘）

一旦后端变成云端 multi-tenant，如果没有把下面两件事补齐，很容易出事故：

1) **串租**：tenant A 的向量/快照/资产，被 tenant B 命中或读取。
2) **SSRF**：后端被诱导访问内网/metadata/localhost。

## What Changes（要改什么）

### 1) 引入 Tenant Context（请求级，强约束）

- 所有“会落盘 / 会出网”的 API/tool call 都必须带 `tenant_id`（不允许缺省）。
- 后端统一解析并贯穿 `tenant_id` 到：
  - storage root（落盘路径）
  - vector store（RAG/memory/skills routing 的持久化/集合名/路径）
  - SSRF policy（黑名单/内网阻断策略）
  - audit log（审计）

### 2) Tenant-scope Storage（所有落盘都进 tenant root）

- 统一 root：`storage/tenants/<tenant_id>/...`
- doc snapshots / assets / browser traces&cache / audit 等临时目录也必须 tenant-scope，并且资源 id 必须在 tenant 内校验边界（防止“猜 id 越权”）。

### 3) SSRF Guard（统一入口 + 审计）

所有后端主动出网入口必须走统一 guard（现在至少包含）：

- `web_fetch`
- `browser_snapshot`
- `rag_ingest_url`

行为（按你当前总则对齐）：

- **http/https 默认通行**：不要求先配 allowlist；只要命中黑名单才拒绝（公网/内网/本机/metadata 都一样）。
- **DNS 解析后再判定**：不是为了“默认拒绝内网”，而是为了让黑名单可以按 IP/CIDR 生效（以及做审计记录）。
- **redirect 逐跳校验**：每一跳都重新走 guard（否则“先允许再跳内网”）。
- **全量审计日志**：每次出网尝试都落 JSONL（允许/拒绝都要记）。

### 4) Tenant Audit Logs（JSONL）

- 落盘位置：`storage/tenants/<tenant_id>/audit/ssrf.jsonl`
- 最少字段：
  - `ts`, `tenant_id`, `trace_id`, `tool`, `url`, `decision`, `reason`, `elapsed_ms`

## Compatibility（兼容性）

- **不提供“无 tenant”模式**：本地单机也必须传 `tenant_id`（可以约定 `local`/`dev` 作为 tenant）。
- 鉴权（`api_key`）本 change 只做“tenant 识别/隔离”的最小闭环；更复杂的租户管理/轮换/配额可后续补。
