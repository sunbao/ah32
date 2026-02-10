"""图片引用管理器 - 阿蛤（AH32）核心功能

根据 docs/AH32_DESIGN.md 设计：
- RAG存储图片时分配引用ID
- LLM生成内容时使用[图片:id]格式引用
- JS宏解析并插入实际图片

示例：
RAG: {"id": "img_001", "description": "系统架构图", "path": "D:\\资料\\图1-1.png"}
LLM: "系统架构如下：[图片:img_001]"
JS: 解析[图片:img_001] → 插入实际图片
"""

from __future__ import annotations

import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

logger = logging.getLogger(__name__)


class ImageReferenceManager:
    """图片引用管理器"""

    def __init__(self):
        self.image_references: Dict[str, Dict[str, str]] = {}
        self._counter = 0

    def add(self, image_id: str, path: str, description: str) -> bool:
        """添加图片引用

        Args:
            image_id: 图片ID（如img_001）
            path: 图片本地路径
            description: 图片描述

        Returns:
            是否添加成功

        Examples:
            >>> manager = ImageReferenceManager()
            >>> manager.add("img_001", "D:\\资料\\架构图.png", "系统架构图")
            True
        """
        try:
            # 检查文件是否存在
            if not Path(path).exists():
                logger.warning(f"图片文件不存在: {path}")
                return False

            self.image_references[image_id] = {
                "path": path,
                "description": description,
                "added_time": "2026-01-13"
            }

            logger.info(f"添加图片引用: {image_id} -> {path}")
            return True

        except Exception as e:
            logger.error(f"添加图片引用失败: {str(e)}")
            return False

    def generate_id(self) -> str:
        """生成新的图片ID

        Returns:
            新的图片ID（如img_001）
        """
        self._counter += 1
        return f"img_{self._counter:03d}"

    def add_with_auto_id(self, path: str, description: str) -> Optional[str]:
        """自动生成ID并添加图片引用

        Args:
            path: 图片路径
            description: 图片描述

        Returns:
            生成的图片ID，失败返回None
        """
        image_id = self.generate_id()
        if self.add(image_id, path, description):
            return image_id
        return None

    def get_path(self, image_id: str) -> Optional[str]:
        """根据ID获取图片路径

        Args:
            image_id: 图片ID

        Returns:
            图片路径，不存在返回None
        """
        ref = self.image_references.get(image_id)
        return ref["path"] if ref else None

    def get_description(self, image_id: str) -> Optional[str]:
        """根据ID获取图片描述

        Args:
            image_id: 图片ID

        Returns:
            图片描述，不存在返回None
        """
        ref = self.image_references.get(image_id)
        return ref["description"] if ref else None

    def get_all(self) -> List[Dict[str, str]]:
        """获取所有图片引用

        Returns:
            图片引用列表
        """
        return [
            {
                "id": image_id,
                "path": ref["path"],
                "description": ref["description"],
                "added_time": ref.get("added_time", "")
            }
            for image_id, ref in self.image_references.items()
        ]

    def remove(self, image_id: str) -> bool:
        """删除图片引用

        Args:
            image_id: 图片ID

        Returns:
            是否删除成功
        """
        if image_id in self.image_references:
            del self.image_references[image_id]
            logger.info(f"删除图片引用: {image_id}")
            return True
        return False

    def clear(self):
        """清空所有图片引用"""
        count = len(self.image_references)
        self.image_references.clear()
        logger.info(f"清空{count}个图片引用")

    def parse_image_references(self, content: str) -> List[Dict[str, Any]]:
        """解析内容中的图片引用

        Args:
            content: 文本内容

        Returns:
            图片引用列表 [{"id": "img_001", "position": 10}]

        Examples:
            >>> manager = ImageReferenceManager()
            >>> content = "系统架构如下：[图片:img_001]"
            >>> refs = manager.parse_image_references(content)
            >>> print(refs)
            [{"id": "img_001", "position": 10}]
        """
        import re

        # 正则匹配[图片:id]格式
        pattern = r'\[图片:(\w+)\]'
        matches = re.finditer(pattern, content)

        references = []
        for match in matches:
            image_id = match.group(1)
            position = match.start()

            references.append({
                "id": image_id,
                "position": position,
                "full_match": match.group(0)
            })

        return references

    def replace_with_js_macro(self, content: str) -> str:
        """将图片引用替换为JS宏代码

        Args:
            content: 原始内容

        Returns:
            替换后的内容

        Examples:
            >>> manager = ImageReferenceManager()
            >>> content = "系统架构：[图片:img_001]"
            >>> result = manager.replace_with_js_macro(content)
            >>> print(result)
            "系统架构："
        """
        import re

        def replace_func(match):
            image_id = match.group(1)
            path = self.get_path(image_id)

            if path:
                # 生成JS宏代码插入图片
                return f'''
// 插入图片: {image_id}
try {{
    var pic = selection.InlineShapes.AddPicture("{path}");
    pic.Width = 400;  // 设置宽度
    pic.Height = 300; // 设置高度
}} catch (error) {{
    console.error("插入图片失败 {image_id}:", error);
}}
                '''.strip()
            else:
                return f"[图片插入失败：{image_id}]"

        # 替换所有图片引用
        pattern = r'\[图片:(\w+)\]'
        return re.sub(pattern, replace_func, content)

    def generate_js_macro_code(self, content: str) -> str:
        """生成包含图片插入的JS宏代码

        Args:
            content: 包含图片引用的内容

        Returns:
            完整的JS宏代码

        Examples:
            >>> manager = ImageReferenceManager()
            >>> manager.add("img_001", "D:\\资料\\图.png", "架构图")
            >>> content = "系统架构：[图片:img_001]"
            >>> code = manager.generate_js_macro_code(content)
        """
        # 首先插入内容文本
        import re

        # 提取纯文本内容（移除图片引用标记）
        text_content = re.sub(r'\[图片:\w+\]', '', content).strip()

        # 生成JS宏代码
        js_code = f'''
function insertContentWithImages() {{
    try {{
        // 插入文本内容
        selection.TypeText("{text_content}");

        // 插入图片
        {self._generate_image_insertion_js()}

        console.log("内容插入成功");
        return true;
    }} catch (error) {{
        console.error("插入内容失败:", error);
        throw error;
    }}
}}
        '''.strip()

        return js_code

    def _generate_image_insertion_js(self) -> str:
        """生成图片插入的JS代码"""
        js_parts = []

        for image_id, ref in self.image_references.items():
            path = ref["path"]
            js_parts.append(f'''
        // 插入图片: {image_id} - {ref["description"]}
        try {{
            var pic = selection.InlineShapes.AddPicture("{path}");
            pic.Width = 400;
            pic.Height = 300;
        }} catch (error) {{
            console.error("插入图片失败 {image_id}:", error);
        }}
            '''.strip())

        return '\n'.join(js_parts)


# 单例实例
_image_manager = None


def get_image_manager() -> ImageReferenceManager:
    """获取图片引用管理器单例"""
    global _image_manager
    if _image_manager is None:
        _image_manager = ImageReferenceManager()
    return _image_manager


# 便捷函数
def add_image_reference(path: str, description: str) -> Optional[str]:
    """添加图片引用的便捷函数"""
    manager = get_image_manager()
    return manager.add_with_auto_id(path, description)


def get_image_path(image_id: str) -> Optional[str]:
    """获取图片路径的便捷函数"""
    manager = get_image_manager()
    return manager.get_path(image_id)


def parse_image_references(content: str) -> List[Dict[str, Any]]:
    """解析图片引用的便捷函数"""
    manager = get_image_manager()
    return manager.parse_image_references(content)


def generate_js_for_images(content: str) -> str:
    """生成图片插入JS代码的便捷函数"""
    manager = get_image_manager()
    return manager.generate_js_macro_code(content)
