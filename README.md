# 阿蛤 (AH32)

阿蛤是一个本地优先（local-first）的办公助手，面向 **WPS** 场景。它借鉴 *VibeCoding* 的整体架构与交互模式，通过 **对话 + 可执行动作（默认 Plan JSON 写回）**，降低从日常办公文档中提取价值（总结、对齐、查找、结构化笔记等）的成本。

备注：后端 Python 包目录因历史原因仍保留为 `src/ah32/`（包路径仍为 `ah32`；对外产品名为 **阿蛤**，技术代号为 **AH32**）。

## 下载与安装

推荐通过 GitHub Releases 分发与安装（插件 zip、后端压缩包）。打包与发布说明见：`PACKAGING.md`。

### 安装 WPS 插件（连接远程后端）

1) 下载 `Ah32WpsPlugin.zip` 并解压
2) 运行安装脚本（将 `ApiBase` 指向你的远程后端）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-wps-plugin.ps1 `
  -PluginSource .\wps-plugin `
  -ApiBase http://<YOUR_BACKEND_HOST>:5123 `
  -ApiKey <YOUR_KEY>
```

3) 重启 WPS

安全与隐私：`SECURITY.md`。

## 仓库结构

只整理核心目录（可读、可维护、会长期用到）。运行/生成/缓存目录见下方“不要提交”。

- `src/ah32/`：后端（FastAPI；包路径仍为 `ah32`）
  - `server/`：HTTP API（后端入口：`python -m ah32.server.main`）
  - `agents/`：对话/执行代理逻辑（planning、tool-use、WPS 写回执行链路）
  - `skills/`：SkillRegistry/SkillRouter（从运行时 `skills/` 目录热加载）
  - `services/`：服务层（提示词、@ 引用、memory/RAG 等）
  - `telemetry/`：观测与事件（落库/上报/关联上下文）
  - `dev/`：后端 dev/bench/debug（默认关闭；仅在 `AH32_ENABLE_DEV_ROUTES=true` 时开放 `/dev/*`）
- `ah32-ui-next/`：前端（Vue 3 + TypeScript + Vite）与 WPS 加载项
  - `src/`：前端业务代码
  - `src/dev/`、`src/components/dev/`：MacroBench/调试面板（build-time 开关：`VITE_ENABLE_DEV_UI=true`）
  - `manifest.xml` / `ribbon.xml` / `taskpane.html`：WPS 加载项入口与配置
  - `wps-plugin/`：前端构建输出目录（运行时加载项目录，通常不提交）
  - `install-wps-plugin.ps1` / `uninstall-wps-plugin.ps1`：本地安装/卸载脚本（Windows）
- `skills/`：运行时 Skills 目录（默认从这里热加载；可按需替换为别的路径）
- `schemas/`：JSON Schema（如 `ah32.skill.v1`、`ah32.styleSpec.v1`）
- `scripts/`：开发/打包脚本
- `installer/`：安装器相关资源与脚本（多平台）

不要提交（运行/生成目录，可能很大或包含敏感信息）：`storage/`、`logs/`、`.venv/`、`ah32-ui-next/node_modules/`、`ah32-ui-next/wps-plugin/`、`dist/`、`build/`、`_release/`、`.env`。

## 开发快速开始

后端：

```bash
python -m venv .venv
# Windows：
.venv\\Scripts\\activate
# macOS/Linux：
# source .venv/bin/activate

pip install -e ".[dev]"
cp .env.example .env   # Windows：copy .env.example .env

python -m ah32.server.main
```

前端（WPS TaskPane）：

```bash
cd ah32-ui-next
npm install
npm run dev
```

默认后端地址：`http://127.0.0.1:5123`

## 打包 / 发布

见 `PACKAGING.md`。
