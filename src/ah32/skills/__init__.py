"""Runtime hot-loaded skills (Claude-style extensions).

Skills live outside the Python package (default: <runtime_root>/skills) and are
loaded dynamically on each request (with caching). They inject extra system
instructions and can declare tools for deterministic operations.

Directory structure:
    skills/<skill-id>/
        skill.json         # Manifest with tools declaration
        SYSTEM.txt         # System prompt / business rules
        scripts/
            __init__.py    # Optional: TOOLS registry
            tool_name.py    # Tool implementations (functions)
"""

from .registry import SkillRegistry, Skill, SkillTool
from .router import SkillRouter, SkillRoutingHints
from .tool_executor import ToolExecutor, ToolResult

__all__ = [
    "SkillRegistry",
    "Skill",
    "SkillTool",
    "SkillRouter",
    "SkillRoutingHints",
    "ToolExecutor",
    "ToolResult",
]
