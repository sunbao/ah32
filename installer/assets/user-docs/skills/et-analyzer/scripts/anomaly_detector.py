"""ET anomaly detector (deterministic rules).

Goal:
- Detect numeric anomalies from tabular text:
  negative/zero, outliers (IQR), large absolute values.

Notes:
- This tool parses `doc_text` internally to avoid passing large parsed data back-and-forth.
"""

from __future__ import annotations

import csv
import io
import math
import re
from typing import Any, Dict, List, Optional, Tuple


def anomaly_detector(
    doc_text: str = "",
    table_text: str = "",
    numeric_columns: Optional[List[str]] = None,
    amount_threshold: Optional[float] = None,
    max_results: int = 120,
) -> Dict[str, Any]:
    """Detect anomalies in a table text."""
    raw = str(doc_text or table_text or "")
    if not raw.strip():
        return {"meta": {}, "anomalies": [], "summary": {"row_count": 0, "checked_columns": []}}

    meta, raw = _extract_meta_lines(raw)
    headers, rows_full = _parse_table(raw, max_rows=500)
    row_count = len(rows_full)
    rows_preview = rows_full[: min(50, max(10, row_count))]

    cols = [str(c).strip() for c in (numeric_columns or []) if str(c).strip()]
    if not cols:
        cols = _infer_numeric_columns(headers, rows_full[: min(200, len(rows_full))])

    max_results = max(1, int(max_results or 0))

    anomalies: List[Dict[str, Any]] = []

    for col in cols:
        if col not in headers:
            continue
        values: List[Tuple[int, float]] = []
        for i, r in enumerate(rows_full):
            n = _parse_number(r.get(col))
            if n is None:
                continue
            values.append((i, float(n)))
        if len(values) < 4:
            continue

        nums = [v for _, v in values]
        lo, hi = _iqr_bounds(nums)

        for i, v in values:
            if len(anomalies) >= max_results:
                break
            reason = ""
            sev = "low"
            if v < 0:
                reason = "negative"
                sev = "high"
            elif v == 0:
                reason = "zero"
                sev = "medium"
            elif amount_threshold is not None and abs(v) >= float(amount_threshold):
                reason = "large_value"
                sev = "medium"
            elif v < lo or v > hi:
                reason = "outlier_iqr"
                sev = "medium"
            else:
                continue

            row_preview = rows_preview[i] if 0 <= i < len(rows_preview) else {}
            anomalies.append(
                {
                    "row_index": i + 1,
                    "column": col,
                    "value": v,
                    "reason": reason,
                    "severity": sev,
                    "row_preview": row_preview,
                }
            )

    anomalies.sort(
        key=lambda x: ("high", "medium", "low").index(str(x.get("severity") or "low"))
        if str(x.get("severity") or "") in ("high", "medium", "low")
        else 2
    )

    preview_only = False
    warnings: List[str] = []
    try:
        truncated = str(meta.get("truncated") or "").strip().lower() == "true"
        truncated_by_budget = str(meta.get("truncated_by_char_budget") or "").strip().lower() == "true"
        if truncated or truncated_by_budget:
            preview_only = True
            warnings.append("preview_only")
            if truncated_by_budget:
                warnings.append("truncated_by_char_budget")
    except Exception:
        pass

    return {
        "meta": meta,
        "anomalies": anomalies[:max_results],
        "summary": {
            "row_count": row_count,
            "checked_columns": cols,
            "amount_threshold": amount_threshold,
            "preview_only": preview_only,
            "warnings": warnings,
        },
    }


_NUM_RE = re.compile(r"[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?")


def _parse_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    s = s.replace("￥", "").replace("¥", "").replace(" ", "")
    # Keep percent as numeric.
    s = s.replace("%", "")
    m = _NUM_RE.search(s)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except Exception:
        return None


