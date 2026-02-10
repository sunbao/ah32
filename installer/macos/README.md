# macOS 安装器（规划）

## 规则文件与 Skills（给办公用户）

安装后建议把“规则文件/技能模板”放到用户文档目录，办公人员可以直接用 WPS 打开 `.docx` 编辑保存：

- `~/Documents/Ah32/规则.docx`（或 `rules.docx`）
- `~/Documents/Ah32/skills/<skill-id>/SYSTEM.docx`

本仓库提供模板：
- `installer/assets/user-docs/`（安装器可拷贝）
- `examples/user-docs/`（示例）

macOS 版“一键安装器”通常需要：

1. 先用 PyInstaller 生成可执行文件（或 `.app`）
2. 打包为 `.dmg`（或 `.pkg`）并签名/公证
3. 安装时把后端放到 `~/Applications` 或 `~/Library/Application Support/Ah32`
4. WPS 加载项建议以“本地加载项目录”的方式安装（WPS for macOS 入口可能不同）

建议的实现路线：

- 后端 `.app`：`pyinstaller --windowed --name Ah32 --paths src -m ah32.launcher`
- DMG：使用 `hdiutil` 打包
- 签名/公证：`codesign` + `notarytool`

由于签名证书/公证需要你们的 Apple Developer 账号，本仓库先提供流程说明；如需我把脚本骨架补齐（可填入 Team ID / Bundle ID），告诉我你们的目标交付形式（DMG 还是 PKG）。
