from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class PolicyListItem(BaseModel):
    policy_name: str = Field(..., description="政策标题")
    issue_date: Optional[str] = Field(default=None, description="发布日期 YYYY-MM-DD")
    document_number: Optional[str] = Field(default=None, description="文号（如有）")
    source_url: str = Field(..., description="详情页链接")
    is_major: bool = Field(default=False, description="是否重大政策（规则标记）")

    model_config = {"extra": "allow"}


class PolicyDocument(BaseModel):
    policy_name: str
    issued_by: Optional[str] = None
    issue_date: Optional[str] = None
    document_number: Optional[str] = None
    source_url: str
    key_points: List[str] = Field(default_factory=list)
    category: Optional[str] = None
    keywords: List[str] = Field(default_factory=list)

    # Monitoring metadata
    is_major: bool = False
    scraped_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config = {"extra": "allow"}

    @classmethod
    def now_iso(cls) -> str:
        # Keep microseconds so rapid successive updates can be distinguished in unit tests.
        return datetime.utcnow().isoformat(timespec="microseconds") + "Z"

    def to_storage_dict(self) -> Dict[str, Any]:
        data = self.model_dump()
        data.setdefault("scraped_at", self.scraped_at or self.now_iso())
        data.setdefault("updated_at", self.updated_at or self.now_iso())
        return data
