from __future__ import annotations

import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.types import JsonValue

PLAN_SCHEMA_ID = "ah32.plan.v1"

_ID_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,64}$")


HostApp = Literal["wps", "et", "wpp"]
Anchor = Literal["cursor", "end"]
SelectionAnchor = Literal["cursor", "start_of_document", "end_of_document"]
JsonNumber = Union[int, float]


def _validate_id(value: str) -> str:
    v = (value or "").strip()
    if not _ID_RE.match(v):
        raise ValueError("must match /^[a-zA-Z0-9_\\-:.]{1,64}$/")
    return v


class _ActionBase(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)

    @field_validator("id")
    @classmethod
    def _validate_action_id(cls, v: str) -> str:
        return _validate_id(v)


class InsertTextAction(_ActionBase):
    op: Literal["insert_text"] = "insert_text"
    text: str = Field(min_length=1, max_length=200_000)
    new_paragraph_before: bool = False
    new_paragraph_after: bool = False


class SetSelectionAction(_ActionBase):
    """Move the active selection deterministically (Writer-only for now)."""

    op: Literal["set_selection"] = "set_selection"
    anchor: SelectionAnchor = "cursor"
    # Best-effort bounds: we want strict ints, but not overly restrictive for real docs.
    offset_lines: int = Field(default=0, ge=-10_000, le=10_000)
    offset_chars: int = Field(default=0, ge=-1_000_000, le=1_000_000)


class InsertAfterTextAction(_ActionBase):
    op: Literal["insert_after_text"] = "insert_after_text"
    anchor_text: str = Field(min_length=1, max_length=10_000)
    text: str = Field(min_length=1, max_length=200_000)
    new_paragraph_before: bool = False
    new_paragraph_after: bool = False


class InsertBeforeTextAction(_ActionBase):
    op: Literal["insert_before_text"] = "insert_before_text"
    anchor_text: str = Field(min_length=1, max_length=10_000)
    text: str = Field(min_length=1, max_length=200_000)
    new_paragraph_before: bool = False
    new_paragraph_after: bool = False


class InsertTableAction(_ActionBase):
    op: Literal["insert_table"] = "insert_table"
    rows: int = Field(ge=1, le=100)
    cols: int = Field(ge=1, le=50)
    borders: bool | None = None
    style: str | None = Field(default=None, max_length=200)
    header: bool | None = None
    auto_fit: int | None = Field(default=None, ge=0, le=10)


class InsertChartFromSelectionAction(_ActionBase):
    op: Literal["insert_chart_from_selection"] = "insert_chart_from_selection"
    chart_type: int | None = Field(default=None, ge=1, le=1_000_000)
    width: JsonNumber | None = Field(default=None, gt=0)
    height: JsonNumber | None = Field(default=None, gt=0)


class InsertWordArtAction(_ActionBase):
    op: Literal["insert_word_art"] = "insert_word_art"
    text: str = Field(min_length=1, max_length=10_000)
    preset: int | None = Field(default=None, ge=1, le=500)
    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    italic: bool | None = None


class SetTextStyleAction(_ActionBase):
    op: Literal["set_text_style"] = "set_text_style"
    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = Field(default=None, max_length=32)
    apply_to_selection: bool = True


class SetCellFormulaAction(_ActionBase):
    op: Literal["set_cell_formula"] = "set_cell_formula"
    cell: str = Field(min_length=1, max_length=32)
    formula: str = Field(min_length=1, max_length=5000)


class SetNumberFormatAction(_ActionBase):
    op: Literal["set_number_format"] = "set_number_format"
    range: str = Field(min_length=1, max_length=64)
    number_format: str = Field(min_length=1, max_length=200)


class SetConditionalFormatAction(_ActionBase):
    op: Literal["set_conditional_format"] = "set_conditional_format"
    range: str = Field(min_length=1, max_length=64)
    rule_type: Literal["color_scale", "cell_value"] = "color_scale"
    operator: (
        Literal[
            "between",
            "not_between",
            "equal",
            "not_equal",
            "greater_than",
            "less_than",
            "greater_or_equal",
            "less_or_equal",
        ]
        | None
    ) = None
    formula1: str | None = Field(default=None, max_length=5000)
    formula2: str | None = Field(default=None, max_length=5000)
    min_color: str | None = Field(default=None, max_length=32)
    mid_color: str | None = Field(default=None, max_length=32)
    max_color: str | None = Field(default=None, max_length=32)
    fill_color: str | None = Field(default=None, max_length=32)
    font_color: str | None = Field(default=None, max_length=32)
    bold: bool | None = None
    clear_existing: bool = True


