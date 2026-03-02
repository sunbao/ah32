FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps: keep minimal; add curl for optional healthcheck/debugging.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Allow overriding pip index in environments where pypi.org is slow/unreachable.
# Default to Aliyun mirror (common for CN networks); override via build-arg if needed.
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TORCH_INDEX_URL=${PIP_TORCH_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install python deps first for better layer caching.
COPY pyproject.toml /app/pyproject.toml

# NOTE: do not blindly upgrade pip in Docker builds.
# New pip releases may hit resolver limits (e.g. "resolution-too-deep") with our broad deps.
#
# To keep rebuilds fast, install dependencies in a layer keyed only by `pyproject.toml`.
# Then copy the source and install the project with `--no-deps` (so code changes won't
# trigger a full dependency reinstall).
# `sentence-transformers` pulls `torch`; installing `torch` from PyPI brings huge CUDA deps.
# Prefer a CPU-only torch wheel from the official index to keep image size/build time sane.
RUN python -m pip install --no-cache-dir -U setuptools wheel \
    && python -c "import tomllib; from pathlib import Path; data = tomllib.loads(Path('pyproject.toml').read_text(encoding='utf-8')); deps = data.get('project', {}).get('dependencies', []); Path('/tmp/requirements.txt').write_text('\\n'.join(deps) + '\\n', encoding='utf-8')" \
    && if grep -Eq '^sentence-transformers' /tmp/requirements.txt 2>/dev/null; then \
         python -m pip install --no-cache-dir --index-url "${PIP_TORCH_INDEX_URL}" --extra-index-url "${PIP_INDEX_URL}" torch \
           || echo "WARN: failed to install CPU torch from ${PIP_TORCH_INDEX_URL}; continuing with default resolver (may download large CUDA wheels)."; \
       fi \
    && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

COPY README.md /app/README.md
COPY LICENSE /app/LICENSE
COPY src /app/src

RUN python -m pip install --no-cache-dir --no-deps .

COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

EXPOSE 5123

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "-m", "ah32.server.main"]
