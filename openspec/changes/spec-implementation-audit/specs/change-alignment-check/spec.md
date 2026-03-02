# Spec — Change Alignment Check

## Summary

校验 change 的 tasks 完成情况与实际代码实现是否匹配，确保规范落地。

## ADDED Requirements

### Requirement: Task 完成度校验
系统 SHALL 能够校验 tasks.md 中的任务与实际代码实现的匹配情况。

#### Scenario: 检测未实现的任务
- **WHEN** 对某个 change 执行对齐检查，且某 task 已勾选完成但无对应代码实现时
- **THEN** 系统报告该任务可能存在实现遗漏

#### Scenario: 检测已实现但未标记的任务
- **WHEN** 对某个 change 执行对齐检查，且存在代码实现但 tasks.md 中未勾选时
- **THEN** 系统报告该任务可能未在 tasks.md 中标记

### Requirement: API 端点存在性检查
系统 SHALL 校验 change 中定义的 API 端点是否已在代码中实现。

#### Scenario: API 端点缺失
- **WHEN** spec 中定义的 API 端点在代码中不存在时
- **THEN** 系统报告该 API 端点缺失

### Requirement: 配置项检查
系统 SHALL 校验 change 中要求的环境变量/配置项是否已在 config 中定义。

#### Scenario: 配置项缺失
- **WHEN** change 要求某个配置项但代码中未定义时
- **THEN** 系统报告该配置项缺失

## Non-Goals

- 不提供自动修复功能
- 不提供实现质量的评估
