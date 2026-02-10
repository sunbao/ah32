TOOLS = {
    "layout_recommender": {
        "description": "根据内容结构推荐 WPP 版式",
        "parameters": {
            "type": "object",
            "properties": {
                "slide_content": {"type": "object"}
            },
            "required": ["slide_content"]
        }
    },
    "placeholder_mapper": {
        "description": "根据版式编号返回占位区域映射",
        "parameters": {
            "type": "object",
            "properties": {
                "layout_id": {"type": "integer"}
            },
            "required": ["layout_id"]
        }
    }
}
