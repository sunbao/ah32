# Review (Draft) — doc-snapshot-v1-and-llm-provider-v1

## Checklist

- [ ] Snapshot bytes/text never appear in logs（只看得到 id/大小/状态，不会把正文打出来）
- [x] Deletion triggers cover success/cancel/disconnect + TTL（代码已接入；仍需手工验证）
- [x] Chat requests stay small and stable (no giant JSON strings)（走 doc_snapshot_id 引用；仍需手工压测）
- [x] LLM provider strict mode has no silent downgrade（strict 下缺依赖直接报错）

## 代码证据（给你定位用）

- Doc Snapshot API：`src/ah32/server/doc_snapshot_api.py`
- Snapshot Store（TTL/cleanup）：`src/ah32/doc_snapshots/store.py`
- Chat 侧接入与回合结束删除：`src/ah32/server/agentic_chat_api.py`
- 文档提取优先 snapshot：`src/ah32/services/docx_extract.py`
- LLM provider 选择与 strict：`src/ah32/services/models.py`
