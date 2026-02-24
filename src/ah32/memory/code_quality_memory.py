"""JS宏Vibe Coding记忆系统 - 支持跨会话学习和尝试跟踪"""

import logging
import json
import os
import threading
import time
import uuid
from typing import Dict, List, Optional
from pydantic import BaseModel
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class JSMacroErrorPattern(BaseModel):
    """JS宏错误模式记录"""
    error_type: str
    error_pattern: str
    correction_rule: str
    frequency: int = 1
    success_rate: float = 0.0  # 成功率
    last_seen: datetime = None


class VisualStep(BaseModel):
    """Vibe Coding可视化步骤"""
    step_id: str
    type: str
    title: str
    content: str
    reasoning: Optional[str] = None
    code_diff: Optional[Dict] = None
    timestamp: float
    status: str


class JSMacroAttempt(BaseModel):
    """JS宏尝试记录"""
    attempt_id: str
    session_id: str
    user_query: str
    original_code: str
    fixed_code: str
    attempt_number: int
    errors_found: List[str]
    fixes_applied: List[Dict]
    execution_result: Optional[Dict] = None
    success: bool
    timestamp: datetime
    duration: float
    visual_steps: List[VisualStep] = []
    total_steps: int
    completed_steps: int


class FixPath(BaseModel):
    """修复路径记录"""
    path_id: str
    error_type: str
    steps: List[str]  # 修复步骤序列
    success_rate: float
    average_attempts: float
    usage_count: int = 1
    last_used: datetime = None


class SuccessfulSolution(BaseModel):
    """成功方案记录"""
    solution_id: str
    query_pattern: str
    code_template: str
    success_rate: float
    usage_count: int = 1
    last_used: datetime = None
    average_attempts: float


