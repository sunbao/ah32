# Tasks: plan-wpp-placeholder-fill-v1

## 1) 协议/口径

- [ ] 定义 `fill_placeholder` 字段与默认值（strict/fallback 策略）
- [ ] 更新 `plan-ops-matrix-v1`：补充新 OP 行 + 限制说明

## 2) 后端（schema/prompt/normalize）

- [ ] `src/ah32/plan/schema.py`：新增 Action schema + allowed ops（wpp）
- [ ] `src/ah32/services/plan_prompts.py`：提示词写清“填占位符优先”的规则
- [ ] `src/ah32/plan/normalize.py`：别名/字段归一化（如 `placeholderKind -> placeholder_kind`）

## 3) 前端（PlanExecutor / WPP）

- [ ] `ah32-ui-next/src/services/plan-executor.ts`：实现 `fill_placeholder`（复用现有 placeholder 查找逻辑，避免新造一套）
- [ ] 可观测：记录成功/失败分支（placeholder 找不到/不可写/回退到 add_textbox）

## 4) 宏基准（对应上）

- [ ] `ah32-ui-next/src/dev/macro-bench-chat-suites.ts`：新增 `placeholder_fill_v1` story
- [ ] （建议）`ah32-ui-next/src/dev/macro-bench-chat-suites.ts`：新增 WPP placeholder 断言类型，确保不是“靠新增文本框糊过去”

