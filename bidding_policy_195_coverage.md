# 发改法规〔2026〕195号 宏基准覆盖矩阵

## 说明
- 这份清单只管“宏基准是否有对应 story 和可验收交付”，不等于自由模型生成已经全部根治。
- 当前 `bidding-helper` 采用三类覆盖方式：
  - `Writer`：适合验证制度、清单、报告、矩阵、意见书等块级交付。
  - `ET`：适合验证流程台账、抽取方案、监管表、档案索引等结构化表格交付。
  - `WPP`：适合验证投标汇报类演示文稿交付。
- 真实自动化已验证跑绿的重点深测项：
  - `policy_tender_live_v1`
  - `policy_bid_live_v1`
  - `policy_complaint_live_v1`

## 覆盖矩阵
| 条款 | 政策场景 | Story | Host | Turn / 交付 | 当前状态 |
|---|---|---|---|---|---|
| 1 | 招标策划 | `policy_tender_v1` | `wps` | `t1_tender_planning / 招标策划简报` | 已覆盖 |
| 2 | 招标文件编制 | `policy_tender_v1` | `wps` | `t2_tender_file_draft / 招标文件编制建议` | 已覆盖 |
| 3 | 招标文件检测 | `policy_tender_v1` + `policy_tender_live_v1` | `wps` | `t3_tender_file_check / 招标文件体检问题清单` + `t1_tender_detection_live / 招标文件检测报告块（真实材料）` | 已覆盖，含真实材料深测 |
| 4 | 投标策划 | `policy_bid_v1` | `wps` | `t1_bid_planning / 投标策划图谱` | 已覆盖 |
| 5 | 投标合规自查 | `policy_bid_v1` + `policy_bid_live_v1` | `wps` | `t2_bid_compliance / 投标合规自查矩阵` + `t1_bid_compliance_live / 投标响应自查矩阵（真实材料）` | 已覆盖，含真实材料深测 |
| 6 | 开标 | `policy_open_eval_v1` | `et` | `t1_opening_flow / 数字开标流程台账` | 已覆盖 |
| 7 | 专家抽取 | `policy_open_eval_v1` | `et` | `t2_expert_draw / 专家抽取方案表` | 已覆盖 |
| 8 | 智能辅助评标 | `policy_open_eval_v1` | `et` | `t3_ai_eval / 智能辅助评标指标表` | 已覆盖 |
| 9 | 评标报告核验 | `policy_award_v1` | `wps` | `t1_report_verify / 评标报告核验清单` | 已覆盖 |
| 10 | 辅助定标决策 | `policy_award_v1` | `wps` | `t2_award_decision / 辅助定标比选表` | 已覆盖 |
| 11 | 中标合同签订 | `policy_award_v1` | `wps` | `t3_contract_sign / 中标合同签约要素与风险提示` | 已覆盖 |
| 12 | 场所调度 | `policy_onsite_v1` | `et` | `t1_venue_dispatch / 场所调度表` | 已覆盖 |
| 13 | 见证管理 | `policy_onsite_v1` | `et` | `t2_witness_management / 见证管理闭环表` | 已覆盖 |
| 14 | 档案管理 | `policy_onsite_v1` | `et` | `t3_archive_management / 档案索引与摘要表` | 已覆盖 |
| 15 | 智慧问答 | `policy_qa_v1` | `wps` | `t1_qa_engine / 招投标智慧问答（不写回）` | 已覆盖 |
| 16 | 专家管理 | `policy_regulation_v1` | `wps` | `t1_expert_management / 专家全生命周期画像` | 已覆盖 |
| 17 | 围串标识别 | `policy_regulation_v1` | `wps` | `t2_collusion_detection / 围串标预警线索表` | 已覆盖 |
| 18 | 信用管理 | `policy_regulation_v1` | `wps` | `t3_credit_management / 招投标信用管理台账` | 已覆盖 |
| 19 | 协同监管 | `policy_supervision_v1` | `wps` | `t1_collaborative_supervision / 协同监管预警清单` | 已覆盖 |
| 20 | 投诉处理 | `policy_supervision_v1` + `policy_complaint_live_v1` | `wps` | `t2_complaint_handling / 投诉处理初审意见` + `t1_complaint_handling_live / 投诉处理初审意见（真实材料）` | 已覆盖，含真实材料深测 |

## 现阶段结论
- 从 story 维度看，20 条政策场景已经都有对应宏基准入口。
- 从稳定回归维度看，深测优先收口在第 3、5、20 条，因为这三条最接近真实客户材料处理链路。
- 从“是否已经彻底根治自由生成”这个维度看，还不能一概而论；当前先保证宏基准能稳定自动跑、稳定发现回归。
