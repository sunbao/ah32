# Review: remote-backend-client-skills-pack

## Summary

- 明确了远端后端场景下的核心边界：skills **归租户、后端托管**（prompt-only），客户端不再上送/覆盖 skills 内容；后端只执行内置 allowlist 工具。
- 写回裁决清晰：只有 `ah32.plan.v1` 才允许写回；内部 JSON 不得泄露到会话/文档。
- 多租户与 SSRF 作为架构层能力被固化为 tenant 维度的可配置/可审计策略，符合互联网部署形态。

## Consistency Checks

- 与现有 doc snapshot 底座一致：原文二进制上传、短期存储、按 turn 删除，TTL 仅 crash-safety。
- 与现有 output-guard 一致：plan/tool JSON 属于内部协议，不应出现在用户可见文本中。
- 架构/业务边界合理：抓取/入库/写回的公共能力在架构层；触发时机与抓取目标在 skill 业务层。

## Findings

### MUST-FIX (Blocking)

- (none) — 本变更为边界与契约定义，进入实现前需在 tasks 中落实“鉴权/SSRF/审计日志/输出分流”的最小闭环。

### SHOULD (Recommended)

- 为 tenant keyring 与 tenant policy 提供最小运维指引（新增 tenant、轮换 key、更新 `ssrf_blacklist.json`）。
- 明确“会话取消/前端重载”触发 doc snapshot 删除与后端 turn 取消的路径（减少资源泄漏）。

## Decision

- Status: Approved
- Rationale: 已达到“可实现、可验证、边界清晰”的最终版要求，可进入任务拆解与实现阶段。