class CodeQualityMemory:
    """JS宏Vibe Coding记忆系统"""

    def __init__(self, persist_path: Optional[Path] = None):
        # 原有功能
        self.js_macro_error_patterns: Dict[str, JSMacroErrorPattern] = {}

        # 新增功能
        self.attempts: List[JSMacroAttempt] = []
        self.fix_paths: Dict[str, FixPath] = {}
        self.successful_solutions: List[SuccessfulSolution] = []

        # 统计信息
        self.total_attempts = 0
        self.successful_attempts = 0
        self.average_attempts = 0.0
        self.average_success_rate = 0.0

        self._lock = threading.RLock()
        self._persist_path = Path(persist_path) if persist_path else None
        self._save_timer: Optional[threading.Timer] = None
        self._dirty = False
        self._sync_save = os.getenv("AH32_CODE_QUALITY_MEMORY_SYNC_SAVE", "").lower() in ("1", "true", "yes")

        if self._persist_path:
            self._load_from_disk()

    def _to_dict(self) -> Dict[str, object]:
        def dt(v: Optional[datetime]) -> Optional[str]:
            try:
                return v.isoformat() if v else None
            except Exception:
                return None

        return {
            "schema_version": 1,
            "saved_at": datetime.now().isoformat(),
            "stats": {
                "total_attempts": self.total_attempts,
                "successful_attempts": self.successful_attempts,
                "average_attempts": self.average_attempts,
                "average_success_rate": self.average_success_rate,
            },
            "js_macro_error_patterns": {
                k: {
                    "error_type": v.error_type,
                    "error_pattern": v.error_pattern,
                    "correction_rule": v.correction_rule,
                    "frequency": v.frequency,
                    "success_rate": v.success_rate,
                    "last_seen": dt(v.last_seen),
                }
                for k, v in self.js_macro_error_patterns.items()
            },
            "fix_paths": {
                k: {
                    "path_id": v.path_id,
                    "error_type": v.error_type,
                    "steps": list(v.steps or []),
                    "success_rate": v.success_rate,
                    "average_attempts": v.average_attempts,
                    "usage_count": v.usage_count,
                    "last_used": dt(v.last_used),
                }
                for k, v in self.fix_paths.items()
            },
            "successful_solutions": [
                {
                    "solution_id": s.solution_id,
                    "query_pattern": s.query_pattern,
                    "code_template": "",  # avoid persisting large code blobs by default
                    "success_rate": s.success_rate,
                    "usage_count": s.usage_count,
                    "last_used": dt(s.last_used),
                    "average_attempts": s.average_attempts,
                }
                for s in self.successful_solutions
            ],
        }

    def _load_from_disk(self) -> None:
        p = self._persist_path
        if not p:
            return
        try:
            if not p.exists():
                return
            raw = p.read_text(encoding="utf-8")
            data = json.loads(raw)
            if not isinstance(data, dict):
                return

            patterns = data.get("js_macro_error_patterns") or {}
            if isinstance(patterns, dict):
                for k, v in patterns.items():
                    if not isinstance(v, dict):
                        continue
                    try:
                        last_seen = None
                        if v.get("last_seen"):
                            last_seen = datetime.fromisoformat(str(v.get("last_seen")))
                        self.js_macro_error_patterns[str(k)] = JSMacroErrorPattern(
                            error_type=str(v.get("error_type") or k),
                            error_pattern=str(v.get("error_pattern") or ""),
                            correction_rule=str(v.get("correction_rule") or ""),
                            frequency=int(v.get("frequency") or 1),
                            success_rate=float(v.get("success_rate") or 0.0),
                            last_seen=last_seen,
                        )
                    except Exception:
                        continue

            fix_paths = data.get("fix_paths") or {}
            if isinstance(fix_paths, dict):
                for k, v in fix_paths.items():
                    if not isinstance(v, dict):
                        continue
                    try:
                        last_used = None
                        if v.get("last_used"):
                            last_used = datetime.fromisoformat(str(v.get("last_used")))
                        self.fix_paths[str(k)] = FixPath(
                            path_id=str(v.get("path_id") or k),
                            error_type=str(v.get("error_type") or ""),
                            steps=list(v.get("steps") or []),
                            success_rate=float(v.get("success_rate") or 0.0),
                            average_attempts=float(v.get("average_attempts") or 0.0),
                            usage_count=int(v.get("usage_count") or 1),
                            last_used=last_used,
                        )
                    except Exception:
                        continue

            sols = data.get("successful_solutions") or []
            if isinstance(sols, list):
                self.successful_solutions = []
                for v in sols[:50]:
                    if not isinstance(v, dict):
                        continue
                    try:
                        last_used = None
                        if v.get("last_used"):
                            last_used = datetime.fromisoformat(str(v.get("last_used")))
                        self.successful_solutions.append(
                            SuccessfulSolution(
                                solution_id=str(v.get("solution_id") or str(uuid.uuid4())),
                                query_pattern=str(v.get("query_pattern") or ""),
                                code_template=str(v.get("code_template") or ""),
                                success_rate=float(v.get("success_rate") or 0.0),
                                usage_count=int(v.get("usage_count") or 1),
                                last_used=last_used,
                                average_attempts=float(v.get("average_attempts") or 0.0),
                            )
                        )
                    except Exception:
                        continue

            stats = data.get("stats") or {}
            if isinstance(stats, dict):
                self.total_attempts = int(stats.get("total_attempts") or self.total_attempts)
                self.successful_attempts = int(stats.get("successful_attempts") or self.successful_attempts)
                self.average_attempts = float(stats.get("average_attempts") or self.average_attempts)
                self.average_success_rate = float(stats.get("average_success_rate") or self.average_success_rate)
        except Exception as e:
            logger.warning(f"[code_quality_memory] load failed: {e}", exc_info=True)

    def _save_to_disk(self) -> None:
        p = self._persist_path
        if not p:
            return
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(self._to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(p)
        except Exception as e:
            logger.warning(f"[code_quality_memory] save failed: {e}", exc_info=True)

    def _mark_dirty(self) -> None:
        if not self._persist_path:
            return
        self._dirty = True
        if self._sync_save:
            self._save_to_disk()
            self._dirty = False
            return
        # Debounce writes: batch updates that happen within a short window.
        try:
            if self._save_timer:
                self._save_timer.cancel()
            self._save_timer = threading.Timer(1.0, self._flush_dirty)
            self._save_timer.daemon = True
            self._save_timer.start()
        except Exception:
            # Best-effort; do not block app execution.
            logger.warning("[code_quality_memory] schedule save timer failed (ignored)", exc_info=True)

    def _flush_dirty(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            self._save_to_disk()
            self._dirty = False

    def get_prompt_hints(self, error_type: Optional[str] = None, limit: int = 4, max_chars: int = 800) -> str:
        """Return a compact hint block for LLM prompts (Top-K relevant, no bloat)."""
        try:
            patterns = list(self.js_macro_error_patterns.values())
            if not patterns:
                return ""
            if error_type:
                # Prefer exact matches, then fall back to global high-frequency patterns.
                exact = [p for p in patterns if p.error_type == error_type]
                rest = [p for p in patterns if p.error_type != error_type]
                patterns = exact + rest

            patterns = sorted(patterns, key=lambda p: (p.frequency, p.success_rate), reverse=True)
            lines: List[str] = []
            for p in patterns:
                rule = (p.correction_rule or "").strip()
                if not rule:
                    continue
                line = f"- {p.error_type}: {rule}"
                if p.frequency > 1:
                    line += f" (seen={p.frequency})"
                lines.append(line)
                if len(lines) >= int(limit or 0):
                    break
            out = "\n".join(lines).strip()
            if not out:
                return ""
            if len(out) > max_chars:
                out = out[:max_chars] + "..."
            return out
        except Exception:
            return ""

    def record_js_macro_error(self, error_type: str, error_pattern: str,
                            correction_rule: str, context: str = ""):
        """记录JS宏错误和修正规则"""
        if error_type in self.js_macro_error_patterns:
            pattern = self.js_macro_error_patterns[error_type]
            pattern.frequency += 1
            pattern.last_seen = datetime.now()
        else:
            self.js_macro_error_patterns[error_type] = JSMacroErrorPattern(
                error_type=error_type,
                error_pattern=error_pattern,
                correction_rule=correction_rule,
                last_seen=datetime.now()
            )
        logger.debug(f"记录JS宏错误模式: {error_type}")
        self._mark_dirty()

    def record_attempt(self, attempt: JSMacroAttempt):
        """记录一次尝试"""
        self.attempts.append(attempt)
        self.total_attempts += 1

        if attempt.success:
            self.successful_attempts += 1

        # 更新统计信息
        self._update_statistics()

        # 学习修复路径
        self._learn_fix_path(attempt)

        # 记录成功方案
        if attempt.success:
            self._record_successful_solution(attempt)

        logger.info(f"记录尝试: {attempt.attempt_id}, 成功: {attempt.success}")
        self._mark_dirty()

    def _update_statistics(self):
        """更新统计信息"""
        if self.total_attempts > 0:
            self.average_success_rate = self.successful_attempts / self.total_attempts

            # 计算平均尝试次数
            successful_attempts = [a for a in self.attempts if a.success]
            if successful_attempts:
                total_attempts_for_success = sum(a.attempt_number for a in successful_attempts)
                self.average_attempts = total_attempts_for_success / len(successful_attempts)

    def _learn_fix_path(self, attempt: JSMacroAttempt):
        """学习修复路径"""
        if not attempt.success or not attempt.fixes_applied:
            return

        # 创建修复步骤序列
        fix_steps = [fix.get('type', 'unknown') for fix in attempt.fixes_applied]
        path_key = ' -> '.join(fix_steps)

        # 查找或创建修复路径
        existing_path = None
        for path in self.fix_paths.values():
            if path.steps == fix_steps:
                existing_path = path
                break

        if existing_path:
            # 更新现有路径
            existing_path.usage_count += 1
            existing_path.last_used = datetime.now()

            # 更新成功率
            total_usage = existing_path.usage_count
            current_rate = (total_usage - 1) / total_usage
            existing_path.success_rate = (current_rate * existing_path.success_rate + 1) / total_usage

        else:
            # 创建新路径
            path_id = str(uuid.uuid4())
            self.fix_paths[path_id] = FixPath(
                path_id=path_id,
                error_type=attempt.errors_found[0] if attempt.errors_found else "unknown",
                steps=fix_steps,
                success_rate=1.0,
                average_attempts=attempt.attempt_number,
                last_used=datetime.now()
            )

    def _record_successful_solution(self, attempt: JSMacroAttempt):
        """记录成功方案"""
        # 查找相似查询
        similar_solution = None
        for solution in self.successful_solutions:
            if self._is_similar_query(attempt.user_query, solution.query_pattern):
                similar_solution = solution
                break

        if similar_solution:
            # 更新现有方案
            similar_solution.usage_count += 1
            similar_solution.last_used = datetime.now()

            # 更新成功率
            total_usage = similar_solution.usage_count
            current_rate = (total_usage - 1) / total_usage
            similar_solution.success_rate = (current_rate * similar_solution.success_rate + 1) / total_usage

        else:
            # 创建新方案
            solution_id = str(uuid.uuid4())
            self.successful_solutions.append(SuccessfulSolution(
                solution_id=solution_id,
                query_pattern=attempt.user_query,
                code_template=attempt.fixed_code,
                success_rate=1.0,
                last_used=datetime.now(),
                average_attempts=attempt.attempt_number
            ))

    def _is_similar_query(self, query1: str, query2: str, threshold: float = 0.8) -> bool:
        """检查两个查询是否相似（简化版）"""
        # 这里可以使用更复杂的文本相似度算法
        # 现在使用简单的关键词匹配
        words1 = set(query1.lower().split())
        words2 = set(query2.lower().split())

        if not words1 or not words2:
            return False

        intersection = words1.intersection(words2)
        union = words1.union(words2)

        similarity = len(intersection) / len(union)
        return similarity >= threshold

    def get_best_fix_path(self, error_type: str) -> Optional[FixPath]:
        """获取最佳修复路径"""
        suitable_paths = [
            path for path in self.fix_paths.values()
            if path.error_type == error_type and path.success_rate > 0.5
        ]

        if not suitable_paths:
            return None

        # 按成功率和平均尝试次数排序
        best_path = max(
            suitable_paths,
            key=lambda p: (p.success_rate, -p.average_attempts)
        )

        return best_path

    def get_similar_solutions(self, query: str, limit: int = 3) -> List[SuccessfulSolution]:
        """获取相似的成功方案"""
        similar_solutions = [
            solution for solution in self.successful_solutions
            if self._is_similar_query(query, solution.query_pattern)
        ]

        # 按成功率和使用次数排序
        similar_solutions.sort(
            key=lambda s: (s.success_rate, s.usage_count),
            reverse=True
        )

        return similar_solutions[:limit]

    def get_recommendation(self, user_query: str, error_types: List[str]) -> Dict[str, any]:
        """获取修复建议"""
        recommendations = {
            'suggested_fix_path': None,
            'similar_solutions': [],
            'common_errors': [],
            'statistics': {
                'average_success_rate': self.average_success_rate,
                'average_attempts': self.average_attempts,
                'total_attempts': self.total_attempts
            }
        }

        # 获取最佳修复路径
        if error_types:
            best_error = error_types[0]  # 使用第一个错误类型
            recommendations['suggested_fix_path'] = self.get_best_fix_path(best_error)

        # 获取相似方案
        recommendations['similar_solutions'] = self.get_similar_solutions(user_query)

        # 获取常见错误
        recommendations['common_errors'] = list(self.js_macro_error_patterns.values())[:5]

        return recommendations

    def get_common_errors(self, limit: int = 5) -> List[JSMacroErrorPattern]:
        """获取最常见的JS宏错误模式"""
        patterns = sorted(
            self.js_macro_error_patterns.values(),
            key=lambda x: x.frequency,
            reverse=True
        )
        return patterns[:limit]

    def get_error_patterns_for_prompt(self) -> str:
        """获取错误模式，用于构建LLM提示词"""
        if not self.js_macro_error_patterns:
            return ""

        # 获取最常见的错误
        common_errors = self.get_common_errors(3)
        error_texts = []

        for error in common_errors:
            error_texts.append(f"- {error.error_type}: {error.correction_rule}")

        return "常见错误和修复建议:\n" + "\n".join(error_texts)

    def mark_successful_correction(self, context: str):
        """标记成功修复"""
        logger.info(f"记录成功修复: {context}")

    def export_learning_data(self) -> Dict[str, any]:
        """导出学习数据"""
        return {
            'statistics': {
                'total_attempts': self.total_attempts,
                'successful_attempts': self.successful_attempts,
                'average_success_rate': self.average_success_rate,
                'average_attempts': self.average_attempts
            },
            'fix_paths': [
                {
                    'error_type': path.error_type,
                    'steps': path.steps,
                    'success_rate': path.success_rate,
                    'usage_count': path.usage_count
                }
                for path in self.fix_paths.values()
            ],
            'successful_solutions': [
                {
                    'query_pattern': solution.query_pattern,
                    'success_rate': solution.success_rate,
                    'usage_count': solution.usage_count
                }
                for solution in self.successful_solutions
            ],
            'common_errors': [
                {
                    'error_type': error.error_type,
                    'frequency': error.frequency,
                    'success_rate': error.success_rate
                }
                for error in self.get_common_errors()
            ]
        }


# 全局实例
_memory_instance = None


def _resolve_persist_path() -> Optional[Path]:
    try:
        override = os.getenv("AH32_CODE_QUALITY_MEMORY_PATH", "").strip()
        if override:
            return Path(override)
        from ah32.config import settings

        return Path(settings.memory_root) / "code_quality_memory.json"
    except Exception:
        return None


def get_code_quality_memory() -> CodeQualityMemory:
    """获取全局代码质量记忆实例"""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = CodeQualityMemory(persist_path=_resolve_persist_path())
    return _memory_instance


def record_js_macro_error(error_type: str, error_pattern: str,
                         correction_rule: str, context: str = ""):
    """便捷方法：记录JS宏错误"""
    memory = get_code_quality_memory()
    memory.record_js_macro_error(error_type, error_pattern, correction_rule, context)


def get_pre_generation_warning() -> str:
    """获取JS宏生成前的警告提示，用于LLM生成阶段

    Returns:
        str: 格式化的警告提示文本（仅基于实际累积数据，最多3个）
    """
    memory = get_code_quality_memory()
    if not memory.js_macro_error_patterns:
        return ""

    # 获取高频错误（frequency >= 3），最多3个
    high_freq_errors = [
        pattern for pattern in memory.js_macro_error_patterns.values()
        if pattern.frequency >= 3
    ][:3]  # 最多3个

    # 如果没有高频错误，获取任意高频错误
    if not high_freq_errors:
        high_freq_errors = sorted(
            memory.js_macro_error_patterns.values(),
            key=lambda x: x.frequency,
            reverse=True
        )[:3]

    if not high_freq_errors:
        return ""

    # 简化警告文本，只保留最核心信息
    warning_text = "\n⚠️ 实际使用中的错误提醒（基于历史数据）：\n"
    for i, pattern in enumerate(high_freq_errors, 1):
        warning_text += f"• {pattern.error_type} → {pattern.correction_rule}\n"
        if pattern.frequency > 1:
            warning_text += f"  (已出现 {pattern.frequency} 次)\n"

    return warning_text


def record_and_analyze_error(
    error_type: str,
    error_code: str = "",
    correction_suggestion: str = "",
    user_context: str = "",
    severity: str = "medium",
    error_message: str = "",
) -> None:
    """Record a JS macro execution error for cross-session learning.

    This is used by the `/agentic/error/report` endpoint. The memory system currently
    tracks error patterns and suggested correction rules; we store a compact "pattern"
    using the message and a short code snippet, and keep extra context for debugging.
    """
    # Keep this function lightweight and non-throwing; the API layer will surface errors.
    pattern_parts = []
    if error_message:
        pattern_parts.append(error_message.strip())
    if error_code:
        # Avoid storing huge code blobs as patterns.
        code_snippet = error_code.strip()
        if len(code_snippet) > 200:
            code_snippet = code_snippet[:200] + "..."
        pattern_parts.append(code_snippet)

    error_pattern = " | ".join([p for p in pattern_parts if p]) or "execution_error"

    context = ""
    if user_context:
        context += f"user_context={user_context}\n"
    if severity:
        context += f"severity={severity}\n"

    correction_rule = correction_suggestion.strip() if correction_suggestion else ""
    if not correction_rule:
        # Lightweight heuristics so we learn useful rules even when the frontend doesn't provide suggestions.
        em = (error_message or "").lower()
        et = (error_type or "").lower()
        if "syntax" in et or "unexpected token" in em or "invalid or unexpected token" in em:
            correction_rule = (
                "Normalize non-ASCII punctuation (fullwidth brackets/colons/quotes), avoid template literals (`), "
                "strip TS/ESM syntax, and ensure only plain JS executes in the TaskPane."
            )
        elif "referenceerror" in em or "undefined" in em:
            correction_rule = "Add guards for missing objects/fields and feature-detect APIs before calling."
        elif "typeerror" in em:
            correction_rule = "Add null/undefined checks; avoid calling missing methods; prefer BID helper APIs when available."
        else:
            correction_rule = "Review WPS JS API usage and add guards for missing objects/fields."

    record_js_macro_error(
        error_type=error_type or "execution_error",
        error_pattern=error_pattern,
        correction_rule=correction_rule,
        context=context.strip(),
    )
