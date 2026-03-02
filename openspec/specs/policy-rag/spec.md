# policy-rag Specification

## Purpose
TBD - created by archiving change policy-monitor. Update Purpose after archive.
## Requirements
### Requirement: 关键词检索
系统 SHALL 支持按政策名称、文号、关键词检索已获取的政策。

#### Scenario: 按名称检索
- **WHEN** 用户输入政策名称关键词
- **THEN** 系统返回匹配的政策列表，包含政策名称、发布日期、文号

#### Scenario: 按类别筛选
- **WHEN** 用户指定政策类别（部门规章/行政法规/规范性文件）
- **THEN** 系统返回该类别下的所有政策

#### Scenario: 按时间范围筛选
- **WHEN** 用户指定时间范围
- **THEN** 系统返回该时间范围内发布的政策

### Requirement: 语义检索
系统 SHALL 支持向量语义检索，返回与查询最相关的政策。

#### Scenario: 语义相似度检索
- **WHEN** 用户输入自然语言查询
- **THEN** 系统计算向量相似度，返回相关性最高的政策及匹配片段

#### Scenario: 无检索结果
- **WHEN** 检索无匹配结果
- **THEN** 系统返回提示"未找到相关政策，可尝试其他关键词"

### Requirement: 政策详情返回
系统 SHALL 返回政策的完整结构化信息。

#### Scenario: 返回政策摘要
- **WHEN** 检索到匹配政策
- **THEN** 系统返回政策摘要，包含关键条款、主要要点

#### Scenario: 返回政策原文
- **WHEN** 用户请求查看政策原文
- **THEN** 系统返回政策原文内容或原文链接

