from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from ah32.runtime_paths import runtime_root

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RuleFile:
    path: Path
    content: str
    truncated: bool = False


def _resolve_path(p: Path) -> Path:
    # Relative paths are resolved against runtime_root() for packaging friendliness.
    if not p.is_absolute():
        return (runtime_root() / p).resolve()
    return p.resolve()


def load_rule_files(paths: Iterable[Path], max_total_chars: int = 12000) -> List[RuleFile]:
    """Load rule files (docx/txt/md) as plain text.

    This is designed for per-request injection. It should be resilient:
    - missing files -> warn and skip
    - unsupported extensions -> warn and skip
    - overlong content -> truncate
    """
    loaded: List[RuleFile] = []
    remaining = int(max_total_chars)
    for raw in paths:
        if remaining <= 0:
            break
        try:
            path = _resolve_path(Path(raw).expanduser())
        except Exception:
            continue

        if not path.exists() or not path.is_file():
            logger.warning(f"[rules] not found: {path}")
            continue

        suffix = path.suffix.lower()
        try:
            if suffix in (".txt", ".md"):
                text = path.read_text(encoding="utf-8", errors="replace")
            elif suffix == ".docx":
                from docx import Document  # python-docx

                doc = Document(str(path))
                parts: List[str] = []
                for p in doc.paragraphs:
                    t = (p.text or "").strip()
                    if t:
                        parts.append(t)
                text = "\n".join(parts)
            else:
                logger.warning(f"[rules] unsupported type: {path}")
                continue
        except Exception as e:
            logger.warning(f"[rules] failed to read {path}: {e}")
            continue

        text = (text or "").strip()
        if not text:
            continue

        truncated = False
        if len(text) > remaining:
            text = text[:remaining] + "\n\n[...truncated...]"
            truncated = True

        loaded.append(RuleFile(path=path, content=text, truncated=truncated))
        remaining -= len(text) + 2
    return loaded


def render_rules_for_prompt(rule_files: List[RuleFile]) -> str:
    if not rule_files:
        return ""
    header = (
        "【对话规则文件】以下内容来自用户指定的“工作说明/规范文件”（每次请求自动加载）。"
        "这些规则优先级高于技能(Skills)与一般偏好，但不能改变系统核心运行机制；且低于安全约束。"
    )
    blocks: List[str] = [header]
    for rf in rule_files:
        blocks.append(f"【规则文件】{rf.path.name}\n{rf.content}".strip())
    return "\n\n".join(blocks)
