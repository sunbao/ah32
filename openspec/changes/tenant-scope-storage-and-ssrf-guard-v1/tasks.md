# Tasks: tenant-scope-storage-and-ssrf-guard-v1

## 1) Tenant context（解析/贯穿）

- [x] 1.1 定义并实现 `tenant_id` 的 header 解析（缺失则使用默认 tenant；用于“互联网体验用户”）
- [x] 1.2 定义并实现 `user_id` 的 header 解析（非默认租户必填；默认租户允许缺省并回落为 `anon`）
- [x] 1.3 为每个请求生成/透传 `trace_id`（后端日志与审计统一使用）
- [x] 1.4 增加鉴权：支持 `X-AH32-Api-Key`（租户级）与 `Authorization: Bearer <JWT>`（用户级，优先）
- [x] 1.5 提供最小发 token 动作：`POST /agentic/auth/token`（tenant_id+api_key+user_id → JWT）

## 2) Tenant-scope storage（落盘隔离）

- [x] 2.1 定义 tenant root：`storage/tenants/<tenant_id>/...`
- [x] 2.2 RAG/skills/memory 向量库按 tenant 隔离（路径或 collection/namespace 必须包含 tenant）
- [x] 2.3 doc snapshots 按 tenant 隔离（root_dir tenant-scope + 资源访问边界校验）
- [x] 2.4 assets 按 tenant 隔离（root_dir tenant-scope + 资源访问边界校验）
- [x] 2.5 tenant 审计目录按 tenant 隔离：`storage/tenants/<tenant_id>/audit/`

## 3) SSRF guard + audit（出网隔离）

- [x] 3.1 实现统一 `ssrf_guard`（scheme/userinfo 校验 + DNS 解析用于黑名单命中 + redirect 逐跳校验）
- [x] 3.2 增加 tenant 黑名单加载：`storage/tenants/<tenant_id>/policy/ssrf_blacklist.json`
- [x] 3.3 接入所有后端主动出网入口：`web_fetch` / `browser_snapshot` / `rag_ingest_url`（以及未来抓取工具）
- [x] 3.4 SSRF 审计 JSONL：记录 allow/deny、reason、elapsed_ms、tenant/trace_id（不记录敏感 payload）

## 4) Manual validation（手工验收）

- [ ] 4.1 串租验证：tenant A 的 snapshot/asset 在 tenant B 下不可见（404/403）
- [ ] 4.2 串租验证：tenant A 写入 RAG，tenant B 查询不命中
- [ ] 4.3 SSRF 验证：黑名单可以阻断 localhost / metadata / 私网段 / redirect-to-private，并落审计（allow/deny 都记录）
