# Review: ah32-hardening-v1

## Summary

- Problem: 当前代码存在 UTF-8/乱码、启动误杀进程、关键模块过大且 schema 漂移风险、以及 Plan/JS 宏双通道复杂度等问题，直接影响稳定性与维护成本。
- Solution: 以 3 个 capability（UTF-8、端口冲突安全处理、写回架构收敛）为契约，补齐 specs，并用 tasks 拆解到可落地的实现步骤。

## Consistency Checks

- Proposal ↔ Specs
  - Proposal 列出的 3 个 new capabilities 均已建立对应 spec：
    - `utf8-io-hardening`
    - `safe-startup-port-handling`
    - `writeback-architecture-hardening`
  - Spec 内容覆盖 proposal 的 4 类缺点（其中“可维护性/拆分大文件 + schema 单一来源”主要落在 `writeback-architecture-hardening` 与 tasks 3.x）。
- Specs ↔ Design
  - Design 的关键决策（编码统一、端口冲突模式化、schema 导出与一致性检查、Plan 主通道与宏通道显式化）与各 spec 要求一致。
  - env/key 命名在 spec/design/tasks 内一致：`AH32_PORT_CONFLICT_MODE`。
- Design ↔ Tasks
  - tasks 覆盖设计的迁移顺序（先安全不破坏，再加检查点，再重构拆分，再收敛通道）。
  - tasks 颗粒度基本可控，但 3.x/4.3 仍属于高风险改动，建议实现时按 host/op 分批落地并配合 macrobench 回归。
- Cross-change dependencies
  - 可能与以下 change 的范围交叉（需确认是否已落地/是否在同分支上）：`plan-writeback-rollback-v1`、`doc-snapshot-v1-and-llm-provider-v1`、`tenant-scope-storage-and-ssrf-guard-v1`。

## Findings

### MUST-FIX (Blocking)

- (none)

### SHOULD (Recommended)

- 明确“验证为 AH32 实例”的判定细节（/health 字段匹配、pid 文件/启动标识），避免实现时口径不一致。
- schema 导出形态（JSON Schema vs ops 列表）在落地前尽早定案，以免前后端检查机制返工。
- 拆分前端大文件时，保持对外导出 API 不变，并把“行为等价”回归清单写进实现 PR 的验证步骤（macrobench + 手工清单）。

## Risks / Trade-offs

- 大规模重构（PlanExecutor/Chat store/宏执行器拆分）回归风险高，但收益（可维护性/可定位性/减少漂移）明确。
- “不再自动杀端口”会降低一键启动爽感，但显著降低误杀风险；通过 `AH32_PORT_CONFLICT_MODE=force_kill` 保留可选捷径。

## Decision

- Status: Approved
- Rationale:
  - 变更动机明确、capabilities/规格/设计/任务拆分一致，且把高风险点（端口误杀、schema 漂移、双通道复杂度）转化为可验证的 requirements 与可执行 tasks。
