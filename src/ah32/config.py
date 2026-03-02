"""Centralized settings for Ah32."""



from __future__ import annotations



import os

import logging

from pathlib import Path

from typing import Optional, Dict, Any



from pydantic import Field

from pydantic_settings import BaseSettings, SettingsConfigDict

from pydantic import field_validator, ValidationInfo



logger = logging.getLogger(__name__)



# Runtime root (supports PyInstaller frozen builds)

from ah32.runtime_paths import runtime_root



# Load .env before settings (strict: must exist and include AH32_EMBEDDING_MODEL).
try:
    from dotenv import load_dotenv
except ImportError as e:
    raise RuntimeError("python-dotenv is required to load .env; please install it.") from e

def _env_file_has_key(env_file: Path, key: str) -> bool:
    try:
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            # Handle UTF-8 BOM emitted by some Windows editors/Out-File encodings.
            line = line.lstrip("\ufeff")
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() != key:
                continue
            value = v.strip().strip("\"").strip("'")
            return bool(value)
    except Exception as e:
        raise RuntimeError(f"Failed to read .env: {env_file} ({e})") from e
    return False

env_file = runtime_root() / ".env"
if not env_file.exists():
    raise RuntimeError(f".env file not found: {env_file}. Create it in the repo root.")

if not _env_file_has_key(env_file, "AH32_EMBEDDING_MODEL"):
    raise RuntimeError("AH32_EMBEDDING_MODEL is missing in .env; please configure it.")

# Use utf-8-sig to gracefully handle BOM written by some Windows editors.
load_dotenv(env_file, override=True, encoding="utf-8-sig")


def _default_user_documents_dir() -> Path:

    """Return a user-friendly directory for non-technical users to edit files.



    We prefer the user's "Documents" folder because office users are familiar with

    opening/editing/saving files there via WPS. Fall back to home if unavailable.

    """

    home = Path.home()

    candidates = [

        home / "Documents",

        home / "My Documents",

    ]

    for p in candidates:

        try:

            if p.exists() and p.is_dir():

                return p

        except Exception:

            logger.debug("[config] probe documents dir failed (ignored): %s", p, exc_info=True)
            continue

    return home


def _default_llm_tool_allowlist() -> str:
    # Default backend LLM tool allowlist for "chat mode":
    # - Allow: read/query/view + web fetch/crawl + ingest-from-web + image generation.
    # - Disallow: local file import (manual via UI), and destructive RAG admin operations.
    return ",".join(
        [
            # Document read/analysis (non-destructive)
            "list_open_documents",
            "read_document",
            "document_memory",
            "quick_analyze",
            "generate_report",
            "export_analysis",
            "get_user_preferences",
            "calculate_date",
            # Web fetch / browser crawl (backend strong tools)
            "web_fetch",
            "browser_snapshot",
            # RAG (read + ingest-from-web; no delete/clear)
            "rag_search",
            "rag_stats",
            "rag_list_documents",
            "rag_ingest_url",
            # Multimodal (image)
            "mm_generate_image",
        ]
    )


