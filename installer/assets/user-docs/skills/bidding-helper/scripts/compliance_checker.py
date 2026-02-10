"""Compliance Checker - Check bid document compliance against tender requirements."""

import re
from typing import Any, Dict, List, Optional


def check_compliance(
    tender_doc: str,
    bid_doc: str = None
) -> Dict[str, Any]:
    """逐条检查投标文件与招标文件的符合性。

    Args:
        tender_doc: 招标文件内容
        bid_doc: 投标文件内容（可选，用于对比）

    Returns:
        {
            "results": [
                {
                    "clause": "3.1 资质要求",
                    "requirement": "注册资金500万以上",
                    "response": "注册资本1000万",
                    "status": "符合",
                    "evidence": "P3 营业执照"
                }
            ],
            "summary": {"comply": 15, "partial": 2, "missing": 1, "total": 18},
            "high_risk": [
                {"clause": "5.2 交付周期", "risk": "我方响应7天，招标要求5天", "level": "高"}
            ]
        }
    """
    if not tender_doc:
        return {"results": [], "summary": {"comply": 0, "partial": 0, "missing": 0, "total": 0}, "high_risk": []}

    # 提取招标条款
    clauses = _extract_clauses(tender_doc)

    # 检查每个条款
    results: List[Dict[str, Any]] = []
    comply_count = 0
    partial_count = 0
    missing_count = 0
    high_risk: List[Dict[str, Any]] = []

    for clause in clauses:
        # 在投标文件中查找响应
        response = ""
        if bid_doc:
            response = _find_response(bid_doc, clause["requirement"])

        # 判断符合性
        status, evidence, risk = _evaluate_compliance(clause, response)

        result = {
            "clause": clause["id"],
            "requirement": clause["requirement"],
            "response": response if response else "未找到响应",
            "status": status,
            "evidence": evidence,
        }

        if risk:
            result["risk"] = risk
            high_risk.append({"clause": clause["id"], "risk": risk, "level": "高"})

        results.append(result)

        if status == "符合":
            comply_count += 1
        elif status == "偏离":
            partial_count += 1
        else:
            missing_count += 1

    return {
        "results": results,
        "summary": {
            "comply": comply_count,
            "partial": partial_count,
            "missing": missing_count,
            "total": len(results)
        },
        "high_risk": high_risk
    }


def _extract_clauses(doc: str) -> List[Dict[str, Any]]:
    """从文档中提取条款。"""
    clauses: List[Dict[str, Any]] = []

    # 条款编号模式
    clause_patterns = [
        r"(\d+\.\d+)\s+(.{10,50})",      # 3.1 xxx
        r"第(\d+)条\s+(.{10,50})",        # 第3条 xxx
        r"(\d+）、\s*(.{10,50})",         # 1）、xxx
        r"\((\d+)\)\s*(.{10,50})",        # (1) xxx
    ]

    for pattern in clause_patterns:
        matches = re.finditer(pattern, doc)
        for match in matches:
            clause_id = match.group(1)
            requirement = match.group(2).strip()

            # 跳过已处理的条款
            if any(c["id"] == clause_id for c in clauses):
                continue

            clauses.append({
                "id": clause_id,
                "requirement": requirement,
                "full_text": match.group(0)
            })

    return clauses


def _find_response(bid_doc: str, requirement: str) -> str:
    """在投标文件中查找对应响应。"""
    # 提取关键词
    keywords = _extract_keywords(requirement)

    # 简单匹配：查找包含关键词的段落
    for keyword in keywords[:3]:  # 只用前3个关键词
        pattern = rf".{{0,30}}{re.escape(keyword)}.{{0,100}}"
        matches = re.findall(pattern, bid_doc)
        if matches:
            # 返回最相关的段落（包含最多关键词的）
            return matches[0].strip()

    return ""


def _extract_keywords(text: str) -> List[str]:
    """提取文本关键词。"""
    # 移除常见词
    stop_words = {"要求", "必须", "应该", "应当", "需要", "具备", "满足", "符合", "响应"}

    # 提取名词和数值
    words = re.findall(r"[\d\w]{2,10}", text)
    words = [w for w in words if w not in stop_words and len(w) > 2]

    return words


def _evaluate_compliance(
    clause: Dict[str, Any],
    response: str
) -> tuple[str, str, Optional[str]]:
    """评估符合性。"""
    requirement = clause["requirement"]
    status = "待确认"
    evidence = ""
    risk = None

    if not response or response == "未找到响应":
        return "待确认", "", "投标文件中未找到对应响应"

    # 数值检查
    numbers_in_req = re.findall(r"[\d]+", requirement)
    numbers_in_resp = re.findall(r"[\d]+", response)

    if numbers_in_req:
        for nr in numbers_in_req:
            if nr in numbers_in_resp:
                status = "符合"
                evidence = "响应中包含要求的数值"
                break
        else:
            status = "偏离"
            risk = f"要求数值 ({numbers_in_req}) 与响应数值 ({numbers_in_resp}) 不一致"
            return status, "", risk

    # 关键词检查
    keywords = _extract_keywords(requirement)
    matched = sum(1 for kw in keywords if kw in response)

    if matched >= len(keywords) * 0.5:
        status = "符合"
        evidence = f"匹配到 {matched}/{len(keywords)} 个关键词"
    elif matched >= len(keywords) * 0.3:
        status = "偏离"
        risk = "部分关键词未响应"
    else:
        status = "偏离"
        risk = "关键词匹配度低"

    return status, evidence, risk


# 便捷函数：生成偏离矩阵表
def generate_compliance_matrix(tender_doc: str, bid_doc: str) -> str:
    """生成符合性/偏离矩阵的 Markdown 表格。"""
    result = check_compliance(tender_doc, bid_doc)

    table = "|#|条款|要求|响应|符合性|证据|风险|\n"
    table += "|---:|---|---|---|---|---|---|\n"

    for item in result["results"]:
        risk = item.get("risk", "")
        table += f"|{item['clause']}|{item['requirement'][:30]}...|{item['response'][:30]}...|{item['status']}|{item['evidence']}|{risk}|\n"

    return table


# 便捷函数：检查是否有高风险偏离
def has_high_risk(compliance_result: Dict[str, Any]) -> bool:
    """检查是否有高风险偏离项。"""
    return len(compliance_result.get("high_risk", [])) > 0


def compliance_checker(bid_doc: str, tender_doc: str) -> Dict[str, Any]:
    return check_compliance(tender_doc=tender_doc, bid_doc=bid_doc)
