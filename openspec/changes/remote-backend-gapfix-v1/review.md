# Review checklist: remote-backend-gapfix-v1

## P0 - 必须满足

- `/api/documents/*` 与 `/memory/*` 任意请求都能在日志中定位到 `trace_id`，且绑定正确的 `tenant_id/user_id`（至少对非默认租户强约束）。
- doc sync 与 memory 的落盘路径位于 `storage/tenants/<tenant_id>/...`，不会写入服务器 HOME 目录。
- 前端触发写回/插图时，`asset://` 下载成功且不会因为缺 headers 被 401/404。
- skills catalog 拉取失败会留痕（前端日志 + 后端接收），不允许“静默返回旧缓存但没人知道发生过错误”。
- 触发对话时，前端走 doc snapshot 上传链路；chat 请求体只引用 `doc_snapshot_id`（不得携带大段全文/二进制）。
- doc snapshot 必须支持“全量二进制/OOXML 上传”（`extracted_text-only` 只能算兜底，不算满足正确性要求）。
- 不存在“服务端 HOME 目录缓存文档正文并回传服务端路径”的 API；如存在必须 dev-only gate 或迁移到 doc snapshot。

## P1 - 建议满足

- 默认租户匿名用户在“会落盘”的接口上策略明确（拒绝/隔离/不落盘/共享体验池任选其一，但必须对外说明与可清理）。
- doc snapshot 的格式策略对用户可解释：非 OOXML 明确提示如何导出成 `.docx/.xlsx/.pptx`。
