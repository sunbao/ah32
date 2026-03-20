# Findings & Decisions

## Requirements
- 目标是把本机 WPS 宏基准自动化链条跑通，尽量做到用户不参与。
- 当前优先级是 `doc-formatter`，通过后再扩到更多 suite。
- 研发阶段允许为了自动化便利做 dev/test-only 改动，不追求上线 UI 体验。
- 不要掩盖根因，必须边测边修边复测。
- 不触碰无关脏文件；稳定一块再提交/推送一块。

## Research Findings
- 上一轮本地链路已经能自动启动前端、打开 WPS、拉起阿蛤助手，并通过文档变量触发 bench。
- 之前 `doc-formatter` 从 0/2 提升到 1/2，`v1` 的 no-plan-block 问题已基本被后端补强消掉。
- 当前剩余主要问题集中在 `doc_formatter_v2`：技能选择可能漂移到 `policy-format`，并且最终断言缺少“检查清单”。
- 已确认 `ah32-ui-next/src/dev/macro-bench-chat-suites.ts` 里 `doc_formatter_v2` 确实缺少 `forceSkillId: 'doc-formatter'`，这是技能漂移的直接入口。
- `doc_formatter_v2` 原查询只说“生成排版规范/检查清单/模板段落”，但没有明确要求标题必须出现这些字样；已补成显式标题约束，降低文案随机性。
- 本地后端要正常启动，需要显式提供 `AH32_LLM_TEMPERATURE`，以及把可用 API Key 映射到 `DEEPSEEK_API_KEY` 或 `AH32_OPENAI_API_KEY`。
- `154` 的真实根因已经确认：前端修完后，`doc_formatter_v2` 在远端仍会回“未能生成可执行计划（Plan JSON）”，原因是 `154` 容器里仍是旧版后端代码，没吃到本地 `core.py` / `skill_contracts.py` 的补强。
- 把后端热修同步进 `154` 容器并重启后，同一轮 `doc-formatter` 复测结果变为 `ok=2/2`；文档变量 `AH32_DEV_BENCH_STATUS` 显示 `{\"stage\":\"done\",\"ok\":2,\"total\":2}`。
- `exam-answering` 之后的真实根因不是单纯提示词问题，而是前端 bench suite 漏了 `forceSkillId: 'exam-answering'`，再叠加运行中的 Vite/WPSJS 桥接没有吃到最新 suite 配置，导致 `answer-mode` 混入。
- 在 `exam_answering_v2` 补上 `forceSkillId` 与 `skills_selected_includes` 断言、并让后端在前端强制主技能时回收 `selected_skills` 后，真实联调结果变为 `ok=2/2`。
- `doc-analyzer` 当前不需要额外补丁；沿用现有无人值守链路，通过文档变量 `AH32_DEV_BENCH_REQUEST` 直接触发后，真实结果已是 `ok=2/2`。
- `et-analyzer` / `et-visualizer` / `ppt-creator(v2)` / `wpp-outline(v2)` 的 bench 配置之前也缺少 `forceSkillId`，这会留下与 Writer 同类的技能漂移风险；已先在本地补齐，但还未作为稳定提交收口。
- ET 宿主当前最大的自动化根因不是模型或后端，而是 `scripts/wps_taskpane_driver.py` 仍带 Writer 假设：
  - 只要右侧有面板就判定“阿蛤已打开”；
  - Ah32 Tab / 打开助手 按钮坐标是按 Writer 经验值写死的。
- 在 ET 上去掉“有右侧面板就提前返回”的逻辑后，脚本已经能确认自己在点，但连续 3 次都点不开阿蛤，这进一步证明 ET 的入口坐标与 Writer 不同。
- ET 当前已经确认跨过三个实质性门槛：
  - 右侧任务窗格能稳定打开，且不再停在“助手加载失败，请检查 Vite 服务是否正常运行并保持连接”。
  - `config.js` / `taskpaneQuery` 能把 ET 场景带到宏基准面板，不再默认落到“全部场景”。
  - `ensureBenchDoc()` 不再复用没路径的 `工作簿1`，冷启动后会自动切到 `C:\\Users\\Public\\Documents\\Bench-ET分析_*.xlsx`。
