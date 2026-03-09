from __future__ import annotations

import argparse
import re
from pathlib import Path


_DEFAULT_TEXT_EXTS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".vue",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".txt",
    ".ps1",
}


def _iter_files(paths: list[Path], *, exts: set[str]) -> list[Path]:
    skip_dirs = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        ".venv_release_test",
        "dist",
        "build",
        "storage",
        "logs",
        "htmlcov",
        "data",
    }
    out: list[Path] = []
    for p in paths:
        if p.is_file():
            if p.suffix.lower() in exts:
                out.append(p)
            continue
        if not p.exists():
            continue
        for child in p.rglob("*"):
            if not child.is_file():
                continue
            if any(part in skip_dirs for part in child.parts):
                continue
            if child.suffix.lower() not in exts:
                continue
            out.append(child)
    return sorted(set(out), key=lambda x: str(x).lower())


def _check_utf8_decode(paths: list[Path]) -> list[str]:
    failures: list[str] = []
    for p in paths:
        try:
            p.read_text(encoding="utf-8")
        except Exception as exc:
            failures.append(f"not-utf8: {p} ({type(exc).__name__}: {exc})")
    return failures


def _check_crcrlf(paths: list[Path]) -> list[str]:
    failures: list[str] = []
    for p in paths:
        try:
            b = p.read_bytes()
        except Exception as exc:
            failures.append(f"read-failed: {p} ({type(exc).__name__}: {exc})")
            continue
        if b"\r\r\n" in b:
            failures.append(f"crcrlf: {p}")
    return failures


def _check_sse_charset(repo_root: Path) -> list[str]:
    """Static guardrails: ensure SSE endpoints declare charset=utf-8."""
    failures: list[str] = []
    files = [
        repo_root / "src" / "ah32" / "server" / "agentic_chat_api.py",
        repo_root / "src" / "ah32" / "server" / "rag_api.py",
    ]
    bad = re.compile(r"media_type\s*=\s*([\"'])text/event-stream\1")
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            failures.append(f"sse-scan-failed: {p} ({type(exc).__name__}: {exc})")
            continue
        if bad.search(text):
            failures.append(f"sse-missing-charset: {p}")
    return failures


def _check_json_charset(repo_root: Path) -> list[str]:
    """Static guardrails: ensure backend uses UTF-8 JSON response class on error paths."""
    failures: list[str] = []
    p = repo_root / "src" / "ah32" / "server" / "main.py"
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return [f"json-scan-failed: {p} ({type(exc).__name__}: {exc})"]

    if "application/json; charset=utf-8" not in text:
        failures.append(f"json-missing-charset-response-class: {p}")

    # We want error paths to use UTF8JSONResponse, not bare JSONResponse.
    if re.search(r"\breturn\s+JSONResponse\s*\(", text):
        failures.append(f"json-error-path-uses-jsonresponse: {p}")

    return failures


def main() -> None:
    ap = argparse.ArgumentParser(description="Repo self-check: UTF-8 decode + newline corruption + charset guardrails.")
    ap.add_argument(
        "paths",
        nargs="*",
        help="Paths to scan (default: src ah32-ui-next/src start.py scripts).",
    )
    ap.add_argument(
        "--ext",
        action="append",
        default=[],
        help="Extra file extension(s) to include, e.g. --ext .ini",
    )
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    scan_paths = [Path(p) for p in (args.paths or ["src", "ah32-ui-next/src", "start.py", "scripts"])]
    scan_paths = [p if p.is_absolute() else (repo_root / p) for p in scan_paths]

    exts = set(_DEFAULT_TEXT_EXTS)
    for e in args.ext or []:
        s = str(e).strip()
        if not s:
            continue
        exts.add(s if s.startswith(".") else f".{s}")

    files = _iter_files(scan_paths, exts=exts)
    failures: list[str] = []
    failures += _check_utf8_decode(files)
    failures += _check_crcrlf(files)
    failures += _check_sse_charset(repo_root)
    failures += _check_json_charset(repo_root)

    if failures:
        print("[FAIL] UTF-8 IO check failed:")
        for line in failures[:200]:
            print(f"- {line}")
        if len(failures) > 200:
            print(f"... {len(failures) - 200} more")
        raise SystemExit(1)

    print(f"[OK] UTF-8 IO check passed (files={len(files)})")


if __name__ == "__main__":
    main()
