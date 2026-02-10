from __future__ import annotations

import hashlib
import re
from typing import Any

from ah32.plan.schema import PLAN_SCHEMA_ID, HostApp

_ID_RE = re.compile(r"^[a-zA-Z0-9_\-:.]{1,64}$")
_ID_SAFE_CHARS_RE = re.compile(r"[^a-zA-Z0-9_\-:.]+")


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
        "createPivotTable": "create_pivot_table",
        "setSlideBackground": "set_slide_background",
        "setSlideTextStyle": "set_slide_text_style",
        "setSlideTheme": "set_slide_theme",
        "setSlideLayout": "set_slide_layout",
        "setShapeStyle": "set_shape_style",
        "setTableStyle": "set_table_style",
        "setTextStyle": "set_text_style",
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
    }
    return key_map.get(k, k)


def _as_plain_dict(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return dict(value)


def _normalize_action(action: Any, *, fallback_id: str) -> dict[str, Any] | None:
    a0 = _as_plain_dict(action)
    if a0 is None:
        return None

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

        def _to_int(v: Any) -> int:
            try:
                if v is None:
                    return 0
                if isinstance(v, bool):
                    return int(v)
                if isinstance(v, (int, float)):
                    return int(v)
                s2 = str(v).strip()
                if not s2:
                    return 0
                return int(float(s2))
            except Exception:
                return 0

        out = {
            "id": action_id,
            "title": title,
            "op": "set_selection",
            "anchor": anchor,
            "offset_lines": _to_int(a1.get("offset_lines")),
            "offset_chars": _to_int(a1.get("offset_chars")),
        }
        return out

    if op in ("insert_after_text", "insert_before_text"):
        out = {
            "id": action_id,
            "title": title,
            "op": op,
            "anchor_text": a1.get("anchor_text"),
            "text": a1.get("text") if isinstance(a1.get("text"), str) else a1.get("content"),
            "new_paragraph_before": bool(a1.get("new_paragraph_before") or False),
            "new_paragraph_after": bool(a1.get("new_paragraph_after") or False),
        }
        return out

    if op == "insert_table":
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_table",
            "rows": a1.get("rows"),
            "cols": a1.get("cols"),
            "borders": a1.get("borders"),
            "style": a1.get("style"),
            "header": a1.get("header"),
            "auto_fit": a1.get("auto_fit"),
        }
        return out

    if op == "insert_chart_from_selection":
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_chart_from_selection",
            "chart_type": a1.get("chart_type"),
            "width": a1.get("width"),
            "height": a1.get("height"),
        }
        return out

    if op == "insert_word_art":
        out = {
            "id": action_id,
            "title": title,
            "op": "insert_word_art",
            "text": a1.get("text") if isinstance(a1.get("text"), str) else a1.get("content"),
            "preset": a1.get("preset"),
            "font": a1.get("font"),
            "size": a1.get("size"),
            "bold": a1.get("bold"),
            "italic": a1.get("italic"),
        }
        return out

    if op == "set_cell_formula":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_cell_formula",
            "cell": a1.get("cell") if isinstance(a1.get("cell"), str) else a1.get("address"),
            "formula": a1.get("formula") if isinstance(a1.get("formula"), str) else a1.get("text"),
        }
        return out

    if op == "set_number_format":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_number_format",
            "range": a1.get("range") if isinstance(a1.get("range"), str) else a1.get("address"),
            "number_format": a1.get("number_format") if isinstance(a1.get("number_format"), str) else a1.get("format"),
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

    if op == "create_pivot_table":
        rows = a1.get("rows") if isinstance(a1.get("rows"), list) else []
        columns = a1.get("columns") if isinstance(a1.get("columns"), list) else []
        filters = a1.get("filters") if isinstance(a1.get("filters"), list) else []
        values_raw = a1.get("values") if isinstance(a1.get("values"), list) else []
        if not values_raw and isinstance(a1.get("value_fields"), list):
            values_raw = a1.get("value_fields")
        values: list[dict[str, Any]] = []
        for idx, value in enumerate(values_raw):
            v = _as_plain_dict(value)
            if not v:
                continue
            field = v.get("field") if isinstance(v.get("field"), str) else v.get("name")
            summary = v.get("summary") if isinstance(v.get("summary"), str) else v.get("agg")
            title = v.get("title") if isinstance(v.get("title"), str) else None
            values.append(
                {
                    "field": field,
                    "summary": summary if isinstance(summary, str) else "sum",
                    "title": title,
                }
            )

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
            "rows": [str(r) for r in rows if isinstance(r, (str, int, float))],
            "columns": [str(c) for c in columns if isinstance(c, (str, int, float))],
            "values": values,
            "filters": [str(f) for f in filters if isinstance(f, (str, int, float))],
            "table_name": a1.get("table_name") if isinstance(a1.get("table_name"), str) else None,
            "replace_existing": bool(a1.get("replace_existing") if a1.get("replace_existing") is not None else True),
        }
        return out

    if op == "set_slide_background":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_background",
            "color": a1.get("color") if isinstance(a1.get("color"), str) else a1.get("fill"),
            "apply_to_all": bool(a1.get("apply_to_all") or False),
        }
        return out

    if op == "set_slide_text_style":
        out = {
            "id": action_id,
            "title": title,
            "op": "set_slide_text_style",
            "font": a1.get("font"),
            "size": a1.get("size"),
            "bold": a1.get("bold"),
            "color": a1.get("color"),
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
        layout = a1.get("layout")
        if not isinstance(layout, int):
            try:
                layout = int(layout)
            except Exception:
                layout = None
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
            "line_width": a1.get("line_width"),
            "text_color": a1.get("text_color") if isinstance(a1.get("text_color"), str) else None,
            "bold": a1.get("bold") if isinstance(a1.get("bold"), bool) else None,
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
                norm = _normalize_action(child, fallback_id=f"{action_id}_{i+1}")
                if norm is not None:
                    children.append(norm)

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

    schema_version = p0.get("schema_version") or p0.get("schema") or PLAN_SCHEMA_ID
    host = p0.get("host_app") or p0.get("hostApp") or (host_app or "wps")
    try:
        host = str(host).strip().lower()
    except Exception:
        host = "wps"

    meta = p0.get("meta")
    if not isinstance(meta, dict):
        meta = {}

    actions_raw = p0.get("actions")
    if actions_raw is None:
        actions_raw = p0.get("steps")
    actions_list = actions_raw if isinstance(actions_raw, list) else []

    actions: list[dict[str, Any]] = []
    for i, a in enumerate(actions_list):
        norm = _normalize_action(a, fallback_id=f"step_{i+1}")
        if norm is not None:
            actions.append(norm)

    return {
        "schema_version": schema_version,
        "host_app": host,
        "meta": meta,
        "actions": actions,
    }
