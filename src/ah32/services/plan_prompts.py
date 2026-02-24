from __future__ import annotations

import json

from ah32.plan.schema import PLAN_SCHEMA_ID


def get_plan_generation_prompt(host_app: str = "wps") -> str:
    """Return a host-specific system prompt for generating a deterministic Plan JSON."""

    host = (host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"

    allowed_ops = {
        "wps": [
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
        ],
        "et": [
            "upsert_block",
            "delete_block",
            "set_selection",
            "insert_text",
            "insert_table",
            "insert_chart_from_selection",
            "set_cell_formula",
            "set_number_format",
            "set_conditional_format",
            "set_data_validation",
            "sort_range",
            "filter_range",
            "transform_range",
            "create_pivot_table",
        ],
        "wpp": [
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
        ],
    }[host]

    allowed_ops_text = "\n".join([f"- {op}" for op in allowed_ops])

    # Keep the schema description intentionally compact; validation is enforced server-side.
    example = {
        "schema_version": PLAN_SCHEMA_ID,
        "host_app": host,
        "meta": {"note": "optional"},
        "actions": [
            {
                "id": "step_0",
                "title": "Move cursor",
                "op": "set_selection",
                "anchor": "start_of_document",
                "offset_lines": 0,
                "offset_chars": 0,
            },
            {
                "id": "step_1",
                "title": "Write artifact",
                "op": "upsert_block",
                "block_id": "ah32_auto",
                "anchor": "cursor",
                "freeze_cursor": True,
                "actions": [
                    {
                        "id": "step_1_1",
                        "title": "Insert text",
                        "op": "insert_text",
                        "text": "Hello",
                        "new_paragraph_after": True,
                    }
                ],
            }
        ],
    }

    return (
        "You are a deterministic Plan JSON generator for WPS Office add-in execution.\n"
        "Return a SINGLE JSON object only (no markdown, no code fences, no explanations).\n\n"
        "Hard constraints:\n"
        f"- schema_version MUST be {json.dumps(PLAN_SCHEMA_ID)}\n"
        f"- host_app MUST be {json.dumps(host)}\n"
        "- The JSON must be strictly valid (double quotes, no trailing commas).\n"
        "- Do NOT output JavaScript.\n"
        "- Do NOT wrap fields in a `params` object (flatten all fields at the action level).\n"
        "- Do NOT use non-schema keys like: params, arguments, inserts, content, format, type.\n"
        "- Each action MUST include: id, title, op.\n"
        "- id and block_id must match /^[a-zA-Z0-9_\\-:.]{1,64}$/.\n"
        "- For op=set_selection:\n"
        "  - wps(Writer): anchor is one of cursor/start_of_document/end_of_document; offset_lines/offset_chars are integers.\n"
        "  - et(Excel): prefer sheet_name + range/cell (A1 or A1:D10). range/cell may also be 'Sheet1!$A$1:$D$10'.\n"
        "- For wpp:add_textbox:\n"
        "  - You may set placeholder_kind (title|body|subtitle) + placeholder_index to fill layout placeholders (preferred).\n"
        "  - If placeholder is not found, executor will fall back to placing by left/top/width/height.\n"
        "- For document write-back, prefer op=upsert_block to ensure idempotency.\n\n"
        "Host-specific field constraints:\n"
        "- et:create_pivot_table -> source_range,destination,rows(>=1),values(>=1).\n"
        "- et:create_pivot_table.values[].summary MUST be one of: sum|count|average|max|min.\n"
        "- et:set_data_validation -> range,validation_type,formula1(required).\n"
        "- wpp:set_shape_style -> at least one of fill_color/line_color/line_width/text_color/bold.\n"
        "- wpp:set_table_style -> at least one of style_name/first_row/last_row/banded_rows/banded_columns.\n\n"
        "- wps:set_writer_table_style -> at least one of style_name/borders/header (prefer scoping via block_id or selection).\n\n"
        "- wps:apply_paragraph_style -> at least one style field; prefer scoping via block_id or selection.\n\n"
        "- wps:normalize_headings -> best-effort heading detection; prefer scoping via block_id or selection.\n\n"
        "Allowed ops for this host_app:\n"
        f"{allowed_ops_text}\n\n"
        "Top-level shape:\n"
        "- schema_version: string\n"
        "- host_app: 'wps' | 'et' | 'wpp'\n"
        "- meta: object (optional)\n"
        "- actions: array of actions\n\n"
        "Example (for format only):\n"
        f"{json.dumps(example, ensure_ascii=False)}"
    )


def get_plan_repair_prompt(host_app: str = "wps") -> str:
    """Return a host-specific system prompt for repairing a deterministic Plan JSON."""

    host = (host_app or "wps").strip().lower()
    if host not in ("wps", "et", "wpp"):
        host = "wps"

    allowed_ops = {
        "wps": [
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
        ],
        "et": [
            "upsert_block",
            "delete_block",
            "set_selection",
            "insert_text",
            "insert_table",
            "insert_chart_from_selection",
            "set_cell_formula",
            "set_number_format",
            "set_conditional_format",
            "set_data_validation",
            "sort_range",
            "filter_range",
            "transform_range",
            "create_pivot_table",
        ],
        "wpp": [
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
        ],
    }[host]

    allowed_ops_text = "\n".join([f"- {op}" for op in allowed_ops])

    return (
        "You are a deterministic Plan JSON repairer for WPS Office add-in execution.\n"
        "Return a SINGLE JSON object only (no markdown, no code fences, no explanations).\n\n"
        "Hard constraints:\n"
        f"- schema_version MUST be {json.dumps(PLAN_SCHEMA_ID)}\n"
        f"- host_app MUST be {json.dumps(host)}\n"
        "- The JSON must be strictly valid (double quotes, no trailing commas).\n"
        "- Do NOT output JavaScript.\n"
        "- Do NOT wrap fields in a `params` object (flatten all fields at the action level).\n"
        "- Do NOT use non-schema keys like: params, arguments, inserts, content, format, type.\n"
        "- Keep the plan minimal and fix only what is necessary.\n"
        "- Each action MUST include: id, title, op.\n"
        "- id and block_id must match /^[a-zA-Z0-9_\\-:.]{1,64}$/.\n\n"
        "- For op=set_selection:\n"
        "  - wps(Writer): anchor is one of cursor/start_of_document/end_of_document; offset_lines/offset_chars are integers.\n"
        "  - et(Excel): prefer sheet_name + range/cell (A1 or A1:D10). range/cell may also be 'Sheet1!$A$1:$D$10'.\n\n"
        "- For wpp:add_textbox:\n"
        "  - You may set placeholder_kind (title|body|subtitle) + placeholder_index to fill layout placeholders (preferred).\n"
        "  - If placeholder is not found, executor will fall back to placing by left/top/width/height.\n\n"
        "Host-specific field constraints:\n"
        "- et:create_pivot_table -> source_range,destination,rows(>=1),values(>=1).\n"
        "- et:create_pivot_table.values[].summary MUST be one of: sum|count|average|max|min.\n"
        "- et:set_data_validation -> range,validation_type,formula1(required).\n"
        "- wpp:set_shape_style -> at least one of fill_color/line_color/line_width/text_color/bold.\n"
        "- wpp:set_table_style -> at least one of style_name/first_row/last_row/banded_rows/banded_columns.\n\n"
        "- wps:set_writer_table_style -> at least one of style_name/borders/header (prefer scoping via block_id or selection).\n\n"
        "- wps:apply_paragraph_style -> at least one style field; prefer scoping via block_id or selection.\n\n"
        "- wps:normalize_headings -> best-effort heading detection; prefer scoping via block_id or selection.\n\n"
        "Allowed ops for this host_app:\n"
        f"{allowed_ops_text}\n"
    )
