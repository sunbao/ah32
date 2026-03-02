# source-display-policy Specification

## Purpose
TBD - created by archiving change bidding-rag-ingest-and-source-policy. Update Purpose after archive.
## Requirements
### Requirement: 默认不展示来源
在用户未明确提出“出处/来源/引用/链接/URL”等要求时，系统 MUST NOT 在正文答案与写回内容中展示来源列表、URL、或引用片段标记；系统 MAY 在内部元数据中保留来源信息以便追溯与调试。

#### Scenario: 用户未要求时不展示来源
- **WHEN** 系统生成回答或写回内容，且用户未要求展示出处/链接
- **THEN** 输出正文与写回内容 MUST 不包含来源/URL

### Requirement: 用户明确要求时才展示来源
当用户明确要求展示出处/来源/引用/链接时，系统 MUST 在输出中展示来源信息；为避免破坏正文排版，系统 SHOULD 将来源展示放在正文末尾的独立段落/独立区块中（或以可复制列表形式呈现）。

#### Scenario: 用户要求出处时展示来源
- **WHEN** 用户提出“给出处/给链接/引用来源”等明确请求
- **THEN** 系统 MUST 展示来源信息（例如 URL 列表或引用标识）

### Requirement: 用户明确要求隐藏来源时必须遵守
当用户明确要求“不显示来源/不要链接/不要引用”时，即便系统内部有来源信息，系统 MUST 不在正文与写回中展示来源。

#### Scenario: 用户要求不展示来源
- **WHEN** 用户明确指示不展示来源
- **THEN** 系统输出 MUST 不包含来源/URL

---