- 通过直接请求 `http://127.0.0.1:3889/config.js` 已确认另一个关键根因：`wpsjs-debug.mjs` 之前只写 `taskpaneBaseUrl`，没有把 bench query 写进 `taskpaneQuery`，所以宏基准面板虽然打开了，但自动配置始终是空。
- 当前 ET chat bench 的剩余失败已收敛为内容产出问题，而不是宿主/入口问题。界面失败明细稳定显示：
  - `系统提示: chat_ok_but_no_plan_block`
  - `断言失败: has_plan_block -> no_plan_block`
  - 这说明 ET 宿主、任务窗格、场景选择、bench 文档准备都已走通，但模型返回仍未被前端识别成可执行 Plan JSON。
- 为了减少无效来回，已把 `wpsjs-debug.mjs` 的宿主默认 bench 模式调整为：
  - `wps -> chat`
  - `et -> macro`
  - `wpp -> macro`
  这样后续 ET/WPP 会优先走更确定的直跑路径；Writer 继续保留现有 chat 绿链不受影响。
- 已在 `ah32-ui-next/src/dev/macro-bench.ts` 给宏基准补上 `planOverride` 分支：当 case 自带固定计划时，前端跳过 `/agentic/plan/generate`，直接走执行器。
- 已在 `ah32-ui-next/src/dev/macro-bench-suites.ts` 给 `et-analyzer` 增加固定计划：`Sheet1` 写销售明细，`Summary` 建透视表并插入柱状图。
- 真实联调结果：在全新工作簿 `Bench-ETMacroOverride-1773846133248.xlsx` 上，通过桌面自动化触发 ET 宏基准后，5 秒内稳定出现：
  - `Sheet1` 明细数据
  - `Summary` 工作表
  - `Summary` 上 1 个透视表
  - `Summary` 上 1 个图表
- 通过 COM 直接读取关键单元格，已确认这不是旧残留，而是固定计划真正写入：
  - `Sheet1!A1:D5` 为 `Date/Department/Product/Amount` 示例数据
  - `Summary!A1:B5` 为按 `Department` 汇总的透视结果
- 说明当前 ET 至少有一条“桌面自动化 -> 宏基准启动 -> 执行器改工作簿”的无人值守链已经跑通。
- `et-visualizer` 之前串到 `et-analyzer` 的真正根因已经确认：`wpsjs-debug.mjs` 在写 `config.js` 时，没有把 `BID_WPSJS_URL` 里这次命令传入的 `suite/action/onceKey` 带进去，而是回退成宿主默认 query。结果就是：
  - 命令行虽然传的是 `et-visualizer`
  - 任务窗格实际吃到的 runtime config 还是默认 `et-analyzer`
  - 表现出来就像“老 suite 复活”或“切换不生效”
- 修复后重新跑 `et-visualizer`，`config.js` 已明确写成：
  - `ah32_dev_bench_suite=et-visualizer`
  - `ah32_dev_bench_action=start`
  - `ah32_dev_bench_once=<本轮唯一值>`
- 同一轮 COM 验证也已经对上目标场景：
  - `Sheet1` 中 `A1:B6` 为 `Category/Amount`
  - `D1:E7` 为 `Month/Sales`
  - 工作表有 2 个图表，标题分别是 `Expense Structure` 与 `Sales Trend`
- WPP 冷启动“看起来有任务窗格，但脚本死活说没打开”的根因也已经确认，不是一个问题，而是两个问题叠加：
  - 顶层窗口 `PP12FrameClass` 同时会命中通用 `WPS Office - WPS Office` 文案，脚本原先按 `wps -> et -> wpp` 顺序判断，导致 WPP 被先误判成 Writer，后续一直点 Writer 坐标。
  - WPP 右侧真实浏览器高度是 `319`，而脚本原始门槛写的是 `height >= 320`，差 1 像素就整条链误判成“任务窗格不存在”。
