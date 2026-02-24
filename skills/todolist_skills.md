# todolist_skills.md（对照 docs/requirements_skills.md 的落地清单）

> 说明：
> - 需求原文在 `docs/requirements_skills.md`（本地研发文档；按仓库约定不提交/不发布）。
> - 本文件放在 `skills/` 下，作为可提交、可跟踪的“落地对照表”（实现状态以仓库代码为准）。

---

## 0) 对照结论（差异点）

- `docs/requirements_skills.md` 的 **Phase 3/4 工具命名** 与当前内置种子技能不一致：当前种子技能（`installer/assets/user-docs/skills/`）以 `generate_timeline/check_compliance/generate_checklist`、`recommend_layout/get_placeholder_map` 为准。
- `docs/requirements_skills.md` 将 `ppt-outline.layout_recommender` 标为待实现，但仓库种子技能已提供基础实现（见下方“已落地 tools”）。

---

## 1) Phase 1：平台能力（Skills 平台）

- [x] `ah32.skill.v1` manifest + prompt-only 回退（`schemas/ah32.skill.v1.schema.json`，`src/ah32/skills/registry.py`）
- [x] 运行时技能目录（默认 `%USERPROFILE%\\Documents\\Ah32\\skills\\`，可用 `AH32_SKILLS_DIR` 覆盖；`src/ah32/config.py`）
- [x] 热更新（按文件 fingerprint 自动 reload；`src/ah32/skills/registry.py`）
- [x] 动态路由（TopK + host 过滤 + group 互斥；`src/ah32/skills/router.py`，`src/ah32/skills/registry.py`）
- [x] Skills 向量路由持久化（ChromaDB: `storage/skills_vector_store/`；collection=`make_collection_name("skills", embedding_model, embedding_dim)`；`src/ah32/skills/registry.py` + `src/ah32/server/main.py`）
- [x] 工具声明注入（按“已选 skills”渲染 tools；`src/ah32/skills/registry.py#render_tools_for_prompt`）
- [x] 工具执行（`scripts/*.py` 同名函数；参数校验 + 不吞错；`src/ah32/skills/tool_executor.py`）
- [x] `doc_text` 自动注入（工具参数缺失 `doc_text` 时，运行时自动填充“当前文档内容”，避免重复占用 token；`src/ah32/agents/react_agent/core.py`）
- [x] 最终写回只接受 `ah32.plan.v1`（后端 schema：`src/ah32/plan/schema.py`；前端提取/提示：`ah32-ui-next/src/stores/chat.ts`）

---

## 2) Phase 2-4：已落地的确定性 tools（以“种子包”为准）

> 种子包：`installer/assets/user-docs/skills/`（后端启动会 seed 到用户目录；不会覆盖用户已存在目录）。

| # | skill_id | tool（对外） | 状态 | 代码位置 |
|---:|---|---|---|---|
| 1 | exam-answering | fill_blank_detector | ✅ 已实现 | `installer/assets/user-docs/skills/exam-answering/scripts/fill_blank_detector.py` |
| 2 | exam-answering | question_parser | ✅ 已实现 | `installer/assets/user-docs/skills/exam-answering/scripts/question_parser.py` |
| 3 | exam-answering | answer_formatter | ✅ 已实现 | `installer/assets/user-docs/skills/exam-answering/scripts/answer_formatter.py` |
| 4 | bidding-helper | generate_timeline | ✅ 已实现 | `installer/assets/user-docs/skills/bidding-helper/scripts/generate_timeline.py` |
| 5 | bidding-helper | check_compliance | ✅ 已实现 | `installer/assets/user-docs/skills/bidding-helper/scripts/check_compliance.py` |
| 6 | bidding-helper | generate_checklist | ✅ 已实现 | `installer/assets/user-docs/skills/bidding-helper/scripts/generate_checklist.py` |
| 7 | wpp-outline | recommend_layout | ✅ 已实现 | `installer/assets/user-docs/skills/wpp-outline/scripts/recommend_layout.py` |
| 8 | wpp-outline | get_placeholder_map | ✅ 已实现 | `installer/assets/user-docs/skills/wpp-outline/scripts/get_placeholder_map.py` |
| 9 | ppt-outline | layout_recommender | ✅ 已实现（基础版） | `installer/assets/user-docs/skills/ppt-outline/scripts/layout_recommender.py` |
| 10 | ppt-outline | placeholder_mapper | ✅ 已实现（基础版） | `installer/assets/user-docs/skills/ppt-outline/scripts/placeholder_mapper.py` |

---

## 3) Phase 5：落地 tools（12 个；按 `docs/requirements_skills.md` 归类）

> 说明：这里的“tool 名称”以需求文档为准；落地时可根据实际 seed skill 的命名规范调整，但需同步更新 `skill.json` + `SYSTEM.*`。

### answer-mode（×3）
- [x] placeholder_detector（括号/方括号/下划线/横线占位符检测）`installer/assets/user-docs/skills/answer-mode/scripts/placeholder_detector.py`
- [x] position_calculator（题号锚点 + 占位符位置计算 + marker 检测）`installer/assets/user-docs/skills/answer-mode/scripts/position_calculator.py`
- [x] answer_writer（生成 `answer_mode_apply` 的 Plan JSON）`installer/assets/user-docs/skills/answer-mode/scripts/answer_writer.py`

### contract-review（×2）
- [x] clause_extractor（核心条款提取）`installer/assets/user-docs/skills/contract-review/scripts/clause_extractor.py`
- [x] risk_detector（风险词/风险信号检测）`installer/assets/user-docs/skills/contract-review/scripts/risk_detector.py`

### finance-audit（×2）
- [x] data_parser（表格/CSV/TSV/Markdown 表格解析）`installer/assets/user-docs/skills/finance-audit/scripts/data_parser.py`
- [x] anomaly_detector（负数/零值/离群/大额异常检测）`installer/assets/user-docs/skills/finance-audit/scripts/anomaly_detector.py`

### meeting-minutes（×2）
- [x] speaker_extractor（发言人提取）`installer/assets/user-docs/skills/meeting-minutes/scripts/speaker_extractor.py`
- [x] decision_detector（决议/结论检测）`installer/assets/user-docs/skills/meeting-minutes/scripts/decision_detector.py`

### policy-format（×2）
- [x] numbering_checker（编号层级校验/连续性问题）`installer/assets/user-docs/skills/policy-format/scripts/numbering_checker.py`
- [x] terminology_checker（术语一致性/是否定义检查）`installer/assets/user-docs/skills/policy-format/scripts/terminology_checker.py`

### ppt-review（×1）
- [x] consistency_checker（口径/术语/指标一致性检查）`installer/assets/user-docs/skills/ppt-review/scripts/consistency_checker.py`

---

## 4) 内置 10 个业务技能（种子包目录）

- `installer/assets/user-docs/skills/answer-mode/`
- `installer/assets/user-docs/skills/bidding-helper/`
- `installer/assets/user-docs/skills/contract-review/`
- `installer/assets/user-docs/skills/exam-answering/`
- `installer/assets/user-docs/skills/finance-audit/`
- `installer/assets/user-docs/skills/meeting-minutes/`
- `installer/assets/user-docs/skills/policy-format/`
- `installer/assets/user-docs/skills/ppt-outline/`
- `installer/assets/user-docs/skills/ppt-review/`
- `installer/assets/user-docs/skills/wpp-outline/`
