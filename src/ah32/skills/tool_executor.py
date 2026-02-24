"""Skill Tool Executor - Executes tools declared by skills."""

from __future__ import annotations

import atexit
import importlib.util
import json
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from .registry import SkillTool

logger = logging.getLogger(__name__)

_SKILL_TOOL_THREAD_POOL: Optional[ThreadPoolExecutor] = None
_SKILL_TOOL_THREAD_POOL_LOCK = threading.Lock()


def get_skill_tool_thread_pool() -> ThreadPoolExecutor:
    """Return a shared single-thread pool for running skill tools.

    Why: some integrations (e.g., Playwright sync API) cannot run inside the
    server's asyncio event loop thread.
    """
    global _SKILL_TOOL_THREAD_POOL
    if _SKILL_TOOL_THREAD_POOL is None:
        with _SKILL_TOOL_THREAD_POOL_LOCK:
            if _SKILL_TOOL_THREAD_POOL is None:
                _SKILL_TOOL_THREAD_POOL = ThreadPoolExecutor(
                    max_workers=1,
                    thread_name_prefix="ah32-skill-tools",
                )
    return _SKILL_TOOL_THREAD_POOL


def _shutdown_skill_tool_thread_pool() -> None:
    global _SKILL_TOOL_THREAD_POOL
    pool = _SKILL_TOOL_THREAD_POOL
    if pool is None:
        return
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:
        logger.debug("[tools] skill tool thread pool shutdown failed", exc_info=True)
    finally:
        _SKILL_TOOL_THREAD_POOL = None


atexit.register(_shutdown_skill_tool_thread_pool)


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
        cache_key = f"{tool.script_path}:{tool.name}"

        with self._lock:
            if cache_key in self._tool_cache:
                return self._tool_cache[cache_key]

            try:
                # Use a unique module name per script to avoid collisions across skills/tools,
                # and register it in sys.modules before exec_module so that decorators like
                # @dataclass can resolve module globals correctly.
                module_name = f"ah32_skilltool_{tool.name}_{abs(hash(str(tool.script_path))) % 1_000_000_000}"
                spec = importlib.util.spec_from_file_location(module_name, tool.script_path)
                if spec is None or spec.loader is None:
                    logger.warning(f"[tools] cannot load spec for {tool.script_path}")
                    return None

                module = importlib.util.module_from_spec(spec)
                try:
                    sys.modules[module_name] = module
                except Exception:
                    # Best-effort; exec_module will still run.
                    logger.warning(
                        "[tools] failed to register tool module in sys.modules: %s",
                        module_name,
                        exc_info=True,
                    )
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
                logger.warning(
                    f"[tools] failed to load tool from {tool.script_path}: {e}",
                    exc_info=True,
                )
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
            payload = {
                "error": {
                    "message": str(result.error or "tool execution failed"),
                }
            }
            return json.dumps(payload, ensure_ascii=False)

        payload = {"result": {"data": result.result if isinstance(result.result, dict) else {"value": result.result}}}
        return json.dumps(payload, ensure_ascii=False)

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
