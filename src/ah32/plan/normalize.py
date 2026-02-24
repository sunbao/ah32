from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

from ah32.plan.schema import PLAN_SCHEMA_ID, HostApp

logger = logging.getLogger(__name__)

_ID_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,64}$")
_ID_SAFE_CHARS_RE = re.compile(r"[^a-zA-Z0-9_\-:.]+")

def _to_int_opt(v: Any) -> int | None:
    try:
        if v is None:
            return None
        if isinstance(v, bool):
            return int(v)
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return int(v)
        s = str(v).strip()
        if not s:
            return None
        return int(float(s))
    except Exception:
        return None


def _to_int(v: Any, *, default: int = 0) -> int:
    out = _to_int_opt(v)
    return default if out is None else out


def _to_float_opt(v: Any) -> float | None:
    try:
        if v is None:
            return None
        if isinstance(v, bool):
            return float(int(v))
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip()
        if not s:
            return None
        return float(s)
    except Exception:
        return None


def _to_bool_opt(v: Any) -> bool | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "1", "yes", "y", "on"):
            return True
        if s in ("false", "0", "no", "n", "off"):
            return False
    return None


def _to_str_opt(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return None


def _safe_id(value: Any, *, prefix: str) -> str:
    raw = "" if value is None else str(value)
    v = raw.strip()
    if _ID_RE.match(v):
        return v

    cleaned = _ID_SAFE_CHARS_RE.sub("_", v).strip("_")
    if cleaned and _ID_RE.match(cleaned):
        return cleaned[:64]

    h = hashlib.sha256(v.encode("utf-8", errors="ignore")).hexdigest()[:12]
    base = f"{prefix}_{h}"
    return base[:64]


def _norm_op(op: Any) -> str:
    s = "" if op is None else str(op).strip()
    m = {
        "upsertBlock": "upsert_block",
        "deleteBlock": "delete_block",
        "setSelection": "set_selection",
        "insertText": "insert_text",
        "insertAfterText": "insert_after_text",
        "insertBeforeText": "insert_before_text",
        "insertTable": "insert_table",
        "insertChartFromSelection": "insert_chart_from_selection",
        "insertWordArt": "insert_word_art",
        "answerModeApply": "answer_mode_apply",
        "setCellFormula": "set_cell_formula",
        "setNumberFormat": "set_number_format",
        "setConditionalFormat": "set_conditional_format",
        "setDataValidation": "set_data_validation",
        "sortRange": "sort_range",
        "filterRange": "filter_range",
        "transformRange": "transform_range",
        "createPivotTable": "create_pivot_table",
        "setSlideBackground": "set_slide_background",
        "setSlideTextStyle": "set_slide_text_style",
        "setSlideTheme": "set_slide_theme",
        "setSlideLayout": "set_slide_layout",
        "setShapeStyle": "set_shape_style",
        "setTableStyle": "set_table_style",
        "setTextStyle": "set_text_style",
        "setParagraphFormat": "set_paragraph_format",
        "applyParagraphStyle": "apply_paragraph_style",
        "normalizeHeadings": "normalize_headings",
        "applyTextStyleToMatches": "apply_text_style_to_matches",
        "setWriterTableStyle": "set_writer_table_style",
        "addSlide": "add_slide",
        "addTextbox": "add_textbox",
        "addImage": "add_image",
        "addChart": "add_chart",
        "addTable": "add_table",
        "addShape": "add_shape",
        "deleteSlide": "delete_slide",
        "duplicateSlide": "duplicate_slide",
        "reorderSlides": "reorder_slides",
        "setSlideTransition": "set_slide_transition",
        "addAnimation": "add_animation",
        "setAnimationTiming": "set_animation_timing",
        "addHyperlink": "add_hyperlink",
        "setPresentationProps": "set_presentation_props",
    }
    return m.get(s, s)


def _map_key(k: str) -> str:
    key_map = {
        "blockId": "block_id",
        "anchorText": "anchor_text",
        "newParagraphBefore": "new_paragraph_before",
        "newParagraphAfter": "new_paragraph_after",
        "freezeCursor": "freeze_cursor",
        "chartType": "chart_type",
        "autoFit": "auto_fit",
        "offsetLines": "offset_lines",
        "offsetChars": "offset_chars",
        "searchWindowChars": "search_window_chars",
        "schema": "schema_version",
        "hostApp": "host_app",
        "applyToAll": "apply_to_all",
        "numberFormat": "number_format",
        "applyToSelection": "apply_to_selection",
        "spaceBefore": "space_before",
        "spaceAfter": "space_after",
        "lineSpacing": "line_spacing",
        "styleName": "style_name",
        "maxParagraphs": "max_paragraphs",
        "maxMatches": "max_matches",
        "caseSensitive": "case_sensitive",
        "wholeWord": "whole_word",
        "ruleType": "rule_type",
        "formula1": "formula1",
        "formula2": "formula2",
        "minColor": "min_color",
        "midColor": "mid_color",
        "maxColor": "max_color",
        "fillColor": "fill_color",
        "fontColor": "font_color",
        "clearExisting": "clear_existing",
        "validationType": "validation_type",
        "allowBlank": "allow_blank",
        "inCellDropdown": "in_cell_dropdown",
        "showInput": "show_input",
        "showError": "show_error",
        "inputTitle": "input_title",
        "inputMessage": "input_message",
        "errorTitle": "error_title",
        "errorMessage": "error_message",
        "themeName": "theme_name",
        "themeIndex": "theme_index",
        "templatePath": "template_path",
        "hasHeader": "has_header",
        "criteria1": "criteria1",
        "criteria2": "criteria2",
        "visibleDropdown": "visible_dropdown",
        "sourceRange": "source_range",
        "destRange": "destination",
        "tableName": "table_name",
        "replaceExisting": "replace_existing",
        "valueFields": "values",
        "shapeName": "shape_name",
        "fillColor": "fill_color",
        "lineColor": "line_color",
        "lineWidth": "line_width",
        "textColor": "text_color",
        "styleName": "style_name",
        "firstRow": "first_row",
        "lastRow": "last_row",
        "bandedRows": "banded_rows",
        "bandedColumns": "banded_columns",
        "slideIndex": "slide_index",
        "sourceIndex": "source_index",
        "targetPosition": "target_position",
        "fromIndex": "from_index",
        "toIndex": "to_index",
        "advanceOnClick": "advance_on_click",
        "textToDisplay": "text_to_display",
        "targetShapeName": "target_shape_name",
        "animationIndex": "animation_index",
        "fontSize": "font_size",
        "fontBold": "font_bold",
        "placeholderKind": "placeholder_kind",
        "placeholderType": "placeholder_type",
        "placeholderIndex": "placeholder_index",
        "sheetName": "sheet_name",
        "shapeType": "shape_type",
        "hasLegend": "has_legend",
        "legendPosition": "legend_position",
        "sourceRange": "source_range",
        "addTrendline": "add_trendline",
        "trendlineType": "trendline_type",
        "showDataLabels": "show_data_labels",
        "dataLabelsShowPercent": "data_labels_show_percent",
        "findText": "find_text",
    }
    return key_map.get(k, k)


def _as_plain_dict(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return dict(value)


def _normalize_action(action: Any, *, fallback_id: str, host: HostApp) -> dict[str, Any] | None:
    a0 = _as_plain_dict(action)
    if a0 is None:
        return None

    # Flatten common wrapper patterns:
    # - { op, id, title, params: {...} }
    # - { op, id, title, arguments: {...} } (tool-call-like)
    args = _as_plain_dict(a0.get("arguments"))
    if args:
        rest = {k: v for k, v in a0.items() if k != "arguments"}
        a0 = {**args, **rest}

    # Flatten common wrapper pattern: { op, id, title, params: {...} }.
    params = _as_plain_dict(a0.get("params"))
    if params:
        rest = {k: v for k, v in a0.items() if k != "params"}
        a0 = {**params, **rest}

    # Normalize keys (camelCase -> snake_case) one-level deep.
    a1: dict[str, Any] = {}
    for k, v in a0.items():
        try:
            nk = _map_key(str(k))
        except Exception:
            nk = str(k)
        a1[nk] = v

    op = _norm_op(a1.get("op"))
    a1["op"] = op

    # Host-aware op tolerance (keep server-side schema strict, but repair common mis-mappings).
    #
    # - ET plans sometimes mistakenly use WPP's add_chart; map it to insert_chart_from_selection.
    # - Writer plans sometimes mistakenly use WPP's set_table_style; map it to set_writer_table_style
    #   and keep only the fields Writer supports.
    try:
        if host == "et" and op == "add_chart":
            op = "insert_chart_from_selection"
            a1["op"] = op
            ct = a1.get("chart_type")
            if isinstance(ct, str):
                s = ct.strip().lower()
                type_map: dict[str, int] = {
                    "column": 51,
                    "bar": 57,
                    "line": 4,
                    "pie": 5,
                    "area": 1,
                    "scatter": -4169,
                }
                if s in type_map:
                    a1["chart_type"] = type_map[s]
            if a1.get("chart_type") is None:
                dt = a1.get("data_type") or a1.get("chart_type_name")
                if isinstance(dt, str):
                    s = dt.strip().lower()
                    type_map2: dict[str, int] = {
                        "column": 51,
                        "bar": 57,
                        "line": 4,
                        "pie": 5,
                        "area": 1,
                        "scatter": -4169,
                    }
                    if s in type_map2:
                        a1["chart_type"] = type_map2[s]

        if host == "wps" and op == "set_table_style":
            op = "set_writer_table_style"
            a1["op"] = op
            if a1.get("header") is None and isinstance(a1.get("first_row"), bool):
                a1["header"] = a1.get("first_row")
    except Exception:
        # Best-effort only: normalization must never raise here.
        logger.warning(
            "[plan.normalize] host-aware op normalization failed host=%s op=%s",
            host,
            op,
            exc_info=True,
        )

    action_id = _safe_id(a1.get("id") or fallback_id, prefix="step")
    title = str(a1.get("title") or op or "action").strip()[:200] or "action"

    if op == "insert_text":
        text = a1.get("text")
        if not isinstance(text, str) or not text.strip():
            content = a1.get("content")
            if isinstance(content, str) and content.strip():
                text = content
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_text",
            "text": text,
            "new_paragraph_before": bool(a1.get("new_paragraph_before") or False),
            "new_paragraph_after": bool(a1.get("new_paragraph_after") or False),
        }
        # Keep schema strict: drop unknown keys.
        return out

    if op == "set_selection":
        anchor_raw = a1.get("anchor")
        try:
            anchor = str(anchor_raw or "cursor").strip().lower()
        except Exception:
            anchor = "cursor"
        if anchor in ("start", "start_of_document", "startofdocument", "doc_start", "document_start"):
            anchor = "start_of_document"
        elif anchor in ("end", "end_of_document", "endofdocument", "doc_end", "document_end"):
            anchor = "end_of_document"
        elif anchor not in ("cursor", "start_of_document", "end_of_document"):
            anchor = "cursor"

        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "set_selection",
            "anchor": anchor,
            "offset_lines": _to_int(a1.get("offset_lines"), default=0),
            "offset_chars": _to_int(a1.get("offset_chars"), default=0),
        }
        sheet_name = _to_str_opt(a1.get("sheet_name") or a1.get("sheet"))
        if sheet_name is not None:
            out["sheet_name"] = sheet_name[:64]
        cell = _to_str_opt(a1.get("cell"))
        if cell is not None:
            out["cell"] = cell[:64]
        range_addr = _to_str_opt(a1.get("range"))
        if range_addr is not None:
            out["range"] = range_addr[:128]
        return out

    if op in ("insert_after_text", "insert_before_text"):
        anchor_text = a1.get("anchor_text")
        if not isinstance(anchor_text, str) or not anchor_text.strip():
            anchor_text = a1.get("anchor") if isinstance(a1.get("anchor"), str) else None
        text_value = a1.get("text") if isinstance(a1.get("text"), str) else a1.get("content")
        if not isinstance(text_value, str) or not text_value.strip():
            # Let schema validation fail with a clearer message.
            return {"id": action_id, "title": title, "op": op}
        out = {
            "id": action_id,
            "title": title,
            "op": op,
            "anchor_text": str(anchor_text),
            "text": text_value,
            "new_paragraph_before": bool(a1.get("new_paragraph_before") or False),
            "new_paragraph_after": bool(a1.get("new_paragraph_after") or False),
        }
        return out

    if op == "insert_table":
        rows = _to_int_opt(a1.get("rows"))
        cols = _to_int_opt(a1.get("cols"))
        if rows is None:
            rows = 2
        if cols is None:
            cols = 2

        data_raw = a1.get("data")
        data: list[list[str]] | None = None
        if isinstance(data_raw, list):
            tmp: list[list[str]] = []
            for r in data_raw:
                if not isinstance(r, list):
                    continue
                tmp.append([("" if c is None else str(c))[:20_000] for c in r][:50])
            if tmp:
                data = tmp[:100]
                rows = max(rows, len(data))
                cols = max(cols, max((len(r) for r in data), default=cols))
                rows = min(rows, 100)
                cols = min(cols, 50)
                data = [r[:cols] + ([""] * max(0, cols - len(r))) for r in data[:rows]]

        out = {
            "id": action_id,
            "title": title,
            "op": "insert_table",
            "rows": rows,
            "cols": cols,
            "data": data,
            "borders": a1.get("borders"),
            "style": a1.get("style"),
            "header": a1.get("header"),
            "auto_fit": a1.get("auto_fit"),
        }
        return out

    if op == "insert_chart_from_selection":
        chart_type = _to_int_opt(a1.get("chart_type"))
        width = _to_float_opt(a1.get("width"))
        height = _to_float_opt(a1.get("height"))
        has_legend = _to_bool_opt(a1.get("has_legend"))
        legend_position = _to_str_opt(a1.get("legend_position"))
        sheet_name = _to_str_opt(a1.get("sheet_name"))
        source_range = _to_str_opt(a1.get("source_range"))
        add_trendline = _to_bool_opt(a1.get("add_trendline"))
        trendline_type = _to_str_opt(a1.get("trendline_type"))
        show_data_labels = _to_bool_opt(a1.get("show_data_labels"))
        data_labels_show_percent = _to_bool_opt(a1.get("data_labels_show_percent"))
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_chart_from_selection",
            "chart_type": chart_type,
            "sheet_name": sheet_name,
            "source_range": source_range,
            "width": width,
            "height": height,
            "has_legend": has_legend,
            "legend_position": legend_position,
            "add_trendline": add_trendline,
            "trendline_type": trendline_type,
            "show_data_labels": show_data_labels,
            "data_labels_show_percent": data_labels_show_percent,
            "title": _to_str_opt(a1.get("title")),
        }
        return out

    if op == "insert_word_art":
        text_value = a1.get("text") if isinstance(a1.get("text"), str) else a1.get("content")
        if not isinstance(text_value, str) or not text_value.strip():
            return {"id": action_id, "title": title, "op": "insert_word_art"}
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_word_art",
            "text": text_value,
            "preset": _to_int_opt(a1.get("preset")),
            "font": _to_str_opt(a1.get("font")),
            "size": _to_float_opt(a1.get("size")) or _to_int_opt(a1.get("size")),
            "bold": _to_bool_opt(a1.get("bold")),
            "italic": _to_bool_opt(a1.get("italic")),
        }
        return out

    if op == "set_cell_formula":
        cell = a1.get("cell") if isinstance(a1.get("cell"), str) else a1.get("address")
        formula = a1.get("formula") if isinstance(a1.get("formula"), str) else a1.get("text")
        if not isinstance(cell, str) or not cell.strip() or not isinstance(formula, str) or not formula.strip():
            return {"id": action_id, "title": title, "op": "set_cell_formula"}
        out = {
            "id": action_id,
            "title": title,
            "op": "set_cell_formula",
            "cell": cell,
            "formula": formula,
        }
        return out

    if op == "set_number_format":
        range_addr = a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address")
        fmt = a1.get("number_format") if isinstance(a1.get("number_format"), str) else a1.get("format")
        if not isinstance(range_addr, str) or not range_addr.strip() or not isinstance(fmt, str) or not fmt.strip():
            return {"id": action_id, "title": title, "op": "set_number_format"}
        out = {
            "id": action_id,
            "title": title,
            "op": "set_number_format",
            "range": range_addr,
            "number_format": fmt,
        }
        return out

    if op == "set_conditional_format":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_conditional_format",
            "range": a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address"),
            "rule_type": a1.get("rule_type") if isinstance(a1.get("rule_type"), str) else "color_scale",
            "operator": a1.get("operator") if isinstance(a1.get("operator"), str) else None,
            "formula1": a1.get("formula1") if isinstance(a1.get("formula1"), str) else None,
            "formula2": a1.get("formula2") if isinstance(a1.get("formula2"), str) else None,
            "min_color": a1.get("min_color") if isinstance(a1.get("min_color"), str) else None,
            "mid_color": a1.get("mid_color") if isinstance(a1.get("mid_color"), str) else None,
            "max_color": a1.get("max_color") if isinstance(a1.get("max_color"), str) else None,
            "fill_color": a1.get("fill_color") if isinstance(a1.get("fill_color"), str) else None,
            "font_color": a1.get("font_color") if isinstance(a1.get("font_color"), str) else None,
            "bold": a1.get("bold") if isinstance(a1.get("bold"), bool) else None,
            "clear_existing": bool(a1.get("clear_existing") if a1.get("clear_existing") is not None else True),
        }
        return out

    if op == "set_data_validation":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_data_validation",
            "range": a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address"),
            "validation_type": a1.get("validation_type") if isinstance(a1.get("validation_type"), str) else "list",
            "operator": a1.get("operator") if isinstance(a1.get("operator"), str) else None,
            "formula1": (
                a1.get("formula1")
                if isinstance(a1.get("formula1"), str)
                else (
                    a1.get("source")
                    if isinstance(a1.get("source"), str)
                    else (
                        a1.get("value") if isinstance(a1.get("value"), str) else a1.get("list")
                    )
                )
            ),
            "formula2": a1.get("formula2") if isinstance(a1.get("formula2"), str) else None,
            "allow_blank": bool(a1.get("allow_blank") if a1.get("allow_blank") is not None else True),
            "in_cell_dropdown": bool(a1.get("in_cell_dropdown") if a1.get("in_cell_dropdown") is not None else True),
            "show_input": bool(a1.get("show_input") if a1.get("show_input") is not None else True),
            "show_error": bool(a1.get("show_error") if a1.get("show_error") is not None else True),
            "input_title": a1.get("input_title") if isinstance(a1.get("input_title"), str) else None,
            "input_message": a1.get("input_message") if isinstance(a1.get("input_message"), str) else None,
            "error_title": a1.get("error_title") if isinstance(a1.get("error_title"), str) else None,
            "error_message": a1.get("error_message") if isinstance(a1.get("error_message"), str) else None,
        }
        return out

    if op == "sort_range":
        out = {
            "id": action_id,
            "title": title,
            "op": "sort_range",
            "range": a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address"),
            "key": a1.get("key") if isinstance(a1.get("key"), str) else a1.get("sort_by"),
            "order": a1.get("order") if isinstance(a1.get("order"), str) else "asc",
            "has_header": bool(a1.get("has_header") or False),
        }
        return out

    if op == "filter_range":
        field = a1.get("field")
        if not isinstance(field, int):
            try:
                field = int(field)
            except Exception:
                field = None
        out = {
            "id": action_id,
            "title": title,
            "op": "filter_range",
            "range": a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address"),
            "field": field,
            "criteria1": (
                a1.get("criteria1")
                if isinstance(a1.get("criteria1"), str)
                else (a1.get("criteria") if isinstance(a1.get("criteria"), str) else None)
            ),
            "operator": a1.get("operator") if isinstance(a1.get("operator"), str) else None,
            "criteria2": a1.get("criteria2") if isinstance(a1.get("criteria2"), str) else None,
            "visible_dropdown": bool(a1.get("visible_dropdown") if a1.get("visible_dropdown") is not None else True),
        }
        return out

    if op == "transform_range":
        transform = _to_str_opt(a1.get("transform")) or "transpose"
        if transform not in ("transpose",):
            transform = "transpose"
        out = {
            "id": action_id,
            "title": title,
            "op": "transform_range",
            "source_range": (
                a1.get("source_range") if isinstance(a1.get("source_range"), str) else a1.get("source")
            ),
            "destination": (
                a1.get("destination") if isinstance(a1.get("destination"), str) else a1.get("dest")
            ),
            "transform": transform,
            "clear_existing": bool(a1.get("clear_existing") if a1.get("clear_existing") is not None else True),
        }
        return out

    if op == "create_pivot_table":
        rows_raw = a1.get("rows") if isinstance(a1.get("rows"), list) else []
        columns_raw = a1.get("columns") if isinstance(a1.get("columns"), list) else []
        filters_raw = a1.get("filters") if isinstance(a1.get("filters"), list) else []
        values_raw = a1.get("values") if isinstance(a1.get("values"), list) else []
        if not values_raw and isinstance(a1.get("value_fields"), list):
            values_raw = a1.get("value_fields")

        def _clean_fields(items: list[Any]) -> list[str]:
            out: list[str] = []
            for it in items:
                if not isinstance(it, (str, int, float)):
                    continue
                s = str(it).strip()
                if s:
                    out.append(s)
            return out

        rows = _clean_fields(rows_raw)
        columns = _clean_fields(columns_raw)
        filters = _clean_fields(filters_raw)

        def _norm_summary(v: Any) -> str:
            s = _to_str_opt(v) or ""
            t = s.strip().lower()
            if not t:
                return "sum"
            m = {
                # English aliases
                "avg": "average",
                "mean": "average",
                "cnt": "count",
                "total": "sum",
                # Chinese common terms
                "求和": "sum",
                "合计": "sum",
                "总计": "sum",
                "计数": "count",
                "数量": "count",
                "平均": "average",
                "最大": "max",
                "最小": "min",
            }
            t = m.get(t, t)
            if t in ("sum", "count", "average", "max", "min"):
                return t
            return "sum"

        values: list[dict[str, Any]] = []
        for idx, value in enumerate(values_raw):
            # Allow shorthand: ["Sales", "sum"] or "Sales"
            if isinstance(value, str):
                field = value.strip()
                if field:
                    values.append({"field": field, "summary": "sum", "title": None})
                continue
            if isinstance(value, (list, tuple)) and len(value) >= 1:
                field = str(value[0]).strip()
                if not field:
                    continue
                summary = _norm_summary(value[1] if len(value) >= 2 else None)
                values.append({"field": field, "summary": summary, "title": None})
                continue
            v = _as_plain_dict(value)
            if not v:
                continue
            field_raw = v.get("field") if v.get("field") is not None else v.get("name")
            field = str(field_raw).strip() if isinstance(field_raw, (str, int, float)) else None
            if not field:
                continue
            summary = _norm_summary(v.get("summary") if v.get("summary") is not None else v.get("agg"))
            title = v.get("title") if isinstance(v.get("title"), str) else None
            values.append(
                {
                    "field": field,
                    "summary": summary,
                    "title": title,
                }
            )

        # Server schema requires values>=1; best-effort fallback to keep writeback executable.
        if not values:
            fallback_field = rows[0] if rows else (columns[0] if columns else None)
            if fallback_field:
                values = [{"field": fallback_field, "summary": "count", "title": None}]

        # Server schema requires rows>=1; best-effort choose a stable dimension field.
        if not rows:
            dim = None
            if columns:
                dim = columns[0]
                columns = columns[1:]
            elif values:
                dim = values[0].get("field")
            if isinstance(dim, str) and dim.strip():
                rows = [dim.strip()]

        out = {
            "id": action_id,
            "title": title,
            "op": "create_pivot_table",
            "source_range": (
                a1.get("source_range") if isinstance(a1.get("source_range"), str) else a1.get("source")
            ),
            "destination": (
                a1.get("destination") if isinstance(a1.get("destination"), str) else a1.get("dest")
            ),
            "rows": rows,
            "columns": columns,
            "values": values,
            "filters": filters,
            "table_name": a1.get("table_name") if isinstance(a1.get("table_name"), str) else None,
            "replace_existing": bool(a1.get("replace_existing") if a1.get("replace_existing") is not None else True),
        }
        return out

    if op == "set_slide_background":
        color = _to_str_opt(a1.get("color") if isinstance(a1.get("color"), str) else a1.get("fill")) or "#FFFFFF"
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_background",
            "color": color,
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    if op == "set_slide_text_style":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_text_style",
            "font": _to_str_opt(a1.get("font")),
            "size": _to_float_opt(a1.get("size")) or _to_int_opt(a1.get("size")),
            "bold": _to_bool_opt(a1.get("bold")),
            "color": _to_str_opt(a1.get("color")),
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    if op == "set_slide_theme":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_theme",
            "theme_name": a1.get("theme_name") if isinstance(a1.get("theme_name"), str) else None,
            "theme_index": a1.get("theme_index") if isinstance(a1.get("theme_index"), int) else None,
            "template_path": a1.get("template_path") if isinstance(a1.get("template_path"), str) else None,
            "apply_to_all": bool(a1.get("apply_to_all") if a1.get("apply_to_all") is not None else True),
        }
        return out

    if op == "set_slide_layout":
        layout = _to_int_opt(a1.get("layout"))
        if layout is None:
            layout = 1
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_layout",
            "layout": layout,
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    if op == "set_shape_style":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_shape_style",
            "shape_name": a1.get("shape_name") if isinstance(a1.get("shape_name"), str) else None,
            "fill_color": a1.get("fill_color") if isinstance(a1.get("fill_color"), str) else None,
            "line_color": a1.get("line_color") if isinstance(a1.get("line_color"), str) else None,
            "line_width": _to_float_opt(a1.get("line_width")) or _to_int_opt(a1.get("line_width")),
            "text_color": a1.get("text_color") if isinstance(a1.get("text_color"), str) else None,
            "bold": _to_bool_opt(a1.get("bold")),
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    if op == "set_table_style":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_table_style",
            "shape_name": a1.get("shape_name") if isinstance(a1.get("shape_name"), str) else None,
            "style_name": a1.get("style_name") if isinstance(a1.get("style_name"), str) else None,
            "first_row": a1.get("first_row") if isinstance(a1.get("first_row"), bool) else None,
            "last_row": a1.get("last_row") if isinstance(a1.get("last_row"), bool) else None,
            "banded_rows": a1.get("banded_rows") if isinstance(a1.get("banded_rows"), bool) else None,
            "banded_columns": a1.get("banded_columns") if isinstance(a1.get("banded_columns"), bool) else None,
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    # ===================== WPP (PPT) add_* ops =====================

    if op == "add_slide":
        layout = a1.get("layout")
        if not isinstance(layout, int):
            try:
                layout = int(layout)
            except Exception:
                layout = None
        position = a1.get("position")
        if position is not None and not isinstance(position, int):
            try:
                position = int(position)
            except Exception:
                position = None
        out = {
            "id": action_id,
            "title": title,
            "op": "add_slide",
            "layout": layout if isinstance(layout, int) else 1,
            "title": _to_str_opt(a1.get("title")),
            "content": a1.get("content") if isinstance(a1.get("content"), str) else None,
            "position": position,
        }
        return out

    if op == "add_textbox":
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_textbox",
        }
        text_value = _to_str_opt(a1.get("text") or a1.get("content"))
        if text_value is not None:
            out["text"] = text_value
        for f in ("left", "top", "width", "height"):
            v = _to_float_opt(a1.get(f))
            if v is not None:
                out[f] = v
        font_size = _to_int_opt(a1.get("font_size"))
        if font_size is not None:
            out["font_size"] = font_size
        font_bold = _to_bool_opt(a1.get("font_bold"))
        if font_bold is not None:
            out["font_bold"] = font_bold
        font_color = _to_str_opt(a1.get("font_color"))
        if font_color is not None:
            out["font_color"] = font_color
        alignment = _to_str_opt(a1.get("alignment"))
        if alignment is not None:
            out["alignment"] = alignment
        placeholder_kind = _to_str_opt(a1.get("placeholder_kind"))
        if placeholder_kind is not None:
            out["placeholder_kind"] = placeholder_kind
        placeholder_type = _to_int_opt(a1.get("placeholder_type"))
        if placeholder_type is not None:
            out["placeholder_type"] = placeholder_type
        placeholder_index = _to_int_opt(a1.get("placeholder_index"))
        if placeholder_index is not None:
            # The schema uses 1-based placeholder_index, but some models output 0-based.
            # Clamp to schema bounds to avoid "invalid plan" failures.
            placeholder_index = max(1, min(10, placeholder_index))
            out["placeholder_index"] = placeholder_index
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "add_image":
        path = _to_str_opt(a1.get("path") or a1.get("url") or a1.get("image_path"))
        if path is None:
            # Treat missing/empty path as a "placeholder image": fallback to a rectangle shape with hint text.
            hint = _to_str_opt(a1.get("alt") or a1.get("description") or a1.get("desc") or a1.get("text"))
            out: dict[str, Any] = {
                "id": action_id,
                "title": title,
                "op": "add_shape",
                "shape_type": "rectangle",
            }
            for f in ("left", "top", "width", "height"):
                v = _to_float_opt(a1.get(f))
                if v is not None:
                    out[f] = v
            if hint is not None:
                out["text"] = f"[IMAGE] {hint}"[:5000]
            slide_index = _to_int_opt(a1.get("slide_index"))
            if slide_index is not None:
                out["slide_index"] = slide_index
            return out

        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_image",
            "path": path,
        }
        for f in ("left", "top", "width", "height"):
            v = _to_float_opt(a1.get(f))
            if v is not None:
                out[f] = v
        placeholder_kind = _to_str_opt(a1.get("placeholder_kind"))
        if placeholder_kind is not None:
            out["placeholder_kind"] = placeholder_kind
        placeholder_type = _to_int_opt(a1.get("placeholder_type"))
        if placeholder_type is not None:
            out["placeholder_type"] = placeholder_type
        placeholder_index = _to_int_opt(a1.get("placeholder_index"))
        if placeholder_index is not None:
            # 1-based per schema; tolerate 0-based outputs.
            placeholder_index = max(1, min(10, placeholder_index))
            out["placeholder_index"] = placeholder_index
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "add_chart":
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_chart",
        }
        chart_type = _to_str_opt(a1.get("chart_type") or a1.get("type"))
        if chart_type is not None:
            out["chart_type"] = chart_type
        chart_title = _to_str_opt(a1.get("title"))
        if chart_title is not None:
            out["title"] = chart_title
        if isinstance(a1.get("data"), list):
            out["data"] = a1.get("data")
        for f in ("left", "top", "width", "height"):
            v = _to_float_opt(a1.get(f))
            if v is not None:
                out[f] = v
        placeholder_kind = _to_str_opt(a1.get("placeholder_kind"))
        if placeholder_kind is not None:
            out["placeholder_kind"] = placeholder_kind
        placeholder_type = _to_int_opt(a1.get("placeholder_type"))
        if placeholder_type is not None:
            out["placeholder_type"] = placeholder_type
        placeholder_index = _to_int_opt(a1.get("placeholder_index"))
        if placeholder_index is not None:
            # 1-based per schema; tolerate 0-based outputs.
            placeholder_index = max(1, min(10, placeholder_index))
            out["placeholder_index"] = placeholder_index
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "add_table":
        rows = _to_int_opt(a1.get("rows"))
        cols = _to_int_opt(a1.get("cols"))
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_table",
        }
        if rows is not None:
            out["rows"] = rows
        if cols is not None:
            out["cols"] = cols
        if isinstance(a1.get("data"), list):
            out["data"] = a1.get("data")
        for f in ("left", "top", "width"):
            v = _to_float_opt(a1.get(f))
            if v is not None:
                out[f] = v
        style = _to_str_opt(a1.get("style"))
        if style is not None:
            out["style"] = style
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "add_shape":
        shape_type = _to_str_opt(a1.get("shape_type") or a1.get("type")) or "rectangle"
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_shape",
            "shape_type": shape_type,
        }
        for f in ("left", "top", "width", "height"):
            v = _to_float_opt(a1.get(f))
            if v is not None:
                out[f] = v
        fill_color = _to_str_opt(a1.get("fill_color"))
        if fill_color is not None:
            out["fill_color"] = fill_color
        line_color = _to_str_opt(a1.get("line_color"))
        if line_color is not None:
            out["line_color"] = line_color
        text_value = _to_str_opt(a1.get("text"))
        if text_value is not None:
            out["text"] = text_value[:5000]
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "delete_slide":
        slide_index = a1.get("slide_index")
        if slide_index is not None and not isinstance(slide_index, int):
            try:
                slide_index = int(slide_index)
            except Exception:
                slide_index = None
        out = {"id": action_id, "title": title, "op": "delete_slide", "slide_index": slide_index}
        return out

    if op == "duplicate_slide":
        source_index = a1.get("source_index")
        if source_index is None:
            source_index = a1.get("slide_index")
        if source_index is not None and not isinstance(source_index, int):
            try:
                source_index = int(source_index)
            except Exception:
                source_index = None

        target_position = a1.get("target_position")
        if target_position is None:
            target_position = a1.get("insert_after")
        if target_position is not None and not isinstance(target_position, int):
            try:
                target_position = int(target_position)
            except Exception:
                target_position = None
        out = {
            "id": action_id,
            "title": title,
            "op": "duplicate_slide",
            "source_index": source_index,
            "target_position": target_position,
        }
        return out

    if op == "reorder_slides":
        from_index = a1.get("from_index")
        to_index = a1.get("to_index")
        try:
            from_index = int(from_index)
        except Exception:
            from_index = None
        try:
            to_index = int(to_index)
        except Exception:
            to_index = None
        if from_index is None or to_index is None:
            return {"id": action_id, "title": title, "op": "reorder_slides"}

        out = {"id": action_id, "title": title, "op": "reorder_slides", "from_index": from_index, "to_index": to_index}
        return out

    if op == "set_slide_transition":
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "set_slide_transition",
            "advance_on_click": bool(
                a1.get("advance_on_click") if a1.get("advance_on_click") is not None else True
            ),
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        effect = _to_str_opt(a1.get("effect"))
        if effect is not None:
            out["effect"] = effect
        duration = _to_float_opt(a1.get("duration"))
        if duration is not None:
            out["duration"] = duration
        sound = _to_str_opt(a1.get("sound"))
        if sound is not None:
            out["sound"] = sound
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "add_animation":
        effect = _to_str_opt(a1.get("effect")) or "fade_in"
        out: dict[str, Any] = {
            "id": action_id,
            "title": title,
            "op": "add_animation",
            "effect": effect,
        }
        target_shape_name = _to_str_opt(a1.get("target_shape_name"))
        if target_shape_name is not None:
            out["target_shape_name"] = target_shape_name
        target_index = _to_int_opt(a1.get("target_index"))
        if target_index is not None:
            out["target_index"] = target_index
        trigger = _to_str_opt(a1.get("trigger"))
        if trigger is not None:
            out["trigger"] = trigger
        duration = _to_float_opt(a1.get("duration"))
        if duration is not None:
            out["duration"] = duration
        delay = _to_float_opt(a1.get("delay"))
        if delay is not None:
            out["delay"] = delay
        slide_index = _to_int_opt(a1.get("slide_index"))
        if slide_index is not None:
            out["slide_index"] = slide_index
        return out

    if op == "set_animation_timing":
        animation_index = a1.get("animation_index")
        if animation_index is not None and not isinstance(animation_index, int):
            try:
                animation_index = int(animation_index)
            except Exception:
                animation_index = None
        if not isinstance(animation_index, int):
            return {"id": action_id, "title": title, "op": "set_animation_timing"}
        out = {
            "id": action_id,
            "title": title,
            "op": "set_animation_timing",
            "animation_index": animation_index,
            "trigger": a1.get("trigger") if isinstance(a1.get("trigger"), str) else None,
            "duration": a1.get("duration"),
            "delay": a1.get("delay"),
            "slide_index": a1.get("slide_index") if isinstance(a1.get("slide_index"), int) else None,
        }
        return out

    if op == "add_hyperlink":
        address = a1.get("address")
        if not isinstance(address, str) or not address.strip():
            address = a1.get("url") if isinstance(a1.get("url"), str) else ""
        out = {
            "id": action_id,
            "title": title,
            "op": "add_hyperlink",
            "address": str(address or "").strip(),
            "text_to_display": a1.get("text_to_display") if isinstance(a1.get("text_to_display"), str) else None,
            "tooltip": a1.get("tooltip") if isinstance(a1.get("tooltip"), str) else None,
            "target_shape_name": a1.get("target_shape_name") if isinstance(a1.get("target_shape_name"), str) else None,
            "slide_index": a1.get("slide_index") if isinstance(a1.get("slide_index"), int) else None,
        }
        return out

    if op == "set_presentation_props":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_presentation_props",
            "title": a1.get("title") if isinstance(a1.get("title"), str) else None,
            "author": a1.get("author") if isinstance(a1.get("author"), str) else None,
            "subject": a1.get("subject") if isinstance(a1.get("subject"), str) else None,
            "comments": a1.get("comments") if isinstance(a1.get("comments"), str) else None,
        }
        return out

    if op == "set_text_style":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_text_style",
            "font": a1.get("font"),
            "size": a1.get("size"),
            "bold": a1.get("bold"),
            "italic": a1.get("italic"),
            "color": a1.get("color"),
            "apply_to_selection": bool(a1.get("apply_to_selection") if a1.get("apply_to_selection") is not None else True),
        }
        return out

    if op == "set_paragraph_format":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_paragraph_format",
            "block_id": _safe_id(a1.get("block_id"), prefix="blk") if isinstance(a1.get("block_id"), str) and a1.get("block_id").strip() else None,
            "apply_to_selection": bool(a1.get("apply_to_selection") if a1.get("apply_to_selection") is not None else True),
            "alignment": a1.get("alignment"),
            "line_spacing": a1.get("line_spacing"),
            "space_before": a1.get("space_before"),
            "space_after": a1.get("space_after"),
        }
        return out

    if op == "apply_paragraph_style":
        style_in = (
            a1.get("style")
            or a1.get("paragraph_style")
            or a1.get("paragraphStyle")
            or a1.get("text_style")
            or a1.get("textStyle")
        )
        style_map: dict[str, Any] = {}
        if isinstance(style_in, dict):
            for k, v in style_in.items():
                try:
                    nk = _map_key(str(k))
                except Exception:
                    nk = str(k)
                style_map[nk] = v

        def pick(key: str) -> Any:
            v = a1.get(key)
            if v is not None:
                return v
            return style_map.get(key)

        raw_apply = a1.get("apply_to_selection")
        if raw_apply is None:
            raw_apply = a1.get("applyToSelection")
        apply_to_selection = _to_bool_opt(raw_apply)
        if apply_to_selection is None:
            apply_to_selection = True

        out = {
            "id": action_id,
            "title": title,
            "op": "apply_paragraph_style",
            "block_id": (
                _safe_id(a1.get("block_id"), prefix="blk")
                if isinstance(a1.get("block_id"), str) and a1.get("block_id").strip()
                else None
            ),
            "apply_to_selection": bool(apply_to_selection),
            "max_paragraphs": _to_int(a1.get("max_paragraphs"), default=2000),
            "font": _to_str_opt(pick("font")),
            "size": _to_float_opt(pick("size")) or _to_int_opt(pick("size")),
            "bold": _to_bool_opt(pick("bold")),
            "italic": _to_bool_opt(pick("italic")),
            "color": _to_str_opt(pick("color")),
            "alignment": _to_str_opt(pick("alignment")),
            "line_spacing": _to_str_opt(pick("line_spacing")),
            "space_before": _to_float_opt(pick("space_before")) or _to_int_opt(pick("space_before")),
            "space_after": _to_float_opt(pick("space_after")) or _to_int_opt(pick("space_after")),
        }
        return out

    if op == "normalize_headings":
        raw_levels = a1.get("levels")
        levels_in = raw_levels if isinstance(raw_levels, list) else []
        levels_out: list[dict[str, Any]] = []
        for it in levels_in[:20]:
            if not isinstance(it, dict):
                continue
            m: dict[str, Any] = {}
            for k, v in it.items():
                try:
                    nk = _map_key(str(k))
                except Exception:
                    nk = str(k)
                m[nk] = v
            lvl = _to_int_opt(m.get("level"))
            if lvl is None or lvl < 1 or lvl > 9:
                continue
            item = {
                "level": lvl,
                "font": _to_str_opt(m.get("font")),
                "size": _to_float_opt(m.get("size")) or _to_int_opt(m.get("size")),
                "bold": _to_bool_opt(m.get("bold")),
                "italic": _to_bool_opt(m.get("italic")),
                "color": _to_str_opt(m.get("color")),
                "alignment": _to_str_opt(m.get("alignment")),
                "line_spacing": _to_str_opt(m.get("line_spacing")),
                "space_before": _to_float_opt(m.get("space_before")) or _to_int_opt(m.get("space_before")),
                "space_after": _to_float_opt(m.get("space_after")) or _to_int_opt(m.get("space_after")),
            }
            # Keep only if at least one style field is provided.
            if any(
                item.get(k) is not None
                for k in (
                    "font",
                    "size",
                    "bold",
                    "italic",
                    "color",
                    "alignment",
                    "line_spacing",
                    "space_before",
                    "space_after",
                )
            ):
                levels_out.append(item)
        out = {
            "id": action_id,
            "title": title,
            "op": "normalize_headings",
            "block_id": _safe_id(a1.get("block_id"), prefix="blk") if isinstance(a1.get("block_id"), str) and a1.get("block_id").strip() else None,
            "apply_to_selection": bool(a1.get("apply_to_selection") if a1.get("apply_to_selection") is not None else True),
            "max_paragraphs": _to_int(a1.get("max_paragraphs"), default=3000),
            "levels": levels_out,
        }
        return out

    if op == "set_writer_table_style":
        style_in = a1.get("style") or a1.get("table_style") or a1.get("tableStyle")
        style_map: dict[str, Any] = {}
        if isinstance(style_in, dict):
            for k, v in style_in.items():
                try:
                    nk = _map_key(str(k))
                except Exception:
                    nk = str(k)
                style_map[nk] = v

        raw_apply = a1.get("apply_to_selection")
        if raw_apply is None:
            raw_apply = a1.get("applyToSelection")
        apply_to_selection = _to_bool_opt(raw_apply)
        if apply_to_selection is None:
            apply_to_selection = True

        style_name = a1.get("style_name") or a1.get("styleName")
        if style_name is None:
            style_name = style_map.get("style_name")

        def pick(key: str) -> Any:
            v = a1.get(key)
            if v is not None:
                return v
            return style_map.get(key)

        out = {
            "id": action_id,
            "title": title,
            "op": "set_writer_table_style",
            "block_id": (
                _safe_id(a1.get("block_id"), prefix="blk")
                if isinstance(a1.get("block_id"), str) and a1.get("block_id").strip()
                else None
            ),
            "apply_to_selection": bool(apply_to_selection),
            "style_name": _to_str_opt(style_name),
            "borders": _to_bool_opt(pick("borders")),
            "header": _to_bool_opt(pick("header")),
        }
        return out

    if op == "apply_text_style_to_matches":
        style_in = a1.get("style") or a1.get("text_style") or a1.get("textStyle")
        style_map: dict[str, Any] = {}
        if isinstance(style_in, dict):
            for k, v in style_in.items():
                try:
                    nk = _map_key(str(k))
                except Exception:
                    nk = str(k)
                style_map[nk] = v

        def pick(key: str) -> Any:
            v = a1.get(key)
            if v is not None:
                return v
            return style_map.get(key)

        max_matches = a1.get("max_matches") if a1.get("max_matches") is not None else a1.get("maxMatches")
        try:
            max_matches = int(max_matches or 50)
        except Exception:
            max_matches = 50
        max_matches = max(1, min(500, int(max_matches)))

        find_text = (
            a1.get("find_text")
            or a1.get("findText")
            or a1.get("pattern")
            or a1.get("text")
            or a1.get("needle")
            or ""
        )

        raw_case_sensitive = a1.get("case_sensitive")
        if raw_case_sensitive is None:
            raw_case_sensitive = a1.get("caseSensitive")
        case_sensitive = _to_bool_opt(raw_case_sensitive)
        if case_sensitive is None:
            case_sensitive = False

        raw_whole_word = a1.get("whole_word")
        if raw_whole_word is None:
            raw_whole_word = a1.get("wholeWord")
        whole_word = _to_bool_opt(raw_whole_word)
        if whole_word is None:
            whole_word = False

        out = {
            "id": action_id,
            "title": title,
            "op": "apply_text_style_to_matches",
            "find_text": str(find_text or "").strip(),
            "max_matches": max_matches,
            "block_id": (
                _safe_id(a1.get("block_id"), prefix="blk")
                if isinstance(a1.get("block_id"), str) and a1.get("block_id").strip()
                else None
            ),
            "case_sensitive": bool(case_sensitive),
            "whole_word": bool(whole_word),
            "font": _to_str_opt(pick("font")),
            "size": _to_float_opt(pick("size")) or _to_int_opt(pick("size")),
            "bold": _to_bool_opt(pick("bold")),
            "italic": _to_bool_opt(pick("italic")),
            "color": _to_str_opt(pick("color")),
        }
        return out

    if op == "delete_block":
        out = {
            "id": action_id,
            "title": title,
            "op": "delete_block",
            "block_id": _safe_id(a1.get("block_id"), prefix="blk"),
        }
        return out

    if op == "upsert_block":
        block_id = _safe_id(a1.get("block_id") or a1.get("blockId") or "ah32_auto", prefix="blk")
        anchor = str(a1.get("anchor") or "cursor").strip().lower()
        if anchor in ("end_of_document", "endofdocument"):
            anchor = "end"
        if anchor not in ("cursor", "end"):
            anchor = "cursor"
        freeze = a1.get("freeze_cursor")
        freeze_cursor = True if freeze is None else bool(freeze)

        children_raw = a1.get("actions")
        children: list[dict[str, Any]] = []
        if isinstance(children_raw, list):
            for i, child in enumerate(children_raw):
                norm = _normalize_action(child, fallback_id=f"{action_id}_{i+1}", host=host)
                if norm is not None:
                    children.append(norm)

        if not children:
            inserts_raw = a1.get("inserts")
            if isinstance(inserts_raw, list):
                for j, ins in enumerate(inserts_raw):
                    if isinstance(ins, dict):
                        typ = str(ins.get("type") or ins.get("op") or "").strip().lower()
                        if typ in ("text", "insert_text", "inserttext"):
                            txt = ins.get("content")
                            if not isinstance(txt, str) or not txt.strip():
                                txt = ins.get("text")
                            if isinstance(txt, str) and txt.strip():
                                before = ins.get("new_paragraph_before")
                                if before is None:
                                    before = ins.get("newParagraphBefore")
                                new_paragraph_before = bool(before) if before is not None else False

                                after = ins.get("new_paragraph_after")
                                if after is None:
                                    after = ins.get("newParagraphAfter")
                                new_paragraph_after = bool(after) if after is not None else True

                                children.append(
                                    {
                                        "id": _safe_id(f"{action_id}_ins{j+1}", prefix="step"),
                                        "title": "Insert text",
                                        "op": "insert_text",
                                        "text": txt,
                                        "new_paragraph_before": new_paragraph_before,
                                        "new_paragraph_after": new_paragraph_after,
                                    }
                                )
                                continue

                        if typ in ("table", "insert_table", "inserttable"):
                            rows = _to_int_opt(ins.get("rows")) or 2
                            cols = _to_int_opt(ins.get("cols")) or 2
                            data = ins.get("data") if isinstance(ins.get("data"), list) else None
                            children.append(
                                {
                                    "id": _safe_id(f"{action_id}_ins{j+1}", prefix="step"),
                                    "title": "Insert table",
                                    "op": "insert_table",
                                    "rows": rows,
                                    "cols": cols,
                                    "data": data,
                                    "borders": None,
                                    "style": None,
                                    "header": None,
                                    "auto_fit": None,
                                }
                            )
                            continue

                    if isinstance(ins, str) and ins.strip():
                        children.append(
                            {
                                "id": _safe_id(f"{action_id}_ins{j+1}", prefix="step"),
                                "title": "Insert text",
                                "op": "insert_text",
                                "text": ins,
                                "new_paragraph_before": False,
                                "new_paragraph_after": True,
                            }
                        )

            if not children:
                content = a1.get("content")
                if not isinstance(content, str) or not content.strip():
                    content = a1.get("text") if isinstance(a1.get("text"), str) else ""
                if isinstance(content, str) and content.strip():
                    children = [
                        {
                            "id": _safe_id(f"{action_id}_1", prefix="step"),
                            "title": "Insert text",
                            "op": "insert_text",
                            "text": content,
                            "new_paragraph_before": False,
                            "new_paragraph_after": True,
                        }
                    ]

        out = {
            "id": action_id,
            "title": title,
            "op": "upsert_block",
            "block_id": block_id,
            "anchor": anchor,
            "freeze_cursor": freeze_cursor,
            "actions": children,
        }
        return out

    if op == "answer_mode_apply":
        answers = a1.get("answers")
        if not isinstance(answers, list):
            answers = []
        out = {
            "id": action_id,
            "title": title,
            "op": "answer_mode_apply",
            "block_id": a1.get("block_id"),
            "answers": answers,
            "strict": bool(a1.get("strict") if a1.get("strict") is not None else True),
            "search_window_chars": a1.get("search_window_chars"),
            "backup": a1.get("backup"),
        }
        return out

    # Unknown op: keep minimal shape so validation can fail with a clearer message.
    return {"id": action_id, "title": title, "op": op}


