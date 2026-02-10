"""Skill Tool Executor - Executes tools declared by skills."""

from __future__ import annotations

import importlib.util
import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from .registry import SkillTool

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolResult:
    """Result of a tool execution."""
    success: bool
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    execution_ms: int = 0


class ToolExecutor:
    """Executes tools declared by skills.

    Usage:
        executor = ToolExecutor()
        result = executor.execute_tool(
            tool_name="fill_blank_detector",
            arguments={"doc_text": "...", "context_chars": 20},
            skill_id="exam-answering"
        )
    """

    def __init__(self, max_tool_calls_per_turn: int = 3) -> None:
        self.max_tool_calls_per_turn = max_tool_calls_per_turn
        self._tool_cache: Dict[str, Callable] = {}
        self._lock = threading.Lock()

    def execute_tool(
        self,
        tool: SkillTool,
        arguments: Dict[str, Any],
        timeout_ms: int = 30000,
    ) -> ToolResult:
        """Execute a tool with the given arguments.

        Args:
            tool: The SkillTool to execute.
            arguments: Arguments to pass to the tool function.
            timeout_ms: Maximum execution time in milliseconds.

        Returns:
            ToolResult with success status and result or error.
        """
        import time
        start_ms = int(time.time() * 1000)

        # Get or load the tool function
        func = self._get_tool_func(tool)
        if func is None:
            return ToolResult(
                success=False,
                error=f"Tool function not found: {tool.name}",
                execution_ms=int(time.time() * 1000) - start_ms,
            )

        # Execute the tool
        try:
            result = func(**arguments)
            # Ensure result is a dict
            if not isinstance(result, dict):
                result = {"result": result}
            return ToolResult(
                success=True,
                result=result,
                execution_ms=int(time.time() * 1000) - start_ms,
            )
        except Exception as e:
            logger.warning(f"[tools] tool {tool.name} failed: {e}", exc_info=True)
            return ToolResult(
                success=False,
                error=str(e),
                execution_ms=int(time.time() * 1000) - start_ms,
            )

    def _get_tool_func(self, tool: SkillTool) -> Optional[Callable]:
        """Load and cache a tool function from its script."""
        cache_key = f"{tool.script_path}"

        with self._lock:
            if cache_key in self._tool_cache:
                return self._tool_cache[cache_key]

            try:
                spec = importlib.util.spec_from_file_location(
                    f"tool_{tool.name}", tool.script_path
                )
                if spec is None or spec.loader is None:
                    logger.warning(f"[tools] cannot load spec for {tool.script_path}")
                    return None

                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

                # Look for function with same name as tool
                func = getattr(module, tool.name, None)
                if func is None:
                    # Try lowercase
                    func = getattr(module, tool.name.lower(), None)

                if func is None or not callable(func):
                    logger.warning(f"[tools] no callable function '{tool.name}' in {tool.script_path}")
                    return None

                self._tool_cache[cache_key] = func
                logger.debug(f"[tools] loaded tool: {tool.name} from {tool.script_path}")
                return func

            except Exception as e:
                logger.warning(f"[tools] failed to load tool from {tool.script_path}: {e}")
                return None

    def render_tool_result_for_llm(self, tool: SkillTool, result: ToolResult) -> str:
        """Render a tool result as a string for LLM consumption.

        Args:
            tool: The executed tool.
            result: The tool result.

        Returns:
            Formatted string for LLM.
        """
        if not result.success:
            return (
                f"【工具调用失败】\n"
                f"工具: {tool.name}\n"
                f"错误: {result.error}\n"
                f"耗时: {result.execution_ms}ms\n"
                f"建议: 记录错误并继续，不要反复重试。"
            )

        result_json = json.dumps(result.result, ensure_ascii=False, indent=2)
        return (
            f"【工具调用结果】\n"
            f"工具: {tool.name}\n"
            f"状态: 成功\n"
            f"耗时: {result.execution_ms}ms\n"
            f"结果:\n{result_json}\n"
        )

    def parse_tool_calls_from_response(self, response_text: str) -> list[Dict[str, Any]]:
        """Parse tool calls from LLM response text.

        Looks for patterns like:
        ```
        TOOL_CALL: {"name": "tool_name", "arguments": {...}}
        ```
        or
        ```json
        {"name": "tool_name", "arguments": {...}}
        ```

        Args:
            response_text: The LLM response text.

        Returns:
            List of tool call dicts with 'name' and 'arguments'.
        """
        import re

        tool_calls: list[Dict[str, Any]] = []

        # Pattern 1: TOOL_CALL: {...}
        pattern1 = re.compile(r'TOOL_CALL:\s*(\{[^}]+\})', re.DOTALL)
        for match in pattern1.finditer(response_text):
            try:
                call = json.loads(match.group(1))
                if "name" in call and "arguments" in call:
                    tool_calls.append(call)
            except json.JSONDecodeError:
                continue

        # Pattern 2: JSON block with name and arguments
        pattern2 = re.compile(r'\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]+\}\s*\}', re.DOTALL)
        for match in pattern2.finditer(response_text):
            try:
                call = json.loads(match.group(0))
                if "name" in call and "arguments" in call:
                    # Avoid duplicates
                    if call not in tool_calls:
                        tool_calls.append(call)
            except json.JSONDecodeError:
                continue

        return tool_calls

    def validate_tool_arguments(
        self,
        tool: SkillTool,
        arguments: Dict[str, Any],
    ) -> Tuple[bool, Optional[str]]:
        """Validate tool arguments against the tool's parameter schema.

        Args:
            tool: The tool to validate against.
            arguments: The arguments to validate.

        Returns:
            Tuple of (is_valid, error_message).
        """
        params = tool.parameters
        if not params:
            # No schema defined, accept any arguments
            return True, None

        required = params.get("required", [])
        properties = params.get("properties", {})

        # Check required parameters
        for req in required:
            if req not in arguments:
                return False, f"Missing required argument: {req}"

        # Type checking (basic)
        for key, value in arguments.items():
            if key in properties:
                expected_type = properties[key].get("type")
                if expected_type == "string" and not isinstance(value, str):
                    return False, f"Argument '{key}' must be a string"
                elif expected_type == "integer" and not isinstance(value, int):
                    return False, f"Argument '{key}' must be an integer"
                elif expected_type == "number" and not isinstance(value, (int, float)):
                    return False, f"Argument '{key}' must be a number"
                elif expected_type == "boolean" and not isinstance(value, bool):
                    return False, f"Argument '{key}' must be a boolean"
                elif expected_type == "array" and not isinstance(value, list):
                    return False, f"Argument '{key}' must be an array"
                elif expected_type == "object" and not isinstance(value, dict):
                    return False, f"Argument '{key}' must be an object"

        return True, None
