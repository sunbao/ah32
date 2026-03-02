# Tasks: spec-implementation-audit

## 0. 对账与收口（把差异点都拿出来）

- [x] 0.1 汇总 `TODOLIST*`、现有代码、现有 OpenSpec changes 的差异点/漏项/冲突点到本 change 的 `review.md`
- [ ] 0.2 对每个“确实要做”的漏项建立 follow-up change（先有 proposal，再排期实现）

- [x] 0.2.1 新建 `plan-writeback-rollback-v1`（Plan 写回的回退/预览口径与实现）
- [x] 0.2.2 新建 `plan-insert-image-wps-et-v1`（Writer/ET 插图能力，支持 asset://）
- [x] 0.2.3 处理 `client-skills-split` 口径冲突（已标记为 superseded，后续以租户托管口径为准）
- [x] 0.2.4 对齐 `doc-snapshot-v1-and-llm-provider-v1` 的 tasks/review（代码已实现，文档状态更新）

## 1. 归档已实现的 Change

- [ ] 1.1 归档 bailian-multimodal-provider-v1（已实现 API + Provider）
- [ ] 1.2 归档 multimodal-writeback-assets-v1（已实现 Asset Store）

## 2. 补充 LLM Provider 实现

- [x] 2.1 支持通过 `AH32_LLM_PROVIDER` 选择 Provider（含 base_url 推断/DeepSeek 默认）
- [x] 2.2 实现 Provider 选择与 strict 行为（默认 strict，不静默降级）
- [x] 2.3 配置缺失时给出明确错误（缺 key / 缺 deepseek 包等）
- [x] 2.4 明确 API Key 读取边界（避免误用宿主环境变量）

## 3. 继续 client-skills-split

- [ ] 3.1 确认 1.1 客户端模式口径（模型 A/B/C）
- [ ] 3.2 确认 1.2 需要迁移的 skills 分组
- [ ] 3.3 完成 2.1-2.3 协议与数据结构定义
- [ ] 3.4 推进 3.1-3.3 PoC
- [ ] 3.5 完成 5.3 客户端 JS tool 迁移

## 4. 实现规范追踪能力

- [ ] 4.1 扫描现有 change，记录规范文件与代码实现的映射
- [ ] 4.2 建立 API 端点与代码文件的关联表
- [ ] 4.3 实现配置项与 change 的关联检查
