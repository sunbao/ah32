#!/usr/bin/env sh
set -eu

cd /app

mkdir -p storage

# main.py currently requires a .env file to exist at runtime_root()/.env.
# In Docker, generate a minimal one if missing (do not override user-provided .env).
if [ ! -f "/app/.env" ]; then
  # If the repo has a local .env, mount it into the container as /app/.env.host and
  # we will derive /app/.env from it (so secrets remain local, but docker-safe overrides apply).
  if [ -f "/app/.env.host" ]; then
    # Copy while removing keys we override for Docker.
    sed -E \
      -e '/^(export[[:space:]]+)?AH32_SERVER_HOST=/d' \
      -e '/^(export[[:space:]]+)?AH32_SERVER_PORT=/d' \
      /app/.env.host > /app/.env

    {
      printf '\n# Docker overrides\n'
      printf 'AH32_SERVER_HOST=0.0.0.0\n'
      printf 'AH32_SERVER_PORT=5123\n'
    } >> /app/.env
  else
    cat > /app/.env <<'EOF'
# Auto-generated minimal .env for Docker (safe defaults; override by mounting /app/.env.host).
AH32_SERVER_HOST=0.0.0.0
AH32_SERVER_PORT=5123

# Storage
AH32_STORAGE_ROOT=storage
AH32_MEMORY_ROOT=storage/memory

# LLM defaults (required by some legacy agentic warmups)
AH32_LLM_MODEL=deepseek-reasoner
AH32_LLM_TEMPERATURE=0.2

# Embeddings
AH32_EMBEDDING_MODEL=BAAI/bge-m3
EOF
  fi

  # Best-effort append defaults if missing in the derived file.
  if ! grep -Eq '^(export[[:space:]]+)?AH32_LLM_MODEL=' /app/.env; then
    printf '\nAH32_LLM_MODEL=deepseek-reasoner\n' >> /app/.env
  fi
  if ! grep -Eq '^(export[[:space:]]+)?AH32_LLM_TEMPERATURE=' /app/.env; then
    printf 'AH32_LLM_TEMPERATURE=0.2\n' >> /app/.env
  fi
  if ! grep -Eq '^(export[[:space:]]+)?AH32_EMBEDDING_MODEL=' /app/.env; then
    printf 'AH32_EMBEDDING_MODEL=BAAI/bge-m3\n' >> /app/.env
  fi

  # Helper: get last value for KEY=... from /app/.env (no eval).
  env_get() {
    _key="$1"
    _file="$2"
    _raw="$(grep -E "^(export[[:space:]]+)?${_key}=" "$_file" 2>/dev/null | tail -n 1 | sed -E "s/^(export[[:space:]]+)?${_key}=//" || true)"
    _raw="$(printf %s "$_raw" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    printf %s "$_raw"
  }

  STORAGE_ROOT="$(env_get AH32_STORAGE_ROOT /app/.env || true)"
  if [ -z "$STORAGE_ROOT" ]; then
    STORAGE_ROOT="storage"
  fi
  EMBEDDING_MODEL="$(env_get AH32_EMBEDDING_MODEL /app/.env || true)"
  if [ -z "$EMBEDDING_MODEL" ]; then
    EMBEDDING_MODEL="BAAI/bge-m3"
  fi

  # Resolve storage root to an absolute path for probes.
  case "$STORAGE_ROOT" in
    /*) STORAGE_ROOT_ABS="$STORAGE_ROOT" ;;
    *) STORAGE_ROOT_ABS="/app/$STORAGE_ROOT" ;;
  esac

  MODEL_SAFE="$(printf %s "$EMBEDDING_MODEL" | sed 's|/|--|g')"
  MODEL_DIR="${STORAGE_ROOT_ABS}/models/models--${MODEL_SAFE}"

  # If the model is already cached under storage, prefer offline to avoid long network retries on startup.
  HF_HUB_OFFLINE_VALUE="0"
  TRANSFORMERS_OFFLINE_VALUE="0"
  if [ -d "${MODEL_DIR}/snapshots" ]; then
    HF_HUB_OFFLINE_VALUE="1"
    TRANSFORMERS_OFFLINE_VALUE="1"
  fi

  if ! grep -Eq '^(export[[:space:]]+)?HF_ENDPOINT=' /app/.env; then
    printf '\nHF_ENDPOINT=https://hf-mirror.com\n' >> /app/.env
  fi
  if ! grep -Eq '^(export[[:space:]]+)?HF_HUB_OFFLINE=' /app/.env; then
    printf 'HF_HUB_OFFLINE=%s\n' "$HF_HUB_OFFLINE_VALUE" >> /app/.env
  fi
  if ! grep -Eq '^(export[[:space:]]+)?TRANSFORMERS_OFFLINE=' /app/.env; then
    printf 'TRANSFORMERS_OFFLINE=%s\n' "$TRANSFORMERS_OFFLINE_VALUE" >> /app/.env
  fi
fi

exec "$@"
