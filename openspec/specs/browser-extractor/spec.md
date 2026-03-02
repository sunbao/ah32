# browser-extractor Specification

## Purpose
TBD - created by archiving change browser-control-layer. Update Purpose after archive.
## Requirements
### Requirement: 快照提取
系统 SHALL 支持获取页面快照。

#### Scenario: 获取文本快照
- **WHEN** 调用 take_snapshot
- **THEN** 返回页面文本内容

### Requirement: 结构化数据提取
系统 SHALL 支持根据 schema 提取数据。

#### Scenario: 提取表格数据
- **WHEN** 传入表格选择器和列名映射
- **THEN** 返回结构化数组数据

---

