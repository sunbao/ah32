# 打包与发布（公共仓库）

本项目建议**前端（WPS 插件）**与**后端（服务端可执行）**分开打包、分开发布：

- 前端包：安装到 WPS 内（本机不需要跑后端），通过 `ApiBase` 连接远程后端。
- 后端包：在 Windows / Linux / macOS 上部署服务端（PyInstaller 构建）。

本文命令均以仓库根目录执行。

---

## 0) 首次提交到 GitHub（你需要提供什么 / 怎么做）

你需要提供（或先在 GitHub 网页端创建好）：

- **GitHub 仓库地址**（HTTPS 或 SSH 均可），例如：`https://github.com/<org>/<repo>.git`
- 你希望的**默认分支名**：`main`（推荐）或 `master`
- 是否要**保留历史提交**（从 CodeUp 同步到 GitHub），还是做一次**“开源干净首发（无历史）”**（更安全，推荐）

> 建议：如果你不 100% 确认历史提交里没有误提交过敏感信息（哪怕后来删掉了），就用“干净首发”，避免把历史一起公开出去。

### 0.x 常见问题：推送被 GitHub 拦截（GH013 / Push Protection）

如果你在 `git push` 时看到类似：

- `remote: error: GH013: Repository rule violations`
- `Push cannot contain secrets`
- 提示某些 commit 里包含 `.env` / API Key

说明**敏感信息存在于历史提交中**（即使你现在已经把 `.env` 加入 `.gitignore` 也没用）。

推荐处理方式（按优先级）：

1) **干净首发（推荐）**：用 `--orphan` 新建无历史的 `main`，只发布当前快照（见 0.2）
2) **保留历史**：用 `git filter-repo` 清理历史中的 `.env`/密钥，然后 `git push --force`（高风险，务必先备份仓库；密钥也应该立刻作废/轮换）

### 0.1 保留历史提交（直接把现有 git 历史推到 GitHub）

```bash
# 1) 添加 GitHub 远程（不改你现有的 origin）
git remote add github https://github.com/<org>/<repo>.git

# 2) 把当前分支推到 GitHub 的 main（或 master）
git push -u github HEAD:main
```

### 0.2 干净首发（推荐：在 GitHub 新仓库只发布“当前快照”，不带历史）

```bash
# 1) 生成一个无历史的 main 分支
git checkout --orphan main
git add -A
git commit -m "chore: initial public release"

# 2) 推到 GitHub
git remote add github https://github.com/<org>/<repo>.git
git push -u github main
```

> 注意：`--orphan` 会让当前分支变成一个“全新历史”。如果你后续还要保留内部历史，可以在推送前先备份原分支名（例如 `feature/plan-writeback`）。

## 1) 面向用户：WPS 插件（一个 zip，拷走即可安装）

### 产物

脚本：`scripts/package-wps-plugin.ps1`  
输出：`_release/Ah32WpsPlugin.zip`

zip 内包含：

- `wps-plugin/`（前端构建产物）
- `install-wps-plugin.ps1` / `uninstall-wps-plugin.ps1`
- `INSTALL.txt`
- `user-docs/`（可选：`rules.docx`、`rules.zh-CN.docx`）

### 安装（Windows）

1) 解压 `Ah32WpsPlugin.zip`
2) 执行安装（`ApiBase` 指向远程后端；`ApiKey` 与后端配置一致）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-wps-plugin.ps1 `
  -PluginSource .\wps-plugin `
  -ApiBase http://<YOUR_BACKEND_HOST>:5123 `
  -ApiKey <YOUR_KEY>
```

3) 重启 WPS

### 更新/卸载

- 更新：使用新 zip 解压后，**再次运行安装脚本**即可覆盖旧版本（然后重启 WPS）。
- 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-wps-plugin.ps1
```

---

## 2) 面向维护者：构建与打包（生成 Releases 产物）

### 2.1 前端插件打包（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-wps-plugin.ps1
```

如果已经构建过（或 CI 已完成 build），可跳过 build：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-wps-plugin.ps1 -SkipBuild -OutZip .\dist\Ah32WpsPlugin.zip
```

### 2.2 后端打包（Windows / Linux / macOS）

> PyInstaller 通常**不能跨平台交叉编译**：要产出哪个平台，就在对应平台的 runner 上打包（CI 会用矩阵分别构建）。

### Windows x64

脚本：`scripts/package-backend.ps1`  
输出：`dist/Ah32Backend-windows-x64.zip`

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-backend.ps1 -Platform windows-x64 -OutDir dist
```

### Linux / macOS（x64 + arm64）

脚本：`scripts/package-backend.sh`  
输出：`dist/Ah32Backend-<platform>.tar.gz`

```bash
bash scripts/package-backend.sh --platform linux-x64 --out-dir dist
bash scripts/package-backend.sh --platform linux-arm64 --out-dir dist
bash scripts/package-backend.sh --platform macos-x64 --out-dir dist
bash scripts/package-backend.sh --platform macos-arm64 --out-dir dist
```

---

## 3) GitHub：如何“自动生成压缩包供下载”

仓库已提供发布流水线：`.github/workflows/release.yml`  
触发方式：推送 tag（形如 `v1.2.3`）。

推荐流程：

1) 本地打 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

2) GitHub Actions 会自动构建：

- 前端：`Ah32WpsPlugin.zip`
- 后端：Windows/Linux/macOS（含 Linux arm64、macOS arm64）对应的压缩包

说明：

- **Public 仓库**的 GitHub Actions 基本是免费的（有配额/并发限制，通常够用）。
- “Release 资产下载”依赖 GitHub Release 功能，本身不额外收费。

---

## 4) 公共仓库：建议提交/不提交清单

建议提交：

- `src/`、`ah32-ui-next/src/`、`ah32-ui-next/js/`、`ah32-ui-next/assets/`
- `scripts/`（打包脚本、CI 需要）
- `schemas/`、`.github/workflows/`、`installer/assets/user-docs/`（若这些就是你对外要发布的素材）
- `README.md`、`LICENSE` 等基础文件

禁止提交（已在 `.gitignore` 覆盖大部分）：

- 运行/生成目录：`storage/`、`logs/`、`.venv/`、`ah32-ui-next/node_modules/`、`build/`、`dist/`、`_release/`
- 敏感配置：`.env`、任何真实 `ApiKey`/Token
- 本地开发文档：`docs/`（公共仓库不发布）
- 本地 QA 与测试：`qa/`、`tests/`（公共仓库不发布）
