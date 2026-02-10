"""SE Deadline Checklist - Generate submission deadline checklist."""

import re
from datetime import datetime
from typing import Any, Dict, List, Optional


def generate_checklist(
    bid_doc: str = None,
    tender_doc: str = None
) -> Dict[str, Any]:
    """生成封标前检查清单。

    Args:
        bid_doc: 投标文件内容（可选，用于检查签章等）
        tender_doc: 招标文件内容（可选，用于检查密封要求）

    Returns:
        {
            "checks": [
                {"item": "签章完整性", "status": "已检查", "notes": "法人章+公章"},
                {"item": "密封要求", "status": "已检查", "notes": "外包+内封"},
                {"item": "授权委托书", "status": "未检查", "notes": ""}
            ],
            "missing": ["授权委托书"],
            "warnings": ["开标时间标注不清晰"],
            "summary": {"total": 10, "checked": 8, "pending": 2}
        }
    """
    checks: List[Dict[str, Any]] = []

    # 1. 签章完整性检查
    seal_check = _check_seals(bid_doc)
    checks.append({
        "item": "签章完整性",
        "category": "签章",
        "status": seal_check["status"],
        "notes": seal_check["notes"]
    })

    # 2. 密封要求检查
    seal_req_check = _check_sealing_requirements(tender_doc)
    checks.append({
        "item": "密封要求",
        "category": "密封",
        "status": seal_req_check["status"],
        "notes": seal_req_check["notes"]
    })

    # 3. 授权委托书检查
    auth_check = _check_authorization(bid_doc)
    checks.append({
        "item": "授权委托书",
        "category": "资质",
        "status": auth_check["status"],
        "notes": auth_check["notes"]
    })

    # 4. 营业执照检查
    biz_check = _check_business_license(bid_doc)
    checks.append({
        "item": "营业执照",
        "category": "资质",
        "status": biz_check["status"],
        "notes": biz_check["notes"]
    })

    # 5. 报价完整性检查
    price_check = _check_price_completeness(bid_doc)
    checks.append({
        "item": "报价完整性",
        "category": "商务",
        "status": price_check["status"],
        "notes": price_check["notes"]
    })

    # 6. 目录检查
    toc_check = _check_toc(bid_doc)
    checks.append({
        "item": "目录完整性",
        "category": "格式",
        "status": toc_check["status"],
        "notes": toc_check["notes"]
    })

    # 7. 页码检查
    page_check = _check_page_numbers(bid_doc)
    checks.append({
        "item": "页码连续性",
        "category": "格式",
        "status": page_check["status"],
        "notes": page_check["notes"]
    })

    # 8. 胶装/装订检查
    binding_check = _check_binding(bid_doc)
    checks.append({
        "item": "胶装/装订",
        "category": "装订",
        "status": binding_check["status"],
        "notes": binding_check["notes"]
    })

    # 9. 封套标识检查
    envelope_check = _check_envelope_label(tender_doc)
    checks.append({
        "item": "封套标识",
        "category": "密封",
        "status": envelope_check["status"],
        "notes": envelope_check["notes"]
    })

    # 10. 上传要求检查（如电子投标）
    upload_check = _check_upload_requirements(tender_doc)
    checks.append({
        "item": "电子上传",
        "category": "电子",
        "status": upload_check["status"],
        "notes": upload_check["notes"]
    })

    # 统计
    checked = sum(1 for c in checks if c["status"] in ["已检查", "通过", "完整"])
    pending = sum(1 for c in checks if c["status"] in ["未检查", "缺失"])
    missing = [c["item"] for c in checks if c["status"] == "缺失"]
    warnings = [c["notes"] for c in checks if "警告" in c.get("notes", "")]

    return {
        "checks": checks,
        "missing": missing,
        "warnings": warnings,
        "summary": {
            "total": len(checks),
            "checked": checked,
            "pending": pending,
            "completion_rate": round(checked / len(checks) * 100, 1) if checks else 0
        }
    }


