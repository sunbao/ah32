from __future__ import annotations

from typing import Any, Dict, List


def _split_lines(text: str) -> List[str]:
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]


def compliance_checker(bid_doc: str, tender_doc: str) -> Dict[str, Any]:
    bid_lines = _split_lines(bid_doc)
    tender_lines = _split_lines(tender_doc)

    results: List[Dict[str, Any]] = []
    comply = 0
    partial = 0
    missing = 0

    for idx, requirement in enumerate(tender_lines, start=1):
        status = "缺失"
        response = ""
        evidence = ""

        hit = next((line for line in bid_lines if requirement[:12] and requirement[:12] in line), None)
        if hit:
            status = "符合"
            response = hit
            evidence = f"line:{bid_lines.index(hit) + 1}"
            comply += 1
        else:
            fuzzy_hit = next((line for line in bid_lines if any(tok in line for tok in requirement.split()[:2])), None)
            if fuzzy_hit:
                status = "部分符合"
                response = fuzzy_hit
                evidence = f"line:{bid_lines.index(fuzzy_hit) + 1}"
                partial += 1
            else:
                missing += 1

        results.append(
            {
                "clause": f"条款{idx}",
                "requirement": requirement,
                "response": response,
                "status": status,
                "evidence": evidence,
            }
        )

    return {
        "results": results,
        "summary": {
            "comply": comply,
            "partial": partial,
            "missing": missing,
        },
    }