class SetDataValidationAction(_ActionBase):
    op: Literal["set_data_validation"] = "set_data_validation"
    range: str = Field(min_length=1, max_length=64)
    validation_type: Literal[
        "list",
        "whole_number",
        "decimal",
        "date",
        "time",
        "text_length",
        "custom",
    ] = "list"
    operator: (
        Literal[
            "between",
            "not_between",
            "equal",
            "not_equal",
            "greater_than",
            "less_than",
            "greater_or_equal",
            "less_or_equal",
        ]
        | None
    ) = None
    formula1: str = Field(min_length=1, max_length=5000)
    formula2: str | None = Field(default=None, max_length=5000)
    allow_blank: bool = True
    in_cell_dropdown: bool = True
    show_input: bool = True
    show_error: bool = True
    input_title: str | None = Field(default=None, max_length=255)
    input_message: str | None = Field(default=None, max_length=1024)
    error_title: str | None = Field(default=None, max_length=255)
    error_message: str | None = Field(default=None, max_length=1024)


class SortRangeAction(_ActionBase):
    op: Literal["sort_range"] = "sort_range"
    range: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=1, max_length=64)
    order: Literal["asc", "desc"] = "asc"
    has_header: bool = False


class FilterRangeAction(_ActionBase):
    op: Literal["filter_range"] = "filter_range"
    range: str = Field(min_length=1, max_length=64)
    field: int = Field(ge=1, le=256)
    criteria1: str = Field(min_length=1, max_length=5000)
    operator: Literal["and", "or"] | None = None
    criteria2: str | None = Field(default=None, max_length=5000)
    visible_dropdown: bool = True


class PivotValueField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    field: str = Field(min_length=1, max_length=128)
    summary: Literal["sum", "count", "average", "max", "min"] = "sum"
    title: str | None = Field(default=None, max_length=200)


class CreatePivotTableAction(_ActionBase):
    op: Literal["create_pivot_table"] = "create_pivot_table"
    source_range: str = Field(min_length=1, max_length=128)
    destination: str = Field(min_length=1, max_length=64)
    rows: list[str] = Field(min_length=1, max_length=20)
    columns: list[str] = Field(default_factory=list, max_length=20)
    values: list[PivotValueField] = Field(min_length=1, max_length=20)
    filters: list[str] = Field(default_factory=list, max_length=20)
    table_name: str | None = Field(default=None, max_length=64)
    replace_existing: bool = True


class SetSlideBackgroundAction(_ActionBase):
    op: Literal["set_slide_background"] = "set_slide_background"
    color: str = Field(min_length=1, max_length=32)
    apply_to_all: bool = False


class SetSlideTextStyleAction(_ActionBase):
    op: Literal["set_slide_text_style"] = "set_slide_text_style"
    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    color: str | None = Field(default=None, max_length=32)
    apply_to_all: bool = False


class SetSlideThemeAction(_ActionBase):
    op: Literal["set_slide_theme"] = "set_slide_theme"
    theme_name: str | None = Field(default=None, min_length=1, max_length=200)
    theme_index: int | None = Field(default=None, ge=1, le=200)
    template_path: str | None = Field(default=None, min_length=1, max_length=1024)
    apply_to_all: bool = True

    @model_validator(mode="after")
    def _validate_theme_ref(self) -> SetSlideThemeAction:
        if self.theme_name or self.theme_index or self.template_path:
            return self
        raise ValueError("one of theme_name/theme_index/template_path is required")


class SetSlideLayoutAction(_ActionBase):
    op: Literal["set_slide_layout"] = "set_slide_layout"
    layout: int = Field(ge=1, le=200)
    apply_to_all: bool = False


class SetShapeStyleAction(_ActionBase):
    op: Literal["set_shape_style"] = "set_shape_style"
    shape_name: str | None = Field(default=None, max_length=200)
    fill_color: str | None = Field(default=None, max_length=32)
    line_color: str | None = Field(default=None, max_length=32)
    line_width: JsonNumber | None = Field(default=None, gt=0)
    text_color: str | None = Field(default=None, max_length=32)
    bold: bool | None = None
    apply_to_all: bool = False

    @model_validator(mode="after")
    def _validate_style_payload(self) -> SetShapeStyleAction:
        if (
            self.fill_color is not None
            or self.line_color is not None
            or self.line_width is not None
            or self.text_color is not None
            or self.bold is not None
        ):
            return self
        raise ValueError("set_shape_style requires at least one style field")


