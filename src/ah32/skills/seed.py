"""Seed built-in, office-friendly skills into the user skills directory.

Goal: in dev/test and first-run scenarios, non-technical users should see a few
ready-to-use example skills without touching the repo.

Policy:
- Create missing folders (non-destructive).
- If a folder already exists but the manifest schema is legacy/unsupported,
  upgrade it to the latest built-in v1 manifest **with backup**.
  This keeps the runtime strict (v1 only) while preserving user edits.
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime
from pathlib import Path

from ah32.runtime_paths import runtime_root

logger = logging.getLogger(__name__)


def seed_builtin_skills(dest_dir: Path) -> int:
    """Copy built-in example skills into dest_dir (non-destructive).

    Returns:
        Number of skill folders created.
    """
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    candidates = [
        runtime_root() / "installer" / "assets" / "user-docs" / "skills",
        runtime_root() / "examples" / "user-docs" / "skills",
    ]
    src = next((p for p in candidates if p.exists() and p.is_dir()), None)
    if not src:
        return 0

    prompt_markers = (
        "skill.json",
        "SYSTEM.docx",
        "SYSTEM.md",
        "prompt.docx",
        "prompt.md",
        "SKILL.docx",
        "SKILL.md",
        "SYSTEM.txt",
        "prompt.txt",
        "SKILL.txt",
    )

    created = 0
    for child in sorted(src.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        if not any((child / name).exists() for name in prompt_markers):
            continue
        target = dest / child.name
        if not target.exists():
            try:
                shutil.copytree(child, target)
                created += 1
            except Exception as e:
                logger.warning(f"[skills] seed failed: {child} -> {target} err={e}")
            continue

        # Upgrade-in-place (best-effort) when the existing manifest is legacy.
        # This is common in dev machines where old skills were seeded once and
        # later the runtime schema was tightened to v1-only.
        try:
            src_manifest = child / "skill.json"
            dst_manifest = target / "skill.json"
            if not (src_manifest.exists() and dst_manifest.exists()):
                continue

            try:
                dst_raw = dst_manifest.read_text(encoding="utf-8")
                dst_data = json.loads(dst_raw) if dst_raw.strip() else {}
            except Exception:
                dst_data = {}

            dst_schema = str(dst_data.get("schema_version") or dst_data.get("schemaVersion") or "").strip()
            if dst_schema == "ah32.skill.v1":
                # Non-destructive v1 upgrades: merge in new optional fields from built-in manifests
                # when the user manifest doesn't have them yet.
                #
                # Why: we keep runtime strict (v1 only), but we still want built-in skills to gain
                # new capabilities (e.g., delivery hints) without overwriting user edits.
                try:
                    src_raw = src_manifest.read_text(encoding="utf-8")
                    src_data = json.loads(src_raw) if src_raw.strip() else {}
                except Exception:
                    src_data = {}

                changed = False
                try:
                    src_delivery = src_data.get("delivery") if isinstance(src_data, dict) else None
                    dst_delivery = dst_data.get("delivery") if isinstance(dst_data, dict) else None
                    if isinstance(src_delivery, dict) and src_delivery:
                        if not isinstance(dst_delivery, dict):
                            dst_delivery = {}
                        # delivery.default_writeback
                        want = (
                            str(src_delivery.get("default_writeback") or src_delivery.get("defaultWriteback") or "")
                            .strip()
                            .lower()
                        )
                        have = str(dst_delivery.get("default_writeback") or dst_delivery.get("defaultWriteback") or "").strip()
                        if want and not have:
                            dst_delivery["default_writeback"] = want
                            changed = True
                        if changed:
                            dst_data["delivery"] = dst_delivery
                except Exception as e:
                    logger.debug(f"[skills] merge v1 manifest extras failed (ignored): {dst_manifest} err={e}", exc_info=True)

                # Merge capabilities (e.g., active_doc_text flags) when the user manifest doesn't have them yet.
                try:
                    src_caps = src_data.get("capabilities") if isinstance(src_data, dict) else None
                    dst_caps = dst_data.get("capabilities") if isinstance(dst_data, dict) else None
                    if isinstance(src_caps, dict) and src_caps:
                        if not isinstance(dst_caps, dict):
                            dst_caps = {}
                        for key in ("active_doc_text", "active_doc_max_chars"):
                            want = src_caps.get(key)
                            if want is None:
                                continue
                            if key not in dst_caps:
                                dst_caps[key] = want
                                changed = True
                        if changed:
                            dst_data["capabilities"] = dst_caps
                except Exception as e:
                    logger.debug(f"[skills] merge v1 capabilities failed (ignored): {dst_manifest} err={e}", exc_info=True)

                # Merge tools list (append missing tools only; never overwrite existing tool configs).
                try:
                    src_tools = src_data.get("tools") if isinstance(src_data, dict) else None
                    dst_tools = dst_data.get("tools") if isinstance(dst_data, dict) else None
                    if isinstance(src_tools, list) and src_tools:
                        if not isinstance(dst_tools, list):
                            dst_tools = []
                        existing_names = set()
                        dst_by_name: dict[str, dict] = {}
                        dst_idx_by_name: dict[str, int] = {}
                        for i, item in enumerate(dst_tools):
                            if isinstance(item, str):
                                name = item.strip()
                                if name:
                                    existing_names.add(name)
                                    dst_idx_by_name.setdefault(name, i)
                            elif isinstance(item, dict):
                                name = str(item.get("name") or "").strip()
                                if name:
                                    existing_names.add(name)
                                    dst_by_name[name] = item
                                    dst_idx_by_name.setdefault(name, i)
                        for item in src_tools:
                            name = ""
                            if isinstance(item, str):
                                name = item.strip()
                            elif isinstance(item, dict):
                                name = str(item.get("name") or "").strip()
                            if not name or name in existing_names:
                                # Non-destructive merge for existing tool entries (best-effort):
                                # - Upgrade string tool entry to dict form (adds metadata like hints)
                                # - Merge missing `hints` keys (do not overwrite user edits)
                                if isinstance(item, dict) and name:
                                    dst_item = dst_by_name.get(name)
                                    # Upgrade "string tool entry" -> dict tool entry when present.
                                    if dst_item is None:
                                        try:
                                            idx = dst_idx_by_name.get(name)
                                            if idx is not None and isinstance(dst_tools[idx], str):
                                                dst_tools[idx] = dict(item)
                                                dst_by_name[name] = dst_tools[idx]
                                                dst_item = dst_by_name.get(name)
                                                changed = True
                                        except Exception:
                                            logger.debug(
                                                "[skills] upgrade string tool entry failed (ignored): %s",
                                                name,
                                                exc_info=True,
                                            )
                                    # Merge tool.hints
                                    try:
                                        if isinstance(dst_item, dict):
                                            src_hints = item.get("hints")
                                            if isinstance(src_hints, dict) and src_hints:
                                                dst_hints = dst_item.get("hints")
                                                if not isinstance(dst_hints, dict):
                                                    dst_hints = {}
                                                merged_hints = dict(dst_hints)
                                                for k, v in src_hints.items():
                                                    if k in merged_hints:
                                                        # Merge list-like triggers without overwriting.
                                                        if k in ("triggers", "trigger") and isinstance(merged_hints.get(k), list) and isinstance(v, list):
                                                            cur = list(merged_hints.get(k) or [])
                                                            for x in v:
                                                                if x not in cur:
                                                                    cur.append(x)
                                                            merged_hints[k] = cur
                                                        continue
                                                    merged_hints[k] = v
                                                if merged_hints != dst_hints:
                                                    dst_item["hints"] = merged_hints
                                                    changed = True
                                    except Exception:
                                        logger.debug(
                                            "[skills] merge tool hints failed (ignored): %s",
                                            name,
                                            exc_info=True,
                                        )
                                continue
                            dst_tools.append(item)
                            existing_names.add(name)
                            changed = True
                        dst_data["tools"] = dst_tools
                except Exception as e:
                    logger.debug(f"[skills] merge v1 tools failed (ignored): {dst_manifest} err={e}", exc_info=True)

                if changed:
                    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
                    backup = target / f"skill.json.upgrade.{ts}.bak"
                    try:
                        if not backup.exists():
                            backup.write_text(dst_raw if isinstance(dst_raw, str) else "", encoding="utf-8")
                    except Exception as e:
                        logger.warning(f"[skills] backup v1 upgrade manifest failed: {dst_manifest} -> {backup} err={e}")
                    try:
                        dst_manifest.write_text(
                            json.dumps(dst_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                        )
                        logger.info(f"[skills] upgraded v1 manifest (non-destructive): {dst_manifest} (backup={backup.name})")
                    except Exception as e:
                        logger.warning(f"[skills] write upgraded v1 manifest failed: {dst_manifest} err={e}")

                # Always copy missing files from built-in skill folder (e.g., new scripts/* tools),
                # without overwriting user edits.
                try:
                    _copy_missing_files(child, target)
                except Exception as e:
                    logger.debug(f"[skills] sync missing v1 skill files failed (ignored): {child} -> {target} err={e}", exc_info=True)
                continue

            # Keep a timestamped backup next to the file for human recovery.
            ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            backup = target / f"skill.json.legacy.{ts}.bak"
            try:
                if not backup.exists():
                    backup.write_text(dst_raw if isinstance(dst_raw, str) else "", encoding="utf-8")
            except Exception as e:
                logger.warning(f"[skills] backup legacy manifest failed: {dst_manifest} -> {backup} err={e}")

            # Overwrite only the manifest with the built-in v1 version. Keep prompts as-is.
            shutil.copy2(src_manifest, dst_manifest)
            logger.info(f"[skills] upgraded legacy manifest to v1: {dst_manifest} (backup={backup.name})")
        except Exception as e:
            logger.warning(f"[skills] upgrade legacy manifest failed: {child} -> {target} err={e}")
    return created


def _copy_missing_files(src_dir: Path, dst_dir: Path) -> None:
    """Copy missing files from src_dir to dst_dir (non-destructive)."""
    src_dir = Path(src_dir)
    dst_dir = Path(dst_dir)
    if not src_dir.exists() or not src_dir.is_dir():
        return
    if not dst_dir.exists() or not dst_dir.is_dir():
        return

    for path in src_dir.rglob("*"):
        target: Path | None = None
        try:
            if not path.is_file():
                continue
            rel = path.relative_to(src_dir)
            target = dst_dir / rel
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        except Exception as e:
            logger.debug(
                f"[skills] copy missing file failed (ignored): {path} -> {target} err={e}",
                exc_info=True,
            )
