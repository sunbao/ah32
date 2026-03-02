# Review: bidding-rag-ingest-and-source-policy

## Summary

- Problem: 招投标对话依赖 RAG，但“合同/案例/模板/政策”等资料常未导入；当 RAG 0 命中时，用户需要明确的缺库反馈与可执行补库路径。同时，默认展示来源（source/URL）会破坏正文与写回排版。
- Solution: 以“技能决定、core 提供机制”为边界，定义并落地 3 个能力契约：
  - `rag-missing-library-guidance`：RAG 0 命中必须反馈缺口并引导补库（上传/导入、或 URL 抓取入库；失败兜底为粘贴纯文本/上传文件，暂不支持图片）。
  - `rag-url-ingest`：URL 抓取正文→入库→（项目库优先）可检索命中，含失败分类、正文质量门槛与长度控制、项目上下文判定与 fallback。
  - `source-display-policy`：来源展示策略默认隐藏，仅用户明确要求才展示（正文+写回一致）。

## Consistency Checks

- Proposal ↔ Specs
  - Proposal 列出的 3 个 capability 均已生成同名 specs 文件，并覆盖关键行为（缺库反馈、URL 入库、来源展示策略）。
  - Proposal 中标记的 **BREAKING**（默认不展示 source/URL）在 `source-display-policy` spec 中已固化为 MUST 场景。

- Specs ↔ Design
  - Design 的关键决策（技能决定缺库约束、core 提供机制；来源展示按对话意图；URL 入库项目库优先）与 specs 一致。
  - 之前的阻塞点（项目上下文判定与 fallback、正文抽取/长度控制最低要求）已在 `rag-url-ingest` spec 中固化为可测试条款。

- Design ↔ Tasks
  - Tasks 覆盖了 specs/design 所需的实现工作：capability gating、来源策略落地到正文与写回、URL 抓取入库工具链、项目索引关联、失败分类与兜底、单测与手工清单。

- Cross-change dependencies
  - 依赖既有能力：浏览器控制层（Playwright）、RAG upload-text / upload-files / search API、项目索引/过滤机制、skill manifest 能力声明与路由编排。

## Findings

### MUST-FIX (Blocking)

- (none)

### SHOULD (Recommended)

- 建议把“用户明确要求展示/隐藏来源”的意图判定规则进一步写成更可测试的实现约束（关键词集合 + 显式开关优先级），并在 core/skill 侧统一复用。
- 建议 URL 入库失败返回结构化错误码（machine-readable），便于前端/UI 做更强引导与重试。
- 建议将“入库完成后自动复检一次并反馈是否命中”固化为可选流程，降低“入库了但没生效”的感知问题。

## Risks / Trade-offs

- 网页抓取不稳定（反爬/登录/动态渲染）会提高 URL 入库失败率，需要依赖“失败分类 + 兜底粘贴纯文本/上传文件”确保流程可完成。
- 默认隐藏来源降低可追溯性，但可用“用户显式要求时展示 + 内部元数据保存”折中。
- 项目索引更新若不一致，会出现“入库成功但检索不到”的高感知故障；需要原子更新与可追踪 source_id/doc_id。

## Decision

- Status: Approved
- Rationale:
  - 需求边界清晰，能力拆分合理（skill 约束 vs core 机制）。
  - Specs 已补齐可验收的关键约束（项目上下文判定+fallback、正文质量门槛与长度控制）。
  - Tasks 可直接用于进入 apply/实现阶段。

