## 1. UTF-8 IO Hardening

- [x] 1.1 Identify and convert mojibake source files to UTF-8 (backend + frontend)
- [x] 1.2 Consolidate backend boot-time encoding setup (single UTF-8 strategy; remove contradictory reconfigure blocks)
- [x] 1.3 Verify all JSON endpoints return `Content-Type` with `charset=utf-8` (including error paths)
- [x] 1.4 Ensure server-side text writes explicitly use UTF-8 (doc snapshot extracted text, debug dumps, exports)
- [x] 1.5 Add a lightweight regression check for UTF-8/charset (script or CI hook)

## 2. Safe Startup Port Handling

- [x] 2.1 Introduce `AH32_PORT_CONFLICT_MODE` (`fail` default; support `reuse` and `force_kill`)
- [x] 2.2 Implement "existing AH32 detection" via `GET /health` and log "already running" guidance
- [x] 2.3 Remove unconditional `cleanup_port(5123)`; only allow termination in explicit `force_kill` mode
- [x] 2.4 Implement safe force-kill: only terminate a verifiable previous AH32 instance; refuse otherwise
- [x] 2.5 Add telemetry/audit for port-conflict branch taken (fail/reuse/force_kill)

## 3. Plan Schema Single Source + Frontend Refactor

- [ ] 3.1 Export `ah32.plan.v1` machine-readable artifact under `schemas/` (JSON Schema or ops+params export)
- [ ] 3.2 Add backend script to generate/export the artifact from `src/ah32/plan/schema.py`
- [ ] 3.3 Add build-time check that detects "backend op added but frontend not implemented"
- [ ] 3.4 Refactor `plan-executor.ts`: create module structure and move shared parsing/normalize utilities
- [ ] 3.5 Refactor `plan-executor.ts`: split Writer (wps) execution into its own module
- [ ] 3.6 Refactor `plan-executor.ts`: split ET execution into its own module
- [ ] 3.7 Refactor `plan-executor.ts`: split WPP execution into its own module
- [ ] 3.8 Refactor `js-macro-executor.ts` and `stores/chat.ts` by responsibility (queueing/execution/telemetry)
- [x] 3.9 Run `npm -C ah32-ui-next run build` and backend smoke checks for touched modules

## 4. Writeback Architecture Hardening

- [x] 4.1 Remove backend `/agentic/js-macro/*` model-macro endpoints (channel A)
- [x] 4.2 Remove frontend network calls to js-macro endpoints (keep local BID runtime only)
- [ ] 4.3 Implement `answer_mode_apply` and `rollback_block` fully inside PlanExecutor (no required macro preload)
- [ ] 4.4 Make execution path observable: audit/telemetry records plan vs macro path deterministically
- [ ] 4.5 Validate macrobench/dev flows still work (local BID runtime; no backend model-macro endpoints)
