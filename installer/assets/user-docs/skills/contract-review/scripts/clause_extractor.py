"""Contract clause extractor (deterministic, regex/keyword based).

Goal:
- Extract core clause paragraphs from a contract text for downstream review.
- Keep it best-effort and explainable (keywords + positions).

Notes:
- `doc_text` can be auto-injected from the active document by AH32 runtime.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple


@dataclass(frozen=True)
class _Para:
    idx: int
    start: int
    end: int
    text: str


_CLAUSE_CATALOG: Dict[str, Dict[str, Any]] = {
    "payment_terms": {
        "title": "付款/结算",
        "keywords": ["付款", "支付", "结算", "价款", "费用", "发票", "税率", "税", "对公账户", "预付款"],
    },
    "acceptance": {
        "title": "验收/交付验收",
        "keywords": ["验收", "测试", "交付验收", "验收标准", "验收通过", "验收不通过", "验收期限"],
    },
    "delivery": {
        "title": "交付/进度/里程碑",
        "keywords": ["交付", "交货", "交付时间", "进度", "里程碑", "工期", "延期", "交付物", "上线"],
    },
    "warranty": {
        "title": "质保/保修/服务",
        "keywords": ["质保", "保修", "保证期", "服务期", "维护", "运维", "SLA", "响应时间", "升级"],
    },
    "breach": {
        "title": "违约/违约金",
        "keywords": ["违约", "违约金", "违约责任", "赔偿", "赔付", "损失", "滞纳金", "罚款"],
    },
    "liability_limitation": {
        "title": "责任限制/免责",
        "keywords": ["责任限制", "责任上限", "最高不超过", "不超过", "间接损失", "特别损失", "免责", "不承担"],
    },
    "confidentiality": {
        "title": "保密",
        "keywords": ["保密", "商业秘密", "披露", "保密期限", "保密义务", "保密信息"],
    },
    "ip": {
        "title": "知识产权/成果归属",
        "keywords": ["知识产权", "著作权", "专利", "商标", "成果", "归属", "源代码", "使用权", "许可"],
    },
    "term_termination": {
        "title": "期限/解除/终止",
        "keywords": ["期限", "有效期", "续期", "终止", "解除", "提前", "到期", "自动终止"],
    },
    "dispute_resolution": {
        "title": "争议解决/管辖",
        "keywords": ["争议", "仲裁", "诉讼", "法院", "管辖", "适用法律", "调解"],
    },
    "force_majeure": {
        "title": "不可抗力",
        "keywords": ["不可抗力", "force majeure", "免责事由"],
    },
    "data_privacy": {
        "title": "数据/个人信息/安全",
        "keywords": ["数据", "个人信息", "隐私", "网络安全", "等保", "安全事件", "泄露", "合规", "GDPR"],
    },
}


def clause_extractor(
    doc_text: str = "",
    max_chars_per_clause: int = 1800,
) -> Dict[str, Any]:
    """Extract core clause paragraphs from contract text.

    Args:
        doc_text: Contract plain text.
        max_chars_per_clause: Truncate long clause texts to keep tool results small.

    Returns:
        {
          "clauses": [
            {
              "clause_type": "payment_terms",
              "title": "付款/结算",
              "position": {"start": 120, "end": 560},
              "keywords": ["付款","发票"],
              "text": "..."
            }
          ],
          "total": 12,
          "unmatched_types": ["..."]
        }
    """
    text = str(doc_text or "")
    if not text.strip():
        return {"clauses": [], "total": 0, "unmatched_types": list(_CLAUSE_CATALOG.keys())}

    max_chars_per_clause = max(200, int(max_chars_per_clause or 0))

    paras = _split_paragraphs(text)

    clauses: List[Dict[str, Any]] = []
    unmatched: List[str] = []

    for clause_type, cfg in _CLAUSE_CATALOG.items():
        title = str(cfg.get("title") or clause_type)
        keywords = [str(x).strip() for x in (cfg.get("keywords") or []) if str(x).strip()]
        best = _pick_best_paragraph(paras, keywords)
        if best is None:
            unmatched.append(clause_type)
            continue

        extracted_text, start, end = _maybe_extend_clause(best, paras)
        extracted_text = extracted_text.strip()
        if len(extracted_text) > max_chars_per_clause:
            extracted_text = extracted_text[:max_chars_per_clause] + "\n... (truncated)"

        hit_words = _hit_keywords(extracted_text, keywords)
        clauses.append(
            {
                "clause_type": clause_type,
                "title": title,
                "position": {"start": start, "end": end},
                "keywords": hit_words[:10],
                "text": extracted_text,
            }
        )

    clauses.sort(key=lambda x: str(x.get("clause_type") or ""))
    return {"clauses": clauses, "total": len(clauses), "unmatched_types": unmatched}


def _split_paragraphs(text: str) -> List[_Para]:
    """Split raw text into paragraphs, keeping char positions."""
    s = str(text or "")
    out: List[_Para] = []
    buf: List[str] = []
    start: Optional[int] = None
    idx = 0
    para_idx = 0

    def flush(end_pos: int) -> None:
        nonlocal para_idx, start, buf
        if start is None:
            buf = []
            return
        joined = "\n".join([x for x in buf if x is not None]).strip()
        if joined:
            out.append(_Para(idx=para_idx, start=start, end=end_pos, text=joined))
            para_idx += 1
        buf = []
        start = None

    for line in s.splitlines(True):  # keep newline
        raw = line
        stripped = raw.strip()
        if not stripped:
            flush(idx)
            idx += len(raw)
            continue
        if start is None:
            # Find first non-space char position within this line for a more accurate start.
            lead = len(raw) - len(raw.lstrip("\r\n\t "))
            start = idx + lead
        buf.append(stripped)
        idx += len(raw)

    flush(len(s))
    if not out:
        # Fallback: no line breaks; treat whole text as one paragraph.
        out.append(_Para(idx=0, start=0, end=len(s), text=s.strip()))
    return out


def _hit_keywords(text: str, keywords: List[str]) -> List[str]:
    s = str(text or "")
    hits: List[str] = []
    for kw in keywords:
        if kw and kw in s:
            hits.append(kw)
    return hits


def _score_paragraph(p: _Para, keywords: List[str]) -> int:
    if not keywords:
        return 0
    score = 0
    for kw in keywords:
        if not kw:
            continue
        # Count occurrences (capped) to avoid overweighting repeated terms.
        c = p.text.count(kw)
        score += min(3, c)
    # Slight bonus for headings containing keywords.
    head = p.text[:60]
    for kw in keywords:
        if kw and kw in head:
            score += 1
    return score


def _pick_best_paragraph(paras: List[_Para], keywords: List[str]) -> Optional[_Para]:
    best: Optional[_Para] = None
    best_score = 0
    for p in paras:
        sc = _score_paragraph(p, keywords)
        if sc > best_score:
            best_score = sc
            best = p
    if best is None or best_score <= 0:
        return None
    return best


_HEADING_RE = re.compile(
    r"^(?:第[一二三四五六七八九十百零]+条|\d+(?:\.\d+){0,3}[、.．)]|【[^】]{1,30}】|[（(]?[一二三四五六七八九十]+[）)]\s*)"
)


def _maybe_extend_clause(p: _Para, paras: List[_Para]) -> Tuple[str, int, int]:
    """If the chosen paragraph looks like a heading, merge the next paragraph."""
    i = p.idx
    if i < 0 or i >= len(paras):
        return p.text, p.start, p.end
    t = p.text.strip()
    if len(t) <= 40 and _HEADING_RE.match(t) and (i + 1) < len(paras):
        nxt = paras[i + 1]
        merged = (t + "\n" + nxt.text).strip()
        return merged, p.start, nxt.end
    return p.text, p.start, p.end

