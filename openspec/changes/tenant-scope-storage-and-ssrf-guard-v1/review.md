# Review: tenant-scope-storage-and-ssrf-guard-v1

## Summary

这个 change 是“云端 multi-tenant 的硬底座”，补齐两件事：

- Tenant-scope storage/vector store：杜绝串租
- SSRF guard + tenant 审计：后端主动出网可控、可追踪

已按你当前总则调整：**http/https 默认通行（黑名单拒绝，不做 allowlist / 默认拒绝）**，并且 **不允许缺省 tenant**。

## MUST-FIX（Blocking）

- 所有后端主动出网入口必须接入统一 `ssrf_guard`（至少覆盖 `web_fetch` / `browser_snapshot` / `rag_ingest_url`）。
- 所有落盘目录必须 tenant-scope（至少覆盖 RAG 向量库、doc snapshots、assets、audit）。
- 资源 id（snapshot/asset）必须做 tenant 边界校验，避免“猜 id 越权”。

## SHOULD（Recommended）

- `trace_id` 贯穿：后端日志 + SSRF 审计统一字段，定位更快。
- 黑名单策略与格式定死：支持 host/ip/url_prefix 三类最小规则即可。

## Status

- Status: Pending（等你审）
## Open Questions

1) `user_id` 是否强制必填？（本 change 先把 tenant 隔离跑通；user 维度可以后续加。）
2) 黑名单的最小规则你希望“必须支持”哪几类？（host 通配 / ip(cidr) / url_prefix）
