# Proposal: spec-implementation-audit

## Why

当前有 4 个活动的 OpenSpec change 存在实现与规范不匹配的问题，其中 `bailian-multimodal-provider-v1` 和 `multimodal-writeback-assets-v1` 已实现但尚未归档；`doc-snapshot-v1-and-llm-provider-v1` 的 Doc Snapshot + LLM Provider 切换已实现，但仍缺手工回归项跑通与留证据。需要系统性地核对规范与实现的对齐情况。

## What Changes

1. **审计已实现但未归档的 change**：
   - `bailian-multimodal-provider-v1` - 已实现，可归档
   - `multimodal-writeback-assets-v1` - 已实现，可归档

2. **补齐验收与闭环**：
   - `doc-snapshot-v1-and-llm-provider-v1` 的手工回归（不重载/不泄露正文等）

3. **继续 `client-skills-split`**：
   - 完成 5.3 客户端 JS tool 迁移
   - 推进架构和协议定义

4. **建立规范对齐机制**：
   - 规范文档与代码实现的映射表
   - 实现完成的判定标准

## Capabilities

### New Capabilities
- `spec-implementation-tracker`: 追踪每个 OpenSpec change 的实现状态，包括规范版本、代码文件、API 端点、任务完成度
- `change-alignment-check`: 校验 change 的 tasks 完成情况与实际代码实现是否匹配

### Modified Capabilities
- (无)

## Impact

- 需要修改 `openspec/changes/` 下的各 change 目录
- 可能需要更新 CLAUDE.md 补充规范对齐流程
