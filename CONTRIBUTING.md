# 贡献指南（阿蛤 / AH32）

## 开发环境

- Python: 3.11+
- Node.js: 18+（仅前端/WPS 插件需要）

## 安装（后端）

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
copy .env.example .env
```

## 代码质量

- Python lint（最小基线）：`ruff check src`
- Python lint（现状报告，不阻塞 CI）：`ruff check .`

本仓库 CI 会执行上述检查（见 `.github/workflows/ci.yml`）。

## 提交前自检

- 确认没有提交 `.env`、`storage/`、`logs/`、`.venv/`、`node_modules/`
- 新增/修改的公共 API 有对应文档或示例
- 公共仓库不包含自动化测试用例；如需回归请使用本地/私有测试与手工清单，避免提交敏感数据

## 错误处理（必须遵守）

- 禁止静默吞错：避免 `except: pass`、`catch {}`；允许降级/兼容，但必须记录日志（带堆栈）并给用户可理解的提示。
- 前端（WPS 任务窗格）发生致命错误时，应能让用户截图定位：覆盖层/启动文案需要包含足够信息（例如错误类型/简要信息/时间）。