def normalize_plan_payload(plan: Any, *, host_app: HostApp | str | None = None) -> dict[str, Any]:
    """
    Best-effort normalization for LLM-produced plan JSON.

    This keeps the server-side Plan schema strict, while allowing common "wrapper" shapes
    (e.g. `params`) and noisy extra keys (e.g. `format`, `type`) to be stripped before validation.
    """
    p0 = _as_plain_dict(plan) or {}

    schema_version = PLAN_SCHEMA_ID
    # IMPORTANT: host_app argument (request host) overrides payload host_app.
    # LLM outputs occasionally contain a wrong host_app, and the server must validate ops
    # against the actual host to avoid unnecessary repair loops / false mismatches.
    host = (host_app or None) or p0.get("host_app") or p0.get("hostApp") or "wps"
    try:
        host = str(host).strip().lower()
    except Exception:
        host = "wps"
    host = {"word": "wps", "writer": "wps", "wps": "wps", "excel": "et", "et": "et", "ppt": "wpp", "wpp": "wpp"}.get(
        host, host
    )

    meta = p0.get("meta")
    if not isinstance(meta, dict):
        meta = {}

    actions_raw = p0.get("actions")
    if actions_raw is None:
        actions_raw = p0.get("steps")
    actions_list = actions_raw if isinstance(actions_raw, list) else []

    actions: list[dict[str, Any]] = []
    for i, a in enumerate(actions_list):
        norm = _normalize_action(a, fallback_id=f"step_{i+1}", host=host)
        if norm is not None:
            actions.append(norm)

    return {
        "schema_version": schema_version,
        "host_app": host,
        "meta": meta,
        "actions": actions,
    }
