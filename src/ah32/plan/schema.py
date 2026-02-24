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
    """Move the active selection deterministically.

    - host_app=wps (Writer): anchor + offset_lines/offset_chars
    - host_app=et (Excel): prefer sheet_name + range/cell; fallback to anchor + offsets (rows/cols)
    """

    op: Literal["set_selection"] = "set_selection"
    anchor: SelectionAnchor = "cursor"
    # Best-effort bounds: we want strict ints, but not overly restrictive for real docs.
    offset_lines: int = Field(default=0, ge=-10_000, le=10_000)
    offset_chars: int = Field(default=0, ge=-1_000_000, le=1_000_000)
    # ET-only (best-effort): select a range/cell on a sheet.
    sheet_name: str | None = Field(default=None, max_length=64)
    cell: str | None = Field(default=None, max_length=64, description="ET cell address like A1")
    range: str | None = Field(default=None, max_length=128, description="ET range address like A1:D10")


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
    data: list[list[str]] | None = Field(default=None, description="Optional table data (rows x cols)")
    borders: bool | None = None
    style: str | None = Field(default=None, max_length=200)
    header: bool | None = None
    auto_fit: int | None = Field(default=None, ge=0, le=10)

    @model_validator(mode="after")
    def _validate_data_shape(self) -> InsertTableAction:
        if not self.data:
            return self
        if len(self.data) > self.rows:
            raise ValueError("insert_table data has more rows than rows")
        for r in self.data:
            if len(r) > self.cols:
                raise ValueError("insert_table data has more cols than cols")
            for cell in r:
                if cell is None:
                    continue
                if len(str(cell)) > 20_000:
                    raise ValueError("insert_table cell too long")
        return self


class InsertChartFromSelectionAction(_ActionBase):
    op: Literal["insert_chart_from_selection"] = "insert_chart_from_selection"
    chart_type: int | None = Field(default=None, ge=1, le=1_000_000)
    # ET-only (best-effort): explicit range selection to avoid depending on current UI selection.
    sheet_name: str | None = Field(default=None, max_length=64)
    source_range: str | None = Field(
        default=None, max_length=128, description="ET A1 range, optionally with sheet prefix (e.g. Sheet1!A1:D20)"
    )
    width: JsonNumber | None = Field(default=None, gt=0)
    height: JsonNumber | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, max_length=200)
    has_legend: bool | None = None
    legend_position: str | None = Field(
        default=None, pattern=r"^(right|left|top|bottom)$", description="right|left|top|bottom"
    )
    # ET/WPS best-effort enhancements (optional)
    add_trendline: bool | None = None
    trendline_type: str | None = Field(
        default=None,
        max_length=50,
        description="Best-effort: linear/exponential/logarithmic/polynomial/moving_average (depends on host)",
    )
    show_data_labels: bool | None = None
    data_labels_show_percent: bool | None = None


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


class SetParagraphFormatAction(_ActionBase):
    """Set paragraph formatting (WPS/Writer only; best-effort).

    Prefer scoping by block_id to avoid accidental full-document formatting.
    """

    op: Literal["set_paragraph_format"] = "set_paragraph_format"
    # Optional: scope to an upsert_block region. When present, executor should only format inside that block.
    block_id: str | None = Field(default=None, max_length=64)
    apply_to_selection: bool = True
    alignment: Literal["left", "center", "right", "justify"] | None = None
    line_spacing: Literal["single", "1.5", "double"] | None = None
    space_before: JsonNumber | None = Field(default=None, ge=0, le=500)
    space_after: JsonNumber | None = Field(default=None, ge=0, le=500)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)

    @model_validator(mode="after")
    def _validate_payload(self) -> SetParagraphFormatAction:
        if (
            self.alignment is not None
            or self.line_spacing is not None
            or self.space_before is not None
            or self.space_after is not None
        ):
            return self
        raise ValueError("set_paragraph_format requires at least one format field")


