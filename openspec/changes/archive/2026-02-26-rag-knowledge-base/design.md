# Design: rag-knowledge-base

## Context

**背景**：
- 多个业务场景需要 RAG 知识库（招标文件检测、合同审阅、投诉处理等）
- 需要系统性地构建和管理知识数据

**当前状态**：
- data/rag/policies/ 已有政策数据（JSON）
- data/rag/sensitive_words/ 已有敏感词
- `src/ah32/knowledge/store.py` 的 ChromaDBStore 已完善
- 已有 data_rag_catalog.md 设计参考

**约束**：

- 不使用外部向量数据库（复用现有 ChromaDB）
- 数据文件存储在 data/rag/
- 支持手动更新机制

## Goals / Non-Goals

**Goals:**
- 建立统一的目录结构和数据格式
- 实现核心知识库的数据积累
- 实现 RAG 检索接口

**Non-Goals:**
- 不实现复杂的向量检索（当前仅关键词优先）
- 不自动定时更新（手动触发）
- 不对接外部知识图谱

## Decisions

### 决策1：数据存储方式

**选择**：文件存储 + JSON 格式

**理由**：
- 简单可靠，便于版本控制
- 与现有 data/rag/ 一致
- ChromaDBStore 支持向量化存储

### 决策2：检索实现

**选择**：复用现有 ChromaDBStore

**理由**：
- `src/ah32/knowledge/store.py` 已完善
- 支持：similarity_search, search_by_keywords, search_contextual
- 主要复用既有实现；新增“入库脚本”将 data/rag 导入向量库以闭环

### 决策3：更新机制

**选择**：手动触发 + 周期检查

**理由**：
- 与 policy-monitor 设计一致
- 避免频繁请求
- 用户可控

### 决策4：数据入库（向量化）

**选择**：独立导入脚本，按需执行

**理由**：
- data/rag/ 是静态 JSON 文件，需要批量导入到 Chroma 向量库
- 支持增量更新（基于 mtime 检测变化）
- 解耦抓取（policy-monitor）和检索（本变更）

**流程**：
1. policy-monitor 抓取政策 → 存入 data/rag/policies/*.json
2. 手动/启动时触发导入脚本
3. 脚本读取 JSON → 切分 → 调用 ChromaDBStore.add_documents
4. 检索时直接查询向量库

**落地实现（当前仓库）**
- 入库脚本：`src/ah32/knowledge/ingest.py`（CLI：`ah32-ingest ingest ...` / `ah32-ingest query ...`）
- 轻量数据读取：`src/ah32/knowledge/rag_library.py`（load_policies/load_sensitive_words/detect_sensitive_words）

### 决策5：与 policy-monitor 边界

**分工**：
| 职责 | 变更 |
|------|------|
| 政策抓取 | policy-monitor |
| 政策 JSON 存入 data/rag/ | policy-monitor |
| 数据入库（向量化）| rag-knowledge-base |
| RAG 检索 | rag-knowledge-base |

**理由**：
- 单一职责：抓取和检索分离
- policy-monitor 可独立运行，不依赖本变更
- 本变更专注于数据组织和检索

## Risks / Trade-offs

| 风险 | 影响 | 缓解 |
|------|------|------|
| 数据质量 | 检索不准确 | 人工校验 |
| 更新延迟 | 数据过期 | 手动刷新 |
| 存储膨胀 | 文件过多 | 定期清理 |

## Migration Plan

1. 定义目录结构和数据格式
2. 完善敏感词库数据
3. 补充政策法规数据
4. 建立合同模板数据
5. 测试检索效果
