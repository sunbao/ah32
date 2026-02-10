from __future__ import annotations

import copy
import json
from typing import Any, Dict, Optional


STYLE_SPEC_SCHEMA_V1 = "ah32.styleSpec.v1"


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge override into base (dict-only; lists are replaced)."""
    out = copy.deepcopy(base or {})
    for k, v in (override or {}).items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out.get(k) or {}, v)
        else:
            out[k] = v
    return out


def default_style_spec_v1(*, host_app: str | None = None) -> dict:
    """Return a conservative default StyleSpec for a given host (best-effort)."""
    host = (host_app or "").strip().lower()
    common = {
        "schema": STYLE_SPEC_SCHEMA_V1,
        "name": "default_v1",
        "palette": {
            "primary": "#2563eb",
            "accent": "#f59e0b",
            "danger": "#ef4444",
            "muted": "#94a3b8",
        },
        "font": {
            "body": {"name": "宋体", "size": 12},
            "title": {"name": "黑体", "size": 18, "bold": True},
            "subtitle": {"name": "黑体", "size": 14, "bold": True},
        },
        "writer": {
            "paragraph": {
                "titleSpacing": {"beforePt": 12, "afterPt": 6},
                "bodySpacing": {"beforePt": 0, "afterPt": 3},
                "lineSpacing": {"rule": "single"},
            },
            "table": {
                "header": {"bold": True, "fill": "#f1f5f9"},
                "borders": {"outer": "thick", "inner": "thin"},
                "alignment": {"header": "center", "numberColumnsRightAlign": True},
            },
        },
        "et": {
            "sheet": {"freeze": {"row": 1}, "columnWidth": {"autoFit": True}},
            "numberFormat": {"money": "¥#,##0.00", "percent": "0.00%", "date": "yyyy-mm-dd"},
            "chart": {"theme": "office", "palette": ["#2563eb", "#10b981", "#f59e0b", "#ef4444"]},
        },
        "wpp": {
            "deck": {"theme": "business_clean", "titleAlign": "center"},
            "slide": {"title": {"size": 28, "bold": True}, "body": {"size": 16}},
            "layout": {"grid": {"columns": 2, "gutter": 24, "margin": {"left": 60, "right": 60, "top": 60, "bottom": 60}}},
            "shape": {"emphasisBox": {"fill": "#2563eb", "textColor": "#ffffff"}},
        },
    }

    if host in ("wps", "writer"):
        return {k: common[k] for k in ("schema", "name", "palette", "font", "writer")}
    if host in ("et", "excel"):
        # ET prefers western UI fonts; keep body/title but leave common palette.
        et = copy.deepcopy(common)
        et["font"] = {
            "body": {"name": "Segoe UI", "size": 11},
            "title": {"name": "Segoe UI", "size": 14, "bold": True},
        }
        return {k: et[k] for k in ("schema", "name", "palette", "font", "et")}
    if host in ("wpp", "ppt", "powerpoint"):
        return {k: common[k] for k in ("schema", "name", "palette", "wpp")}

    return common


def normalize_style_spec(raw: Any, *, host_app: str | None = None) -> Optional[Dict[str, Any]]:
    """Normalize a StyleSpec payload into v1 shape (best-effort, never raises).

    - Accepts dict or JSON string.
    - Accepts legacy flat host fields (paragraph/table/sheet/chart/slide/layout/shape) and nests them.
    - Applies conservative defaults so prompts can rely on the presence of common keys.
    - Optionally filters to the target host (writer/et/wpp) to reduce prompt bloat.
    """
    if raw is None:
        return None

    try:
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return None
            try:
                raw = json.loads(s)
            except Exception:
                return None

        if not isinstance(raw, dict):
            return None

        spec = copy.deepcopy(raw)

        # Back-compat aliases
        if "schema_version" in spec and "schema" not in spec:
            spec["schema"] = spec.get("schema_version")
        if "styleSpec" in spec and "schema" not in spec and isinstance(spec.get("styleSpec"), dict):
            # Some clients wrap it as {styleSpec:{...}}
            spec = spec.get("styleSpec") or spec

        # Legacy flat host fields -> nested sections
        if ("paragraph" in spec or "table" in spec) and "writer" not in spec:
            writer: dict = {}
            if isinstance(spec.get("paragraph"), dict):
                writer["paragraph"] = spec.pop("paragraph")
            if isinstance(spec.get("table"), dict):
                writer["table"] = spec.pop("table")
            if writer:
                spec["writer"] = writer

        if ("sheet" in spec or "numberFormat" in spec or "number_format" in spec or "chart" in spec) and "et" not in spec:
            et: dict = {}
            if isinstance(spec.get("sheet"), dict):
                et["sheet"] = spec.pop("sheet")
            nf = spec.pop("numberFormat", None) or spec.pop("number_format", None)
            if isinstance(nf, dict):
                et["numberFormat"] = nf
            if isinstance(spec.get("chart"), dict):
                et["chart"] = spec.pop("chart")
            if et:
                spec["et"] = et

        if ("deck" in spec or "slide" in spec or "layout" in spec or "shape" in spec) and "wpp" not in spec:
            wpp: dict = {}
            if isinstance(spec.get("deck"), dict):
                wpp["deck"] = spec.pop("deck")
            if isinstance(spec.get("slide"), dict):
                wpp["slide"] = spec.pop("slide")
            if isinstance(spec.get("layout"), dict):
                wpp["layout"] = spec.pop("layout")
            if isinstance(spec.get("shape"), dict):
                wpp["shape"] = spec.pop("shape")
            if wpp:
                spec["wpp"] = wpp

        # Always pin schema/name (keep stable ids for logging).
        if not isinstance(spec.get("schema"), str) or not spec.get("schema"):
            spec["schema"] = STYLE_SPEC_SCHEMA_V1
        if not isinstance(spec.get("name"), str) or not spec.get("name"):
            spec["name"] = "default_v1"

        # Merge defaults (host-specific baseline) then override with user values.
        base = default_style_spec_v1(host_app=host_app)
        merged = _deep_merge(base, spec)

        # Reduce bloat: keep only known top-level sections.
        allowed_top = {"schema", "name", "palette", "font", "writer", "et", "wpp"}
        merged = {k: v for k, v in merged.items() if k in allowed_top}

        # Filter by host when requested.
        host = (host_app or "").strip().lower()
        if host in ("wps", "writer"):
            merged.pop("et", None)
            merged.pop("wpp", None)
        elif host in ("et", "excel"):
            merged.pop("writer", None)
            merged.pop("wpp", None)
        elif host in ("wpp", "ppt", "powerpoint"):
            merged.pop("writer", None)
            merged.pop("et", None)

        return merged
    except Exception:
        return None
