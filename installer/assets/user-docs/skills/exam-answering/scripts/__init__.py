"""exam-answering skill tools.

This module exports tools declared in skill.json for the exam-answering skill.
Tools are auto-discovered from this directory.
"""

# Import tools to register them
from .fill_blank_detector import fill_blank_detector
from .question_parser import question_parser
from .answer_formatter import answer_formatter

# Tool registry for explicit registration (optional)
# Tools can be auto-discovered by filename, or explicitly registered here
TOOLS = {
    "fill_blank_detector": {
        "description": "检测文档中的纯下划线填空题（______），返回位置和上下文",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_text": {
                    "type": "string",
                    "description": "文档全文内容"
                },
                "context_chars": {
                    "type": "integer",
                    "description": "前后文字符数",
                    "default": 20
                }
            },
            "required": ["doc_text"]
        }
    },
    "question_parser": {
        "description": "解析题干结构，识别题型、题号、选项，支持选择/填空/问答",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_text": {
                    "type": "string",
                    "description": "文档全文内容"
                }
            },
            "required": ["doc_text"]
        }
    },
    "answer_formatter": {
        "description": "格式化答案输出，生成 Plan JSON 格式",
        "parameters": {
            "type": "object",
            "properties": {
                "answers": {
                    "type": "array",
                    "description": "答案列表"
                },
                "format": {
                    "type": "string",
                    "enum": ["letter", "text", "json"],
                    "description": "答案格式"
                }
            },
            "required": ["answers"]
        }
    }
}
