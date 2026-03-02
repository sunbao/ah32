# Design: policy-monitor

## Context

**背景**：
- 政策更新频繁，需要持续跟踪最新动态
- 现有 data/rag/policies/ 目录已存放政策数据
- 需要实现手动触发+周期刷新的监控机制

**当前状态**：
- 已获取4份最新政策文件（JSON格式）
- 已有敏感词库基础数据
- Playwright 可用于浏览器自动化抓取

**约束**：

- 不使用定时任务（用户要求手动触发）
- 需要缓存机制避免频繁请求
- 政策 JSON 存储在 data/rag/policies/（静态数据，可提交）
- 运行时缓存存储在 storage/policy_cache/（非仓库）
- 集成到 bidding-helper skill 作为工具

**相关现有文档**：
- `docs/design_policy_2026.md` - 包含 4.2.3 政策监控设计

## Goals / Non-Goals

**Goals:**
- 实现手动触发+周期刷新的政策监控机制
- 通过 Playwright 自动抓取政府采购网最新政策
- 结构化存储政策数据（JSON格式）到 data/rag/policies/
- 识别重大政策并标记
- 作为 bidding-helper skill 的工具集成

**Non-Goals:**
- 不实现定时自动抓取（手动触发）
- 不对接所有政策来源（优先政府采购网）
- 不实现政策全文PDF下载（仅获取结构化摘要）
- 不实现 RAG 检索（由 rag-knowledge-base 负责）

## Decisions

### 决策1：缓存机制设计

**选择**：使用文件缓存（JSON），而非数据库

**理由**：
- 运行时缓存（非仓库）放 storage/policy_cache/
- 政策数据（可版本化）放 data/rag/policies/
- 简单易实现，便于区分

### 决策2：政策文件命名规则

**选择**：基于 document_number（文号）或 source_url hash

**理由**：
- 原始标题可能含特殊字符（空格/斜杠/冒号），跨平台不友好
- 文号（如"发改法规〔2026〕195号"）唯一且安全
- 无文号时用 URL hash

**示例**：
- `faoguan_2026_195.json`
- `url_hash_abc123.json`

### 决策3：Skill 集成方式

**选择**：作为 bidding-helper 的内置工具（tool）

**理由**：
- 政策监控是招投标的辅助功能
- 复用现有 skill 基础设施
- 用户在使用招投标技能时可自然触发
- 通过 skill.json 声明工具，在 scripts/ 中实现

### 决策4：数据源优先级

**选择**：优先政府采购网(ccgp.gov.cn) → 其次国家行政法规库

**理由**：
- 政府采购网无验证码，容易抓取
- 与招投标业务最相关
- 后续可扩展其他来源

### 决策5：重大信息识别

**选择**：基于关键词规则识别

**关键词**：
- 修订、草案 → 🔥 重大
- 专项整治 → 🔥 重大
- 新规、实施 → 普通更新
- 通知、意见 → 普通更新

**理由**：
- 简单可靠，无需LLM判断
- 覆盖主要场景

### 决策6：周期刷新机制

**选择**：24小时缓存（可配置）

**理由**：
- 手动触发时检查缓存时效
- 未过期则跳过抓取，提升响应速度
- 用户可强制刷新

### 决策7：与 rag-knowledge-base 边界

**分工**：
| 职责 | 变更 |
|------|------|
| 政策抓取 | policy-monitor |
| 政策 JSON 存入 data/rag/policies/ | policy-monitor |
| 数据入库（向量化）| rag-knowledge-base |
| RAG 检索 | rag-knowledge-base |

**理由**：
- 单一职责：抓取和检索分离
- policy-monitor 可独立运行，不依赖本变更

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 网站结构变化 | 抓取失败 | 预留解析失败处理 |
| 反爬虫限制 | 请求被阻止 | 添加请求间隔 |
| 数据更新延迟 | 获取非最新 | 提示用户手动刷新 |
| Playwright 不可用 | 无法抓取 | 降级提示用户 |

## Migration Plan

1. 创建缓存管理模块（policy_cache.py）
2. 实现 Playwright 抓取逻辑
3. 实现政策数据解析和存储
4. 集成到 bidding-helper skill（新增 tool）
5. 添加重大信息标记逻辑
6. 测试和调优