class ApplyParagraphStyleAction(_ActionBase):
    """Apply font + paragraph formatting to paragraphs in scope (WPS/Writer only; best-effort).

    This is a deterministic primitive for "format this section/document" tasks.
    Prefer scoping by block_id (or selection) to avoid accidental full-document formatting.
    """

    op: Literal["apply_paragraph_style"] = "apply_paragraph_style"
    block_id: str | None = Field(default=None, max_length=64)
    apply_to_selection: bool = True
    max_paragraphs: int = Field(default=2000, ge=1, le=5000)

    # Text style (font)
    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = Field(default=None, max_length=32)

    # Paragraph format
    alignment: Literal["left", "center", "right", "justify"] | None = None
    line_spacing: Literal["single", "1.5", "double"] | None = None
    space_before: JsonNumber | None = Field(default=None, ge=0, le=500)
    space_after: JsonNumber | None = Field(default=None, ge=0, le=500)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)

    @model_validator(mode="after")
    def _validate_payload(self) -> ApplyParagraphStyleAction:
        if (
            self.font
            or self.size is not None
            or self.bold is not None
            or self.italic is not None
            or self.color
            or self.alignment is not None
            or self.line_spacing is not None
            or self.space_before is not None
            or self.space_after is not None
        ):
            return self
        raise ValueError("apply_paragraph_style requires at least one style field")


class HeadingLevelStyle(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    level: int = Field(ge=1, le=9)

    # Text style (font)
    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = Field(default=None, max_length=32)

    # Paragraph format
    alignment: Literal["left", "center", "right", "justify"] | None = None
    line_spacing: Literal["single", "1.5", "double"] | None = None
    space_before: JsonNumber | None = Field(default=None, ge=0, le=500)
    space_after: JsonNumber | None = Field(default=None, ge=0, le=500)

    @model_validator(mode="after")
    def _validate_payload(self) -> HeadingLevelStyle:
        if (
            self.font
            or self.size is not None
            or self.bold is not None
            or self.italic is not None
            or self.color
            or self.alignment is not None
            or self.line_spacing is not None
            or self.space_before is not None
            or self.space_after is not None
        ):
            return self
        raise ValueError("HeadingLevelStyle requires at least one style field")


class NormalizeHeadingsAction(_ActionBase):
    """Normalize heading paragraphs by level (WPS/Writer only; best-effort).

    The executor identifies heading paragraphs via OutlineLevel/style name heuristics and applies
    the corresponding level style. Prefer scoping by block_id (or selection).
    """

    op: Literal["normalize_headings"] = "normalize_headings"
    block_id: str | None = Field(default=None, max_length=64)
    apply_to_selection: bool = True
    max_paragraphs: int = Field(default=3000, ge=1, le=5000)
    levels: list[HeadingLevelStyle] = Field(default_factory=list, max_length=20)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)


class ApplyTextStyleToMatchesAction(_ActionBase):
    """Apply text style to all matches of a plain string (WPS/Writer only).

    This is a deterministic primitive to avoid LLM emitting long loops of
    set_selection + set_text_style for each heading.

    Best-effort: supports optional block_id scoping to an upsert_block bookmark/markers.
    """

    op: Literal["apply_text_style_to_matches"] = "apply_text_style_to_matches"
    find_text: str = Field(min_length=1, max_length=10_000)
    max_matches: int = Field(default=50, ge=1, le=500)
    block_id: str | None = Field(default=None, max_length=64)
    case_sensitive: bool = False
    whole_word: bool = False

    font: str | None = Field(default=None, max_length=200)
    size: JsonNumber | None = Field(default=None, gt=0)
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = Field(default=None, max_length=32)

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)

    @model_validator(mode="after")
    def _validate_style_payload(self) -> ApplyTextStyleToMatchesAction:
        if self.font or self.size is not None or self.bold is not None or self.italic is not None or self.color:
            return self
        raise ValueError("apply_text_style_to_matches requires at least one style field")


