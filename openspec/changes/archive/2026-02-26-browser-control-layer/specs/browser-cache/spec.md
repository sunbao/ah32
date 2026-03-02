## Purpose

实现数据缓存功能，支持抓取结果的临时存储。

---

## ADDED Requirements

### Requirement: 数据缓存
系统 SHALL 缓存抓取的数据。

#### Scenario: 写入缓存
- **WHEN** 调用 cache 并传入 key 和 data
- **THEN** 数据被缓存，返回成功

#### Scenario: 读取缓存
- **WHEN** 调用 retrieve 并传入 key
- **THEN** 返回缓存数据（如果存在且未过期）

### Requirement: 缓存过期
系统 SHALL 管理缓存的生命周期。

#### Scenario: 缓存过期
- **WHEN** 缓存超过设定时间
- **THEN** 返回未命中，允许重新抓取

---

## Tool Contract (v1)

### Tool: cache_write

**Input**
- `key` (string)
- `data` (any JSON-serializable)
- `ttl_seconds` (integer, optional): 默认 3600

**Output**
- 成功：`ok=true`，`data.cached=true`

### Tool: cache_retrieve

**Input**
- `key` (string)

**Output**
- 命中：`ok=true`，`data.hit=true`，`data.value=<cached>`
- 未命中/过期：`ok=true`，`data.hit=false`

### Storage

- 默认落盘目录：`storage/browser_cache/`（运行时目录，禁止提交）

**Implementation**
- `src/ah32/integrations/browser/cache.py` + `src/ah32/integrations/browser/api.py`
