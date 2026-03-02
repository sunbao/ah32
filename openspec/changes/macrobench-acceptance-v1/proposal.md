# Proposal: macrobench-acceptance-v1

## Why

当前根目录的 `TODOLIST*.md` 已经承载了大量“需求 + 已落地 + 验收动作”，但它不属于 OpenSpec 的变更流程，导致：

- 需求/验收项分散在多个清单与多个 change 里，收口困难，容易漏跑验收。
- 清单里的“已实现/未实现/需要调整”的结论无法沉淀为可追踪的 change（谁决定的、何时验证的、有哪些 follow-up）。

目标是把这些清单收口进 OpenSpec，让 OpenSpec 接管“需求确认 → 验收标准 → 任务 → 评审”，最终删除 `TODOLIST*.md`，只保留 OpenSpec 作为唯一来源。

## What Changes

- 新增一个“验收/回归”型 change：把 `TODOLIST.md` / `TODOLIST_WRITER.md` / `TODOLIST_ET.md` / `TODOLIST_PPT.md` 里确认过的验收动作、回归矩阵、手工跑测项，整理成 OpenSpec 的 specs + tasks + review。
- 把现有 OpenSpec changes 中的手工验收项（例如 `remote-backend-gapfix-v1` 的 4.x、`tenant-scope-storage-and-ssrf-guard-v1` 的 4.x）统一纳入“验收矩阵”，避免分散。
- **BREAKING**（文档层面）：当 OpenSpec 中的验收矩阵与任务清单覆盖完成后，删除根目录 `TODOLIST*.md`，后续只以 OpenSpec 管理。

## Capabilities

### New Capabilities

- `office-manual-acceptance`: 统一的“手工验收矩阵”，覆盖 Writer/ET/WPP（多文档并发、写回安全、稳定性、可观测）以及 remote-backend 场景（doc snapshot、asset、tenant 隔离、SSRF 审计等）。
- `macrobench-regression`: MacroBench/长跑回归的“怎么跑、跑什么、怎么判定通过/失败、需要采集哪些证据”的规范化能力（偏 QA/验收，不强行绑定具体实现）。

### Modified Capabilities

- （无：本 change 以“验收规范/收口”为主；若在收口过程中发现 spec 级行为需要调整，将另开 follow-up changes。）

## Impact

- 文档与流程：贡献者不再维护根目录 `TODOLIST*.md`，改为维护 OpenSpec 的验收 specs/tasks/review。
- 研发协作：允许在收口过程中发现“不合理/需要改进”的点并提出问题与调整建议；必要时产出新的 follow-up change（功能改动不在本 change 强行塞入）。
- 验收执行：会明确“哪些必须每轮跑”“哪些是远端后端特有”“哪些是多租户隔离验证”，并要求保留最小证据（trace_id、tenant_id、失败原因、截图/日志片段等）。

