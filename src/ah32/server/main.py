"""FastAPI entry point for Ah32."""

from __future__ import annotations

import locale
# ========== 设置UTF-8编码 ==========
import sys

# 设置标准输出为UTF-8编码
if sys.platform.startswith('win'):
    # Windows下设置控制台编码
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 设置locale为UTF-8
try:
    locale.setlocale(locale.LC_ALL, 'zh_CN.UTF-8')
except Exception as e:
    print(f"[boot] locale zh_CN.UTF-8 not available: {e}", file=sys.stderr)
    try:
        locale.setlocale(locale.LC_ALL, 'C.UTF-8')
    except Exception as e2:
        print(f"[boot] locale C.UTF-8 not available: {e2}", file=sys.stderr)

# ========== 关键：在所有导入之前加载 .env 并设置环境变量 ==========
import os
from pathlib import Path

# 先加载 .env 文件到环境变量
# Load .env (strict: must exist and include AH32_EMBEDDING_MODEL).
try:
    from dotenv import load_dotenv
    from ah32.runtime_paths import runtime_root
except ImportError as e:
    raise RuntimeError("python-dotenv is required to load .env; please install it.") from e

env_file = runtime_root() / ".env"
if not env_file.exists():
    raise RuntimeError(f".env file not found: {env_file}. Create it in the repo root.")

load_dotenv(env_file, override=True)
if not os.environ.get("AH32_EMBEDDING_MODEL"):
    raise RuntimeError("AH32_EMBEDDING_MODEL is missing in .env; please configure it.")

# Telemetry policy:
# - Dev/test often wants telemetry (LLM tracing, etc.).
# - Production can disable telemetry explicitly via env to avoid extra network/latency.
_disable_langsmith = os.environ.get("AH32_DISABLE_LANGSMITH", "").lower() in ("1", "true", "yes")
if _disable_langsmith:
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    os.environ["LANGCHAIN_TRACING"] = "false"
    os.environ["LANGSMITH_TRACING"] = "false"

_disable_chroma_telemetry = os.environ.get("AH32_DISABLE_CHROMA_TELEMETRY", "").lower() in ("1", "true", "yes")
if _disable_chroma_telemetry:
    os.environ["ANONYMIZED_TELEMETRY"] = "False"


# ============================================================
import logging

# 配置日志（支持通过环境变量控制级别）
import os
import sys
log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
log_level_value = getattr(logging, log_level, logging.INFO)

# Ensure UTF-8 output even when launched directly (avoid mojibake in logs).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

