# Linux/Ubuntu 安装器（规划）

## 规则文件与 Skills（给办公用户）

安装后建议把“规则文件/技能模板”放到用户文档目录，办公人员可以直接用 WPS 打开 `.docx` 编辑保存：

- `~/Documents/Ah32/规则.docx`（或 `rules.docx`）
- `~/Documents/Ah32/skills/<skill-id>/SYSTEM.docx`

本仓库提供模板：
- `installer/assets/user-docs/`（安装器可拷贝）
- `examples/user-docs/`（示例）

Linux 版“一键安装器”常见交付形态：

- AppImage（无需 root，兼容性强）
- `.deb`（适合 Ubuntu/Debian）

建议的实现路线：

1. PyInstaller 生成可执行文件：
   - `pyinstaller --name Ah32 --paths src -m ah32.launcher`
2. AppImage：
   - 准备 AppDir 目录结构、desktop 文件与图标
   - 使用 `appimagetool` 生成 `.AppImage`
3. `.deb`：
   - 使用 `fpm` 或 `dpkg-deb` 打包

WPS for Linux 的加载项入口与目录因版本不同而异，推荐依旧采用“本地加载项目录”安装 `wps-plugin/`，并保持后端绑定 `127.0.0.1:5123`。
