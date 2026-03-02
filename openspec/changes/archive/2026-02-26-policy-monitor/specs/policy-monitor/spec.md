## Purpose

实现政策资讯监控功能，提供手动触发+周期刷新的政策获取机制。

---

## ADDED Requirements

### Requirement: 缓存时效检查
系统 SHALL 检查政策缓存的更新时间，判断是否需要重新抓取数据。

#### Scenario: 缓存未过期
- **WHEN** 用户触发政策检查，且距离上次更新时间未超过24小时
- **THEN** 系统返回缓存的政策数据，提示"数据为 {时间} 前更新"

#### Scenario: 缓存已过期
- **WHEN** 用户触发政策检查，且距离上次更新时间超过24小时
- **THEN** 系统执行抓取逻辑，获取最新政策数据

#### Scenario: 首次运行（无缓存）
- **WHEN** 用户首次触发政策检查，且无缓存文件
- **THEN** 系统执行抓取逻辑，获取最新政策数据

#### Scenario: 强制刷新
- **WHEN** 用户触发政策检查，且设置 force_refresh=true
- **THEN** 系统跳过TTL判断，强制执行抓取逻辑

### Requirement: 政策抓取
系统 SHALL 通过 browser-control-layer（Playwright）访问政府采购网，获取最新政策列表。

#### Scenario: 抓取成功
- **WHEN** browser-control-layer 成功访问政策列表页
- **THEN** 系统解析页面，提取政策标题、发布日期、文号等关键信息

#### Scenario: 抓取失败
- **WHEN** browser-control-layer 访问失败或页面结构变化
- **THEN** 系统返回错误提示，保留现有缓存数据

### Requirement: 政策详情提取
系统 SHALL 访问政策详情页，提取政策全文或摘要内容。

#### Scenario: 详情页可访问
- **WHEN** 政策详情页可正常访问
- **THEN** 系统提取政策关键条款，保存为结构化 JSON

#### Scenario: 新政策检测
- **WHEN** 抓取到新政策（不在现有缓存中）
- **THEN** 系统标记为"新政策"，通知用户

### Requirement: 重大信息标记
系统 SHALL 识别政策标题中的关键词，自动标记重大政策。

#### Scenario: 识别修订草案
- **WHEN** 政策标题包含"修订"或"草案"
- **THEN** 系统标记为 🔥 重大更新

#### Scenario: 识别专项整治
- **WHEN** 政策标题包含"专项整治"
- **THEN** 系统标记为 🔥 重大更新

### Requirement: 政策数据存储
系统 SHALL 将政策数据保存为结构化 JSON 文件。

#### Scenario: 存储新政策
- **WHEN** 抓取到新政策
- **THEN** 系统创建新 JSON 文件，命名为 `{document_number}.json` 或 `{hash(source_url)}.json`（避免标题特殊字符）

#### Scenario: 更新已有政策
- **WHEN** 政策已存在但内容有更新
- **THEN** 系统覆盖现有文件，保留更新时间戳

---

## Tool Contract (v1)

### Tool: check_policy_update

**Input**
- `force_refresh` (boolean, optional): 跳过TTL
- `ttl_hours` (integer, optional): 默认24
- `max_items` (integer, optional): 默认10
- `record_trace` (boolean, optional): 是否记录 trace（落盘 `storage/browser_traces/`）
- `timeout_ms` (integer, optional): 默认30000

**Output**
- `ok` (boolean)
- `from_cache` (boolean)
- `message` (string)
- `last_checked_at` (string|null)
- `items` (array): 元信息（含 `policy_id`、`policy_name`、`issue_date`、`document_number`、`source_url`、`is_major`、`file_name`）
- `new_items` (array): 新增项
- `major_items` (array): 重大政策项（🔥）
- `error` (object, optional): 失败时的错误信息（抓取失败时会降级返回缓存）

### Tool: get_latest_policies

**Input**
- `limit` (integer, optional): 默认10

**Output**
- `ok` (boolean)
- `items` (array)
- `total` (integer)

**Implementation**
- `src/ah32/integrations/policy_monitor/scraper.py`
- `installer/assets/user-docs/skills/bidding-helper/scripts/check_policy_update.py`
- `installer/assets/user-docs/skills/bidding-helper/scripts/get_latest_policies.py`