class Ah32Settings(BaseSettings):

    """Application level settings loaded from environment variables."""



    storage_root: Path = Field(

        default_factory=lambda: runtime_root() / "storage",

        description="Root folder that stores uploads, embeddings and logs.",

    )

    memory_root: Path = Field(

        default_factory=lambda: runtime_root() / "storage/memory",

        description="Root folder that stores uploads, memory and logs.",

    )

    uploads_dirname: str = Field(default="uploads")

    embeddings_dirname: str = Field(default="embeddings")

    # Persisted vector stores (kept as sibling folders under storage_root).
    #
    # NOTE: We keep separate persist directories for RAG / memory / skills to
    # avoid SQLite write-lock contention and lifecycle coupling.
    skills_vector_dirname: str = Field(default="skills_vector_store")
    memory_vector_dirname: str = Field(default="memory_vector_store")

    logs_dirname: str = Field(default="logs")
    doc_snapshots_dirname: str = Field(default="doc_snapshots", description="Ephemeral per-turn document snapshots.")
    assets_dirname: str = Field(default="assets", description="Ephemeral generated assets (images).")

    # Doc snapshot transport (ephemeral, privacy-first)
    doc_snapshot_ttl_sec: int = Field(
        default=1800,
        description="TTL seconds for doc snapshots (crash-safety only; normal flow deletes immediately).",
    )
    doc_snapshot_max_bytes: int = Field(
        default=200_000_000,
        description="Max upload bytes for a single doc snapshot (safety cap).",
    )

    # Asset store (ephemeral, privacy-first)
    asset_ttl_sec_default: int = Field(
        default=600,
        description="Default TTL seconds for assets (crash-safety; frontend should DELETE after use).",
    )
    asset_max_bytes: int = Field(
        default=20_000_000,
        description="Max bytes for a single asset upload (safety cap).",
    )



    # Office配置

    office_mode: bool = Field(

        default=True,

        description="通用办公软件支持"

    )



    server_host: str = Field(default="127.0.0.1")

    server_port: int = Field(default=5123)



    @field_validator("storage_root", mode="before")

    @classmethod

    def _coerce_storage_root(cls, v):

        # Treat empty env vars as "unset" so we keep the intended default.

        if v is None:

            return runtime_root() / "storage"

        if isinstance(v, str) and not v.strip():

            return runtime_root() / "storage"

        return v



    @field_validator("memory_root", mode="before")

    @classmethod

    def _coerce_memory_root(cls, v):

        # Treat empty env vars as "unset" so we keep the intended default.

        if v is None:

            return runtime_root() / "storage/memory"

        if isinstance(v, str) and not v.strip():

            return runtime_root() / "storage/memory"

        return v



    @field_validator("skills_dir", mode="before")

    @classmethod

    def _coerce_skills_dir(cls, v):

        # Treat empty env vars as "unset" so we keep the intended OS-specific default.

        if v is None:

            return _default_user_documents_dir() / "Ah32/skills"

        if isinstance(v, str) and not v.strip():

            return _default_user_documents_dir() / "Ah32/skills"

        return v



    @field_validator("server_port", mode="after")

    @classmethod

    def _validate_server_port(cls, v):

        if not (1 <= v <= 65535):

            raise ValueError("server_port must be between 1 and 65535")



        # Product constraint: the local backend port is fixed for WPS integration.

        if v != 5123:

            logger.warning("server_port is fixed to 5123; overriding configured value.")

            return 5123



        return v



    llm_model: str = Field(

        default="deepseek-reasoner",

        description="LLM identifier or endpoint name used for generation.",

    )

    vision_model: str = Field(

        default="qwen-vl-max",

        description="Vision model identifier used for image analysis and understanding.",

    )

    # Multimodal (v1): image understanding + image generation (ephemeral assets).
    mm_provider: str = Field(
        default="disabled",
        description="Multimodal provider: bailian|openai-compatible|disabled",
    )
    mm_strict: bool = Field(
        default=True,
        description="Strict mode for multimodal: missing keys/models -> error (no silent fallback).",
    )

    # Bailian (阿里百炼) — recommended default for multimodal
    bailian_api_key: Optional[str] = Field(default=None, description="Bailian API key (AH32_BAILIAN_API_KEY).")
    bailian_base_url: str = Field(default="", description="Bailian base URL (OpenAI-compatible).")
    bailian_vision_model: str = Field(default="qwen-vl-max", description="Bailian vision model id.")
    bailian_image_model: str = Field(default="", description="Bailian image generation model id.")

    # Generic OpenAI-compatible multimodal provider (optional)
    mm_api_key: Optional[str] = Field(default=None, description="OpenAI-compatible MM API key (AH32_MM_API_KEY).")
    mm_base_url: str = Field(default="", description="OpenAI-compatible MM base URL (e.g. https://.../v1).")
    mm_vision_model: str = Field(default="", description="OpenAI-compatible vision model id.")
    mm_image_model: str = Field(default="", description="OpenAI-compatible image model id.")

    # GPU配置

    enable_gpu: bool = Field(

        default=True,

        description="Enable GPU acceleration if available.",

    )

    gpu_device: str = Field(

        default="auto",

        description="GPU device ID ('auto' for auto-detect, 'cuda:0' for first GPU, 'cpu' for CPU only).",

    )

    embedding_model: str = Field(

        ...,
        description="Embedding model identifier used for document retrieval (required, from .env)."

    )



    # Runtime extensions

    skills_dir: Path = Field(

        default_factory=lambda: _default_user_documents_dir() / "Ah32/skills",

        description=(

            "Directory that contains user-installable skills (hot-loaded). "

            "Default points to a user-friendly Documents folder so non-technical users can edit skills in WPS."

        ),

    )

    skills_enabled: bool = Field(default=True, description="Enable hot-loaded skills.")

    enable_dynamic_skills: bool = Field(

        default=True,

        description="Enable dynamic skill routing (select 0..N relevant skills per turn).",

    )

    skills_max_chars: int = Field(

        default=12000,

        description="Max total characters of skills text injected into prompts per turn.",

    )

    skills_top_k: int = Field(

        default=4,

        description="Max number of skills selected and injected per turn (0 = inject all enabled skills).",

    )

    skills_min_score: float = Field(

        default=0.18,

        description="Minimum routing score for a skill to be considered relevant (embedding router).",

    )

    llm_tool_allowlist: str = Field(
        default_factory=_default_llm_tool_allowlist,
        description=(
            "Comma-separated tool names allowed for backend LLM tool-calls. "
            "Set AH32_LLM_TOOL_ALLOWLIST to override."
        ),
    )

    # Client-managed skills pack (remote backend mode)
    skills_pack_max_total_chars: int = Field(
        default=12000,
        description="Max total characters allowed for a client-sent skills_pack (prompt_text + schemas).",
    )
    skills_pack_max_skill_chars: int = Field(
        default=8000,
        description="Max characters allowed for a single skill prompt_text in skills_pack.",
    )
    skills_pack_max_skills: int = Field(
        default=6,
        description="Max number of skills allowed in a single skills_pack.",
    )
    skills_pack_store_ttl_seconds: int = Field(
        default=3600,
        description="TTL seconds for in-memory skills_pack_ref cache (crash-safety only; not persistent).",
    )
    skills_pack_store_max_sessions: int = Field(
        default=5000,
        description="Max cached skills_pack refs across sessions (best-effort bound).",
    )



    # Per-conversation rule files ("Claude.md"-like), loaded every turn.

    # Format: semicolon-separated paths, e.g. \"rules/office.md;C:/Docs/team-guide.docx\"

    conversation_rule_files: str = Field(

        default="",

        description="Semicolon-separated paths to rule files injected into every request (docx/txt/md).",

    )

    conversation_rule_files_max_chars: int = Field(

        default=12000,

        description="Max total characters of rule files injected into prompts per turn.",

    )



    # Dev-only routes (bench/debug). Keep OFF by default so production deployments

    # don't accidentally expose diagnostic endpoints.

    enable_dev_routes: bool = Field(

        default=False,

        description="Enable /dev/* diagnostic routes (unsafe for public exposure).",

    )



    # Telemetry (ah32.telemetry.v1)

    # Design goals:

    # - Same client API for local vs remote deployment (client always POSTs to apiBase).

    # - Server decides whether to persist locally, forward remotely, or both.

    telemetry_mode: str = Field(

        default="local",

        description="Telemetry sink mode: local|remote|both|off",

    )

    telemetry_sqlite_path: Path = Field(

        default_factory=lambda: runtime_root() / "storage/telemetry/telemetry.sqlite3",

        description="SQLite path for local telemetry persistence (when telemetry_mode includes local).",

    )

    telemetry_retention_days: int = Field(

        default=7,

        description="Retention days for telemetry events stored locally.",

    )

    telemetry_flush_interval_ms: int = Field(

        default=1000,

        description="Flush interval for batching telemetry writes.",

    )

    telemetry_batch_size: int = Field(

        default=200,

        description="Batch size for telemetry flushes.",

    )

    telemetry_remote_endpoint: str = Field(

        default="",

        description="Optional remote telemetry collector endpoint (when telemetry_mode includes remote).",

    )



    chunk_size: int = Field(default=800)

    chunk_overlap: int = Field(default=150)



    max_workers: int = Field(default=4)

    conversation_history_limit: int = Field(

        default=10, description="Max number of conversation turns fed back to the model."

    )

    conversation_store_path: Optional[Path] = Field(

        default=None, description="File used to persist conversation history."

    )

    tasks_store_path: Optional[Path] = Field(

        default=None, description="File used to persist task records."

    )

    

    # 新增的安全配置

    enable_auth: bool = Field(

        default=False, description="Enable authentication for API endpoints."

    )

    api_key: Optional[str] = Field(

        default=None,

        description="API key for authentication. Must be set in production environment."

    )

    default_tenant_id: str = Field(
        default="public",
        description="Default tenant id when X-AH32-Tenant-Id is missing (for trial/experience users).",
    )

    max_tenants: int = Field(default=100, description="Maximum number of tenants supported by local keyring.")

    tenant_keyring_path: Optional[Path] = Field(
        default=None,
        description="Local tenant keyring file path (default: storage/tenants/keyring.json). Not committed.",
    )

    tenant_keyring_reload_sec: int = Field(
        default=5,
        description="Keyring reload interval in seconds (best-effort).",
    )

    auth_accept_legacy_x_api_key: bool = Field(
        default=True,
        description="Accept legacy X-API-Key header as alias of X-AH32-Api-Key.",
    )

    auth_allow_default_tenant_anonymous: bool = Field(
        default=True,
        description="When enable_auth=true, allow anonymous access for default_tenant_id (trial/experience mode).",
    )

    jwt_secret: str = Field(
        default="",
        description="JWT HS256 secret for issuing/verifying tokens (AH32_JWT_SECRET).",
    )

    jwt_issuer: str = Field(default="ah32", description="JWT issuer claim (iss).")

    jwt_audience: str = Field(default="ah32", description="JWT audience claim (aud).")

    jwt_access_token_ttl_sec: int = Field(default=3600, description="JWT access token TTL in seconds.")



    # OpenAI/DeepSeek/阿里云 API Key

    OPENAI_API_KEY: Optional[str] = Field(

        default=None, description="OpenAI/DeepSeek/阿里云 API Key"

    )

    cors_allowed_origins: list[str] = Field(

        default_factory=lambda: ["*"],

        description="Origins allowed to access the HTTP API. WARNING: Do not use ['*'] in production!"

    )

    cors_allow_origin_regex: Optional[str] = Field(

        default=None,

        description="Optional regex for allowed origins (useful for custom schemes).",

    )



    # 安全相关配置

    rate_limit_enabled: bool = Field(

        default=False,

        description="Enable rate limiting for API endpoints."

    )

    rate_limit_requests: int = Field(

        default=100,

        description="Number of requests allowed per time window."

    )

    rate_limit_window: int = Field(

        default=60,

        description="Time window in seconds for rate limiting."

    )



    model_config = SettingsConfigDict(env_prefix="AH32_")



    @field_validator("OPENAI_API_KEY", mode="before")

    @classmethod

    def _load_api_key(cls, value):
        # 只使用本项目配置项（AH32_OPENAI_API_KEY；由 env_prefix=AH32_ 映射）。
        # 不要读取全局环境变量 OPENAI_API_KEY / DASHSCOPE_API_KEY，避免被宿主环境污染。
        return value




    @field_validator("embedding_model", mode="after")
    @classmethod
    def _validate_embedding_model(cls, v):
        if v is None:
            raise ValueError("AH32_EMBEDDING_MODEL must be set in .env")
        value = str(v).strip()
        if not value:
            raise ValueError("AH32_EMBEDDING_MODEL must be set in .env")
        return value
    @field_validator("api_key", mode="after")

    @classmethod

    def _validate_api_key(cls, v):

        # 安全验证：API密钥不能为默认值

        if v == "test-key":

            logger.warning(

                "WARNING: Using default API key 'test-key' is insecure! "

                "Please set a secure API key in production!"

            )

        return v



    @field_validator("cors_allowed_origins", mode="after")

    @classmethod

    def _validate_cors_origins(cls, v):

        # 安全验证：CORS不允许使用通配符

        if v == ["*"] or "*" in v:

            logger.warning(

                "WARNING: CORS allowed origins contains '*' which allows all origins! "

                "This is insecure for production use. Please specify exact origins."

            )

        return v



    @field_validator("rate_limit_requests", mode="after")

    @classmethod

    def _validate_rate_limit_requests(cls, v):

        if v <= 0:

            raise ValueError("rate_limit_requests must be positive")

        return v



    @field_validator("rate_limit_window", mode="after")

    @classmethod

    def _validate_rate_limit_window(cls, v):

        if v <= 0:

            raise ValueError("rate_limit_window must be positive")

        return v



    @field_validator("cors_allowed_origins", mode="before")

    @classmethod

    def _parse_cors_origins(cls, v):

        """解析CORS来源配置，支持JSON字符串和列表"""

        import os

        env_value = os.getenv("AH32_CORS_ALLOWED_ORIGINS")

        if env_value:

            try:

                import json

                return json.loads(env_value)

            except (json.JSONDecodeError, TypeError):

                # 如果解析失败，尝试按逗号分割

                return [origin.strip() for origin in env_value.split(",")]

        return v if v is not None else []



    # --- 新增：是否在流中暴露 Agent 的内部思考（默认关闭） ---
    # --- ?????????? Agent ??????????? ---
    expose_agent_thoughts: bool = Field(
        default=False,
        description="?????????? Agent ???????? False??????",
    )

    expose_rag_hits: bool = Field(
        default=False,
        description="?????????? RAG ?????debug ???? False?",
    )



    @property

    def uploads_path(self) -> Path:

        return self.storage_root / self.uploads_dirname



    @property

    def embeddings_path(self) -> Path:

        return self.storage_root / self.embeddings_dirname

    @property
    def skills_vector_store_path(self) -> Path:
        return self.storage_root / self.skills_vector_dirname

    @property
    def memory_vector_store_path(self) -> Path:
        return self.storage_root / self.memory_vector_dirname



    @property

    def logs_path(self) -> Path:

        return self.storage_root / self.logs_dirname

    @property
    def doc_snapshots_path(self) -> Path:
        return self.storage_root / self.doc_snapshots_dirname

    @property
    def assets_path(self) -> Path:
        return self.storage_root / self.assets_dirname



    @field_validator("storage_root", mode="before")

    @classmethod

    def _expand_storage(cls, value: Path | str) -> Path:

        if isinstance(value, str):

            path = Path(value).expanduser()

            # 如果是相对路径，尝试从项目根目录计算

            if not path.is_absolute():

                # 获取当前配置文件的目录

                config_dir = Path(__file__).resolve().parent  # src/ah32

                # 向上查找项目根目录（包含.env的目录）

                project_root = config_dir

                for _ in range(5):  # 最多向上5级

                    if (project_root / ".env").exists():

                        break

                    project_root = project_root.parent



                # 如果找到.env文件，从项目根目录计算相对路径

                if (project_root / ".env").exists():

                    path = project_root / path

                else:

                    # 没找到，使用当前工作目录

                    path = path.resolve()



            return path

        return value



    @field_validator("conversation_store_path", "tasks_store_path", mode="before")

    @classmethod

    def _ensure_store_paths(cls, value: Path | str | None, info: ValidationInfo) -> Path:

        field_name = info.field_name

        values = info.data

        storage_root: Path = values.get("storage_root") or Path(__file__).resolve().parents[2] / "storage"

        if value:

            return Path(value).expanduser().resolve()

        default_name = "conversations.json" if field_name == "conversation_store_path" else "tasks.json"

        return (storage_root / "logs" / default_name).resolve()



    def ensure_directories(self) -> None:

        """Create storage directories if they don't exist."""

        for path in (
            self.storage_root,
            self.uploads_path,
            self.embeddings_path,
            self.skills_vector_store_path,
            self.memory_vector_store_path,
            self.logs_path,
            self.doc_snapshots_path,
            self.assets_path,
        ):

            path.mkdir(parents=True, exist_ok=True)

        for file_path in (self.conversation_store_path, self.tasks_store_path):

            if file_path:

                file_path.parent.mkdir(parents=True, exist_ok=True)



        # Optional runtime extension folders.

        try:

            if self.skills_dir:

                Path(self.skills_dir).mkdir(parents=True, exist_ok=True)

        except Exception:

            # Don't block startup on a non-critical folder.

            logger.warning(
                "[config] create skills_dir failed (ignored): %s",
                self.skills_dir,
                exc_info=True,
            )



        # Telemetry storage (optional; best-effort).

        try:

            if self.telemetry_sqlite_path:

                Path(self.telemetry_sqlite_path).parent.mkdir(parents=True, exist_ok=True)

        except Exception:

            logger.warning(
                "[config] create telemetry_sqlite_path parent failed (ignored): %s",
                self.telemetry_sqlite_path,
                exc_info=True,
            )



    def get_conversation_rule_file_paths(self) -> list[Path]:

        """Parse conversation_rule_files into Paths.



        If not configured, we auto-discover conventional rule docs in the user's

        Documents folder (so office users can edit them in WPS without touching code).

        """

        raw = (self.conversation_rule_files or "").strip()

        if not raw:

            root = _default_user_documents_dir() / "Ah32"

            candidates = [

                root / "rules.docx",

                root / "rules.md",

                root / "规则.docx",

                root / "规则.md",

                root / "rules.txt",

                root / "规则.txt",

            ]

            existing: list[Path] = []

            for p in candidates:

                try:

                    if p.exists() and p.is_file():

                        existing.append(p)

                except Exception:

                    logger.debug("[config] probe rule file failed (ignored): %s", p, exc_info=True)
                    continue

            return existing

        parts = [p.strip() for p in raw.replace("\n", ";").split(";") if p.strip()]

        out: list[Path] = []

        for p in parts:

            try:

                out.append(Path(p).expanduser())

            except Exception:

                logger.debug("[config] parse rule file path failed (ignored): %s", p, exc_info=True)
                continue

        return out



    def check_security_config(self) -> Dict[str, Any]:

        """检查安全配置并返回安全状态报告



        Returns:

            包含安全检查结果的字典

        """

        warnings = []

        errors = []



        # Check API key only when auth is enabled.

        if self.enable_auth:

            if self.api_key == "test-key" or self.api_key is None:

                warnings.append({

                    "type": "api_key",

                    "level": "HIGH",

                    "message": "API key is missing or using a default value."

                })

        else:

            warnings.append({

                "type": "auth",

                "level": "LOW",

                "message": "Auth is disabled (local-only mode)."

            })



        # 检查CORS配置

        if self.cors_allowed_origins == ["*"] or "*" in self.cors_allowed_origins:

            warnings.append({

                "type": "cors",

                "level": "HIGH",

                "message": "CORS配置允许所有来源，存在安全风险"

            })



        # Auth disabled is acceptable for local-only office integrations.



        # 检查速率限制

        if not self.rate_limit_enabled:

            warnings.append({

                "type": "rate_limit",

                "level": "MEDIUM",

                "message": "未启用速率限制，可能受到DDoS攻击"

            })



        # 生成安全评分

        security_score = 100

        for warning in warnings:

            if warning["level"] == "HIGH":

                security_score -= 30

            elif warning["level"] == "MEDIUM":

                security_score -= 10



        for error in errors:

            if error["level"] == "CRITICAL":

                security_score -= 50



        security_score = max(0, security_score)



        return {

            "security_score": security_score,

            "warnings": warnings,

            "errors": errors,

            "secure": len(errors) == 0 and security_score >= 80

        }



    def get_device(self) -> str:

        """Get the best available device (GPU or CPU)."""

        if not self.enable_gpu:

            return "cpu"



        # 检查GPU可用性

        try:

            import torch

            if torch.cuda.is_available():

                if self.gpu_device == "auto":

                    # 自动选择第一个GPU

                    return "cuda:0"

                else:

                    # 使用用户指定的设备

                    return self.gpu_device

            else:

                logger.info("CUDA不可用，使用CPU")

                return "cpu"

        except ImportError:

            logger.warning("PyTorch未安装，无法使用GPU加速")

            return "cpu"



    def get_embedding_device(self) -> str:

        """Get device for embedding models (can be different from main device)."""

        # 嵌入模型通常使用CPU，除非明确指定GPU

        if self.enable_gpu and self.gpu_device != "cpu":

            try:

                import torch

                if torch.cuda.is_available():

                    return self.gpu_device if self.gpu_device != "auto" else "cuda:0"

            except ImportError:

                pass

        return "cpu"





settings = Ah32Settings()

settings.ensure_directories()