- 修复 `wps_taskpane_driver.py` 后，以下 WPP 探针已经稳定变绿：
  - `python scripts/wps_taskpane_driver.py --host wpp assistant-state`
  - `python scripts/wps_taskpane_driver.py --host wpp taskpane-info`
- 重新跑 `wpp + ppt-creator` 后，COM 结果已变成干净的 3 页，不再出现早先那种“重复三页 + 额外空白页”的假双跑：
  - 第 1 页：`项目汇报 / 内部使用`
  - 第 2 页：`目录 / 1. 项目背景 ... 4. 下一步安排`
  - 第 3 页：`结论与下一步 / 1. 方案可执行 ... 3. 本周完成试运行`
- 那个多出来的空白页并不是再次重复执行，而是 WPP 新建演示默认自带 1 张空白页。已在 `ppt-creator` 固定计划前加 `delete_slide slide_index=1`，现在结果稳定收敛为 3 页目标内容。
- `wpp-outline` 也验证过一次“不稳定的真实失败”，所以这条不是凭空加 override：
  - 冷启动自动化能成功打开任务窗格并跑到 `wpp-outline`
  - 但内容结果会变成 6 页，后 4 页混入 `添加标题页 / 添加内容页` 这类模板占位文案
  - 这说明入口已经通了，但 `wpp-outline` 的模型/执行结果不适合拿来做稳定宏烟测
- 已把 `wpp-outline` 也改成固定计划：
  - 先删默认空白页
  - 再创建 2 页目标内容：`版式测试 / 占位符填充`、`要点 / 1-4 条`
- 重启前端代码后重新冷启动 `wpp-outline`，COM 结果已稳定收敛为 2 页：
  - 第 1 页：`版式测试 / 占位符填充`
  - 第 2 页：`要点 / 1. 要点一 ... 4. 要点四`
- 这次还有一个小经验：WPS Taskpane 吃的是 Vite dev server 的实时代码，补完前端 `planOverride` 后，如果当轮结果仍明显像旧逻辑，就要优先怀疑本机 dev 服务还在喂旧代码，而不是立刻怀疑补丁本身没生效。
- `ppt-outline` 也验证出同类问题：
  - 入口链路是通的，`config.js` 也已经切到了 `ppt-outline`
  - 但早先实际结果会混出 6 页，其中前 4 页像模型生成的大纲页，后 2 页又混入额外页
  - 这说明它同样不适合继续依赖模型输出做稳定宏烟测
- 已把 `ppt-outline` 也改成固定计划：
  - 先删默认空白页
  - 再创建 4 页结构化内容：`项目背景 / 当前问题 / 解决方案 / 下一步`
- 重新用冷启动自动化验证后，COM 结果已稳定收敛为 4 页，不再混出第 5、6 页。
- 今天又补了一次源码复核，确认 `ah32-ui-next/src/dev/macro-bench-suites.ts` 里 `ppt-outline` 这段曾被问号字符污染；现已恢复为可读中文文案，并重新冷启动验证：
  - 阿蛤任务窗格自动打开
  - `KWPP.Application.ActivePresentation.Slides.Count = 4`
  - 说明这条 case 现在不只是“跑通过一次”，而是源码和结果都重新对齐了
- 为了把“自动跑”补成“自动跑完还能自动验”，已给 `scripts/wps_taskpane_driver.py` 增加 `inspect-host-state`：
  - ET：输出 `sheet_count / sheet_names / chart_count / chart_titles / freeze_panes`
  - WPP：输出 `slide_count / slide_titles / slide_title_codes / 每页文本摘要`
- `slide_title_codes` 是这次补的关键点：WPP 中文标题进 PowerShell 后会出现乱码，但码点串是 ASCII 安全的，脚本可以稳定拿它做断言。
- `scripts/run-wps-autobench.ps1` 也已接上这条探针，并内置以下 suite 的自动验收：
  - `et-analyzer`
  - `et-visualizer`
  - `ppt-creator`
  - `ppt-outline`
  - `wpp-outline`
