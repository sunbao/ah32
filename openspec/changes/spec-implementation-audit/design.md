# Design: spec-implementation-audit

## Context

当前存在 4 个活动的 OpenSpec change，审计发现：
- `bailian-multimodal-provider-v1` 和 `multimodal-writeback-assets-v1` 已实现但未归档
- `doc-snapshot-v1-and-llm-provider-v1` 的 Doc Snapshot + LLM Provider 切换已实现；剩下主要是手工回归项未跑完
- `client-skills-split` 部分任务完成（5.0-5.2），但 5.3 及架构/协议定义待继续

## Goals / Non-Goals

**Goals:**
1. 归档已实现且功能完整的 change（bailian-multimodal-provider-v1, multimodal-writeback-assets-v1）
2. 跑通 `doc-snapshot-v1-and-llm-provider-v1` 的手工回归（尤其是“不重载/不泄露正文”）
3. 继续推进 `client-skills-split` 的剩余任务
4. 建立规范与实现的对齐检查机制

**Non-Goals:**
- 不修改已归档的 change 的代码实现
- 不重新设计已有的 API 规范

## Decisions

### D1: 先归档再补充实现
**决定**: 优先归档已完成的 change，再补充缺失实现
**理由**: 归档可以固化已完成的工作，避免重复开发

### D2: LLM Provider 实现策略
**决定**: 参考现有的 Multimodal Provider 模式（`ah32/mm/runtime.py`），使用类似架构实现 LLM Provider 切换
**理由**: 复用已有的 provider 模式，降低实现复杂度

### D3: client-skills-split 推进策略
**决定**: 先确认 1.1-1.2 架构定义（模型口径确认），再继续 2.x 协议定义和 3.x PoC
**理由**: 架构定义是后续工作的前提

## Risks / Trade-offs

### R1: 依赖关系复杂性
**风险**: doc-snapshot-v1 的 Chat 集成（Tasks 2.1-2.3）可能需要修改现有的 `/agentic/chat/stream` 接口
**缓解**: 先检查现有 API 实现，再设计兼容性方案

### R2: client-skills-split 进度
**风险**: 5.3 客户端 JS tool 迁移需要前端配合，前端资源可能有限
**缓解**: 明确前端需要提供的 JS tool 清单，后端提供技术方案

### R3: 规范变更同步
**风险**: 补充实现时可能发现规范需要调整
**缓解**: 实现前先与规范对照，如有冲突在 design 中标注

## Open Questions

1. LLM Provider 需要支持哪些 provider？（当前只设计了切换机制）
2. client-skills-split 的前端 JS tool 是否需要支持网络请求？
3. 是否需要为规范对齐建立自动化检查工具？
