## 1. Spec & Prompt Alignment

- [x] 1.1 校验 `rag-missing-library-guidance` spec 覆盖招投标“合同库/案例库/模板库”等缺库反馈口径（不预设内置数据）
- [x] 1.2 校验 `source-display-policy` spec 覆盖“默认不展示、用户要求才展示、用户要求隐藏必须隐藏”（正文+写回一致）
- [x] 1.3 校验 `rag-url-ingest` spec 覆盖“项目上下文判定+fallback、正文抽取质量门槛、长度截断与元数据记录”

## 2. Core/Agent Plumbing（机制而非业务）

- [x] 2.1 在 skill manifest 中加入并解析 capability：`rag_missing_hint`（或等价字段），并在路由/编排中可感知
- [x] 2.2 在 core 生成 RAG 上下文时：仅当启用该 capability 的 skill 被选中且 RAG 0 命中时，注入“缺库提示信号”
- [x] 2.3 调整 core 的来源展示策略提示词：默认不输出 source/URL；仅当用户明确要求出处/链接时输出
- [x] 2.4 写回（Plan JSON 输出）路径同样遵守来源展示策略，避免 source 破坏排版

## 3. Skill Behavior（招投标技能落地）

- [x] 3.1 更新招投标技能（如 `bidding-helper`）SYSTEM：强制执行缺库反馈 + 补库操作指引（上传/导入、URL 抓取）与抓取失败兜底（粘贴纯文本/上传文件，暂不支持图片）
- [x] 3.2 在技能内实现“来源展示策略”分支：默认不展示；用户明确要出处时在正文末尾独立段落展示
- [x] 3.3 明确仅使用向量检索；不引入关键词检索兜底（缺库时走补库闭环）

## 4. URL → 抓取 → 入库 → 项目可检索（端到端闭环）

- [x] 4.1 提供技能工具 `ingest_url_to_rag`：输入 URL，使用浏览器控制层抓取正文并提取文本
- [x] 4.2 为抓取失败提供可诊断错误类型（不可达/超时/验证码/登录/正文为空）并记录日志（含 trace_id）
- [x] 4.3 实现正文清洗+质量门槛（去空白<500视为正文为空）+ 超长截断（<=200,000 字符）并记录元数据
- [x] 4.4 把抓取结果通过 RAG API 导入向量库（upload-text），按 spec 执行 scope 默认规则与 `project_context_missing` fallback
- [x] 4.5 端到端回归：入库后同一项目对话向量检索可命中；失败时提示粘贴纯文本/上传文件

## 5. Validation

- [x] 5.1 添加/更新单元测试：capability gating（缺库提示仅在技能启用时触发）
- [x] 5.2 添加/更新单元测试：来源展示默认隐藏，用户要求时才展示（正文与写回）
- [x] 5.3 添加/更新单元测试：URL 入库 scope 默认/项目上下文 fallback + 正文长度截断与元数据
- [x] 5.4 手工验证清单：招投标对话里 RAG=0 命中提示与补库引导符合 specs；URL 抓取失败兜底可执行
