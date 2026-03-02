## Purpose

实现敏感词库管理功能，支持招标文件合规检测。

---

> NOTE: 敏感词库的数据维护与检索能力归属 `rag-knowledge-base`（`sensitive-words-lib`）。`policy-monitor` 不再实现敏感词检测/检索逻辑，仅复用 `data/rag/sensitive_words/` 数据作为上游输入。

## ADDED Requirements

### Requirement: 敏感词检查
系统 SHALL 检查文本中是否包含敏感词汇。

#### Scenario: 检测地域歧视词汇
- **WHEN** 文本包含"本地企业"、"本省供应商"等词汇
- **THEN** 系统标记为地域歧视风险

#### Scenario: 检测排斥限制竞争词汇
- **WHEN** 文本包含"唯一"、"指定品牌"、"独家代理"等词汇
- **THEN** 系统标记为排斥限制竞争风险

#### Scenario: 检测资质门槛违规
- **WHEN** 文本包含"过高资质"、"特定业绩"等词汇
- **THEN** 系统标记为资质门槛违规风险

### Requirement: 违规等级判定
系统 SHALL 根据敏感词类型判定违规等级。

#### Scenario: 高风险违规
- **WHEN** 检测到地域歧视或排斥限制竞争词汇
- **THEN** 系统标记为高风险，提示"可能违反政府采购法"

#### Scenario: 中风险违规
- **WHEN** 检测到资质门槛设置不当
- **THEN** 系统标记为中风险，提示"建议评估资质要求合理性"

### Requirement: 检查结果返回
系统 SHALL 返回详细的检查结果和修改建议。

#### Scenario: 返回检测结果
- **WHEN** 完成敏感词检查
- **THEN** 系统返回：风险位置、风险类型、风险等级、修改建议

#### Scenario: 无风险
- **WHEN** 文本未检测到敏感词
- **THEN** 系统返回"未检测到敏感词"
