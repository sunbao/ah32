# Windows 安装器（Inno Setup）

本仓库提供一个基于 **Inno Setup** 的 Windows 一键安装包。

## 它做了什么

- 检测 WPS 是否已安装（未找到则阻止安装）。
- 安装后端可执行文件（PyInstaller 产物）和 WPS 加载项产物（`wps-plugin/`）。
- 生成 `.env`，固定端口为 `5123` 且默认关闭鉴权（`AH32_ENABLE_AUTH=false`）。
- 安装时允许用户填写 `DEEPSEEK_API_KEY`（也可留空，之后编辑 `.env` 补填）。
- 安装完成后自动打开 WPS。

## 构建

1) 构建 all-in-one bundle：

```powershell
scripts\\package.ps1
```

2) 编译安装器（需要 Inno Setup 6，且 `ISCC.exe` 在 PATH 中）：

```powershell
scripts\\build-windows-installer.ps1
```

产物：`installer/out/Ah32Setup.exe`
