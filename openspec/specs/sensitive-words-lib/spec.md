# sensitive-words-lib Specification

## Purpose
TBD - created by archiving change rag-knowledge-base. Update Purpose after archive.
## Requirements
### Requirement: 敏感词加载
系统 SHALL 加载敏感词数据。

#### Scenario: 加载词库
- **WHEN** 调用 load_sensitive_words
- **THEN** 返回分类后的敏感词列表

### Requirement: 敏感词检测
系统 SHALL 检测文本中的敏感词。

#### Scenario: 检测地域歧视
- **WHEN** 文本包含"本地企业"等词汇
- **THEN** 返回地域歧视风险标记

#### Scenario: 检测排斥竞争
- **WHEN** 文本包含"唯一"、"指定品牌"等词汇
- **THEN** 返回排斥限制竞争风险标记

---