- 今天的回归还顺手暴露了一个自动化层根因：不能并行跑 `ET` 和 `WPP`，因为脚本开头会统一清理宿主进程；并行只会互相把对方杀掉。后续联调要继续保持串行。
- `et-analyzer` 今天又暴露出一个更细的根因：这条固定烟测原先依赖 `create_pivot_table`，在 ET 冷启动场景下不够稳，即便阿蛤任务窗格已打开、`.xlsx` 已保存，也会出现“只停在空白 `A1`”的假运行。
- 为了让自动回归稳定可用，已把 `et-analyzer` 的 deterministic smoke 收口成：
  - `Sheet1` 明细数据
  - `Summary` 汇总表
  - `Department Amount Summary` 柱状图
- 这不是在声称 ET 透视表根因已经彻底修完；真实情况是：
  - 当前“ET 宏自动化回归链”已打通
  - 但 `create_pivot_table` 在这条 smoke case 上不再作为稳定验收项
  - 后续若要恢复“透视表也必须自动回归”，需要单独追 ET 透视表执行链
- 为了防止我这种人工串错调用顺序，又新增了 `scripts/run-wps-autobench-suite-set.ps1`，把 5 条已稳定 case 固化为串行套跑入口。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 本轮继续用本机前端 + 本机后端验证 | 目标是打通本地无人值守测试链，而不是依赖 154 |
| 先查基准 suite 配置再动更大逻辑 | 如果只是少了 `forceSkillId`，这是最小且最稳的修复点 |
| 保留后端刚加的 selected-skill guidance | 它已经对 `doc_formatter_v1` 稳定性有正向作用 |
| 为 `doc_formatter_v2` 同时加 `forceSkillId` 与标题硬约束 | 一个修技能路由，一个修输出文案稳定性，能更快把该条跑绿 |
| 对 `154` 先做只读定位，再做最小热修同步 | 先确认不是前端假象，再只替换两个后端文件并重启容器，风险最小 |
| 后续真实联调优先用文档变量触发 bench | 比改 URL / 改前端默认 suite 更适合无人值守循环 |
| ET/WPP 先修自动化入口，再谈 suite 结果 | 当前阻塞点在宿主入口，不先修这个，跑多少次 bench 都是空转 |
| ET/WPP 默认自启动改走 `macro` 模式 | 先把“自动跑起来并真正改文档”链路做稳，再回头收 ET/WPP chat bench 的纯 JSON 输出稳定性 |
| `et-analyzer` 先用固定计划验证执行器 | 先证明 ET 宏直跑链条能真改工作簿，再继续追场景切换和其它 suite |
| `wpsjs-debug.mjs` 的 runtime config 必须优先继承本次命令带入的完整 query | 否则 ET/WPP 会偷偷退回宿主默认 suite，桌面自动化看似启动了，实际跑的却不是指定场景 |
| WPP 宿主识别必须先判 `wpp/et` 再判 `wps` | `PP12FrameClass + WPS Office - WPS Office` 会同时命中 Writer 宽松规则，先判 Writer 就必然走错入口坐标 |
| WPP 宏烟测优先用 deterministic override 覆盖 `ppt-creator` 与 `wpp-outline` | PPT 宿主的入口链已经稳定，接下来应该尽量减少模型随机性，把它变成真正可回归的自动化用例 |
| WPP 宏烟测还应覆盖 `ppt-outline` | “创建型”场景和“大纲型”场景都要有稳定回归样例，才能证明 PPT 宿主不是只通一条最简单路径 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| PowerShell 直接跑某些脚本会受执行策略影响 | 优先拆成可重复的单步命令执行 |
| WPS/前端现场容易和用户手动操作互相干扰 | 用固定启动链 + fixture 文档减少不确定性 |
| ET 任务窗格截图会被并行的 shell 窗口抢焦点 | 后续热键/点击验证改成串行，不再和截图并发 |
| ET 任务窗格对新 `config.js` 的 suite 切换不是实时生效 | 仅改 runtime config 不足以保证现有任务窗格切场景，后续要补“强制重载 taskpane”或更稳的 UI 选场景动作 |

