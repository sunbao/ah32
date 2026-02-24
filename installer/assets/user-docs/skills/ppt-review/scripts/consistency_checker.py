"""PPT review: consistency checker (deterministic, best-effort).

Goal:
- Detect common inconsistencies across slides:
  - term variants (case / punctuation)
  - metric value conflicts (same metric name -> multiple values)

Input is plain text; you can pass either `ppt_text` or `slides`.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


_ACRONYM_RX = re.compile(r"\b[A-Z]{2,12}\b")
_QUOTE_RX = re.compile(r"[“\"](?P<term>[^”\"\n]{2,24})[”\"]")
_METRIC_RX = re.compile(
    r"(?P<name>[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9_\-]{1,18})\s*(?:为|是|≈|约|达到|提升至|下降至)?\s*(?P<value>[-+]?\d+(?:\.\d+)?)\s*(?P<unit>%|万元|万|亿|个|天|年|人|次)?"
)


def consistency_checker(
    doc_text: str = "",
    ppt_text: str = "",
    slides: Optional[List[Dict[str, Any]]] = None,
    max_issues: int = 80,
) -> Dict[str, Any]:
    """Check consistency in slide text.

    Args:
        ppt_text: Concatenated PPT text.
        slides: Optional list: [{"title":"...","body":"..."}]
        max_issues: Safety cap.

    Returns:
        {
          "issues":[{"type":"term_variant","term":"ROI","variants":["ROI","RoI"]}],
          "metrics":[{"name":"收入","values":[{"value":10,"unit":"亿","slide":1}, ...]}]
        }
    """
    max_issues = max(1, int(max_issues or 0))

    chunks = _normalize_slides(ppt_text or doc_text, slides)
    all_text = "\n".join(chunks)
    if not all_text.strip():
        return {"issues": [], "metrics": []}

    issues: List[Dict[str, Any]] = []

    # 1) Term variants (acronyms + quoted terms).
    variants = _find_term_variants(chunks)
    for norm, vs in variants.items():
        uniq = sorted(set(vs))
        if len(uniq) <= 1:
            continue
        issues.append({"type": "term_variant", "term": norm, "variants": uniq})
        if len(issues) >= max_issues:
            break

    # 2) Metric conflicts.
    metrics = _collect_metrics(chunks)
    for name, values in metrics.items():
        uniq_vals = sorted({(v["value"], v.get("unit") or "") for v in values})
        if len(uniq_vals) <= 1:
            continue
        issues.append({"type": "metric_conflict", "name": name, "values": values[:10]})
        if len(issues) >= max_issues:
            break

    return {
        "issues": issues[:max_issues],
        "metrics": [
            {"name": k, "values": v[:10], "distinct": len({(x["value"], x.get("unit") or "") for x in v})}
            for k, v in sorted(metrics.items(), key=lambda kv: kv[0])
        ][:60],
    }


def _normalize_slides(ppt_text: str, slides: Optional[List[Dict[str, Any]]]) -> List[str]:
    if isinstance(slides, list) and slides:
        out: List[str] = []
        for s in slides[:500]:
            if not isinstance(s, dict):
                continue
            title = str(s.get("title") or "").strip()
            body = str(s.get("body") or s.get("text") or "").strip()
            joined = "\n".join([x for x in (title, body) if x])
            if joined:
                out.append(joined)
        if out:
            return out
    t = str(ppt_text or "").strip()
    return [t] if t else []


def _find_term_variants(chunks: List[str]) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    for chunk in chunks:
        for m in _ACRONYM_RX.finditer(chunk):
            term = m.group(0)
            norm = term.upper()
            out.setdefault(norm, []).append(term)
        for m in _QUOTE_RX.finditer(chunk):
            term = str(m.group("term") or "").strip()
            if not term:
                continue
            norm = _normalize_term(term)
            out.setdefault(norm, []).append(term)
    return out


def _normalize_term(term: str) -> str:
    s = str(term or "").strip()
    s = re.sub(r"\s+", "", s)
    s = s.replace("（", "(").replace("）", ")")
    s = s.replace("：", ":").replace("，", ",").replace("。", ".")
    return s


def _collect_metrics(chunks: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    metrics: Dict[str, List[Dict[str, Any]]] = {}
    for idx, chunk in enumerate(chunks, start=1):
        for m in _METRIC_RX.finditer(chunk):
            name = str(m.group("name") or "").strip()
            if not name:
                continue
            value_s = str(m.group("value") or "").strip()
            try:
                value = float(value_s)
            except Exception:
                continue
            unit = str(m.group("unit") or "").strip()
            norm_name = _normalize_metric_name(name)
            metrics.setdefault(norm_name, []).append({"slide": idx, "value": value, "unit": unit, "raw": m.group(0)[:80]})
    return metrics


def _normalize_metric_name(name: str) -> str:
    s = str(name or "").strip()
    s = re.sub(r"[\s:：\-—–_]+", "", s)
    return s[:20]
