# Proposal: policy-monitor

## Why

政策更新频繁，现有的政策数据分散在多个来源（政府采购网、国家行政法规库等），缺乏统一的监控和更新机制。招投标助手需要实时获取最新政策动态，但每次都重新抓取效率低下。需要建立一个手动触发+周期刷新的政策资讯监控机制，作为招投标技能的内置功能。

## What Changes

1. **新增政策资讯监控功能**
   - 手动触发时检查政策更新
   - 24小时周期刷新机制（可配置）
   - 缓存机制避免重复请求

2. **新增政策数据获取能力**
   - 通过 Playwright 抓取政府采购网政策（复用 browser-control-layer）
   - 解析政策列表页获取最新政策
   - 提取政策详情页内容

3. **新增政策数据存储**
   - 政策 JSON 结构化存储
   - 缓存文件记录更新时间
   - 重大信息自动标记

4. **Skill 集成**
   - 作为 bidding-helper skill 的内置工具（tool）
   - 通过 skill.json 声明，在 scripts/ 中实现

## Capabilities

### New Capabilities

- `policy-monitor`: 政策资讯监控 - 手动触发+周期刷新的政策监控机制
  - 检查缓存时效（24小时可配置），决定是否抓取新数据
  - 通过 Playwright 获取最新政策列表
  - 提取政策详情并结构化存储
  - 识别重大政策（修订草案、专项整治等）并标记
  - 作为 bidding-helper skill 的工具集成

- `policy-rag`: 政策 RAG 检索 - 从已获取的政策中检索
  - 关键词检索
  - 语义检索（向量相似度）
  - 按类别/时间筛选

- `sensitive-words`: 敏感词库管理
  - 敏感词检查
  - 违规表述识别
  - 定期更新机制

### Modified Capabilities

- 无（现有 specs 中无相关 capability）

## Impact

- **新增文件**:
  - `data/rag/policies/*.json` - 政策数据
  - `data/rag/.policy_cache.json` - 缓存文件
  - `data/rag/sensitive_words/sensitive_words.txt` - 敏感词库

- **Skill 集成**:
  - 修改 `bidding-helper/skill.json` 或新增 `policy-monitor/skill.json`

- **依赖**:
  - Playwright（browser-control-layer 提供）
  - RAG 向量库（用于语义检索）
