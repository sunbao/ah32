## ADDED Requirements

### Requirement: UTF-8 JSON responses
The backend SHALL return JSON payloads encoded as UTF-8 and SHALL include `charset=utf-8` in the `Content-Type` header for JSON responses.

#### Scenario: /health declares UTF-8 JSON
- **WHEN** a client requests `GET /health`
- **THEN** the response `Content-Type` includes `application/json` and `charset=utf-8`

#### Scenario: API JSON parses as UTF-8
- **WHEN** a client decodes any JSON response body as UTF-8
- **THEN** JSON parsing succeeds without requiring a different encoding

### Requirement: UTF-8 SSE streaming
The backend SHALL stream Server-Sent Events as UTF-8 bytes and SHALL ensure each SSE `data:` line is a complete JSON object (not split across multiple lines).

#### Scenario: SSE data lines are independently parseable JSON
- **WHEN** the client consumes `/agentic/chat/stream`
- **THEN** each SSE event's `data:` line can be parsed as a complete JSON object

### Requirement: UTF-8 text file writes
When the backend writes textual artifacts to disk (for example extracted document text or debug dumps), it SHALL write them using UTF-8 encoding.

#### Scenario: extracted_text.txt is written in UTF-8
- **WHEN** a doc snapshot upload includes `extracted_text`
- **THEN** the server writes `extracted_text.txt` using UTF-8 encoding