def _check_seals(doc: str = None) -> Dict[str, str]:
    """检查签章完整性。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    # 检查印章关键词
    seals_found = []
    if re.search(r"(?:公章|印章|盖章)", doc):
        seals_found.append("公章")
    if re.search(r"(?:法人章|法定代表人章)", doc):
        seals_found.append("法人章")

    # 检查签字
    has_signature = bool(re.search(r"(?:签字|签名|签署)", doc))

    if len(seals_found) >= 2 and has_signature:
        return {"status": "通过", "notes": "已找到：{}".format("+".join(seals_found))}
    elif seals_found:
        return {"status": "部分签章", "notes": "已找到：{}，缺少：{}".format(
            "+".join(seals_found),
            "签字" if not has_signature else ""
        )}
    else:
        return {"status": "未检查", "notes": "未检测到签章信息"}


def _check_sealing_requirements(doc: str = None) -> Dict[str, str]:
    """检查密封要求。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供招标文件内容"}

    # 查找密封要求
    if re.search(r"(?:外包|外封)", doc):
        has_outer = True
    else:
        has_outer = False

    if re.search(r"(?:内封|正本封)", doc):
        has_inner = True
    else:
        has_inner = False

    if has_outer and has_inner:
        return {"status": "已检查", "notes": "要求：外包+内封"}
    elif has_outer:
        return {"status": "已检查", "notes": "要求：外包"}
    else:
        return {"status": "未检查", "notes": "密封要求不明确"}


def _check_authorization(doc: str = None) -> Dict[str, str]:
    """检查授权委托书。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    if re.search(r"(?:授权委托书|授权书|委托书)", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "已包含授权委托书"}
    else:
        return {"status": "缺失", "notes": "未检测到授权委托书"}


def _check_business_license(doc: str = None) -> Dict[str, str]:
    """检查营业执照。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    if re.search(r"营业执照", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "已包含营业执照"}
    else:
        return {"status": "缺失", "notes": "未检测到营业执照"}


def _check_price_completeness(doc: str = None) -> Dict[str, str]:
    """检查报价完整性。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    has_price = bool(re.search(r"(?:总价|报价|金额|合计|sum)", doc, re.IGNORECASE))
    has_budget = bool(re.search(r"(?:预算|控制价|限价)", doc, re.IGNORECASE))

    if has_price:
        return {"status": "已检查", "notes": "已包含报价信息" if has_budget else "已包含报价，建议核对控制价"}
    else:
        return {"status": "缺失", "notes": "未检测到报价信息"}


def _check_toc(doc: str = None) -> Dict[str, str]:
    """检查目录。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    if re.search(r"目录|table of contents", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "已包含目录"}
    else:
        return {"status": "缺失", "notes": "未检测到目录"}


def _check_page_numbers(doc: str = None) -> Dict[str, str]:
    """检查页码。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    # 简单检查页码关键词
    if re.search(r"第.*?页", doc):
        return {"status": "已检查", "notes": "已标注页码"}
    else:
        return {"status": "警告", "notes": "未检测到连续页码标注"}


def _check_binding(doc: str = None) -> Dict[str, str]:
    """检查胶装/装订。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供投标文件内容"}

    if re.search(r"(?:胶装|装订|订装)", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "已进行胶装/装订"}
    else:
        return {"status": "警告", "notes": "未检测到装订信息"}


def _check_envelope_label(doc: str = None) -> Dict[str, str]:
    """检查封套标识。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供招标文件内容"}

    if re.search(r"(?:封套|封袋|信封)", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "涉及封套要求"}
    else:
        return {"status": "未检查", "notes": "未检测到封套要求"}


def _check_upload_requirements(doc: str = None) -> Dict[str, str]:
    """检查电子上传要求。"""
    if not doc:
        return {"status": "未检查", "notes": "请提供招标文件内容"}

    if re.search(r"(?:上传|电子|平台|系统)", doc, re.IGNORECASE):
        return {"status": "已检查", "notes": "涉及电子上传要求"}
    else:
        return {"status": "不适用", "notes": "未检测到电子上传要求"}


# 便捷函数：获取待办项
def get_pending_items(checklist: Dict[str, Any]) -> List[str]:
    """获取待检查/缺失项列表。"""
    return checklist.get("missing", [])


# 便捷函数：检查是否可封标
def can_seal(checklist: Dict[str, Any]) -> bool:
    """判断是否满足封标条件。"""
    summary = checklist.get("summary", {})
    return summary.get("pending", 0) == 0


def seDeadline_checklist(bid_doc: str = None, tender_doc: str = None) -> Dict[str, Any]:
    return generate_checklist(bid_doc=bid_doc, tender_doc=tender_doc)
