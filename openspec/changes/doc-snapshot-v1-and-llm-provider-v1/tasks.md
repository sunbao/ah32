# Tasks: doc-snapshot-v1-and-llm-provider-v1

## 1. Backend snapshot store

- [x] 1.1 Implement `doc_snapshots` ephemeral storage layout + TTL sweeper
- [x] 1.2 Implement init/upload/finalize/status/delete endpoints
- [x] 1.3 Ensure deletion on SSE disconnect/cancel

## 2. Chat integration

- [x] 2.1 Update `/agentic/chat/stream` request to accept `doc_snapshot_id`
- [x] 2.2 Update backend document-reading tool to use snapshot when present
- [x] 2.3 Ensure no full doc text/bytes are embedded in chat JSON by default

## 3. LLM provider switching

- [x] 3.1 Implement `AH32_LLM_PROVIDER` selection with strict behavior
- [x] 3.2 Ensure DeepSeek path requires `langchain-deepseek` under strict

## 4. Validation

- [ ] 4.1 Manual regression: no taskpane reload from large doc strings
- [ ] 4.2 Unit tests for strict mode & provider selection
