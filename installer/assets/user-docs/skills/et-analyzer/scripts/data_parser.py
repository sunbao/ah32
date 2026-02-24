"""ET data parser (best-effort).

Goal:
- Parse tabular text (TSV/CSV/Markdown table) into a compact structured preview.
- Keep the output small to avoid blowing up tokens when fed back to LLM.

Notes:
- `doc_text` can be auto-injected from the active ET document by AH32 runtime
  when the skill declares `capabilities.active_doc_text=true`.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any, Dict, List, Optional, Tuple


def data_parser(
    doc_text: str = "",
    max_preview_rows: int = 20,
    max_cols: int = 50,
    delimiter: str = "",
) -> Dict[str, Any]:
    """Parse one table from plain text.

    Args:
        doc_text: Table text (TSV/CSV/Markdown table).
        max_preview_rows: Only return the first N rows to keep payload small.
        max_cols: Safety cap for columns.
        delimiter: Force delimiter: "\\t" or "," (auto when empty).

    Returns:
        {
          "format": "tsv|csv|md_table|unknown",
          "headers": [...],
          "row_count": 123,
          "rows_preview": [{...}, ...],
          "numeric_columns": ["金额", ...],
          "notes": ["..."]
        }
    """
    raw = str(doc_text or "")
    if not raw.strip():
        return {
            "format": "unknown",
            "meta": {},
            "headers": [],
            "row_count": 0,
            "rows_preview": [],
            "numeric_columns": [],
            "notes": ["empty_input"],
        }

    max_preview_rows = max(0, int(max_preview_rows or 0))
    max_cols = max(1, int(max_cols or 0))
    delimiter = str(delimiter or "")

    meta, raw = _extract_meta_lines(raw)
    fmt = _detect_format(raw)

    notes: List[str] = []
    try:
        truncated = str(meta.get("truncated") or "").strip().lower() == "true"
        truncated_by_budget = str(meta.get("truncated_by_char_budget") or "").strip().lower() == "true"
        if truncated or truncated_by_budget:
            notes.append("preview_truncated")
            if truncated_by_budget:
                notes.append("truncated_by_char_budget")
    except Exception:
        # best-effort only
        pass

    if fmt == "md_table":
        headers, rows = _parse_markdown_table(raw, max_cols=max_cols)
    else:
        delim = delimiter or ("\t" if ("\t" in raw) else ",")
        headers, rows = _parse_delimited(raw, delimiter=delim, max_cols=max_cols)
        fmt = "tsv" if delim == "\t" else "csv"

    if not headers:
        notes.append("header_not_detected")

    numeric_cols = _infer_numeric_columns(headers, rows[: min(len(rows), 200)])
    preview = rows[:max_preview_rows] if max_preview_rows > 0 else []

    return {
        "format": fmt,
        "meta": meta,
        "headers": headers,
        "row_count": len(rows),
        "rows_preview": preview,
        "numeric_columns": numeric_cols,
        "notes": notes,
    }


def _detect_format(text: str) -> str:
    lines = [ln for ln in str(text or "").splitlines() if ln.strip()]
    if len(lines) >= 2:
        # Markdown table heuristic: at least 2 lines with pipes, and a separator line.
        if "|" in lines[0] and "|" in lines[1] and re.fullmatch(r"[\s\|\-:]+", lines[1].strip()):
            return "md_table"
    return "delimited"


_META_RE = re.compile(r"^\s*#\s*([A-Za-z0-9_\-]+)\s*=\s*(.*?)\s*$")


def _normalize_et_addr(v: str) -> tuple[str, str]:
    s = str(v or "").strip()
    if not s:
        return "", ""
    s = s.replace("$", "")
    if "!" in s:
        sheet, addr = s.split("!", 1)
        sheet = sheet.strip().strip("'")
        addr = addr.strip()
        return sheet, addr
    return "", s


def _extract_meta_lines(text: str) -> Tuple[Dict[str, str], str]:
    """Strip leading/inlined metadata lines starting with '#'.

    `extractDocumentTextById()` may prepend lightweight ET metadata like:
    - #sheet=Sheet1
    - #used_range=A1:D20
    Tools should ignore these when parsing TSV/CSV.
    """
    meta: Dict[str, str] = {}
    kept: List[str] = []
    for ln in str(text or "").splitlines():
        if ln.lstrip().startswith("#"):
            m = _META_RE.match(ln)
            if m:
                meta[m.group(1)] = m.group(2)
            continue
        kept.append(ln)

    # Add normalized aliases for ET planning.
    try:
        sheet = str(meta.get("sheet") or meta.get("Sheet") or "").strip()
        if sheet:
            meta.setdefault("sheet_name", sheet)
        used = str(meta.get("used_range") or "").strip()
        if used:
            sheet2, addr2 = _normalize_et_addr(used)
            if sheet2:
                meta.setdefault("sheet_name", sheet2)
            if addr2:
                meta.setdefault("used_range_a1", addr2)
        read_range = str(meta.get("read_range") or "").strip()
        if read_range:
            sheet4, addr4 = _normalize_et_addr(read_range)
            if sheet4:
                meta.setdefault("sheet_name", sheet4)
            if addr4:
                meta.setdefault("read_range_a1", addr4)
        read_source = str(meta.get("read_source") or "").strip()
        if read_source:
            meta.setdefault("read_source", read_source)
        sel = str(meta.get("selection") or "").strip()
        if sel:
            sheet3, addr3 = _normalize_et_addr(sel)
            if sheet3:
                meta.setdefault("sheet_name", sheet3)
            if addr3:
                meta.setdefault("selection_a1", addr3)
    except Exception:
        # Meta is best-effort; keep parsing.
        pass

    return meta, "\n".join(kept)


def _parse_markdown_table(text: str, *, max_cols: int) -> Tuple[List[str], List[Dict[str, Any]]]:
    lines = [ln for ln in str(text or "").splitlines() if ln.strip()]
    if not lines:
        return [], []
    header_line = lines[0].strip()
    # Skip separator line if present.
    body_lines = lines[2:] if len(lines) >= 2 and re.fullmatch(r"[\s\|\-:]+", lines[1].strip()) else lines[1:]
    headers = [h.strip() for h in header_line.strip("|").split("|")]
    headers = [h or f"col_{i+1}" for i, h in enumerate(headers[:max_cols])]

    rows: List[Dict[str, Any]] = []
    for ln in body_lines:
        parts = [p.strip() for p in ln.strip().strip("|").split("|")]
        if not any(parts):
            continue
        parts = parts[: len(headers)]
        row = {headers[i]: (parts[i] if i < len(parts) else "") for i in range(len(headers))}
        rows.append(row)
    return headers, rows


def _parse_delimited(text: str, *, delimiter: str, max_cols: int) -> Tuple[List[str], List[Dict[str, Any]]]:
    s = str(text or "")
    buf = io.StringIO(s)
    reader = csv.reader(buf, delimiter=delimiter)

    rows_raw: List[List[str]] = []
    for row in reader:
        if not row:
            continue
        if not any(str(x).strip() for x in row):
            continue
        rows_raw.append([str(x).strip() for x in row[:max_cols]])

    if not rows_raw:
        return [], []

    headers = rows_raw[0]
    headers = [h or f"col_{i+1}" for i, h in enumerate(headers)]
    headers = headers[:max_cols]

    rows: List[Dict[str, Any]] = []
    for r in rows_raw[1:]:
        r = (r + [""] * len(headers))[: len(headers)]
        rows.append({headers[i]: r[i] for i in range(len(headers))})
    return headers, rows


_NUM_RE = re.compile(r"[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?")


def _parse_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    # Keep percent as number (e.g., "12%").
    s = s.replace("￥", "").replace("¥", "")
    s = s.replace("元", "").replace("万", "").replace("亿", "")
    s = s.replace(" ", "")
    m = _NUM_RE.search(s)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except Exception:
        return None


def _infer_numeric_columns(headers: List[str], rows: List[Dict[str, Any]]) -> List[str]:
    out: List[str] = []
    if not headers or not rows:
        return out
    for h in headers:
        vals = []
        for r in rows:
            if h not in r:
                continue
            n = _parse_number(r.get(h))
            if n is not None:
                vals.append(n)
        if len(vals) >= max(3, int(len(rows) * 0.6)):
            out.append(h)
    return out
