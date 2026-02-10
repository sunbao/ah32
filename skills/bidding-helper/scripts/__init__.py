TOOLS = {
    "timeline_generator": {
        "description": "从文本中提取关键日期并生成里程碑时间线",
        "parameters": {
            "type": "object",
            "properties": {
                "bid_doc_text": {"type": "string"},
                "today": {"type": "string"},
            },
            "required": ["bid_doc_text"],
        },
    },
    "compliance_checker": {
        "description": "按条款检查招标要求与投标响应是否一致",
        "parameters": {
            "type": "object",
            "properties": {
                "bid_doc": {"type": "string"},
                "tender_doc": {"type": "string"},
            },
            "required": ["bid_doc", "tender_doc"],
        },
    },
    "seDeadline_checklist": {
        "description": "生成封标前检查清单并标记缺失项",
        "parameters": {
            "type": "object",
            "properties": {
                "bid_doc": {"type": "string"},
            },
            "required": ["bid_doc"],
        },
    },
}