class SetWriterTableStyleAction(_ActionBase):
    """Set table style for tables in selection or in a specific upsert_block (WPS/Writer only).

    This is intentionally conservative: do NOT support whole-document traversal in v1.
    """

    op: Literal["set_writer_table_style"] = "set_writer_table_style"
    block_id: str | None = Field(default=None, max_length=64)
    apply_to_selection: bool = True

    style_name: str | None = Field(default=None, max_length=200)
    borders: bool | None = None
    header: bool | None = None

    @field_validator("block_id")
    @classmethod
    def _validate_block_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_id(v)

    @model_validator(mode="after")
    def _validate_payload(self) -> SetWriterTableStyleAction:
        if self.style_name is not None or self.borders is not None or self.header is not None:
            return self
        raise ValueError("set_writer_table_style requires at least one style field")


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


class TransformRangeAction(_ActionBase):
    """Transform a range deterministically (ET only)."""

    op: Literal["transform_range"] = "transform_range"
    source_range: str = Field(min_length=1, max_length=128, description="A1 range, optionally with sheet prefix")
    destination: str = Field(min_length=1, max_length=128, description="Top-left cell address, optionally with sheet")
    transform: Literal["transpose"] = "transpose"
    clear_existing: bool = True


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


# ===================== WPP新增操作 =====================

class AddSlideAction(_ActionBase):
    """创建新幻灯片"""
    op: Literal["add_slide"] = "add_slide"
    layout: int = Field(default=1, ge=1, le=200, description="版式ID")
    title: str | None = Field(default=None, max_length=500, description="标题文本")
    content: str | None = Field(default=None, max_length=10000, description="正文内容")
    position: int | None = Field(default=None, ge=0, description="插入位置，默认为末尾")


class AddTextboxAction(_ActionBase):
    """添加文本框"""
    op: Literal["add_textbox"] = "add_textbox"
    text: str | None = Field(default=None, max_length=50000)
    left: float = Field(default=1.0, ge=0, le=100, description="左边距(cm)")
    top: float = Field(default=1.0, ge=0, le=100, description="顶边距(cm)")
    width: float = Field(default=10.0, ge=0.1, le=100, description="宽度(cm)")
    height: float = Field(default=5.0, ge=0.1, le=100, description="高度(cm)")
    font_size: int | None = Field(default=None, ge=1, le=500)
    font_bold: bool | None = None
    font_color: str | None = Field(default=None, max_length=16, description="#RRGGBB")
    alignment: str | None = Field(default=None, pattern=r"^(left|center|right)$")
    placeholder_kind: str | None = Field(
        default=None,
        pattern=r"^(title|body|subtitle)$",
        description="Best-effort: fill a placeholder (when available) instead of placing by coords",
    )
    placeholder_type: int | None = Field(
        default=None,
        ge=0,
        le=50,
        description="Best-effort: WPP placeholder type constant (advanced)",
    )
    placeholder_index: int | None = Field(
        default=None, ge=1, le=10, description="Which placeholder to use when multiple match"
    )
    slide_index: int | None = Field(default=None, ge=1, description="目标幻灯片索引")


class AddImageAction(_ActionBase):
    """插入图片"""
    op: Literal["add_image"] = "add_image"
    path: str = Field(min_length=1, max_length=1000, description="图片路径")
    left: float = Field(default=1.0, ge=0, le=100)
    top: float = Field(default=1.0, ge=0, le=100)
    width: float | None = Field(default=None, ge=0.1, le=100)
    height: float | None = Field(default=None, ge=0.1, le=100)
    placeholder_kind: str | None = Field(
        default=None,
        pattern=r"^(title|body|subtitle)$",
        description="Best-effort: use placeholder bounds instead of guessed coords",
    )
    placeholder_type: int | None = Field(default=None, ge=0, le=50)
    placeholder_index: int | None = Field(default=None, ge=1, le=10)
    slide_index: int | None = Field(default=None, ge=1)


