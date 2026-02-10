from __future__ import annotations

import ast
import json
import logging
import math
import re
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

_SKILL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-_]{1,63}$")


@dataclass(frozen=True)
class SkillTool:
    """Declarative tool metadata loaded from skill manifests/scripts."""

    name: str
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)
    script_path: Path = Path(".")


@dataclass(frozen=True)
class Skill:
    """A hot-loaded skill (prompt-only for now)."""

    skill_id: str
    name: str
    description: str = ""
    version: str = "0.0.0"
    enabled: bool = True
    priority: int = 0
    group: str = ""
    # Optional delivery hints that affect system writeback behavior (skill.json:delivery).
    # This keeps "scenario-specific UX defaults" configurable from skill manifests.
    default_writeback: str = ""
    tags: Tuple[str, ...] = ()
    intents: Tuple[str, ...] = ()
    triggers: Tuple[str, ...] = ()
    examples: Tuple[str, ...] = ()
    hosts: Tuple[str, ...] = ()
    output_schema: str = ""
    max_chars: Optional[int] = None
    markers: Tuple[str, ...] = ()
    style_spec_hints: str = ""
    # Capability flags (optional, loaded from skill.json:capabilities).
    needs_active_doc_text: bool = False
    active_doc_max_chars: Optional[int] = None
    tools: Tuple[SkillTool, ...] = ()
    root: Path = Path(".")
    prompt_path: Optional[Path] = None

    def load_prompt_text(self, max_chars: int) -> str:
        if not self.prompt_path:
            return ""
        try:
            text = _read_text(self.prompt_path)
        except Exception as e:
            logger.warning(f"[skills] failed to read {self.prompt_path}: {e}")
            return ""
        text = (text or "").strip()
        if not text:
            return ""
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n[...truncated...]"
        return text

    def routing_text(self, max_chars: int = 2000) -> str:
        """Compact text used for routing (embeddings/lexical)."""
        parts: List[str] = []
        parts.append(f"id: {self.skill_id}")
        if self.name and self.name != self.skill_id:
            parts.append(f"name: {self.name}")
        if self.group:
            parts.append(f"group: {self.group}")
        if self.default_writeback:
            parts.append(f"default_writeback: {self.default_writeback}")
        if self.description:
            parts.append(f"description: {self.description}")
        if self.hosts:
            parts.append("hosts: " + ", ".join(self.hosts))
        if self.tags:
            parts.append("tags: " + ", ".join(self.tags))
        if self.intents:
            parts.append("intents: " + ", ".join(self.intents))
        if self.triggers:
            parts.append("triggers: " + ", ".join(self.triggers[:20]))
        if self.examples:
            parts.append("examples:\n- " + "\n- ".join(self.examples[:6]))
        if self.output_schema:
            parts.append("output_schema:\n" + self.output_schema.strip())
        if self.style_spec_hints:
            parts.append("styleSpecHints:\n" + self.style_spec_hints.strip())

        base = "\n".join([p for p in parts if p and p.strip()]).strip()
        if len(base) > max_chars:
            return base[:max_chars] + "\n\n[...truncated...]"
        return base


