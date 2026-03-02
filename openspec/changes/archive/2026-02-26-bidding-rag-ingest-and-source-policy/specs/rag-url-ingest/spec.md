## Purpose

定义“URL → 抓取网页正文 → 导入 RAG → 立刻可在同一项目内检索命中”的端到端能力契约，支撑招投标流程中合同/案例/模板/政策等外部资料快速补库。

---

## ADDED Requirements

### Requirement: URL 正文抓取与失败分类
系统 SHALL 支持对用户提供的 URL 进行抓取，并从页面中提取可用于向量检索的正文文本；系统 MUST 能够识别并报告常见失败类型（不可达、超时、验证码/反爬、需要登录、正文提取为空）。

#### Scenario: 成功抓取并提取正文
- **WHEN** 用户提供可访问的 URL 且页面正文可提取
- **THEN** 系统 MUST 返回提取到的正文文本并进入入库流程

#### Scenario: 识别验证码/反爬导致的失败
- **WHEN** 抓取过程中检测到验证码/反爬拦截
- **THEN** 系统 MUST 返回“验证码/反爬”类型的失败原因

### Requirement: 正文抽取质量与长度控制
系统 MUST 对抓取到的内容做最小可控的文本清洗与质量门槛控制，以保证入库质量可验收：

- 系统 MUST 输出纯文本（非 HTML/非脚本），并 SHOULD 去除 script/style 等不可见内容，合并连续空白。
- 若抽取到的正文文本“可用内容长度不足”（例如去空白后 < 500 字符），系统 MUST 将其视为“正文为空/不可提取”的失败类型。
- 为避免超长文本导致性能与检索质量不可控，系统 MUST 将入库正文截断到不超过 200,000 字符；系统 MUST 在内部元数据记录 `original_length` 与 `truncated=true/false`。

#### Scenario: 正文为空时按失败处理
- **WHEN** 抽取后的正文文本去空白后长度不足 500 字符
- **THEN** 系统 MUST 返回“正文为空/不可提取”的失败原因并停止入库

#### Scenario: 正文超长时截断并记录元数据
- **WHEN** 抽取后的正文文本长度超过 200,000 字符
- **THEN** 系统 MUST 截断到 200,000 字符并在内部元数据记录 original_length 与 truncated 标记

### Requirement: 导入 RAG 并默认进入项目库可检索范围（含上下文判定与 fallback）
系统 MUST 将抓取得到的正文文本导入向量库；并在存在“项目上下文”时默认关联到该项目的可检索范围（项目库/项目索引）。

项目上下文判定与作用域规则如下（必须可测试且可追踪）：

- 入库请求 MUST 支持 `scope` 取值 `global|project`，并可携带 `contextDocumentPath`（用于推导项目）。
- 若 `scope` 未显式指定：系统 MUST 在 `contextDocumentPath` 可推导项目时默认使用 `project`；否则默认使用 `global`。
- 若 `scope=project` 但缺少/无法解析项目上下文：系统 MUST fallback 为 `global`，并 MUST 返回可追踪的警告（例如 `project_context_missing`）。

#### Scenario: 入库后在同一项目内可检索命中
- **WHEN** URL 正文抓取成功且导入向量库成功，并且 `scope=project` 且项目上下文可解析
- **THEN** 系统 MUST 能在后续同一项目对话的向量检索中命中该内容

#### Scenario: 无项目上下文时默认全局入库
- **WHEN** URL 正文抓取成功且未提供可解析的项目上下文，且 `scope` 未显式指定
- **THEN** 系统 MUST 默认以 `global` 方式入库，并可在全局检索中命中

#### Scenario: project 作用域缺上下文时 fallback 并给出警告
- **WHEN** `scope=project` 但 `contextDocumentPath` 缺失或无法推导项目
- **THEN** 系统 MUST fallback 为 `global` 并返回 `project_context_missing` 警告

### Requirement: 入库结果必须可追踪（不强制展示）
系统 MUST 为每次 URL 入库生成可追踪标识（例如 source_id/doc_id），并在内部元数据中保存 URL、抓取时间、标题等信息；系统 MUST NOT 在默认回答/写回正文中强制展示这些来源信息（除非用户明确要求展示出处/链接）。

#### Scenario: 入库返回可追踪标识
- **WHEN** 系统完成一次 URL 入库
- **THEN** 系统 MUST 返回可追踪标识（source_id/doc_id 等）并在内部保存 URL 元数据

### Requirement: 失败必须提供下一步操作建议
当 URL 抓取或入库失败时，系统 MUST 给出可执行的下一步建议，包括：更换 URL、稍后重试、改用粘贴纯文本、或上传文件导入；系统 MUST 不得在失败时静默结束。

#### Scenario: 入库失败时给出可执行建议
- **WHEN** URL 抓取或入库任一环节失败
- **THEN** 系统 MUST 返回失败原因并提供至少一种可执行的替代方案

---

## Implementation Notes

- 抓取建议复用浏览器控制层（Playwright）；入库建议复用现有 RAG 文本上传/导入 API，并确保项目索引在写入后可用于检索过滤。
