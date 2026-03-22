# 宏基准测试矩阵：发改法规〔2026〕195号

本文档把《国家发展改革委等部门关于加快招标投标领域人工智能推广应用的实施意见（发改法规〔2026〕195号）》中的 20 个场景，映射到当前仓库中的宏基准测试设计。目标不是写一份需求摘要，而是明确：

- 每条政策场景由哪个 `story/turn` 覆盖
- 使用哪个宿主（`wps / et / wpp`）
- 当前是写回型、表格型还是文本问答型
- 后续真实跑测时该从哪里开始修程序

## 覆盖总览

| 政策编号 | 场景 | 宏基准 story | 宿主 | 交付类型 |
|---|---|---|---|---|
| 1 | 招标策划 | `bidding-helper:wps:policy_tender_v1 / t1_tender_planning` | wps | Writer 写回 |
| 2 | 招标文件编制 | `bidding-helper:wps:policy_tender_v1 / t2_tender_file_draft` | wps | Writer 写回 |
| 3 | 招标文件检测 | `bidding-helper:wps:policy_tender_v1 / t3_tender_file_check` | wps | Writer 写回 |
| 4 | 投标策划 | `bidding-helper:wps:policy_bid_v1 / t1_bid_planning` | wps | Writer 写回 |
| 5 | 投标合规自查 | `bidding-helper:wps:policy_bid_v1 / t2_bid_compliance` | wps | Writer 写回 |
| 6 | 开标 | `bidding-helper:et:policy_open_eval_v1 / t1_opening_flow` | et | ET 表格 |
| 7 | 专家抽取 | `bidding-helper:et:policy_open_eval_v1 / t2_expert_draw` | et | ET 表格 |
| 8 | 智能辅助评标 | `bidding-helper:et:policy_open_eval_v1 / t3_ai_eval` | et | ET 表格 |
| 9 | 评标报告核验 | `bidding-helper:wps:policy_award_v1 / t1_report_verify` | wps | Writer 写回 |
| 10 | 辅助定标决策 | `bidding-helper:wps:policy_award_v1 / t2_award_decision` | wps | Writer 写回 |
| 11 | 中标合同签订 | `bidding-helper:wps:policy_award_v1 / t3_contract_sign` | wps | Writer 写回 |
| 12 | 场所调度 | `bidding-helper:et:policy_onsite_v1 / t1_venue_dispatch` | et | ET 表格 |
| 13 | 见证管理 | `bidding-helper:et:policy_onsite_v1 / t2_witness_management` | et | ET 表格 |
| 14 | 档案管理 | `bidding-helper:et:policy_onsite_v1 / t3_archive_management` | et | ET 表格 |
| 15 | 智慧问答 | `bidding-helper:wps:policy_qa_v1 / t1_qa_engine` | wps | 文本问答 |
| 16 | 专家管理 | `bidding-helper:wps:policy_regulation_v1 / t1_expert_management` | wps | Writer 写回 |
| 17 | 围串标识别 | `bidding-helper:wps:policy_regulation_v1 / t2_collusion_detection` | wps | Writer 写回 |
| 18 | 信用管理 | `bidding-helper:wps:policy_regulation_v1 / t3_credit_management` | wps | Writer 写回 |
| 19 | 协同监管 | `bidding-helper:wps:policy_supervision_v1 / t1_collaborative_supervision` | wps | Writer 写回 |
| 20 | 投诉处理 | `bidding-helper:wps:policy_supervision_v1 / t2_complaint_handling` | wps | Writer 写回 |

## 设计原则

1. 优先做 deterministic bench
   - 本轮政策覆盖先以 `planOverride` / `assistantTextOverride` 为主。
   - 目标是先把政策场景变成稳定可回归的测试基座，再用红灯反推执行器、宿主链路和前后端程序缺陷。

2. 宿主分工
   - `wps`：适合政策分析、清单、矩阵、报告、意见书、风险提示。
   - `et`：适合开标流程、专家抽取、场地调度、见证闭环、档案索引这类结构化台账。
   - `wpp`：当前保留原有投标汇报能力，不作为本轮 20 条政策覆盖主承载宿主。

3. 测试驱动修程序
   - 若某条 story 跑不通，优先追执行器、宿主能力、断言口径和 fixture。
   - 不能用“需求太大”或“缺数据”跳过；缺数据就补 fixture，缺能力就修程序。

## 当前执行顺序建议

1. 先跑 `wps` 文本与 Writer 写回 story
   - 因为反馈最快，最容易先暴露协议、块写回和断言问题。

2. 再跑 `et` 结构化台账 story
   - 开标、抽取、现场管理依赖表格写入与格式断言，更适合第二阶段集中修。

3. 最后把通过项收进专项套跑入口
   - 建议新增 `bidding-helper` 专项 suite-set，而不是只挂在当前通用 14 条主回归里。

## 后续补强方向

1. 为每个政策 story 增加真实 fixture
   - 招标文件节选
   - 投标文件节选
   - 评标报告样本
   - 投诉书样本

2. 将部分 deterministic story 升级为模型驱动回归
   - 先有稳定基座，再逐步替换为真实模型生成，避免一开始就被随机性打散。

3. 增加专项套跑入口
   - 目标：`bidding-helper-policy` 单独跑，单独看红绿，不被其他业务线噪音淹没。
