from __future__ import annotations

from typing import Any, Iterable


class SkillPlanContractError(ValueError):
    def __init__(self, skill_id: str, message: str):
        self.skill_id = skill_id
        self.message = message
        super().__init__(f"skill_contract:{skill_id}: {message}")


def normalize_selected_skill_ids(selected_skill_ids: Iterable[Any] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    if selected_skill_ids is None:
        return out
    for raw in selected_skill_ids:
        skill_id = str(raw or "").strip().lower()
        if not skill_id or skill_id in seen:
            continue
        seen.add(skill_id)
        out.append(skill_id)
    return out


def validate_plan_contract(
    plan: dict[str, Any],
    selected_skill_ids: Iterable[Any] | None,
    *,
    allow_answer_mode_runtime_fallback: bool = False,
) -> None:
    skill_ids = normalize_selected_skill_ids(selected_skill_ids)
    if not skill_ids:
        return

    if "answer-mode" in skill_ids:
        _validate_answer_mode_contract(
            plan,
            allow_runtime_fallback=allow_answer_mode_runtime_fallback,
        )

    if "exam-answering" in skill_ids:
        _validate_exam_answering_contract(plan)

    if "doc-formatter" in skill_ids:
        _validate_writer_delivery_block_contract(plan, "doc-formatter")


def _validate_answer_mode_contract(
    plan: dict[str, Any],
    *,
    allow_runtime_fallback: bool,
) -> None:
    actions = plan.get("actions")
    if not isinstance(actions, list) or not actions:
        raise SkillPlanContractError("answer-mode", "plan.actions must be a non-empty list")

    if len(actions) == 1 and _op(actions[0]) == "answer_mode_apply":
        return

    if allow_runtime_fallback and _is_answer_mode_runtime_fallback(actions):
        return

    expected = "a single top-level answer_mode_apply action"
    if allow_runtime_fallback:
        expected += " or the official runtime-missing fallback (upsert_block -> insert_text)"
    raise SkillPlanContractError(
        "answer-mode",
        f"selected skill requires {expected}; got top_level_ops={_top_level_ops(actions)}",
    )


def _validate_exam_answering_contract(plan: dict[str, Any]) -> None:
    actions = plan.get("actions")
    if not isinstance(actions, list) or len(actions) != 1:
        raise SkillPlanContractError(
            "exam-answering",
            "selected skill requires exactly one top-level upsert_block action",
        )

    action = actions[0]
    if _op(action) != "upsert_block":
        raise SkillPlanContractError(
            "exam-answering",
            f"selected skill requires top_level_ops=['upsert_block']; got top_level_ops={_top_level_ops(actions)}",
        )

    if str(action.get("anchor") or "").strip().lower() != "end":
        raise SkillPlanContractError(
            "exam-answering",
            "selected skill requires upsert_block.anchor='end'",
        )

    nested = action.get("actions")
    if not isinstance(nested, list) or not nested:
        raise SkillPlanContractError(
            "exam-answering",
            "selected skill requires upsert_block.actions to be non-empty",
        )

    if not any(_op(child) == "insert_text" for child in nested):
        raise SkillPlanContractError(
            "exam-answering",
            "selected skill requires at least one nested insert_text action",
        )


def _validate_writer_delivery_block_contract(plan: dict[str, Any], skill_id: str) -> None:
    actions = plan.get("actions")
    if not isinstance(actions, list) or len(actions) != 1:
        raise SkillPlanContractError(
            skill_id,
            "selected skill requires exactly one top-level upsert_block action",
        )

    action = actions[0]
    if _op(action) != "upsert_block":
        raise SkillPlanContractError(
            skill_id,
            f"selected skill requires top_level_ops=['upsert_block']; got top_level_ops={_top_level_ops(actions)}",
        )

    nested = action.get("actions")
    if not isinstance(nested, list) or not nested:
        raise SkillPlanContractError(
            skill_id,
            "selected skill requires upsert_block.actions to be non-empty",
        )

    if not any(_op(child) in {"insert_text", "insert_table"} for child in nested):
        raise SkillPlanContractError(
            skill_id,
            "selected skill requires at least one nested insert_text/insert_table action",
        )


def _is_answer_mode_runtime_fallback(actions: list[Any]) -> bool:
    for action in actions:
        if _op(action) != "upsert_block":
            return False
        nested = action.get("actions") if isinstance(action, dict) else None
        if not isinstance(nested, list) or not nested:
            return False
        if any(_op(child) != "insert_text" for child in nested):
            return False
    return True


def _top_level_ops(actions: list[Any]) -> list[str]:
    out: list[str] = []
    for action in actions:
        op = _op(action)
        if op:
            out.append(op)
    return out


def _op(action: Any) -> str:
    if not isinstance(action, dict):
        return ""
    return str(action.get("op") or "").strip().lower()