class AddChartAction(_ActionBase):
    """插入图表"""
    op: Literal["add_chart"] = "add_chart"
    chart_type: str = Field(default="bar", pattern=r"^(bar|line|pie|area|scatter|column)$")
    title: str | None = Field(default=None, max_length=500)
    data: list[list[JsonNumber | str]] | None = Field(default=None, description="图表数据 [[类别, 值], ...]")
    left: float = Field(default=1.0, ge=0, le=100)
    top: float = Field(default=1.0, ge=0, le=100)
    width: float = Field(default=15.0, ge=1, le=100)
    height: float = Field(default=10.0, ge=1, le=100)
    placeholder_kind: str | None = Field(
        default=None,
        pattern=r"^(title|body|subtitle)$",
        description="Best-effort: use placeholder bounds instead of guessed coords",
    )
    placeholder_type: int | None = Field(default=None, ge=0, le=50)
    placeholder_index: int | None = Field(default=None, ge=1, le=10)
    slide_index: int | None = Field(default=None, ge=1)


class AddTableActionWpp(_ActionBase):
    """在幻灯片中插入表格"""
    op: Literal["add_table"] = "add_table"
    rows: int = Field(default=2, ge=1, le=100)
    cols: int = Field(default=2, ge=1, le=50)
    data: list[list[str]] | None = Field(default=None, description="表格数据")
    left: float = Field(default=1.0, ge=0, le=100)
    top: float = Field(default=1.0, ge=0, le=100)
    width: float | None = Field(default=None, ge=0.1, le=100)
    style: str | None = Field(default=None, max_length=200)
    slide_index: int | None = Field(default=None, ge=1)


class AddShapeAction(_ActionBase):
    """添加形状"""
    op: Literal["add_shape"] = "add_shape"
    shape_type: str = Field(description="rectangle/oval/arrow/diamond/triangle等")
    left: float = Field(default=1.0, ge=0, le=100)
    top: float = Field(default=1.0, ge=0, le=100)
    width: float = Field(default=5.0, ge=0.1, le=100)
    height: float = Field(default=3.0, ge=0.1, le=100)
    fill_color: str | None = Field(default=None, max_length=16)
    line_color: str | None = Field(default=None, max_length=16)
    text: str | None = Field(default=None, max_length=5000)
    slide_index: int | None = Field(default=None, ge=1)


class DeleteSlideAction(_ActionBase):
    """删除幻灯片"""
    op: Literal["delete_slide"] = "delete_slide"
    slide_index: int | None = Field(default=None, ge=1, description="删除的幻灯片索引，为空则删除当前")


class DuplicateSlideAction(_ActionBase):
    """复制幻灯片"""
    op: Literal["duplicate_slide"] = "duplicate_slide"
    source_index: int | None = Field(default=None, ge=1, description="源幻灯片索引")
    target_position: int | None = Field(default=None, ge=0, description="目标位置")


class ReorderSlidesAction(_ActionBase):
    """重新排序幻灯片"""
    op: Literal["reorder_slides"] = "reorder_slides"
    from_index: int = Field(ge=1, le=1000)
    to_index: int = Field(ge=1, le=1000)


class SetSlideTransitionAction(_ActionBase):
    """设置幻灯片切换效果"""
    op: Literal["set_slide_transition"] = "set_slide_transition"
    effect: str = Field(default="fade", description="fade/push/reveal/split/blind/wipe/slide")
    duration: float = Field(default=1.0, ge=0.1, le=10, description="切换时长(秒)")
    sound: str | None = Field(default=None, max_length=200)
    advance_on_click: bool = Field(default=True)
    slide_index: int | None = Field(default=None, ge=1)
    apply_to_all: bool = Field(default=False)


