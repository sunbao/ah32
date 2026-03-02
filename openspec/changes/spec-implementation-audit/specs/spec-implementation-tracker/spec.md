# Spec — Spec Implementation Tracker

## Summary

追踪每个 OpenSpec change 的实现状态，包括规范版本、代码文件、API 端点、任务完成度。

## ADDED Requirements

### Requirement: Change 实现状态追踪
系统 SHALL 维护每个 OpenSpec change 的实现状态，包括：
- 规范文件列表（proposal.md, design.md, specs/*, tasks.md, review.md）
- 代码实现文件映射
- API 端点清单
- 任务完成度（tasks.md 中的 checkbox 状态）

#### Scenario: 列出所有活动的 change
- **WHEN** 开发者查询活动的 OpenSpec change
- **THEN** 系统返回所有未归档的 change 及其状态摘要

#### Scenario: 查看 change 详情
- **WHEN** 开发者查看某个 change 的详细信息
- **THEN** 系统返回该 change 的规范文件列表、代码映射、API 端点、任务完成度

### Requirement: 实现文件自动发现
系统 SHALL 能够扫描代码仓库，自动发现与 change 相关的实现文件。

#### Scenario: 扫描 API 实现
- **WHEN** 对 change 执行扫描时
- **THEN** 系统根据 API 路径前缀匹配（如 `/agentic/mm/*` → mm_api.py）找到相关文件

### Requirement: 规范版本记录
系统 SHALL 记录每个 change 的规范版本信息，包括创建时间、修改时间。

#### Scenario: 查看规范版本
- **WHEN** 开发者查看 change 的版本信息时
- **THEN** 系统返回各规范文件的版本/修改时间

## Non-Goals

- 不提供自动化的实现完成度判定
- 不提供规范与实现的差异对比工具
