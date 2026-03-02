# Skills tools 盘点（v1）

范围：`installer/assets/user-docs/skills/**/skill.json` 的 `tools[]` + 对应 `scripts/*.py`（历史方案，现已禁用后端执行）。

结论速览：
- 存在明显“复用”工具：`data_parser` / `anomaly_detector`（`et-analyzer`、`finance-audit`）。
- 存在“同域复用”工具：PPT/WPP 相关的 `layout_recommender` / `placeholder_mapper`（`ppt-outline`、`wpp-outline`）。
- 存在“强能力”脚本：`bidding-helper.ingest_url_to_rag` / `get_latest_policies` 等，建议迁移为后端白名单工具（而非 skill 脚本）。

| skill_id | tools (skill.json) | scripts/*.py |
|---|---|---|
| answer-mode | placeholder_detector,position_calculator,answer_writer | answer_writer.py,placeholder_detector.py,position_calculator.py |
| bidding-helper | generate_timeline,check_compliance,generate_checklist,check_policy_update,get_latest_policies,ingest_url_to_rag | __init__.py,check_compliance.py,check_policy_update.py,compliance_checker.py,generate_checklist.py,generate_timeline.py,get_latest_policies.py,ingest_url_to_rag.py,sedeadline_checklist.py,timeline_generator.py |
| contract-review | clause_extractor,risk_detector | clause_extractor.py,risk_detector.py |
| doc-analyzer | - | - |
| doc-editor | - | - |
| doc-formatter | - | - |
| et-analyzer | data_parser,anomaly_detector | __init__.py,anomaly_detector.py,data_parser.py |
| et-visualizer | - | - |
| exam-answering | fill_blank_detector,question_parser,answer_formatter | __init__.py,answer_formatter.py,fill_blank_detector.py,question_parser.py |
| finance-audit | data_parser,anomaly_detector | anomaly_detector.py,data_parser.py |
| meeting-minutes | speaker_extractor,decision_detector | decision_detector.py,speaker_extractor.py |
| policy-format | numbering_checker,terminology_checker | numbering_checker.py,terminology_checker.py |
| ppt-creator | - | - |
| ppt-outline | layout_recommender,placeholder_mapper | __init__.py,layout_recommender.py,placeholder_mapper.py |
| ppt-review | consistency_checker | consistency_checker.py |
| risk-register | - | - |
| wpp-outline | recommend_layout,get_placeholder_map | __init__.py,get_placeholder_map.py,layout_recommender.py,placeholder_mapper.py,recommend_layout.py |

