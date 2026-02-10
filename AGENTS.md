# 仓库贡献指南



## 项目结构与模块组织



- `src/ah32/`：后端（FastAPI）。对外产品名为 **阿蛤**（AH32），但包路径保留为 `ah32`（历史原因）。

- `src/ah32/dev/`：后端 dev/bench/debug 模块（默认关闭；仅在 `AH32_ENABLE_DEV_ROUTES=true` 时开放 `/dev/*` 路由）。

- `ah32-ui-next/`：前端（Vue 3 + TypeScript + Vite）与 WPS 加载项；构建产物输出到 `ah32-ui-next/wps-plugin/`。

- `tests/`：私有/本地测试（公共仓库不发布；默认忽略）。

- `docs/`：本地开发文档目录（公共仓库不提交/不发布；对外文档请另建私有仓库或 Wiki）。

- 不要提交运行/生成目录：`storage/`、`logs/`、`.venv/`、`ah32-ui-next/node_modules/`、`dist/`、`build/`。



## 构建、测试与本地开发命令



后端（Python 3.11+）：

- 安装依赖：`python -m venv .venv` -> `pip install -e .[dev]` -> `copy .env.example .env`

- 启动服务：`python -m ah32.server.main`（默认 `http://127.0.0.1:5123`）



前端（Node.js 18+）：

- 启动开发：`npm -C ah32-ui-next install` -> `npm -C ah32-ui-next run dev`（Vite 默认 `:3889`）

- WPS 调试：`npm -C ah32-ui-next run wpsjs`（或 `wpsjs:wps/et/wpp/all`）



Windows 便捷命令：

- 一键启动（会写入 `logs/`）：`python start.py`



打包（可选）：

- 前端 WPS 插件包（zip）：`powershell -ExecutionPolicy Bypass -File scripts/package-wps-plugin.ps1`
- 后端（Windows x64）：`powershell -ExecutionPolicy Bypass -File scripts/package-backend.ps1 -Platform windows-x64 -OutDir dist`
- 后端（Linux/macOS）：`bash scripts/package-backend.sh --platform linux-x64 --out-dir dist`（或 `linux-arm64` / `macos-x64` / `macos-arm64`）



## 代码风格与命名约定



- Python：使用 Ruff（见 `pyproject.toml`，`line-length=100`）；CI 基线为 `ruff check src`。

- 前端：保持与 `ah32-ui-next/src/` 现有风格一致；避免引入新的格式化/校验工具链，除非 PR 明确说明。

## 输出与编码（强约束）

- **只输出 Plan JSON**：涉及写回/执行时，默认只产出 `ah32.plan.v1` 的 Plan JSON（严格 JSON、UTF-8）；不要在对话中输出 JS 宏代码（除非用户明确要求）。
- **UTF-8**：任何脚本生成的 `*.txt/*.js/*.xml` 等文本文件必须用 UTF-8 写入；PowerShell 脚本需优先设置控制台 `OutputEncoding=UTF-8`，避免日志/提示乱码。
- **公共仓库不提交 `docs/`**：`docs/` 仅用于本地研发；公共仓库不要提交/更新 `docs/` 内容。



## 测试（私有/本地）

- 公共仓库不包含自动化测试用例；如需回归请使用本地/私有测试与手工清单，避免提交敏感数据。



## 提交与 PR 要求



- 提交信息建议：`feat:`/`fix:`/`refactor:`/`docs:` + 一句话总结（历史里有不少 `upd`，新提交尽量避免）。

- PR 至少包含：变更目的、验证步骤（给出命令）、以及 UI 变更截图/GIF（若改动 `ah32-ui-next/`）。

- 严禁提交敏感信息：`.env`、`storage/`、`logs/`、安装包/构建产物等应保持忽略。



## 安全与配置提示



- 对话能力依赖 `.env` 中的 `DEEPSEEK_API_KEY`。

- API 鉴权默认关闭；开启时设置 `AH32_ENABLE_AUTH=true` 并配置强随机 `AH32_API_KEY`。



## 错误处理与可观测（强约束）



- **禁止吞错**：后端禁止 `except: pass` / 前端禁止 `catch {}` 这种静默吞掉异常；允许 best-effort/降级，但必须留下可追踪的日志/事件。

- **后端**：任何异常都必须写入日志（包含堆栈 `exc_info=True`），便于通过 `logs/backend*.out|err` 或 `backend.log` 追踪。

- **前端（WPS Taskpane）**：

  - 对用户：将异常包装为友好的提示（告诉“发生了什么/影响是什么/下一步怎么做”，并提示截图反馈）。

  - 对开发：同时写入前端日志并上报后端（例如 `/api/log`、`/agentic/error/report`）。

  - 启动白屏/闪断定位：Taskpane 会把最近一次致命错误落到本地缓存 `ah32_last_error` 并展示覆盖层 `ah32-fatal-error-overlay`；截图时建议包含该覆盖层或 `boot-status` 文案。

- **兼容层（WPS/Office 对象模型差异）**：允许 try/catch 做能力探针或多分支兼容，但必须记录“用了哪个分支/是否触发 fallback”，否则会造成“看起来成功但其实没生效”的假象。