class SkillRegistry:
    """Load skills from a directory and render them into prompt text.

    Hot-loading strategy:
    - Scan directory on demand (per request), but cache results.
    - If any watched file's mtime/size changes, reload.

    Directory layout (minimal):
    skills/<skill-id>/
      - skill.json (optional)
      - SYSTEM.md / prompt.md / SKILL.md (optional, prompt content)
    If skill.json is absent but SKILL.md exists, we treat it as an enabled skill.
    """

    def __init__(self, root_dir: Path, max_total_chars: int = 12000) -> None:
        self.root_dir = Path(root_dir)
        self.max_total_chars = int(max_total_chars)
        self._lock = threading.Lock()
        self._fingerprint: Optional[Tuple[Tuple[str, float, int], ...]] = None
        self._skills: List[Skill] = []
        self._manifest_tools_by_skill: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._resolved_tools_by_skill: Dict[str, Tuple[SkillTool, ...]] = {}
        # Caches for automatic skill routing (cleared on hot reload).
        self._prompt_text_cache: Dict[str, str] = {}
        self._routing_text_cache: Dict[str, str] = {}
        self._routing_vec_cache: Dict[str, List[float]] = {}
        # Lazy activation metrics
        self._lazy_activation_calls: int = 0
        self._lazy_activation_cache_hits: int = 0
        self._lazy_activation_total_ms: float = 0.0
        self._lazy_activation_by_skill: Dict[str, Dict[str, Any]] = {}

    def list_skills(self) -> List[Skill]:
        self._reload_if_changed()
        return list(self._skills)

    def render_for_prompt(self, selected: Optional[Iterable[Skill]] = None) -> str:
        """Render enabled skills (or a selected subset) into a compact system-instruction block."""
        self._reload_if_changed()
        enabled = [s for s in (list(selected) if selected is not None else self._skills) if s.enabled]
        if not enabled:
            return ""

        # Higher priority first.
        enabled.sort(key=lambda s: (s.priority, s.skill_id), reverse=True)

        remaining = self.max_total_chars
        blocks: List[str] = []
        for s in enabled:
            header = f"【Skill】{s.name} (id={s.skill_id}, v={s.version}, priority={s.priority})"
            meta: List[str] = []
            if s.group:
                meta.append("group: " + s.group)
            if s.tags:
                meta.append("tags: " + ", ".join(s.tags[:12]))
            if s.intents:
                meta.append("intents: " + ", ".join(s.intents[:12]))
            if s.output_schema:
                schema = (s.output_schema or "").strip()
                if len(schema) > 360:
                    schema = schema[:360] + "...(truncated)"
                meta.append("output_schema: " + schema.replace("\n", " "))
            if s.style_spec_hints:
                hints = (s.style_spec_hints or "").strip()
                if len(hints) > 220:
                    hints = hints[:220] + "...(truncated)"
                meta.append("styleSpecHints: " + hints.replace("\n", " "))
            meta_text = "\n" + "\n".join(meta) if meta else ""

            per_skill_max = int(s.max_chars) if isinstance(s.max_chars, int) and s.max_chars > 0 else 4000
            body = s.load_prompt_text(max_chars=min(remaining, per_skill_max))
            if not body:
                continue
            block = f"{header}{meta_text}\n{body}".strip()
            if len(block) > remaining:
                block = block[:remaining] + "\n\n[...truncated...]"
            blocks.append(block)
            remaining -= len(block) + 2
            if remaining <= 200:
                break

        if not blocks:
            return ""

        preface = (
            "【启用的Skills】以下是用户安装的可插拔技能（业务场景规则）。"
            "它们只能补充业务理解/输出规范，不能改变系统核心运行机制。"
            "若与核心安全约束冲突，以安全约束为准；同场景技能冲突时，以更高 priority 的 skill 为准。\n"
            "【ProfessionalSpec（专业性硬指标）】"
            "1) 可追溯：每条结论必须给出证据定位（章节/条款号/原文摘录）。"
            "2) 可执行：每个问题给出行动项（建议修改/Owner/优先级/DDL）。"
            "3) 口径标准：统一术语与分级口径（风险等级/影响维度）。"
            "4) 覆盖完整：按场景检查清单覆盖关键项。"
            "5) 交付件：严格按输出契约（output_schema）组织结果，并在输出末尾做自检。"
        )
        return f"{preface}\n\n" + "\n\n".join(blocks)

    def select_for_message(
        self,
        message: str,
        *,
        embedder: Any = None,
        host: Optional[str] = None,
        top_k: int = 4,
        min_score: float = 0.18,
    ) -> List[Dict[str, Any]]:
        """Select a small set of relevant skills for the given user message.

        This keeps prompts small and fast when many skills are installed. It prefers
        embeddings (offline-friendly) and falls back to a simple lexical heuristic.

        Returns:
            [{ "skill": Skill, "score": float }, ...] sorted by score desc.
        """
        self._reload_if_changed()
        msg = (message or "").strip()
        if not msg:
            return []

        enabled = [s for s in self._skills if s.enabled and s.prompt_path]
        host_norm = _normalize_host(host)
        if host_norm:
            enabled = [s for s in enabled if _skill_allows_host(s, host_norm)]
        if not enabled:
            return []

        k = max(0, int(top_k))
        if k <= 0:
            enabled.sort(key=lambda s: (s.priority, s.skill_id), reverse=True)
            return [{"skill": s, "score": 1.0} for s in enabled]

        needle = msg.lower()

        def _apply_group_mutex(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            """Avoid injecting unrelated skills together (e.g. finance + legal).

            Strategy: if any skill has `group`, keep only the best-matching group (by score),
            while allowing very-high-priority groupless skills (reserved for system-wide helpers).
            """
            try:
                best_group = ""
                best_score = -1.0
                for x in items:
                    s = x.get("skill")
                    grp = str(getattr(s, "group", "") or "").strip()
                    if not grp:
                        continue
                    sc = float(x.get("score") or 0.0)
                    if sc > best_score:
                        best_score = sc
                        best_group = grp
                if not best_group:
                    return items

                out: List[Dict[str, Any]] = []
                for x in items:
                    s = x.get("skill")
                    if not s:
                        continue
                    grp = str(getattr(s, "group", "") or "").strip()
                    if grp == best_group:
                        out.append(x)
                        continue
                    if not grp and int(getattr(s, "priority", 0) or 0) >= 90:
                        out.append(x)
                return out
            except Exception as e:
                logger.debug(f"[skills] group mutex failed (ignored): {e}", exc_info=True)
                return items

        def _lex_score(s: Skill) -> float:
            score = 0.0
            sid = (s.skill_id or "").lower()
            sname = (s.name or "").lower()
            if sid and sid in needle:
                score += 1.2
            if sname and sname in needle and sname != sid:
                score += 1.0

            # Triggers: strong signal (substring match).
            hits = 0
            for t in s.triggers:
                tt = (t or "").strip().lower()
                if not tt:
                    continue
                if tt in needle:
                    hits += 1
                    score += 0.45
                if hits >= 6:
                    break

            # Tags/intents: weaker signal.
            for tag in s.tags[:20]:
                tt = (tag or "").strip().lower()
                if tt and tt in needle:
                    score += 0.18
            for it in s.intents[:20]:
                ii = (it or "").strip().lower()
                if ii and ii in needle:
                    score += 0.18

            # Small priority bias for stable ordering (not a main signal).
            score += min(0.15, max(0.0, float(s.priority) / 1000.0))
            return score

        # Try embedding-based routing first (uses routing_text, not full prompt).
        try:
            if embedder is not None and hasattr(embedder, "embed_query"):
                msg_vec = embedder.embed_query(msg)

                # Batch-compute missing vectors when possible.
                missing = [s for s in enabled if s.skill_id not in self._routing_vec_cache]
                if missing and hasattr(embedder, "embed_documents"):
                    texts: List[str] = []
                    ids: List[str] = []
                    for s in missing:
                        t = self._get_routing_text_cached(s, max_chars=2000)
                        if not t:
                            continue
                        texts.append(t)
                        ids.append(s.skill_id)
                    if texts:
                        vecs = embedder.embed_documents(texts)
                        for sid, vec in zip(ids, vecs):
                            if isinstance(vec, list) and vec:
                                self._routing_vec_cache[sid] = vec

                scored: List[Dict[str, Any]] = []
                for s in enabled:
                    vec = self._routing_vec_cache.get(s.skill_id)
                    if not vec:
                        continue
                    emb = float(_cosine_similarity(msg_vec, vec))
                    # Convert to 0..1 range (cosine can be negative).
                    emb01 = max(0.0, min(1.0, (emb + 1.0) / 2.0))
                    lex = _lex_score(s)
                    lex01 = max(0.0, min(1.0, lex / 2.5))
                    score = 0.68 * emb01 + 0.32 * lex01
                    scored.append({"skill": s, "score": score, "score_emb": emb01, "score_lex": lex01})

                scored.sort(key=lambda x: (x["score"], x["skill"].priority, x["skill"].skill_id), reverse=True)
                kept = [x for x in scored if x["score"] >= float(min_score)]
                if kept:
                    return _apply_group_mutex(kept)[:k]
        except Exception as e:
            logger.debug(f"[skills] embedding router failed, fallback to lexical. err={e}")

        # Fallback: lexical match on id/name/tags/triggers; bias to higher priority for stable ordering.
        scored2 = [{"skill": s, "score": _lex_score(s)} for s in enabled]
        scored2.sort(key=lambda x: (x["score"], x["skill"].priority, x["skill"].skill_id), reverse=True)
        # Map to 0..1 for consistent downstream display.
        for x in scored2:
            x["score"] = max(0.0, min(1.0, float(x["score"]) / 2.5))
        kept2 = [x for x in scored2 if float(x["score"]) >= float(min_score)]
        # If nothing matches lexically, do NOT fall back to "top priority" skills.
        # Returning irrelevant skills makes the UI misleading and pollutes prompts.
        return _apply_group_mutex(kept2)[:k]

    def detect_applied_skills(
        self,
        response_text: str,
        *,
        selected: Optional[Iterable[Skill]] = None,
        min_markers: int = 1,
        min_ratio: float = 0.34,
    ) -> List[Dict[str, Any]]:
        """Heuristically detect which selected skills were actually applied in the final output.

        NOTE: For prompt-only skills, "applied" is not provable; we use marker strings configured
        in skill.json (or fallback to output_schema) to make the UI hint more accurate.

        Returns:
            [{ "skill": Skill, "matched": int, "total": int, "ratio": float }, ...] sorted by ratio desc.
        """
        self._reload_if_changed()
        text = (response_text or "").strip()
        if not text:
            return []

        candidates = list(selected) if selected is not None else [s for s in self._skills if s.enabled]
        out: List[Dict[str, Any]] = []

        for s in candidates:
            markers = list(s.markers)
            if not markers:
                # Best-effort fallback: use distinctive fragments from output_schema.
                schema = (s.output_schema or "").strip()
                if schema:
                    # Split by common punctuation and keep short, meaningful tokens.
                    raw = [x.strip() for x in schema.replace("；", ";").replace("：", ":").replace("，", ",").split(";")]
                    markers = [x for x in raw if 3 <= len(x) <= 30][:6]
            markers = [m for m in markers if isinstance(m, str) and m.strip()]
            if not markers:
                continue

            matched = 0
            for m in markers:
                if m in text:
                    matched += 1
            total = len(markers)
            ratio = (matched / total) if total > 0 else 0.0

            if matched >= int(min_markers) and ratio >= float(min_ratio):
                out.append(
                    {
                        "skill": s,
                        "matched": matched,
                        "total": total,
                        "ratio": ratio,
                    }
                )

        out.sort(key=lambda x: (x["ratio"], x["matched"], x["skill"].priority, x["skill"].skill_id), reverse=True)
        return out

    def _reload_if_changed(self) -> None:
        with self._lock:
            fp = self._compute_fingerprint()
            if fp == self._fingerprint:
                return
            self._fingerprint = fp
            self._manifest_tools_by_skill = {}
            self._resolved_tools_by_skill = {}
            self._skills = self._load_skills()
            self._prompt_text_cache = {}
            self._routing_text_cache = {}
            self._routing_vec_cache = {}
            declared_tools = sum(len(s.tools) for s in self._skills)
            logger.info(
                "[skills] loaded=%s enabled=%s declared_tools=%s root=%s",
                len(self._skills),
                len([s for s in self._skills if s.enabled]),
                declared_tools,
                self.root_dir,
            )

    def render_tools_for_prompt(self, skills: Tuple[Skill, ...]) -> str:
        """Render skills' tools as tool declarations for LLM prompt."""
        self._reload_if_changed()
        all_tools: List[Dict[str, Any]] = []

        for skill in skills:
            for tool in self._get_tools_for_skill_lazy(skill):
                all_tools.append({
                    "skill_id": skill.skill_id,
                    "skill_name": skill.name,
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                })

        if not all_tools:
            return ""

        blocks = ["【可用工具】以下是本轮对话可调用的工具（由 Skills 提供）：\n"]

        for t in all_tools:
            params_json = json.dumps(t["parameters"], ensure_ascii=False, indent=4)
            blocks.append(
                f"--- 工具: {t['name']} ---\n"
                f"所属 Skill: {t['skill_name']} (id={t['skill_id']})\n"
                f"描述: {t['description']}\n"
                f"参数 (JSON Schema):\n{params_json}\n"
                f"调用格式: {{\"name\": \"{t['name']}\", \"arguments\": {{}}}}\n"
            )

        blocks.append(
            "\n【使用规则】\n"
            "1. 仅当需要执行确定性操作时调用工具\n"
            "2. 工具调用必须包含 name 和 arguments\n"
            "3. 收到工具结果后，继续推理并输出最终答案\n"
            "4. 若工具调用失败，记录错误并继续\n"
        )

        return "\n".join(blocks)

    def get_tools_for_skill(self, skill_id: str) -> Tuple[SkillTool, ...]:
        """Get tools for a specific skill by ID."""
        self._reload_if_changed()
        for skill in self._skills:
            if skill.skill_id == skill_id:
                return self._get_tools_for_skill_lazy(skill)
        return ()

    def find_tool(self, skill_id: str, tool_name: str) -> Optional[SkillTool]:
        """Find a specific tool by skill ID and tool name."""
        self._reload_if_changed()
        for skill in self._skills:
            if skill.skill_id == skill_id:
                for tool in self._get_tools_for_skill_lazy(skill):
                    if tool.name == tool_name:
                        return tool
        return None

    def _parse_manifest_tools(self, raw_tools: Any) -> Dict[str, Dict[str, Any]]:
        """Parse tools from skill.json into a normalized map by tool name."""
        parsed: Dict[str, Dict[str, Any]] = {}
        if not isinstance(raw_tools, list):
            return parsed

        for item in raw_tools:
            try:
                if isinstance(item, str):
                    name = item.strip()
                    if not name:
                        continue
                    builtin = False
                    ref_name = name
                    if name.startswith("builtin:"):
                        builtin = True
                        ref_name = name.split(":", 1)[1].strip()
                    parsed[name] = {
                        "name": ref_name,
                        "description": "",
                        "parameters": {"type": "object", "properties": {}},
                        "builtin": builtin,
                    }
                    continue

                if isinstance(item, dict):
                    name = str(item.get("name") or "").strip()
                    if not name:
                        continue
                    description = str(item.get("description") or "").strip()
                    parameters = item.get("parameters")
                    builtin = bool(item.get("builtin", False))
                    if not builtin and name.startswith("builtin:"):
                        builtin = True
                        name = name.split(":", 1)[1].strip()
                    if not isinstance(parameters, dict):
                        parameters = {"type": "object", "properties": {}}
                    parsed[name] = {
                        "name": name,
                        "description": description,
                        "parameters": parameters,
                        "builtin": builtin,
                    }
            except Exception as e:
                logger.warning(f"[skills] parse manifest tool failed: item={item!r} err={e}")

        return parsed

    def _get_tools_for_skill_lazy(self, skill: Skill) -> Tuple[SkillTool, ...]:
        """Resolve tools for a skill only when needed (lazy activation)."""
        skill_id = str(skill.skill_id or "").strip()
        if not skill_id:
            return ()

        start = time.perf_counter()
        with self._lock:
            self._lazy_activation_calls += 1
            if skill_id in self._resolved_tools_by_skill:
                self._lazy_activation_cache_hits += 1
                tools = self._resolved_tools_by_skill[skill_id]
                rec = self._lazy_activation_by_skill.setdefault(
                    skill_id,
                    {
                        "calls": 0,
                        "cache_hits": 0,
                        "total_ms": 0.0,
                        "last_ms": 0.0,
                        "tool_count": len(tools),
                    },
                )
                rec["calls"] = int(rec.get("calls", 0)) + 1
                rec["cache_hits"] = int(rec.get("cache_hits", 0)) + 1
                rec["tool_count"] = len(tools)
                return tools

        if skill.tools:
            resolved_tools = tuple(skill.tools)
        else:
            manifest_tools = self._manifest_tools_by_skill.get(skill_id, {})
            resolved_tools = self._load_tools_for_skill(skill.root, manifest_tools)

        elapsed_ms = (time.perf_counter() - start) * 1000.0

        with self._lock:
            self._lazy_activation_total_ms += elapsed_ms
            self._resolved_tools_by_skill[skill_id] = resolved_tools
            rec = self._lazy_activation_by_skill.setdefault(
                skill_id,
                {
                    "calls": 0,
                    "cache_hits": 0,
                    "total_ms": 0.0,
                    "last_ms": 0.0,
                    "tool_count": len(resolved_tools),
                },
            )
            rec["calls"] = int(rec.get("calls", 0)) + 1
            rec["total_ms"] = float(rec.get("total_ms", 0.0)) + elapsed_ms
            rec["last_ms"] = elapsed_ms
            rec["tool_count"] = len(resolved_tools)

        return resolved_tools

    def get_lazy_activation_stats(self) -> Dict[str, Any]:
        """Return a snapshot of lazy-activation stats."""
        with self._lock:
            per_skill = {
                sid: {
                    "calls": int(v.get("calls", 0)),
                    "cache_hits": int(v.get("cache_hits", 0)),
                    "total_ms": float(v.get("total_ms", 0.0)),
                    "last_ms": float(v.get("last_ms", 0.0)),
                    "tool_count": int(v.get("tool_count", 0)),
                }
                for sid, v in self._lazy_activation_by_skill.items()
            }
            calls = int(self._lazy_activation_calls)
            cache_hits = int(self._lazy_activation_cache_hits)
            return {
                "calls": calls,
                "cache_hits": cache_hits,
                "misses": max(0, calls - cache_hits),
                "total_ms": float(self._lazy_activation_total_ms),
                "per_skill": per_skill,
            }

    def _ast_to_python_literal(self, node: ast.AST) -> Any:
        """Best-effort convert AST node to safe Python literal."""
        try:
            return ast.literal_eval(node)
        except Exception:
            return None

    def _parse_ast_tools_dict(self, node: ast.Dict) -> Dict[str, Dict[str, Any]]:
        """Parse TOOLS={...} from AST without importing/executing code."""
        parsed: Dict[str, Dict[str, Any]] = {}
        for key_node, value_node in zip(node.keys, node.values):
            if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
                continue
            key_name = str(key_node.value).strip()
            if not key_name:
                continue

            tool_name = key_name
            description = ""
            parameters: Dict[str, Any] = {"type": "object", "properties": {}}
            builtin = False

            if isinstance(value_node, ast.Dict):
                cfg_nodes: Dict[str, ast.AST] = {}
                for cfg_key_node, cfg_value_node in zip(value_node.keys, value_node.values):
                    if not isinstance(cfg_key_node, ast.Constant) or not isinstance(cfg_key_node.value, str):
                        continue
                    cfg_key = str(cfg_key_node.value).strip()
                    if cfg_key:
                        cfg_nodes[cfg_key] = cfg_value_node

                name_node = cfg_nodes.get("name")
                if isinstance(name_node, ast.Constant) and isinstance(name_node.value, str):
                    maybe_name = name_node.value.strip()
                    if maybe_name:
                        tool_name = maybe_name

                desc_node = cfg_nodes.get("description")
                if isinstance(desc_node, ast.Constant) and isinstance(desc_node.value, str):
                    description = desc_node.value.strip()

                params_node = cfg_nodes.get("parameters")
                if isinstance(params_node, ast.AST):
                    maybe_params = self._ast_to_python_literal(params_node)
                    if isinstance(maybe_params, dict):
                        parameters = maybe_params

                builtin_node = cfg_nodes.get("builtin")
                if isinstance(builtin_node, ast.Constant):
                    builtin = bool(builtin_node.value)

            elif isinstance(value_node, ast.Constant) and isinstance(value_node.value, str):
                description = value_node.value.strip()

            parsed[tool_name] = {
                "name": tool_name,
                "description": description,
                "parameters": parameters,
                "builtin": builtin,
            }

        return parsed

    def _load_tools_registry(self, scripts_dir: Path) -> Dict[str, Dict[str, Any]]:
        """Load optional TOOLS registry from scripts/__init__.py."""
        registry: Dict[str, Dict[str, Any]] = {}
        init_py = scripts_dir / "__init__.py"
        if not init_py.exists() or not init_py.is_file():
            return registry

        try:
            src = init_py.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(src, filename=str(init_py))
            tools_node: Optional[ast.AST] = None

            for stmt in tree.body:
                if isinstance(stmt, ast.Assign):
                    for target in stmt.targets:
                        if isinstance(target, ast.Name) and target.id == "TOOLS":
                            tools_node = stmt.value
                elif isinstance(stmt, ast.AnnAssign):
                    if isinstance(stmt.target, ast.Name) and stmt.target.id == "TOOLS":
                        tools_node = stmt.value

            if tools_node is None:
                return registry

            if isinstance(tools_node, ast.Dict):
                registry.update(self._parse_ast_tools_dict(tools_node))
            elif isinstance(tools_node, (ast.List, ast.Tuple)):
                for elt in tools_node.elts:
                    if not isinstance(elt, ast.Constant) or not isinstance(elt.value, str):
                        continue
                    tool_name = str(elt.value).strip()
                    if not tool_name:
                        continue
                    registry[tool_name] = {
                        "name": tool_name,
                        "description": "",
                        "parameters": {"type": "object", "properties": {}},
                        "builtin": False,
                    }
        except Exception as e:
            logger.warning(f"[skills] load tools registry failed: {init_py} err={e}", exc_info=True)

        return registry

    def _resolve_builtin_tool_script(self, tool_name: str) -> Optional[Path]:
        """Resolve builtin tool script path by name, if present."""
        name = str(tool_name or "").strip()
        if not name:
            return None
        builtin_dir = Path(__file__).resolve().parent / "tools"
        candidate = (builtin_dir / f"{name}.py").resolve()
        if candidate.exists() and candidate.is_file():
            return candidate
        return None

    def _resolve_script_for_tool_name(self, tool_name: str, script_map: Dict[str, Path]) -> Optional[Path]:
        """Resolve tool->script path via file stem first, then by function name scan."""
        if tool_name in script_map:
            return script_map[tool_name]

        pattern = re.compile(rf"^\s*def\s+{re.escape(tool_name)}\s*\(", re.MULTILINE)
        for path in script_map.values():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                if pattern.search(text):
                    return path
            except Exception as e:
                logger.debug(f"[skills] scan tool function failed: {path} err={e}", exc_info=True)
        return None

    def _load_tools_for_skill(self, skill_dir: Path, manifest_tools: Dict[str, Dict[str, Any]]) -> Tuple[SkillTool, ...]:
        """Load tools for a skill from manifest declarations and scripts/ directory."""
        scripts_dir = skill_dir / "scripts"
        script_map: Dict[str, Path] = {}
        registry_tools: Dict[str, Dict[str, Any]] = {}
        if scripts_dir.exists() and scripts_dir.is_dir():
            registry_tools = self._load_tools_registry(scripts_dir)
            for p in scripts_dir.glob("*.py"):
                if not p.is_file() or p.name == "__init__.py":
                    continue
                script_map[p.stem] = p.resolve()

        declared = dict(registry_tools)
        declared.update(manifest_tools)
        # If no declaration at all, fallback to simple mode (scripts/*.py => tool names)
        if not declared:
            declared = {
                name: {
                    "name": name,
                    "description": "",
                    "parameters": {"type": "object", "properties": {}},
                }
                for name in script_map.keys()
            }

        tools: List[SkillTool] = []
        for name, cfg in declared.items():
            script_path = self._resolve_script_for_tool_name(name, script_map)
            if script_path is None and bool(cfg.get("builtin", False)):
                script_path = self._resolve_builtin_tool_script(name)
            if script_path is None:
                logger.warning(
                    f"[skills] tool script missing: skill={skill_dir.name} tool={name} expected={scripts_dir / (name + '.py')}"
                )
                continue
            description = str(cfg.get("description") or "").strip()
            parameters = cfg.get("parameters")
            if not isinstance(parameters, dict):
                parameters = {"type": "object", "properties": {}}
            tools.append(
                SkillTool(
                    name=name,
                    description=description,
                    parameters=parameters,
                    script_path=script_path,
                )
            )

        tools.sort(key=lambda t: t.name)
        if tools:
            logger.info(f"[skills] loaded tools for {skill_dir.name}: {', '.join(t.name for t in tools)}")
        return tuple(tools)

    def _compute_fingerprint(self) -> Tuple[Tuple[str, float, int], ...]:
        files: List[Tuple[str, float, int]] = []
        if not self.root_dir.exists():
            return tuple()

        for path in self.root_dir.rglob("*"):
            if not path.is_file():
                continue
            lower_name = path.name.lower()
            if lower_name in (
                "skill.json",
                "system.md",
                "prompt.md",
                "skill.md",
                "system.docx",
                "prompt.docx",
                "skill.docx",
                "system.txt",
                "prompt.txt",
                "skill.txt",
            ) or (
                lower_name.endswith(".py") and path.parent.name.lower() == "scripts"
            ):
                try:
                    st = path.stat()
                    files.append((str(path.resolve()), st.st_mtime, st.st_size))
                except Exception:
                    continue
        files.sort(key=lambda x: x[0])
        return tuple(files)

    def _load_skills(self) -> List[Skill]:
        if not self.root_dir.exists():
            return []

        skills: List[Skill] = []
        for child in sorted(self.root_dir.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir():
                continue
            skill = self._load_one(child)
            if skill:
                skills.append(skill)
        return skills

    def _load_one(self, skill_dir: Path) -> Optional[Skill]:
        manifest = skill_dir / "skill.json"
        prompt_candidates = [
            skill_dir / "SYSTEM.docx",
            skill_dir / "prompt.docx",
            skill_dir / "SKILL.docx",
            skill_dir / "SYSTEM.md",
            skill_dir / "prompt.md",
            skill_dir / "SKILL.md",
            skill_dir / "SYSTEM.txt",
            skill_dir / "prompt.txt",
            skill_dir / "SKILL.txt",
        ]
        prompt_path = next((p for p in prompt_candidates if p.exists() and p.is_file()), None)

        if manifest.exists():
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning(f"[skills] invalid skill.json: {manifest} err={e}")
                return None

            schema_version = str(data.get("schema_version") or data.get("schemaVersion") or "").strip()
            if schema_version != "ah32.skill.v1":
                logger.warning(
                    f"[skills] unsupported skill.json schema (expect ah32.skill.v1): {manifest}"
                )
                return None
            else:
                meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
                routing = data.get("routing") if isinstance(data.get("routing"), dict) else {}
                output = data.get("output") if isinstance(data.get("output"), dict) else {}
                caps = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
                delivery = data.get("delivery") if isinstance(data.get("delivery"), dict) else {}
                entry = data.get("entry") if isinstance(data.get("entry"), dict) else {}

                try:
                    errs = _validate_skill_manifest_v1(data)
                    if errs:
                        logger.warning(f"[skills] invalid ah32.skill.v1: {manifest} errors={errs}")
                except Exception as e:
                    logger.debug(f"[skills] validate manifest failed (ignored): {e}", exc_info=True)

                skill_id = str(meta.get("id") or skill_dir.name).strip() or skill_dir.name
                name = str(meta.get("name") or skill_id).strip() or skill_id
                version = str(meta.get("version") or "0.0.0").strip() or "0.0.0"
                enabled = bool(meta.get("enabled", True))
                priority = int(meta.get("priority", 0) or 0)
                description = str(meta.get("description") or "").strip()
                group = str(meta.get("group") or meta.get("category") or "").strip()
                default_writeback = str(
                    delivery.get("default_writeback") or delivery.get("defaultWriteback") or ""
                ).strip()

                tags = _coerce_str_list(routing.get("tags"))
                intents = _coerce_str_list(routing.get("intents"))
                triggers = _coerce_str_list(routing.get("triggers"))
                examples = _coerce_examples(routing.get("examples"))
                hosts_raw = _coerce_str_list(routing.get("hosts"))
                hosts = tuple([h for h in (_normalize_host(x) for x in hosts_raw) if h])

                output_schema = str(
                    output.get("output_schema") or output.get("outputSchema") or ""
                ).strip()
                max_chars = output.get("max_chars")
                try:
                    max_chars = int(max_chars) if max_chars is not None else None
                except Exception:
                    max_chars = None
                markers = _coerce_str_list(output.get("markers"))
                style_spec_hints = ""
                try:
                    raw_hints = (
                        output.get("styleSpecHints")
                        or output.get("style_spec_hints")
                        or output.get("styleSpec")
                        or None
                    )
                    if isinstance(raw_hints, dict):
                        style_spec_hints = json.dumps(raw_hints, ensure_ascii=False)
                    elif isinstance(raw_hints, str):
                        style_spec_hints = raw_hints.strip()
                except Exception:
                    style_spec_hints = ""

                # Capability flags (best-effort; callers decide what to do with them).
                needs_active_doc_text = False
                active_doc_max_chars = None
                if isinstance(caps, dict) and caps:
                    needs_active_doc_text = bool(
                        caps.get("active_doc_text")
                        or caps.get("requires_active_doc_text")
                        or caps.get("needs_active_doc_text")
                    )
                    raw_max = caps.get("active_doc_max_chars") or caps.get("active_doc_text_max_chars")
                    try:
                        active_doc_max_chars = int(raw_max) if raw_max is not None else None
                    except Exception:
                        active_doc_max_chars = None

                entry_prompt = entry.get("system_prompt") or entry.get("prompt")
                if entry_prompt:
                    p = (skill_dir / str(entry_prompt)).resolve()
                    if p.exists() and p.is_file():
                        prompt_path = p

                manifest_tools = self._parse_manifest_tools(data.get("tools"))
                self._manifest_tools_by_skill[skill_id] = manifest_tools
                skill_tools = self._load_tools_for_skill(skill_dir, manifest_tools)

                return Skill(
                    skill_id=skill_id,
                    name=name,
                    description=description,
                    version=version,
                    enabled=enabled,
                    priority=priority,
                    group=group,
                    default_writeback=default_writeback,
                    tags=tuple(tags),
                    intents=tuple(intents),
                    triggers=tuple(triggers),
                    examples=tuple(examples),
                    hosts=hosts,
                    output_schema=output_schema,
                    max_chars=max_chars,
                    markers=tuple(markers),
                    style_spec_hints=style_spec_hints,
                    needs_active_doc_text=needs_active_doc_text,
                    active_doc_max_chars=active_doc_max_chars,
                    tools=skill_tools,
                    root=skill_dir,
                    prompt_path=prompt_path.resolve() if prompt_path else None,
                )

        # Fallback: no manifest, but a SKILL.md-like file exists.
        if prompt_path:
            self._manifest_tools_by_skill[skill_dir.name] = {}
            skill_tools = self._load_tools_for_skill(skill_dir, {})
            return Skill(
                skill_id=skill_dir.name,
                name=skill_dir.name,
                description="",
                version="0.0.0",
                enabled=True,
                priority=0,
                hosts=tuple(),
                tools=skill_tools,
                root=skill_dir,
                prompt_path=prompt_path.resolve(),
            )
        return None

    def _get_prompt_text_cached(self, skill: Skill, max_chars: int) -> str:
        key = skill.skill_id
        if key in self._prompt_text_cache:
            t = self._prompt_text_cache[key]
            return t[:max_chars] if len(t) > max_chars else t
        t = skill.load_prompt_text(max_chars=max_chars)
        self._prompt_text_cache[key] = t
        return t

    def _get_routing_text_cached(self, skill: Skill, max_chars: int) -> str:
        key = skill.skill_id
        if key in self._routing_text_cache:
            t = self._routing_text_cache[key]
            return t[:max_chars] if len(t) > max_chars else t
        t = skill.routing_text(max_chars=max_chars)
        self._routing_text_cache[key] = t
        return t


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    if n <= 0:
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for i in range(n):
        x = float(a[i])
        y = float(b[i])
        dot += x * y
        na += x * x
        nb += y * y
    denom = math.sqrt(na) * math.sqrt(nb)
    if denom <= 0:
        return 0.0
    return dot / denom


def _coerce_str_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        out: List[str] = []
        for x in v:
            s = str(x).strip()
            if s:
                out.append(s)
        return out
    if isinstance(v, str):
        # Support comma/semicolon separated strings for convenience.
        parts = [p.strip() for p in v.replace(";", ",").split(",")]
        return [p for p in parts if p]
    return [str(v).strip()] if str(v).strip() else []


def _coerce_examples(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        out: List[str] = []
        for x in v:
            if isinstance(x, dict):
                # Flexible: {user: "...", assistant: "..."} or similar.
                u = str(x.get("user") or x.get("input") or "").strip()
                if u:
                    out.append(u)
                continue
            s = str(x).strip()
            if s:
                out.append(s)
        return out
    if isinstance(v, dict):
        u = str(v.get("user") or v.get("input") or "").strip()
        return [u] if u else []
    s = str(v).strip()
    return [s] if s else []


def _normalize_host(v: Any) -> str:
    """Normalize host ids across frontend/backend/skill manifests.

    Frontend host_app: wps|et|wpp
    Skill manifest hosts: writer|et|wpp|wps|office
    We normalize to: writer|et|wpp (or '' for unknown).
    """
    t = str(v or "").strip().lower()
    if not t:
        return ""
    if t in ("wps", "writer", "word"):
        return "writer"
    if t in ("wpp", "ppt", "powerpoint"):
        return "wpp"
    if t in ("et", "xls", "excel"):
        return "et"
    if t in ("office", "any", "*"):
        return ""
    return t


def _skill_allows_host(skill: Skill, host_norm: str) -> bool:
    """Return True if a skill can run under the given host (writer/et/wpp)."""
    try:
        if not host_norm:
            return True
        if not skill.hosts:
            return True
        hs = {_normalize_host(x) for x in (skill.hosts or ())}
        # If a skill explicitly lists hosts, require a match.
        return (host_norm in hs) or ("" in hs)
    except Exception:
        return True


def _validate_skill_manifest_v1(data: Dict[str, Any]) -> List[str]:
    """Best-effort validation for ah32.skill.v1 manifests.

    We keep this lightweight (no jsonschema dependency) and log warnings instead of crashing.
    """
    errors: List[str] = []
    if str(data.get("schema_version") or "").strip() != "ah32.skill.v1":
        errors.append("schema_version must be 'ah32.skill.v1'")

    meta = data.get("meta")
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
    else:
        sid = str(meta.get("id") or "").strip()
        if not sid:
            errors.append("meta.id is required")
        elif not _SKILL_ID_RE.match(sid):
            errors.append("meta.id must match ^[a-z0-9][a-z0-9\\-_]{1,63}$")
        name = str(meta.get("name") or "").strip()
        if not name:
            errors.append("meta.name is required")

    entry = data.get("entry")
    if not isinstance(entry, dict):
        errors.append("entry must be an object")
    else:
        p = str(entry.get("system_prompt") or entry.get("prompt") or "").strip()
        if not p:
            # Not strictly required by runtime (we can fallback to SYSTEM.*), but required by the spec.
            errors.append("entry.system_prompt (or entry.prompt) is required")

    return errors


def _read_text(path: Path) -> str:
    """Read skill prompt text from an office-friendly file.

    Office users often prefer editing docx in WPS. We support docx/txt/md.
    """
    suffix = path.suffix.lower()
    if suffix in (".md", ".txt"):
        return path.read_text(encoding="utf-8", errors="replace")
    if suffix == ".docx":
        from docx import Document  # python-docx

        doc = Document(str(path))
        parts: List[str] = []
        for p in doc.paragraphs:
            t = (p.text or "").strip()
            if t:
                parts.append(t)
        return "\n".join(parts)
    # Last resort (avoid crash)
    return path.read_text(encoding="utf-8", errors="replace")
