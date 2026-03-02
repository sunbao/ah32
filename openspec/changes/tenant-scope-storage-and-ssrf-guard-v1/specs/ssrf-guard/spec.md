# Spec: ssrf-guard (v1)

## Purpose

定义后端“主动出网”能力的统一 SSRF 防护与审计要求，适用于：

- HTTP fetch（`web_fetch`）
- 浏览器访问/快照（`browser_snapshot` / Playwright）
- URL 入库（`rag_ingest_url`）
- 未来的下载、政策抓取、模板抓取等

## Requirements

### R1: 统一校验入口（必须）

任何后端主动出网请求 MUST 调用同一个 `ssrf_guard`（或等价的统一入口），不得绕过。

### R2: 仅允许 http/https（必须）

- MUST 只允许 `http://` 与 `https://`
- MUST 拒绝 `file://`、`ftp://`、`gopher://` 等其他 scheme
- MUST 拒绝 URL 中的 `user:pass@host`（userinfo）

### R3: DNS 解析后判定是否“公网”（必须）

在发起连接之前，SSRF guard MUST：

- 解析 hostname 得到 IP 列表（IPv4/IPv6）
- DNS 解析结果 MUST 用于黑名单判定（支持 IP/CIDR 规则）与审计记录（例如 `resolved_ips`）

### R4: 默认允许 http/https，但支持 tenant 黑名单（必须）

按当前总则：

- 对 `http/https` 请求，默认 **允许**（不区分公网/内网/本机/metadata）
- 仅当命中黑名单规则时，才 **拒绝**

黑名单 MUST 支持按 tenant 配置（建议路径）：

- `storage/tenants/<tenant_id>/policy/ssrf_blacklist.json`

规则建议最小形态（实现时可微调）：

- `blocked_hosts`: 精确域名与通配（如 `*.example.com`）
- `blocked_ips`: IP 或 CIDR（如 `203.0.113.0/24`）
- `blocked_url_prefixes`: URL 前缀（如 `https://example.com/private/`）

### R5: redirect 逐跳校验（必须）

- 如果允许自动 redirect，MUST 对每一跳 `Location` 重新执行 R2~R4。
- 如果无法保证逐跳校验，MUST 禁用自动 redirect，并将 redirect 视为失败返回（带原因）。

### R6: 审计日志（必须）

每次出网尝试 MUST 写入 tenant 审计日志（JSONL）：

- 路径：`storage/tenants/<tenant_id>/audit/ssrf.jsonl`
- 至少字段：
  - `ts`, `tenant_id`, `trace_id`, `tool`, `url`, `decision`, `reason`, `elapsed_ms`
- MUST 不记录敏感 payload（bytes、正文长文本等）

## Scenarios

### S1: 黑名单阻断 metadata（示例）

- GIVEN 黑名单包含 `169.254.169.254/32`
- WHEN 请求访问 `http://169.254.169.254/latest/meta-data/`
- THEN MUST 拒绝，`decision=deny`，`reason=blacklist_ip`

### S2: 黑名单阻断 localhost（示例）

- GIVEN 黑名单包含 `127.0.0.1/32`（或 `localhost`）
- WHEN 请求访问 `http://127.0.0.1:80/`
- THEN MUST 拒绝，`decision=deny`，`reason=blacklist_ip`（或 `blacklist_host`）

### S3: redirect 跳到内网必须阻断

- GIVEN `https://example.com` 本身通过校验
- WHEN 它 302 到 `http://127.0.0.1/`
- THEN MUST 逐跳校验并应用黑名单；若 `127.0.0.1` 在黑名单中则拒绝，并记录审计（redirect 逐跳校验命中）