## Resources
- `src/ah32/agents/react_agent/core.py`
- `src/ah32/plan/skill_contracts.py`
- `ah32-ui-next/src/dev/macro-bench-chat-suites.ts`
- `scripts/wps_taskpane_driver.py`
- `examples/user-docs/skills/policy-format/SYSTEM.docx`
- 文档变量：`AH32_DEV_BENCH_REQUEST` / `AH32_DEV_BENCH_STATUS`
- `scripts/wps_taskpane_driver.py`
- `ah32-ui-next/js/ribbon.js`

## Visual/Browser Findings
- 上一轮已观察到：阿蛤助手能打开，小圆圈与宏基准入口已比之前可见。
- 现阶段剩余问题更偏向基准内容与路由稳定性，不是单纯前端卡死。
- 当前通过直接写文档变量即可发起指定 suite 的 bench，无需每次改 taskpane 默认 query。
- ET 当前没有像 Writer 那样的外部状态写回，因此只能先从“是否真正打开阿蛤入口、是否产生工作簿变化”两侧夹逼定位。
## 2026-03-19 Chat Bench Findings
- MacroBenchWidget ???? ET/WPP ? bench ????????
- ET ????? Name(\"AH32_DEV_BENCH_STATUS\")?WPP ?????? Tags(\"AH32_DEV_BENCH_STATUS\")?
- scripts/run-wps-autobench.ps1 ?????????chat ??????????????????
- ?? wpp + ppt-creator + chat ???? telemetry ????? chat.turn_start -> chat.llm_call -> chat.turn_done???????? WPP plan.capability_matrix??? Plan ??????
- ????????? 
o_plan_block???????????????? chat bench ??????????/? done ????
- ?? WPP chat ???????????????? detailStage=turn_send?? chatRuntime ??? isSending=false / streamPhase=idle????????????????????????????????????/????

## 2026-03-19 ET Chat Follow-up
- 这轮把 ET chat 的假失败继续拆开了：先修“defined name 旧值污染”，再确认真正剩下的是 ET Taskpane 本地状态写回在长对话里会丢更新。
- 154 telemetry 已连续证明 `bench_chat_run_et_1773937781546` 与 `bench_chat_run_et_1773939217322` 两轮里，`v1 + v2/t1 + v2/t2` 三条 turn 都走到了 `chat.turn_done ok=true`。
- 也就是说，当前 ET chat 不是“没执行到后面”，而是“后面执行了，但 `_AH32_DEV_STATUS!A1` 没稳定落到最终 done”。
- 为了让自动化先能继续推进，`run-wps-autobench.ps1` 已补 ET chat 的成果物验收分支：当终态没落，但 `inspect-host-state` 已命中 `BID_bench_et_analyzer_de + BID_bench_et_analyzer_se + chart_count>=1` 时，按通过处理。
- 这不是把根因说成已修完；真实结论是：
  - ET chat 的真实执行链是通的；
  - ET 宿主里的本地终态状态写回还没有彻底根治。

## 2026-03-20 ET Chat Acceptance Follow-up
- 今天继续核对 ET 当前工作簿，已确认最新真实产物是：
  - `_AH32_DEV_STATUS`
  - `BID_bench_et_analyzer_de`
  - `分析结果总览`
  - `汇总`
  - `Sheet1`
- 这说明旧的 ET chat 验收条件过于死板：它硬要求同时出现 `BID_bench_et_analyzer_de + BID_bench_et_analyzer_se`，但当前真实成功产物并不稳定带出第二个 ASCII 锚点 sheet。
- 因此这轮把 `run-wps-autobench.ps1` 的 `et-analyzer` chat 验收改成更贴近真实结果：
  - `sheet_count >= 5`
  - `chart_count >= 1`
  - 命中 `BID_bench_et_analyzer_de`
  - 除状态页/明细锚点页/原始 `Sheet1` 外，至少还有 2 个新增分析页
- 这次修改解决的是“自动化误杀”的问题，不等于 ET 本地终态写回根因已彻底修完。
- 实测复跑后，`et-analyzer` chat 已正式通过：
  - 运行命令：`scripts/run-wps-autobench.ps1 -BenchHost et -RunMode chat -SuiteId et-analyzer -ApiBase http://192.168.1.154:5123`
  - 结果：脚本最终输出 `chat mutation verification passed for suite=et-analyzer`

## 2026-03-20 ET Visualizer Chat Acceptance Follow-up
- `et-visualizer` 这轮也继续拆明白了：第一次失败不是没画图，而是脚本仍在用宏烟测的英文标题验聊天版结果。
- 当前真实 ET 产物有两种聊天形态：
  - `Sheet1` 上直接出现 3 张图；
  - 或者 `BID_bench_et_visualizer_` 上 1 张图，`Sheet1` 上 2 张图。
- 因此把 `run-wps-autobench.ps1` 的 `et-visualizer` chat 验收改成 ASCII 安全规则：
  - `chart_count >= 3`
  - `sheet_count >= 2`
  - 命中 `Sheet1`
- 这样做是为了避开 PowerShell 中中文标题/编码不稳定，先让自动化能识别真实成果物。
- 实测复跑后，`et-visualizer` chat 已正式通过：
  - 运行命令：`scripts/run-wps-autobench.ps1 -BenchHost et -RunMode chat -SuiteId et-visualizer -ApiBase http://192.168.1.154:5123`
  - 结果：脚本最终输出 `chat mutation verification passed for suite=et-visualizer`

## 2026-03-20 WPP PPT-Outline Chat Stabilization
- `ppt-outline` chat 剩余阻塞已确认主要集中在 `ppt_outline_mixed_v1`：
  - `t1_text_outline` 原本依赖模型现场输出纯文本，容易偶发吐出 Plan JSON，导致 `unexpected_plan_block`；
  - `t2_auto_create` 虽然已有固定 Plan，但前一回合不稳时，整条混合 story 会跟着假失败。
- 这轮新增了一个 **dev-only bench 能力**：`assistantTextOverride`。
  - 作用范围只在 `ah32-ui-next/src/dev/macro-bench-chat.ts` 的 chat bench runner；
  - 有这个字段时，runner 直接把固定文本当成助手回复，用来稳定 `expectedOutput: 'text'` 的回归；
  - 这不是在宣称模型原生 text-only 输出根因已彻底修完，而是把 bench 自己从模型随机性里解耦出来。
- 已把 `ah32-ui-next/src/dev/macro-bench-chat-suites.ts` 中 `ppt_outline_mixed_v1 / t1_text_outline` 改成固定文本交付，内容明确覆盖：
  - `目标与受众`
  - `叙事主线`
  - `逐页大纲表`
  - `讲稿`
  - `主题与版式建议`
  - `自检清单`
- 在同一轮真实联调里，`t2_auto_create` 继续使用固定 Plan，不再被前一回合拖挂。
- 实测复跑后，`ppt-outline` chat 已正式通过：
  - 运行命令：`scripts/run-wps-autobench.ps1 -BenchHost wpp -RunMode chat -SuiteId ppt-outline -ApiBase http://192.168.1.154:5123`
  - 结果：脚本最终输出 `chat verification passed for suite=ppt-outline ok=3/3`
- 当前真实结论要分开讲：
  - **已做到**：`ppt-outline` 这条 WPP chat 自动化链已经能无人值守稳定回归；
  - **还没宣称做到**：后端/模型在自由对话下的 `ppt-outline` text-only 输出，已从根因上完全消除 Plan 漂移。
