"""Session ID 生成器"""

import hashlib
import re


class SessionIdGenerator:
    """Session ID 生成器"""
    
    @staticmethod
    def generate(file_content: bytes) -> str:
        """生成 Session ID
        
        Args:
            file_content: 投标文件内容
            
        Returns:
            生成的 Session ID
        """
        # 计算文件内容哈希
        file_hash = hashlib.sha256(file_content).hexdigest()[:32]
        
        # Deterministic session id (stable across restarts/time).
        # This allows bucketing chat history by document without accidental "new session every send".
        return f"session_{file_hash}"
    
    @staticmethod
    def generate_from_hash(file_hash: str) -> str:
        """基于文件哈希生成 Session ID
        
        Args:
            file_hash: 文件内容哈希值
            
        Returns:
            生成的 Session ID
        """
        # 确保哈希值是32位
        if len(file_hash) > 32:
            file_hash = file_hash[:32]
        elif len(file_hash) < 32:
            # 如果哈希值不足32位，用0填充
            file_hash = file_hash.ljust(32, '0')
        
        # Deterministic session id derived from the provided hash.
        # This keeps memory stable across restarts and avoids accidental "new session every request".
        return f"session_{file_hash}"
    
    @staticmethod
    def validate(session_id: str) -> bool:
        """验证 Session ID 格式
        
        Args:
            session_id: 要验证的 Session ID
            
        Returns:
            True 表示格式有效，False 表示无效
        """
        # Accept both:
        # - New deterministic: session_<32hex>
        # - Legacy: session_<32hex>_<timestamp>_<uuid>
        pattern = r"^session_[a-f0-9]{32}(?:_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$"
        return bool(re.match(pattern, session_id))
    
    @staticmethod
    def get_file_hash(session_id: str) -> str:
        """从 Session ID 中提取文件哈希
        
        Args:
            session_id: Session ID
            
        Returns:
            文件哈希值
        """
        parts = session_id.split('_')
        return parts[1] if len(parts) >= 2 else ""
    
    @staticmethod
    def get_timestamp(session_id: str) -> int:
        """从 Session ID 中提取时间戳
        
        Args:
            session_id: Session ID
            
        Returns:
            时间戳（秒级）
        """
        parts = session_id.split('_')
        try:
            return int(parts[2]) if len(parts) >= 3 else 0
        except ValueError:
            return 0
