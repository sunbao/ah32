## Purpose

实现敏感词库，支持招标文件合规检测。

---

## ADDED Requirements

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

## Implementation Notes

- 数据文件：`data/rag/sensitive_words/sensitive_words.txt`
- 加载与检测：`src/ah32/knowledge/rag_library.py`（`load_sensitive_words` / `detect_sensitive_words`）
- 向量入库（可选）：`src/ah32/knowledge/ingest.py`（会将敏感词按类别切分入库）
