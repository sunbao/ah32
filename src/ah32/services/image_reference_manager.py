"""简化的图片引用管理器 - 只保留核心功能"""

import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

logger = logging.getLogger(__name__)


class ImageReferenceManager:
    """简化的图片引用管理器"""

    def __init__(self):
        self.image_references: Dict[str, Dict[str, str]] = {}
        self._counter = 0

    def add(self, image_id: str, path: str, description: str) -> bool:
        """添加图片引用"""
        try:
            if not Path(path).exists():
                logger.warning(f"图片文件不存在: {path}")
                return False

            self.image_references[image_id] = {
                "path": path,
                "description": description
            }
            return True
        except Exception as e:
            logger.error(f"添加图片引用失败: {str(e)}")
            return False

    def generate_id(self) -> str:
        """生成新的图片ID"""
        self._counter += 1
        return f"img_{self._counter:03d}"

    def get_path(self, image_id: str) -> Optional[str]:
        """根据ID获取图片路径"""
        ref = self.image_references.get(image_id)
        return ref["path"] if ref else None

    def parse_image_references(self, content: str) -> List[Dict[str, Any]]:
        """解析内容中的图片引用"""
        import re
        pattern = r'\[图片:(\w+)\]'
        matches = re.finditer(pattern, content)

        references = []
        for match in matches:
            image_id = match.group(1)
            references.append({
                "id": image_id,
                "position": match.start(),
                "full_match": match.group(0)
            })

        return references


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
    image_id = manager.generate_id()
    if manager.add(image_id, path, description):
        return image_id
    return None


def parse_image_references(content: str) -> List[Dict[str, Any]]:
    """解析图片引用的便捷函数"""
    manager = get_image_manager()
    return manager.parse_image_references(content)
