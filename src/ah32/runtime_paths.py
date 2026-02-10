"""Runtime path helpers.

This project is sometimes packaged via PyInstaller. In that case, `__file__`
paths point inside the bundle/temporary extraction, so we use `sys.executable`
to locate the runtime root.
"""

from __future__ import annotations

import sys
from pathlib import Path


def runtime_root() -> Path:
    """Return the runtime root directory for config/data lookup."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]

