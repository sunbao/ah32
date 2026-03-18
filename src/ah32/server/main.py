"""FastAPI entry point for Ah32."""

from __future__ import annotations

import locale
import logging
import sys
import os
# ========== Startup Port Cleanup ==========
def cleanup_port(port: int = 5123):
    """Best-effort cleanup for the fixed backend port on Windows."""
    log = logging.getLogger(__name__)
    import time
    import socket
    import subprocess

    def is_port_in_use(port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(2)
                return s.connect_ex(("127.0.0.1", port)) == 0
        except Exception:
            log.exception("port availability check failed", exc_info=True)
            return False

    if not is_port_in_use(port):
        log.info("port %s is available", port)
        return

    log.info("port %s is in use; trying cleanup", port)
    if not sys.platform.startswith("win"):
        log.warning("port %s is busy and automatic cleanup is only supported on Windows", port)
        return

    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            encoding="gbk",
            errors="ignore",
        )
        for line in result.stdout.splitlines():
            row = line.strip()
            if f":{port}" not in row or "LISTENING" not in row:
                continue
            parts = row.split()
            if len(parts) < 5:
                continue
            pid = parts[-1]
            if not pid.isdigit():
                continue
            try:
                log.info("terminating process on port %s pid=%s", port, pid)
                subprocess.run(["taskkill", "/F", "/PID", pid], check=False, capture_output=True)
            except Exception as exc:
                log.error("failed to terminate pid=%s on port %s: %s", pid, port, exc)
            break
        time.sleep(2)
        if is_port_in_use(port):
            log.warning("port %s is still busy after cleanup", port)
        else:
            log.info("port %s released", port)
    except Exception as exc:
        log.error("cleanup_port failed for %s: %s", port, exc)


# Run once before app startup.
cleanup_port(5123)
# ============================================================
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

# Load core settings after environment bootstrap.
from ah32.config import settings
from ah32.runtime_paths import runtime_root
from ah32.knowledge.chroma_utils import make_collection_name
from ah32.knowledge.embeddings import resolve_embedding, check_embedding_model_ready
from ah32.knowledge.store import LocalVectorStore
from ah32.services.models import load_llm

from ah32.server.agentic_chat_api import router as agentic_chat_router  # Agentic chat API
from ah32.server.document_monitor import router as document_monitor_router  # Document sync API
from ah32.server.rag_api import router as rag_router  # RAG鐭ヨ瘑搴揂PI
from ah32.server.memory_api import router as memory_router  # 璁板繂鍐欏叆/璇诲彇API
from ah32.server.metrics_api import router as metrics_router  # Metrics export API
from ah32.server.audit_api import router as audit_router  # Audit API
from ah32.server.runtime_config_api import router as runtime_config_router  # Frontend-safe runtime flags
from ah32.server.telemetry_api import router as telemetry_router  # Telemetry ingest
from ah32.server.doc_snapshot_api import router as doc_snapshot_router  # Ephemeral doc snapshot API (v1)
from ah32.server.asset_api import router as asset_router  # Ephemeral asset store (v1)
from ah32.server.mm_api import router as mm_router  # Multimodal provider APIs (v1)
from ah32.server.auth_api import router as auth_router  # JWT token issuance (v1)
from ah32.server.tenant_user_api import router as tenant_user_router  # Tenant user allowlist (minimal)

from ah32.agents.agentic_coordinator import get_coordinator  # 闃胯洡锛圓H32锛夊崗璋冨櫒
from ah32.services.tasks import ConversationRepository, TaskRepository

# Note: avoid re-configuring logging handlers here.
# Logging is configured once at module startup above (including trace/tenant fields).
# Noisy dependency debug logs are controlled by AH32_HTTP_DEBUG.

# Even when LOG_LEVEL=DEBUG, keep LangSmith log spam down; tracing can still be enabled via env.
_langsmith_log_level = os.environ.get("AH32_LANGSMITH_LOG_LEVEL", "WARNING").upper()
_langsmith_level_value = getattr(logging, _langsmith_log_level, logging.WARNING)
logging.getLogger("langsmith").setLevel(_langsmith_level_value)
logging.getLogger("langsmith.client").setLevel(_langsmith_level_value)

