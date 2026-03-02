# Proposal: rag-knowledge-base

## Why

BidAgent 的多个业务场景需要 RAG 知识库支持（招标文件检测、合同审阅、投诉处理等），需要系统性地构建和管理知识数据。现有的 data/rag/ 目录已有部分数据，但缺乏统一的结构和维护机制。

## What Changes

1. **复用现有 ChromaDB 实现**
   - 无需新增代码模块，现有 `src/ah32/knowledge/store.py` 的 ChromaDBStore 已完善
   - 仅需添加数据文件到 `data/rag/` 目录

2. **建立统一的 RAG 数据结构**
   - 定义各类知识库的目录结构
   - 统一数据格式（JSON/TXT）
   - 向量化存储规范

3. **构建核心知识库**
   - 敏感词库（地域歧视、排斥竞争、资质门槛等）
   - 政策法规库（政府采购、招标投标）
   - 合同模板库
   - 历史案例库

4. **建立数据更新机制**
   - 手动触发更新（Playwright 抓取）
   - 定期更新计划
   - 版本管理

5. **实现 RAG 检索接口**
   - 关键词检索
   - 向量语义检索
   - 混合检索

## Capabilities

### New Capabilities

- `sensitive-words-lib`: 敏感词库 - 地域歧视、排斥限制竞争、资质门槛等违规词汇
- `policy-lib`: 政策法规库 - 政府采购法、招标投标法、实施条例等
- `contract-lib`: 合同模板库 - 各类合同示范文本
- `case-lib`: 历史案例库 - 过往招投标案例、投诉处理案例
- `rag-retriever`: RAG 检索 - 关键词检索、向量检索、混合检索

### Modified Capabilities

- 无

## Impact

- **数据文件**:
  - `data/rag/sensitive_words/` - 敏感词数据
  - `data/rag/policies/` - 政策法规数据
  - `data/rag/contracts/` - 合同模板数据
  - `data/rag/cases/` - 历史案例数据

- **代码模块**:
  - 无需新增（复用 `src/ah32/knowledge/store.py`）

- **依赖**:
  - `browser-control-layer` - 用于抓取政策数据（复用现有 ChromaDBStore）

- **被依赖**:
  - `policy-monitor` - 使用政策库
  - 各业务 Skill - 使用敏感词库、合同库等