class SetTableStyleAction(_ActionBase):
    op: Literal["set_table_style"] = "set_table_style"
    shape_name: str | None = Field(default=None, max_length=200)
    style_name: str | None = Field(default=None, max_length=200)
    first_row: bool | None = None
    last_row: bool | None = None
    banded_rows: bool | None = None
    banded_columns: bool | None = None
    apply_to_all: bool = False

    @model_validator(mode="after")
    def _validate_table_style_payload(self) -> SetTableStyleAction:
        if (
            self.style_name is not None
            or self.first_row is not None
            or self.last_row is not None
            or self.banded_rows is not None
            or self.banded_columns is not None
        ):
            return self
        raise ValueError("set_table_style requires at least one style field")


class AnswerModeItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    q: str = Field(min_length=1, max_length=80)
    answer: str = Field(default="", max_length=20_000)


class AnswerModeApplyAction(_ActionBase):
    """Apply Answer Mode writeback deterministically (Writer-only)."""

    op: Literal["answer_mode_apply"] = "answer_mode_apply"
    # Stable idempotency key for marker tags; when omitted, the frontend picks a reasonable default.
    block_id: str | None = Field(default=None, min_length=1, max_length=64)
    answers: list[AnswerModeItem] = Field(min_length=1, max_length=2000)
    strict: bool = True
    search_window_chars: int = Field(default=520, ge=120, le=4000)
    backup: bool | None = None

    @field_validator("block_id")
    @classmethod
    def _validate_block_id_optional(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)


class DeleteBlockAction(_ActionBase):
    op: Literal["delete_block"] = "delete_block"
    block_id: str = Field(min_length=1, max_length=64)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str) -> str:
        return _validate_id(v)


class UpsertBlockAction(_ActionBase):
    op: Literal["upsert_block"] = "upsert_block"
    block_id: str = Field(min_length=1, max_length=64)
    anchor: Anchor = "cursor"
    freeze_cursor: bool = True
    actions: list[PlanAction] = Field(min_length=1)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str) -> str:
        return _validate_id(v)


PlanAction = Annotated[
    Union[
        SetSelectionAction,
        InsertTextAction,
        InsertAfterTextAction,
        InsertBeforeTextAction,
        InsertTableAction,
        InsertChartFromSelectionAction,
        InsertWordArtAction,
        SetTextStyleAction,
        SetCellFormulaAction,
        SetNumberFormatAction,
        SetConditionalFormatAction,
        SetDataValidationAction,
        SortRangeAction,
        FilterRangeAction,
        CreatePivotTableAction,
        SetSlideBackgroundAction,
        SetSlideTextStyleAction,
        SetSlideThemeAction,
        SetSlideLayoutAction,
        SetShapeStyleAction,
        SetTableStyleAction,
        AnswerModeApplyAction,
        DeleteBlockAction,
        UpsertBlockAction,
    ],
    Field(discriminator="op"),
]

# Resolve recursive type references (UpsertBlockAction.actions -> PlanAction).
UpsertBlockAction.model_rebuild()


def _allowed_ops(host_app: HostApp) -> set[str]:
    # Keep this conservative (deterministic, best-effort across versions).
    if host_app == "et":
        return {
            "upsert_block",
            "delete_block",
            "insert_text",
            "set_cell_formula",
            "set_number_format",
            "set_conditional_format",
            "set_data_validation",
            "sort_range",
            "filter_range",
            "create_pivot_table",
        }
    if host_app == "wpp":
        return {
            "upsert_block",
            "delete_block",
            "insert_text",
            "insert_word_art",
            "set_slide_background",
            "set_slide_text_style",
            "set_slide_theme",
            "set_slide_layout",
            "set_shape_style",
            "set_table_style",
        }
    return {
        "upsert_block",
        "delete_block",
        "set_selection",
        "insert_text",
        "insert_after_text",
        "insert_before_text",
        "insert_table",
        "insert_chart_from_selection",
        "insert_word_art",
        "set_text_style",
        "answer_mode_apply",
    }


class Plan(BaseModel):
    """Deterministic plan schema (strict JSON; no JS)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[PLAN_SCHEMA_ID] = PLAN_SCHEMA_ID
    host_app: HostApp = "wps"
    meta: dict[str, JsonValue] = Field(default_factory=dict)
    actions: list[PlanAction] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_actions_for_host(self) -> Plan:
        allowed = _allowed_ops(self.host_app)

        def walk(actions: list[PlanAction], path: str) -> None:
            for idx, action in enumerate(actions):
                op = getattr(action, "op", None)
                if op not in allowed:
                    raise ValueError(f"{path}[{idx}].op='{op}' not allowed for host_app='{self.host_app}'")
                if isinstance(action, UpsertBlockAction):
                    walk(action.actions, f"{path}[{idx}].actions")

        walk(self.actions, "actions")
        return self


Plan.model_rebuild()
