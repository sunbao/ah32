TOOLS = {
    "fill_blank_detector": {
        "description": "检测下划线填空位置并返回上下文信息",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_text": {"type": "string"},
                "context_chars": {"type": "integer", "default": 20},
            },
            "required": ["doc_text"],
        },
    },
    "question_parser": {
        "description": "解析题目结构，识别题号、题型与选项",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_text": {"type": "string"},
                "parse_options": {"type": "boolean", "default": True},
            },
            "required": ["doc_text"],
        },
    },
    "answer_formatter": {
        "description": "统一答案输出结构，便于后续写回",
        "parameters": {
            "type": "object",
            "properties": {
                "answers": {"type": "array"},
                "format": {"type": "string", "default": "plan_json"},
                "include_rationale": {"type": "boolean", "default": False},
            },
            "required": ["answers"],
        },
    },
}
