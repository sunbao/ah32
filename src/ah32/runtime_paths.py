"""Runtime path helpers.

This project is sometimes packaged via PyInstaller. In that case, `__file__`
paths point inside the bundle/temporary extraction, so we use `sys.executable`
to locate the runtime root.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def runtime_root() -> Path:
    """Return the runtime root directory for config/data lookup."""
    override = os.getenv("AH32_RUNTIME_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent

    # Prefer the current working directory when it looks like a checkout/runtime root.
    # This matters for Docker images that `pip install` the package into site-packages:
    # `__file__` then lives under /usr/local/lib/... and is not a suitable runtime root.
    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if (candidate / ".env").exists() or (candidate / "pyproject.toml").exists():
            return candidate

    # Fallback: in editable installs this still points to the repo root.
    return Path(__file__).resolve().parents[2]