class AddAnimationAction(_ActionBase):
    """添加动画效果"""
    op: Literal["add_animation"] = "add_animation"
    target_shape_name: str | None = Field(default=None, max_length=200)
    target_index: int | None = Field(default=None, ge=1, description="目标形状索引")
    effect: str = Field(description="fade_in/zoom_in/fly_in_left/wipe_left/appear等")
    trigger: str = Field(default="on_click", description="on_click/with_previous/after_previous")
    duration: float = Field(default=1.0, ge=0.1, le=60)
    delay: float = Field(default=0, ge=0, le=60)
    slide_index: int | None = Field(default=None, ge=1)


class SetAnimationTimingAction(_ActionBase):
    """设置动画时间"""
    op: Literal["set_animation_timing"] = "set_animation_timing"
    animation_index: int = Field(ge=1, description="动画序号（从 1 开始）")
    trigger: str | None = Field(default=None, pattern=r"^(on_click|with_previous|after_previous)$")
    duration: float | None = Field(default=None, ge=0.1, le=60)
    delay: float | None = Field(default=None, ge=0, le=60)
    slide_index: int | None = Field(default=None, ge=1)


class AddHyperlinkAction(_ActionBase):
    """添加超链接"""
    op: Literal["add_hyperlink"] = "add_hyperlink"
    address: str = Field(min_length=1, max_length=2000, description="链接地址")
    text_to_display: str | None = Field(default=None, max_length=500, description="显示文本")
    tooltip: str | None = Field(default=None, max_length=500)
    target_shape_name: str | None = Field(default=None, max_length=200)
    slide_index: int | None = Field(default=None, ge=1)


class SetPresentationPropsAction(_ActionBase):
    """设置演示文稿属性"""
    op: Literal["set_presentation_props"] = "set_presentation_props"
    title: str | None = Field(default=None, max_length=500)
    author: str | None = Field(default=None, max_length=200)
    subject: str | None = Field(default=None, max_length=500)
    comments: str | None = Field(default=None, max_length=5000)


# ===================== WPP新增操作结束 =====================


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
        SetParagraphFormatAction,
        ApplyParagraphStyleAction,
        NormalizeHeadingsAction,
        ApplyTextStyleToMatchesAction,
        SetWriterTableStyleAction,
        SetCellFormulaAction,
        SetNumberFormatAction,
        SetConditionalFormatAction,
        SetDataValidationAction,
        SortRangeAction,
        FilterRangeAction,
        TransformRangeAction,
        CreatePivotTableAction,
        SetSlideBackgroundAction,
        SetSlideTextStyleAction,
        SetSlideThemeAction,
        SetSlideLayoutAction,
        SetShapeStyleAction,
        SetTableStyleAction,
        # WPP新增操作
        AddSlideAction,
        AddTextboxAction,
        AddImageAction,
        AddChartAction,
        AddTableActionWpp,
        AddShapeAction,
        DeleteSlideAction,
        DuplicateSlideAction,
        ReorderSlidesAction,
        SetSlideTransitionAction,
        AddAnimationAction,
        SetAnimationTimingAction,
        AddHyperlinkAction,
        SetPresentationPropsAction,
        # 通用操作
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
            "set_selection",
            "insert_text",
            "insert_chart_from_selection",
            "set_cell_formula",
            "set_number_format",
            "set_conditional_format",
            "set_data_validation",
            "sort_range",
            "filter_range",
            "transform_range",
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
            # WPP新增操作
            "add_slide",
            "add_textbox",
            "add_image",
            "add_chart",
            "add_table",
            "add_shape",
            "delete_slide",
            "duplicate_slide",
            "reorder_slides",
            "set_slide_transition",
            "add_animation",
            "set_animation_timing",
            "add_hyperlink",
            "set_presentation_props",
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
        "set_paragraph_format",
        "apply_paragraph_style",
        "normalize_headings",
        "apply_text_style_to_matches",
        "set_writer_table_style",
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
