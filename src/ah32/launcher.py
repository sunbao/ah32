#!/usr/bin/env python3

from __future__ import annotations

"""
AH32 launcher.

Used by PyInstaller packaging (`-m ah32.launcher`) to produce a runnable backend
executable for Windows/Linux/macOS.

Design goals:
- No silent fallbacks: fail fast on missing config and log stack traces.
- Works in editable installs and PyInstaller bundles.
"""

import logging
import os
import sys
from pathlib import Path

from ah32.runtime_paths import runtime_root

_reconfigure_exc_info = None
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    _reconfigure_exc_info = sys.exc_info()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(filename)s:%(lineno)d - %(message)s",
    handlers=[logging.FileHandler("ah32_launcher.log", encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)
if _reconfigure_exc_info:
    logger.warning("[launcher] stdout/stderr reconfigure failed (ignored)", exc_info=_reconfigure_exc_info)
    _reconfigure_exc_info = None


def _can_interact() -> bool:
    try:
        if hasattr(sys.stdin, "isatty") and sys.stdin.isatty():
            return True
        if getattr(sys, "frozen", False):
            return False
        return True
    except Exception:
        logger.debug("[launcher] stdin probe failed (ignored)", exc_info=True)
        return False


def _wait_for_exit(message: str = "按回车键退出...") -> None:
    if _can_interact():
        try:
            input(message)
        except Exception:
            logger.debug("[launcher] wait for input failed (ignored)", exc_info=True)
        return

    # In a no-console PyInstaller exe, pause briefly so users can see the last logs.
    try:
        import time

        logger.info("[launcher] 即将退出（3 秒）...")
        time.sleep(3)
    except Exception:
        return


def _load_env_strict() -> Path:
    """Load `.env` from runtime_root; required for a usable backend."""
    try:
        from dotenv import load_dotenv
    except ImportError as e:
        raise RuntimeError("Missing dependency: python-dotenv") from e

    env_file = runtime_root() / ".env"
    if not env_file.exists():
        raise RuntimeError(f".env file not found: {env_file}. Please copy .env.example to .env.")

    load_dotenv(env_file, override=True)
    if not os.environ.get("AH32_EMBEDDING_MODEL"):
        raise RuntimeError("AH32_EMBEDDING_MODEL is missing in .env; please configure it.")
    return env_file


def _check_embedding_model() -> None:
    """Resolve embedding to ensure config is consistent (no silent downgrades)."""
    from ah32.config import settings
    from ah32.knowledge.embeddings import resolve_embedding

    logger.info("[launcher] storage_root=%s", settings.storage_root)
    logger.info("[launcher] embedding_model=%s", settings.embedding_model)
    logger.info("[launcher] llm_model=%s", settings.llm_model)

    resolve_embedding(settings)


def main() -> None:
    logger.info("[launcher] AH32 launcher starting...")

    try:
        env_file = _load_env_strict()
        logger.info("[launcher] loaded config: %s", env_file)
    except Exception as e:
        logger.error("[launcher] config load failed: %s", e, exc_info=True)
        _wait_for_exit()
        return

    try:
        _check_embedding_model()
    except Exception as e:
        logger.error("[launcher] embedding config check failed: %s", e, exc_info=True)
        _wait_for_exit()
        return

    # Start the backend in-process. In a PyInstaller bundle, there is no separate
    # python interpreter + source tree to run `server/main.py` via subprocess.
    try:
        from ah32.server.main import run

        run()
    except Exception as e:
        logger.error("[launcher] backend crashed: %s", e, exc_info=True)
        _wait_for_exit()
        return


if __name__ == "__main__":
    main()