logger = logging.getLogger(__name__)
log = logger

# ========== Lifespan浜嬩欢绠＄悊 ==========
@asynccontextmanager
async def lifespan(app: FastAPI):
    """搴旂敤鐢熷懡鍛ㄦ湡绠＄悊"""
    log.info("姝ｅ湪鍚姩Ah32鏈嶅姟...")
    
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
                log.info(f"[telemetry] enabled={caps.get('mode') != 'off'} caps={caps}")
            except Exception as e:
                log.warning(f"[telemetry] caps log failed: {e}", exc_info=True)
        except Exception as e:
            log.error(f"[telemetry] init failed: {e}", exc_info=True)
            try:
                from ah32.telemetry import set_telemetry

                set_telemetry(None)
            except Exception:
                log.error("[telemetry] disable failed", exc_info=True)

        # 楠岃瘉瀹夊叏閰嶇疆
        security_report = settings.check_security_config()
        if not security_report["secure"]:
            log.warning(f"瀹夊叏閰嶇疆妫€鏌ョ粨鏋?- 璇勫垎: {security_report['security_score']}/100")
            for warning in security_report["warnings"]:
                log.warning(f"瀹夊叏璀﹀憡 [{warning['level']}]: {warning['message']}")
            for error in security_report["errors"]:
                log.error(f"瀹夊叏閿欒 [{error['level']}]: {error['message']}")

        # Seed demo tenants + users (R&D convenience).
        # This makes the on-disk JSON formats visible and enables quick manual testing.
        try:
            import json
            import time
            from pathlib import Path

            from ah32.security.keyring import get_tenant_keyring
            from ah32.tenancy.user_registry import get_tenant_user_registry

            # Allow overriding seed tenants/users for automation, but keep a sensible default.
            # Defaults: 3 tenants, each with 5 users.
            seed_tenants_raw = str(os.environ.get("AH32_SEED_TENANTS", "") or "").strip()
            if seed_tenants_raw:
                seed_tenants = [x.strip() for x in seed_tenants_raw.split(",") if x.strip()]
            else:
                seed_tenants = ["demo-a", "demo-b", "demo-c"]

            seed_user_prefix = str(os.environ.get("AH32_SEED_USER_PREFIX", "user") or "user").strip() or "user"
            seed_user_count = 5
            try:
                seed_user_count = int(os.environ.get("AH32_SEED_USER_COUNT") or "5")
                seed_user_count = max(1, min(seed_user_count, 50))
            except Exception:
                seed_user_count = 5

            # Per-tenant api keys.
            # - If you want explicit keys, set AH32_SEED_TENANT_KEYS as "demo-a=key1,demo-b=key2".
            # - Otherwise keys default to "<tenant_id>-key".
            seed_keys_raw = str(os.environ.get("AH32_SEED_TENANT_KEYS", "") or "").strip()
            seed_keys = {}
            if seed_keys_raw:
                for pair in [x.strip() for x in seed_keys_raw.split(",") if x.strip()]:
                    if "=" not in pair:
                        continue
                    k, v = pair.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if k and v:
                        seed_keys[k] = v

            # 1) Tenant api-key keyring seed: storage/tenants/keyring.json
            kr = get_tenant_keyring()
            keyring_path = Path(getattr(kr, "path", settings.storage_root / "tenants" / "keyring.json"))
            try:
                keyring_path.parent.mkdir(parents=True, exist_ok=True)
                if keyring_path.exists():
                    try:
                        raw = keyring_path.read_text(encoding="utf-8")
                        keyring_obj = json.loads(raw) if raw.strip() else {}
                        if not isinstance(keyring_obj, dict):
                            keyring_obj = {}
                    except Exception:
                        keyring_obj = {}
                else:
                    keyring_obj = {}

                tenants_obj = keyring_obj.get("tenants") if isinstance(keyring_obj.get("tenants"), dict) else {}
                if not isinstance(tenants_obj, dict):
                    tenants_obj = {}

                changed = False
                for tid in seed_tenants[:20]:
                    key = seed_keys.get(tid) or f"{tid}-key"
                    if tid not in tenants_obj or not isinstance(tenants_obj.get(tid), dict) or not str(tenants_obj.get(tid, {}).get("api_key") or "").strip():
                        tenants_obj[tid] = {"api_key": key}
                        changed = True

                if changed or not keyring_path.exists():
                    keyring_obj["schema_version"] = keyring_obj.get("schema_version") or "ah32.tenant_keyring.v1"
                    keyring_obj["updated_at"] = int(time.time())
                    keyring_obj["tenants"] = tenants_obj
                    keyring_path.write_text(json.dumps(keyring_obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    log.info("[seed] ensured tenant keyring: %s tenants=%s", keyring_path, len(tenants_obj))
            except Exception as e:
                log.error("[seed] ensure keyring failed path=%s err=%s", keyring_path, e, exc_info=True)

            # 2) Tenant user allowlist seed (only triggers when policy file exists)
            reg = get_tenant_user_registry()
            for tid in seed_tenants[:20]:
                try:
                    # Create the policy file (enforcement ON) if missing, and add a small user set.
                    # Keep it idempotent: upsert is safe.
                    if not reg.policy_exists(tid):
                        note = "seeded for R&D; edit storage/tenants/<tenant_id>/policy/users.json"
                    else:
                        note = ""

                    for i in range(1, seed_user_count + 1):
                        uid = f"{seed_user_prefix}{i}"
                        reg.upsert_user(tid, uid, enabled=True, note=note)
                    log.info("[seed] ensured tenant users policy (enforced): tenant=%s users=%s", tid, seed_user_count)
                except Exception as e:
                    log.error("[seed] ensure users policy failed tenant=%s err=%s", tid, e, exc_info=True)
        except Exception:
            log.error("[seed] demo tenant/user seed failed", exc_info=True)
        
        # 鍒濆鍖栨湇鍔?        # Embedding preflight: fail fast in offline mode if the local cache is incomplete.
        offline = os.environ.get("HF_HUB_OFFLINE") == "1" or os.environ.get("TRANSFORMERS_OFFLINE") == "1"
        ok, msg = check_embedding_model_ready(settings)
        if ok:
            log.info(f"[embedding self-check] {msg}")
        else:
            if offline:
                log.error(f"[embedding self-check] {msg}")
                raise RuntimeError(msg)
            log.warning(f"[embedding self-check] {msg}")

        app.state._embedding = resolve_embedding(settings)  # 淇璋冪敤鍙傛暟

        # Allow the service to start even if the LLM key is not configured yet.
        # The client can set DEEPSEEK_API_KEY after installation and restart the backend.
        try:
            app.state._llm = load_llm(settings)
        except ValueError as e:
            log.warning(f"[llm] not configured: {e}")
            app.state._llm = None

        embedding_dim = None
        try:
            # One-time probe; avoids Chroma dimension mismatch when switching models.
            embedding_dim = len(app.state._embedding.embed_query("dimension_probe"))
        except Exception as e:
            log.warning(f"[embedding] dimension probe failed (will use model-only collection name): {e}")

        # Tenant-scoped vector stores (RAG / skills routing / memory).
        try:
            from ah32.tenancy.vector_store_registry import TenantVectorStoreRegistry

            app.state._tenant_vector_stores = TenantVectorStoreRegistry(
                storage_root=settings.storage_root,
                embedding=app.state._embedding,
                embedding_model=settings.embedding_model,
                embedding_dim=embedding_dim,
            )
        except Exception as e:
            log.error("[tenant] init TenantVectorStoreRegistry failed: %s", e, exc_info=True)
            app.state._tenant_vector_stores = None

        # Tenant-scoped skills registries (prompt-only; server-managed).
        default_tenant_id = str(getattr(settings, "default_tenant_id", "public") or "public").strip() or "public"
        try:
            from ah32.tenancy.skills_registry_manager import TenantSkillsRegistryManager

            app.state._tenant_skills_registry = TenantSkillsRegistryManager(
                storage_root=settings.storage_root,
                max_total_chars=settings.skills_max_chars,
                tenant_vector_stores=getattr(app.state, "_tenant_vector_stores", None),
            )
            # Convenience pointer for legacy call-sites (default tenant only).
            app.state._skills_registry = app.state._tenant_skills_registry.get(default_tenant_id)
        except Exception as e:
            log.error("[skills] init TenantSkillsRegistryManager failed: %s", e, exc_info=True)
            app.state._tenant_skills_registry = None
            app.state._skills_registry = None

        rag_collection_name = make_collection_name(
            "ah32_rag",
            settings.embedding_model,
            embedding_dim=embedding_dim,
        )

        # Skills routing vector store (persistent, separate from RAG/memory to avoid
        # cross-workload contention). The SkillRegistry will use it for similarity
        # routing and keep it in sync with hot-loaded skills.
        try:
            # Backward-compatible default instance for server-managed skills routing (dev fallback).
            if getattr(app.state, "_tenant_vector_stores", None) is not None:
                app.state._skills_vector_store = app.state._tenant_vector_stores.get_skills_routing_store(default_tenant_id)
            else:
                skills_collection_name = make_collection_name(
                    "skills",
                    settings.embedding_model,
                    embedding_dim=embedding_dim,
                )
                app.state._skills_vector_store = LocalVectorStore(
                    persist_path=settings.skills_vector_store_path,
                    embedding=app.state._embedding,
                    config={
                        "collection_name": skills_collection_name,
                        "collection_metadata": {
                            "embedding_model": settings.embedding_model,
                            "embedding_dim": embedding_dim,
                            # Explicitly prefer cosine for short "routing_text" embeddings.
                            "hnsw:space": "cosine",
                        },
                    },
                )
            try:
                if app.state._skills_registry is not None and hasattr(
                    app.state._skills_registry, "set_routing_vector_store"
                ):
                    app.state._skills_registry.set_routing_vector_store(app.state._skills_vector_store)
            except Exception as e:
                log.warning(f"[skills] attach routing vector store failed (ignored): {e}")
        except Exception as e:
            log.warning(f"[skills] init routing vector store failed (ignored): {e}")

        if getattr(app.state, "_tenant_vector_stores", None) is not None:
            app.state._vector_store = app.state._tenant_vector_stores.get_rag_store(default_tenant_id)
        else:
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
        # Initialize the coordinator only when an LLM is available.
        if app.state._llm is not None:
            from ah32.agents.agentic_coordinator import get_coordinator
            get_coordinator(app.state._vector_store)
        else:
            log.warning('[llm] coordinator init skipped at startup because LLM is not configured')

        app.state._tasks = TaskRepository(settings.tasks_store_path)
        app.state._conversations = ConversationRepository(settings.conversation_store_path)
        
        log.info("Ah32鏈嶅姟鍚姩瀹屾垚")
        yield
        
    except Exception as e:
        log.error(f"Ah32鏈嶅姟鍚姩澶辫触: {e}", exc_info=True)
        raise
    finally:
        log.info("姝ｅ湪鍏抽棴Ah32鏈嶅姟...")
        # Stop telemetry last so shutdown events can still be flushed.
        try:
            from ah32.telemetry import get_telemetry, set_telemetry

            tsvc = get_telemetry()
            if tsvc:
                tsvc.stop()
            set_telemetry(None)
        except Exception as e:
            log.error(f"[telemetry] stop failed: {e}", exc_info=True)

        # 鍦ㄨ繖閲屽彲浠ユ坊鍔犳竻鐞嗚祫婧愮殑浠ｇ爜
        log.info("Ah32 service stopped")


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
                log.debug("[wps-plugin] probe dir failed (ignored): %s", p, exc_info=True)
                continue
    except Exception:
        log.warning("[wps-plugin] resolve dir failed (ignored)", exc_info=True)
        return None
    return None


# Serve the bundled plugin so modern WPS builds can load it via `%APPDATA%/.../publish.xml`.
_wps_plugin_dir = _resolve_wps_plugin_dir()
if _wps_plugin_dir:
    app.mount("/wps-plugin", StaticFiles(directory=_wps_plugin_dir, html=True), name="wps-plugin")
# ========== 鍚姩鍏ㄥ眬鏈嶅姟 ==========
# 娉ㄦ剰锛氱幆澧冩劅鐭ュ姛鑳藉凡绉婚櫎

# Add permissive CORS for the desktop taskpane/dev environment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)
@app.middleware("http")
async def _trace_and_tenancy(request: Request, call_next):
    """Attach trace_id and enforce tenant/user/auth context for /agentic/* endpoints."""
    path = str(request.url.path or "")
    trace_id = (
        str(request.headers.get("X-AH32-Trace-Id") or "").strip()
        or str(request.headers.get("X-Trace-Id") or "").strip()
        or uuid.uuid4().hex
    )
    try:
        request.state.trace_id = trace_id
    except Exception:
        pass

    # Bind trace_id globally (best-effort).
    try:
        from ah32.tenancy.context import set_trace_id

        set_trace_id(trace_id)
    except Exception:
        pass

    diag_plan_path = path in ("/agentic/plan/generate", "/agentic/plan/repair")
    if diag_plan_path:
        try:
            log.info("[middleware] plan request start path=%s trace_id=%s", path, trace_id)
        except Exception:
            pass

    if path.startswith("/agentic"):
        try:
            from ah32.security.request_context import bind_tenancy_for_request

            with bind_tenancy_for_request(request, trace_id=trace_id):
                response = await call_next(request)
        except HTTPException as e:
            return JSONResponse(
                status_code=int(getattr(e, "status_code", 500) or 500),
                content={"ok": False, "error": getattr(e, "detail", str(e)), "trace_id": trace_id},
            )
        except Exception as e:
            log.error("[middleware] agentic request failed: %s", e, exc_info=True)
            return JSONResponse(status_code=500, content={"ok": False, "error": str(e), "trace_id": trace_id})
    else:
        response = await call_next(request)

    try:
        response.headers["X-AH32-Trace-Id"] = trace_id
    except Exception:
        pass
    if diag_plan_path:
        try:
            log.info(
                "[middleware] plan request end path=%s trace_id=%s status=%s",
                path,
                trace_id,
                getattr(response, "status_code", "unknown"),
            )
        except Exception:
            pass
    return response

# 娉ㄥ唽璺敱 - 绾疉gentic妯″紡
app.include_router(auth_router)  # JWT token issuance
app.include_router(agentic_chat_router)  # 鍞竴鐢ㄦ埛鍏ュ彛
app.include_router(document_monitor_router)  # 鏂囨。鍚屾API
app.include_router(rag_router)  # RAG鐭ヨ瘑搴揂PI
app.include_router(memory_router)  # 鐢ㄦ埛纭寮忚蹇嗗啓鍏?璇诲彇
app.include_router(metrics_router)  # Metrics export
app.include_router(audit_router)  # Audit export
app.include_router(runtime_config_router)  # Frontend-safe runtime flags
app.include_router(telemetry_router)  # Telemetry ingest/query (query gated by AH32_ENABLE_DEV_ROUTES)
app.include_router(doc_snapshot_router)  # Ephemeral doc snapshot transport
app.include_router(asset_router)  # Ephemeral generated assets (images)
app.include_router(mm_router)  # Multimodal APIs (vision/image gen)
app.include_router(tenant_user_router)  # Tenant user allowlist (minimal)
if settings.enable_dev_routes:
    # Dev-only telemetry UI/query; keep this out of the core server package so it can be excluded.
    from ah32.dev.telemetry_dev_api import router as telemetry_dev_router

    app.include_router(telemetry_dev_router)

    # Dev-only tenant skills mutation helpers (gated by AH32_ENABLE_DEV_ROUTES=true).
    from ah32.dev.skills_dev_api import router as skills_dev_router

    app.include_router(skills_dev_router)


# 瀹夊叏閰嶇疆
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
authorization_header = APIKeyHeader(name="Authorization", auto_error=False)

@app.get("/health")
async def health_check():
    """Health endpoint."""
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

    enable_reload = os.environ.get("RELOAD", "false").lower() in ("true", "1", "yes")
    reload_dirs = None
    if enable_reload:
        from pathlib import Path
        current_dir = Path.cwd()
        reload_dirs = [str(current_dir / "src")]

    uvicorn.run(
        "ah32.server.main:app",
        host=settings.server_host,
        port=settings.server_port,
        reload=enable_reload,
        reload_dirs=reload_dirs,
        timeout_keep_alive=1800,
        timeout_graceful_shutdown=60,
        timeout_worker_healthcheck=1800,
        lifespan="on",
        loop="auto",
        http="auto",
        access_log=False,
    )


if __name__ == "__main__":
    run()



