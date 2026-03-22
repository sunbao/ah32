# 阿蛤 (AH32)

[中文](README.md) | [English](README.en.md)

阿蛤（AH32）是面向 **WPS Office** 的企业办公助手，适合“内部知识库 + 私有化部署 + 文档写回”的场景：你在聊天里说要做什么，它会输出一份可执行的 **Plan JSON**，由 WPS 插件在文档里把内容/表格/排版真正写出来（不是简单复制粘贴）。

备注：后端 Python 包目录因历史原因仍保留为 `src/ah32/`（包路径仍为 `ah32`；对外产品名为 **阿蛤**，技术代号为 **AH32**）。

## 最新里程碑

- 当前里程碑版本：`v0.3.0`
- 这是 Writer / ET / WPP 三宿主宏基准无人值守自动化的第一个稳定里程碑
- 当前已验证基线：chat 宏基准 `14/14` 全绿
- 里程碑详情见：[CHANGELOG.md](CHANGELOG.md)

## 界面与链路预览

### 产品总览

![AH32 总览](assets/readme/overview.svg)

### 宏基准自动化流程

![宏基准自动化流程](assets/readme/macro-bench-flow.svg)

### 宿主支持示意

![宿主支持示意](assets/readme/hosts.svg)

## 能解决什么（作用/场景）

- **招投标/标书**：把招标/投标文件里的要求、偏离点、澄清问题、风险清单整理成结构化结果，并可写回到标书文档里。
- **制度/合规/合同**：对条款、要点、缺失项做检查与归纳，输出可落地的修改建议/核对清单。
- **会议纪要/汇报材料**：把散乱信息整理成大纲、要点、行动项，并按指定格式写回。
- **表格/数据辅助（ET）**：对表格做摘要、对齐、结构化输出，必要时生成表格/图表写回。
- **企业知识库（RAG）**：合同库/案例库/模板库/政策库等资料可导入为知识库，聊天时按需检索引用；缺资料会明确提示需要补库。

## 企业化 / 私有化部署（推荐）

典型形态：**WPS 插件（客户端） + AH32 后端（你的内网/云） + 租户隔离存储（按组织分目录）**。

- **数据隔离**：落盘按 `storage/tenants/<tenant_id>/...` 分开（避免不同组织数据混在一起）。
- **文档上下文**：远端后端模式下，前端会走“文档快照（doc snapshot）”链路，把文档内容独立上传；对话请求只引用 `doc_snapshot_id`，减少大文本/二进制塞进聊天。
- **安全与管控**：鉴权默认关闭；企业可开启 API Key/JWT 等；后端出网支持按“黑名单”策略拦截并留审计（更贴合内网/银行等环境）。

## 快速开始（私有化/内网）

后端（服务器/内网机器）：

```bash
docker compose up -d --build
```

默认端口：`http://127.0.0.1:5123`

客户端（安装 WPS 插件）：见下方“安装 WPS 插件（连接远程后端）”。

## 下载与安装

推荐通过 GitHub Releases 分发与安装（插件 zip、后端压缩包）。打包与发布说明见：`PACKAGING.md`。

## 联系

- 优先通过 GitHub Issues 反馈问题（建议附截图/日志/复现步骤）。
- 如需快速沟通/合作对接：微信 `abaokaimen`（备注：AH32/GitHub）。

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