def _percentile(sorted_vals: List[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    if p <= 0:
        return sorted_vals[0]
    if p >= 1:
        return sorted_vals[-1]
    n = len(sorted_vals)
    k = (n - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    d0 = sorted_vals[int(f)] * (c - k)
    d1 = sorted_vals[int(c)] * (k - f)
    return d0 + d1


def _iqr_bounds(nums: List[float]) -> Tuple[float, float]:
    vals = sorted(float(x) for x in nums if x is not None and not math.isnan(float(x)))
    if len(vals) < 4:
        return (float("-inf"), float("inf"))
    q1 = _percentile(vals, 0.25)
    q3 = _percentile(vals, 0.75)
    iqr = q3 - q1
    if iqr <= 0:
        return (q1 - 1.0, q3 + 1.0)
    return (q1 - 1.5 * iqr, q3 + 1.5 * iqr)


def _detect_format(text: str) -> str:
    lines = [ln for ln in str(text or "").splitlines() if ln.strip()]
    if len(lines) >= 2 and ("|" in lines[0] and "|" in lines[1]):
        if re.fullmatch(r"[\s\|\-:]+", lines[1].strip()):
            return "md_table"
    return "delimited"


_META_RE = re.compile(r"^\s*#\s*([A-Za-z0-9_\-]+)\s*=\s*(.*?)\s*$")


def _normalize_et_addr(v: str) -> Tuple[str, str]:
    s = str(v or "").strip()
    if not s:
        return ("", "")
    s = s.replace("$", "")
    if "!" in s:
        sheet, addr = s.split("!", 1)
        return (sheet.strip().strip("'"), addr.strip())
    return ("", s)


def _extract_meta_lines(text: str) -> Tuple[Dict[str, str], str]:
    meta: Dict[str, str] = {}
    kept: List[str] = []
    for ln in str(text or "").splitlines():
        if ln.lstrip().startswith("#"):
            m = _META_RE.match(ln)
            if m:
                meta[m.group(1)] = m.group(2)
            continue
        kept.append(ln)

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
        pass

    return meta, "\n".join(kept)


def _parse_markdown_table(text: str, *, max_rows: int, max_cols: int) -> Tuple[List[str], List[Dict[str, Any]]]:
    lines = [ln for ln in str(text or "").splitlines() if ln.strip()]
    if not lines:
        return [], []
    header_line = lines[0].strip()
    body_lines = lines[2:] if len(lines) >= 2 and re.fullmatch(r"[\s\|\-:]+", lines[1].strip()) else lines[1:]
    headers = [h.strip() for h in header_line.strip("|").split("|")]
    headers = [h or f"col_{i+1}" for i, h in enumerate(headers[:max_cols])]

    rows: List[Dict[str, Any]] = []
    for ln in body_lines:
        if len(rows) >= max_rows:
            break
        parts = [p.strip() for p in ln.strip().strip("|").split("|")]
        if not any(parts):
            continue
        parts = parts[: len(headers)]
        row = {headers[i]: (parts[i] if i < len(parts) else "") for i in range(len(headers))}
        rows.append(row)
    return headers, rows


def _parse_delimited(text: str, *, delimiter: str, max_rows: int, max_cols: int) -> Tuple[List[str], List[Dict[str, Any]]]:
    s = str(text or "")
    buf = io.StringIO(s)
    reader = csv.reader(buf, delimiter=delimiter)
    raw_rows: List[List[str]] = []
    for row in reader:
        if len(raw_rows) >= max_rows + 1:
            break
        if not row or not any(str(x).strip() for x in row):
            continue
        raw_rows.append([str(x).strip() for x in row[:max_cols]])

    if not raw_rows:
        return [], []

    headers = raw_rows[0]
    headers = [h or f"col_{i+1}" for i, h in enumerate(headers)]
    headers = headers[:max_cols]

    rows: List[Dict[str, Any]] = []
    for r in raw_rows[1:]:
        r = (r + [""] * len(headers))[: len(headers)]
        rows.append({headers[i]: r[i] for i in range(len(headers))})
    return headers, rows


def _parse_table(text: str, *, max_rows: int, max_cols: int = 50) -> Tuple[List[str], List[Dict[str, Any]]]:
    fmt = _detect_format(text)
    if fmt == "md_table":
        return _parse_markdown_table(text, max_rows=max_rows, max_cols=max_cols)
    delim = "\t" if "\t" in text else ","
    return _parse_delimited(text, delimiter=delim, max_rows=max_rows, max_cols=max_cols)


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
