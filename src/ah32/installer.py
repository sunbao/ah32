"""Minimal first-run installer.

The Windows installer (Inno Setup) is the recommended way to provision config.
This module is a fallback for "portable" distributions or when the executable
is launched without a `.env` present.
"""

from __future__ import annotations

from pathlib import Path

from ah32.runtime_paths import runtime_root


def _upsert_env(text: str, key: str, value: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    found = False
    prefix = f"{key}="
    for line in lines:
        if line.startswith(prefix):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    return "\n".join(out).strip() + "\n"


def main() -> None:
    root = runtime_root()
    env_example = root / ".env.example"
    env_file = root / ".env"

    if env_file.exists():
        return

    template = env_example.read_text(encoding="utf-8") if env_example.exists() else ""

    text = template
    text = _upsert_env(text, "AH32_SERVER_HOST", "127.0.0.1")
    text = _upsert_env(text, "AH32_SERVER_PORT", "5123")
    text = _upsert_env(text, "AH32_ENABLE_AUTH", "false")
    text = _upsert_env(text, "AH32_API_KEY", "")

    env_file.write_text(text, encoding="utf-8")

    # Also emit a frontend runtime config template next to the executable when possible.
    # The WPS plugin installer writes the actual `config.js` into the plugin folder.
    config_hint = root / "CONFIG_GENERATED.txt"
    config_hint.write_text(
        "Generated .env (port=5123, auth disabled).\n"
        "Configure DEEPSEEK_API_KEY in .env before using chat.\n"
        "If you use the bundled WPS plugin, run install-wps-plugin.ps1 to generate config.js.\n",
        encoding="utf-8",
    )