logging.basicConfig(
    level=log_level_value,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 记录日志级别配置（改为DEBUG级别，减少启动噪音）
logger.debug(f"📊 日志级别配置: {log_level} (环境变量: LOG_LEVEL)")

# 记录热加载配置（改为DEBUG级别，减少启动噪音）
# 默认禁用，避免长连接/任务执行期间被自动重载打断；需要时可设置 RELOAD=true。
enable_reload = os.environ.get("RELOAD", "false").lower() in ("true", "1", "yes")
logger.debug(f"🔥 热加载配置: {'启用' if enable_reload else '禁用'} (环境变量: RELOAD)")

# ========== 端口自动清理功能 ==========
def cleanup_port(port: int = 5123):
    """自动清理被占用的端口"""
    import socket
    import subprocess
    import time

    def is_port_in_use(port: int) -> bool:
        """检查端口是否被占用"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(2)  # 设置超时时间
                return s.connect_ex(('127.0.0.1', port)) == 0
        except Exception:
            logger.exception("端口占用检测失败", exc_info=True)
            return False

    if is_port_in_use(port):
        logger.info(f"端口 {port} 已被占用，正在清理...")

        # 仅 Windows 下尝试查找并杀死占用端口的进程（避免在 Linux/macOS 上执行 Windows 命令）
        if not sys.platform.startswith('win'):
            logger.warning(f"端口 {port} 已被占用，但当前平台不支持自动清理，请手动释放端口后重试。")
            return

        # 查找并杀死占用端口的进程
        try:
            # Windows下使用 netstat
            result = subprocess.run(
                ['netstat', '-ano', '-p', 'tcp'],
                capture_output=True,
                text=True,
                encoding='gbk',  # Windows默认编码
                errors='ignore'  # 忽略无法解码的字符
            )

            for line in result.stdout.split('\n'):
                line = line.strip()
                if f':{port}' in line and 'LISTENING' in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        if pid.isdigit():  # 确保PID是数字
                            try:
                                logger.info(f"正在杀死进程 PID: {pid}")
                                subprocess.run(['taskkill', '/F', '/PID', pid], check=False, capture_output=True)
                                logger.info(f"已尝试杀死进程 {pid}")
                            except Exception as e:
                                logger.error(f"杀死进程时出错: {e}")
                        break

            # 等待端口释放
            time.sleep(2)

            if is_port_in_use(port):
                logger.warning(f"警告：端口 {port} 仍然被占用")
            else:
                logger.info(f"端口 {port} 已成功释放")

        except Exception as e:
            logger.error(f"清理端口时出错: {e}")
    else:
        logger.info(f"端口 {port} 当前可用")


# 启动前自动清理端口
cleanup_port(5123)
# ============================================================
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

# 修改导入方式为绝对导入
from ah32.config import settings
from ah32.runtime_paths import runtime_root
from ah32.knowledge.chroma_utils import make_collection_name
from ah32.knowledge.embeddings import resolve_embedding, check_embedding_model_ready
from ah32.knowledge.store import LocalVectorStore
from ah32.services.models import load_llm

from ah32.server.agentic_chat_api import router as agentic_chat_router  # Agentic聊天API（唯一用户入口）
from ah32.server.document_monitor import router as document_monitor_router  # 文档同步API
from ah32.server.rag_api import router as rag_router  # RAG知识库API
from ah32.server.memory_api import router as memory_router  # 记忆写入/读取API
from ah32.server.metrics_api import router as metrics_router  # Metrics export API
from ah32.server.audit_api import router as audit_router  # Audit API
from ah32.server.runtime_config_api import router as runtime_config_router  # Frontend-safe runtime flags
from ah32.server.telemetry_api import router as telemetry_router  # Telemetry ingest

from ah32.agents.agentic_coordinator import get_coordinator  # 阿蛤（AH32）协调器
from ah32.services.tasks import ConversationRepository, TaskRepository

# 配置日志
log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
log_level_value = getattr(logging, log_level, logging.INFO)

logging.basicConfig(
    level=log_level_value,
    format='%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# 特别设置HTTP库的日志级别（防止连接断开的关键）
if log_level.upper() == "DEBUG":
    logging.getLogger('httpcore').setLevel(logging.DEBUG)
    logging.getLogger('httpx').setLevel(logging.DEBUG)
    logging.getLogger('urllib3.connectionpool').setLevel(logging.DEBUG)
    # 强制设置所有HTTP相关日志为DEBUG
    logging.getLogger('httpcore.http11').setLevel(logging.DEBUG)
    logging.getLogger('httpcore.connection').setLevel(logging.DEBUG)

# Even when LOG_LEVEL=DEBUG, keep LangSmith log spam down; tracing can still be enabled via env.
_langsmith_log_level = os.environ.get("AH32_LANGSMITH_LOG_LEVEL", "WARNING").upper()
try:
    _langsmith_level_value = getattr(logging, _langsmith_log_level, logging.WARNING)
except Exception:
    _langsmith_level_value = logging.WARNING
logging.getLogger("langsmith").setLevel(_langsmith_level_value)
logging.getLogger("langsmith.client").setLevel(_langsmith_level_value)

logger = logging.getLogger(__name__)

# ========== Lifespan事件管理 ==========
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logger.info("正在启动Ah32服务...")
    
    try:
        # Telemetry (ah32.telemetry.v1): best-effort, non-blocking.
        # Keep it OFF by default in prod; enable via TELEMETRY_MODE or AH32_TELEMETRY_MODE.
        try:
            from ah32.telemetry import TelemetryService, set_telemetry

            tsvc = TelemetryService.from_settings(settings)
            set_telemetry(tsvc)
            tsvc.start()
            try:
                caps = tsvc.capabilities().to_dict()
                logger.info(f"[telemetry] enabled={caps.get('mode') != 'off'} caps={caps}")
            except Exception as e:
                logger.warning(f"[telemetry] caps log failed: {e}", exc_info=True)
        except Exception as e:
            logger.error(f"[telemetry] init failed: {e}", exc_info=True)
            try:
                from ah32.telemetry import set_telemetry

                set_telemetry(None)
            except Exception:
                pass

        # 验证安全配置
        security_report = settings.check_security_config()
        if not security_report["secure"]:
            logger.warning(f"安全配置检查结果 - 评分: {security_report['security_score']}/100")
            for warning in security_report["warnings"]:
                logger.warning(f"安全警告 [{warning['level']}]: {warning['message']}")
            for error in security_report["errors"]:
                logger.error(f"安全错误 [{error['level']}]: {error['message']}")
        
        # 初始化服务
        # Embedding preflight: fail fast in offline mode if the local cache is incomplete.
        offline = os.environ.get("HF_HUB_OFFLINE") == "1" or os.environ.get("TRANSFORMERS_OFFLINE") == "1"
        ok, msg = check_embedding_model_ready(settings)
        if ok:
            logger.info(f"[embedding self-check] {msg}")
        else:
            if offline:
                logger.error(f"[embedding self-check] {msg}")
                raise RuntimeError(msg)
            logger.warning(f"[embedding self-check] {msg}")

        app.state._embedding = resolve_embedding(settings)  # 修复调用参数

        # Allow the service to start even if the LLM key is not configured yet.
        # The client can set DEEPSEEK_API_KEY after installation and restart the backend.
        try:
            app.state._llm = load_llm(settings)
        except ValueError as e:
            logger.warning(f"[llm] not configured: {e}")
            app.state._llm = None

        # Hot-loaded skills (prompt-only) - loaded on demand per request, but keep a shared registry.
        try:
            from ah32.skills import SkillRegistry
            from ah32.skills.seed import seed_builtin_skills

            try:
                seeded = seed_builtin_skills(settings.skills_dir)
                if seeded:
                    logger.info(f"[skills] seeded_builtin={seeded} dest={settings.skills_dir}")
            except Exception as e:
                logger.warning(f"[skills] seed builtin failed: {e}")

            app.state._skills_registry = SkillRegistry(
                root_dir=settings.skills_dir,
                max_total_chars=settings.skills_max_chars,
            )
        except Exception as e:
            logger.warning(f"[skills] registry init failed: {e}")
            app.state._skills_registry = None

        embedding_dim = None
        try:
            # One-time probe; avoids Chroma dimension mismatch when switching models.
            embedding_dim = len(app.state._embedding.embed_query("dimension_probe"))
        except Exception as e:
            logger.warning(f"[embedding] dimension probe failed (will use model-only collection name): {e}")

        rag_collection_name = make_collection_name(
            "ah32_rag",
            settings.embedding_model,
            embedding_dim=embedding_dim,
        )
        app.state._vector_store = LocalVectorStore(
            persist_path=settings.embeddings_path,
            embedding=app.state._embedding,
            config={
                "collection_name": rag_collection_name,
                "collection_metadata": {
                    "embedding_model": settings.embedding_model,
                    "embedding_dim": embedding_dim,
                },
            },
        )
        # 初始化阿蛤（AH32）协调器并传递向量存储
        from ah32.agents.agentic_coordinator import get_coordinator
        get_coordinator(app.state._vector_store)

        app.state._tasks = TaskRepository(settings.tasks_store_path)
        app.state._conversations = ConversationRepository(settings.conversation_store_path)
        
        logger.info("Ah32服务启动完成")
        yield
        
    except Exception as e:
        logger.error(f"Ah32服务启动失败: {e}")
        raise
    finally:
        logger.info("正在关闭Ah32服务...")
        # Stop telemetry last so shutdown events can still be flushed.
        try:
            from ah32.telemetry import get_telemetry, set_telemetry

            tsvc = get_telemetry()
            if tsvc:
                tsvc.stop()
            set_telemetry(None)
        except Exception as e:
            logger.error(f"[telemetry] stop failed: {e}", exc_info=True)

        # 在这里可以添加清理资源的代码
        logger.info("Ah32服务已关闭")


class UTF8JSONResponse(JSONResponse):
    # Some embedded webviews (including certain WPS taskpane runtimes) decode JSON
    # as system ANSI when charset is missing. Explicitly mark UTF-8 to avoid mojibake.
    media_type = "application/json; charset=utf-8"


app = FastAPI(
    title="Ah32",
    version="0.1.0",
    lifespan=lifespan,
    default_response_class=UTF8JSONResponse,
)


def _resolve_wps_plugin_dir() -> str | None:
    """Best-effort locate the bundled `wps-plugin/` directory for WPS ET/WPP.

    - Source repo: <repo>/ah32-ui-next/wps-plugin
    - Packaged dist: <exe-dir>/wps-plugin
    """
    try:
        root = runtime_root()
        candidates = [
            root / "wps-plugin",
            root / "ah32-ui-next" / "wps-plugin",
        ]
        for p in candidates:
            try:
                if p.exists() and p.is_dir() and (p / "manifest.xml").exists():
                    return str(p)
            except Exception:
                continue
    except Exception:
        return None
    return None


# Serve the bundled plugin so modern WPS builds can load it via `%APPDATA%/.../publish.xml`.
_wps_plugin_dir = _resolve_wps_plugin_dir()
if _wps_plugin_dir:
    app.mount("/wps-plugin", StaticFiles(directory=_wps_plugin_dir, html=True), name="wps-plugin")
# ========== 启动全局服务 ==========
# 注意：环境感知功能已移除

# 添加CORS中间件 - 最大权限配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=True,  # 允许凭据
    allow_methods=["*"],  # 允许所有方法
    allow_headers=["*"],  # 允许所有请求头
    expose_headers=["*"],  # 暴露所有响应头
)
# 注册路由 - 纯Agentic模式
app.include_router(agentic_chat_router)  # 唯一用户入口
app.include_router(document_monitor_router)  # 文档同步API
app.include_router(rag_router)  # RAG知识库API
app.include_router(memory_router)  # 用户确认式记忆写入/读取
app.include_router(metrics_router)  # Metrics export
app.include_router(audit_router)  # Audit export
app.include_router(runtime_config_router)  # Frontend-safe runtime flags
app.include_router(telemetry_router)  # Telemetry ingest/query (query gated by AH32_ENABLE_DEV_ROUTES)
if settings.enable_dev_routes:
    # Dev-only telemetry UI/query; keep this out of the core server package so it can be excluded.
    from ah32.dev.telemetry_dev_api import router as telemetry_dev_router

    app.include_router(telemetry_dev_router)


# 安全配置
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
authorization_header = APIKeyHeader(name="Authorization", auto_error=False)


@app.get("/health")
async def health_check():
    """健康检查端点"""
    return {
        "status": "healthy",
        "version": "0.1.0",
        "server": f"{settings.server_host}:{settings.server_port}",
        "features": {
            "plan_normalize_v1": True,
        },
    }

def run() -> None:
    import uvicorn

    # 🔥 热加载配置：默认禁用（更稳定）；如需开启，设置环境变量 RELOAD=true
    enable_reload = os.environ.get("RELOAD", "false").lower() in ("true", "1", "yes")

    # 🔥 优化：指定热加载监控目录，排除logs目录避免监控噪音
    reload_dirs = None
    if enable_reload:
        from pathlib import Path
        # 排除logs和storage等目录，减少监控噪音
        current_dir = Path.cwd()
        reload_dirs = [str(current_dir / "src")]  # 只监控src目录

    uvicorn.run(
        "ah32.server.main:app",
        host=settings.server_host,
        port=settings.server_port,
        reload=enable_reload,
        reload_dirs=reload_dirs,  # 指定监控目录
        # 🚀 HTTP超时配置 - 防止客户端断开连接
        timeout_keep_alive=1800,  # 30分钟keep-alive超时 - 防止断开
        timeout_graceful_shutdown=60,  # 优雅关闭超时（增加到60秒）
        timeout_worker_healthcheck=1800,  # Worker健康检查超时（增加到30分钟）
        lifespan="on",  # 显式启用生命周期管理
        loop="auto",
        http="auto",
        access_log=False  # 禁用访问日志以减少噪音
    )


if __name__ == "__main__":
    run()
