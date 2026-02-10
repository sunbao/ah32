"""JS宏Vibe Coding可视化工作流"""

from typing import TypedDict, List, Optional, Dict, Any, AsyncGenerator
# langgraph uses a namespace package layout; StateGraph/END live under langgraph.graph.
from langgraph.graph import StateGraph, END
import logging
import re
import json
import asyncio
import uuid
import os
from datetime import datetime

logger = logging.getLogger(__name__)


class VisualStep(TypedDict):
    """可视化步骤"""
    type: str  # 'thinking', 'analyzing', 'generating', 'checking', 'fixing', 'validating', 'executing'
    title: str
    content: str
    timestamp: str
    reasoning: Optional[str] = None  # LLM思考过程
    code_diff: Optional[Dict[str, Any]] = None  # 代码差异
    status: str  # 'pending', 'processing', 'completed', 'error'


class JSMacroState(TypedDict):
    """JS宏Vibe Coding工作流状态"""
    # 用户输入
    user_query: str
    session_id: str
    host_app: str = "wps"
    capabilities: Optional[Dict[str, Any]] = None
    style_spec: Optional[Dict[str, Any]] = None

    # 代码相关
    original_code: str = ""
    current_code: str = ""
    fixed_code: str = ""

    # 工作流状态
    current_step: int = 0
    total_steps: int = 0
    visual_steps: List[VisualStep] = []
    thinking_content: str = ""  # LLM思考过程

    # 错误和修复
    errors_found: List[str] = []
    fixes_applied: List[Dict[str, Any]] = []
    attempt_count: int = 0
    max_attempts: int = 3

    # 执行状态
    execution_result: Optional[Dict[str, Any]] = None
    needs_retry: bool = False
    success: bool = False

    # 流式输出控制
    stream_steps: bool = True
    completed: bool = False


class JSMacroVibeWorkflow:
    """JS宏Vibe Coding可视化工作流"""

    def __init__(self, llm=None):
        self.llm = llm
        self.max_attempts = 3
        # NOTE: In production we optimize for speed/stability; verbose reasoning is optional (dev only).
        self._emit_node_state = os.getenv("AH32_MACRO_STREAM_NODE_STATE", "").lower() in ("1", "true", "yes")
        self._emit_reasoning = os.getenv("AH32_MACRO_SHOW_THOUGHTS", "").lower() in ("1", "true", "yes")
        self._emit_code_diff = os.getenv("AH32_MACRO_STREAM_CODE_DIFF", "").lower() in ("1", "true", "yes")
        # 初始化代码质量记忆系统
        from ah32.memory.code_quality_memory import get_code_quality_memory
        self.code_quality_memory = get_code_quality_memory()
        self._build_workflow()

    def _build_workflow(self):
        """构建 LangGraph 工作流（以“少回合 + 小流量”为优先）。

        说明：
        - 这个工作流用于“生成/修复可执行代码”，实际执行发生在前端 WPS 环境中。
        - 默认不做“思考/分析文本”的额外 LLM 调用（除非 AH32_MACRO_SHOW_THOUGHTS=true）。
        - 默认不在 SSE 中发送巨大 node_state（除非 AH32_MACRO_STREAM_NODE_STATE=true）。
        """
        workflow = StateGraph(JSMacroState)

        # 添加节点
        workflow.add_node("generating", self._generating_step)
        workflow.add_node("basic_check", self._basic_check_step)
        workflow.add_node("code_fix", self._code_fix_step)
        workflow.add_node("validating", self._validating_step)
        workflow.add_node("error_recovery", self._error_recovery_step)
        workflow.add_node("finalize", self._finalize_step)

        # 设置入口点
        workflow.set_entry_point("generating")

        workflow.add_conditional_edges(
            "generating",
            self._check_generation,
            {
                "check": "basic_check",
                "error": "error_recovery"
            }
        )

        workflow.add_conditional_edges(
            "basic_check",
            self._check_basic_issues,
            {
                "fix": "code_fix",
                "validating": "validating"
            }
        )

        workflow.add_conditional_edges(
            "code_fix",
            self._check_fix_result,
            {
                "validate": "validating",
                "retry": "code_fix"
            }
        )

        workflow.add_conditional_edges(
            "validating",
            self._check_validation,
            {
                "finalize": "finalize",
                "retry_fix": "code_fix",
            }
        )

        workflow.add_conditional_edges(
            "error_recovery",
            self._check_recovery,
            {
                "retry": "generating",
                "finalize": "finalize"
            }
        )

        # 编译工作流
        self.graph = workflow.compile()

    def _get_recommendations_from_memory(self, user_query: str, errors: List[str]) -> Dict[str, Any]:
        """从记忆系统获取修复建议"""
        try:
            if errors:
                recommendations = self.code_quality_memory.get_recommendation(user_query, errors)
                return recommendations
            return {}
        except Exception as e:
            logger.error(f"获取记忆系统建议失败: {e}")
            return {}

    def _record_attempt_to_memory(self, state: JSMacroState, start_time: float):
        """记录尝试到记忆系统"""
        try:
            from ah32.memory.code_quality_memory import JSMacroAttempt, VisualStep

            # 创建可视化步骤对象
            visual_steps = []
            for step in state["visual_steps"]:
                visual_step = VisualStep(
                    step_id=str(uuid.uuid4()),
                    type=step.get("type", ""),
                    title=step.get("title", ""),
                    content=step.get("content", ""),
                    reasoning=step.get("reasoning"),
                    code_diff=step.get("code_diff"),
                    timestamp=step.get("timestamp", 0),
                    status=step.get("status", "")
                )
                visual_steps.append(visual_step)

            # 计算持续时间
            duration = asyncio.get_event_loop().time() - start_time

            # 创建尝试记录
            attempt = JSMacroAttempt(
                attempt_id=str(uuid.uuid4()),
                session_id=state["session_id"],
                user_query=state["user_query"],
                original_code=state.get("original_code", ""),
                fixed_code=state.get("current_code", ""),
                attempt_number=state["attempt_count"] + 1,
                errors_found=state.get("errors_found", []),
                fixes_applied=state.get("fixes_applied", []),
                execution_result=state.get("execution_result"),
                success=state.get("success", False),
                timestamp=datetime.now(),
                duration=duration,
                visual_steps=visual_steps,
                total_steps=state.get("total_steps", 0),
                completed_steps=len([s for s in state["visual_steps"] if s.get("status") == "completed"])
            )

            # 记录到记忆系统
            self.code_quality_memory.record_attempt(attempt)
            logger.info(f"尝试已记录到记忆系统: {attempt.attempt_id}, 成功: {attempt.success}")

        except Exception as e:
            logger.error(f"记录尝试到记忆系统失败: {e}")

    def _add_visual_step(self, state: JSMacroState, step_type: str, title: str, content: str, reasoning: str = None):
        """添加可视化步骤"""
        visual_step: VisualStep = {
            "type": step_type,
            "title": title,
            "content": content,
            "timestamp": asyncio.get_event_loop().time(),
            "reasoning": reasoning,
            "status": "completed"
        }
        state["visual_steps"].append(visual_step)
        logger.info(f"[{step_type.upper()}] {title}: {content}")

    def _hydrate_state(self, state: JSMacroState) -> JSMacroState:
        """LangGraph 节点可能返回“局部 state”，这里确保常用字段存在，避免 KeyError。"""
        state.setdefault("original_code", "")
        state.setdefault("current_code", "")
        state.setdefault("fixed_code", "")
        state.setdefault("current_step", 0)
        state.setdefault("total_steps", 0)
        state.setdefault("thinking_content", "")
        state.setdefault("errors_found", [])
        state.setdefault("fixes_applied", [])
        state.setdefault("attempt_count", 0)
        state.setdefault("max_attempts", self.max_attempts)
        state.setdefault("execution_result", None)
        state.setdefault("needs_retry", False)
        state.setdefault("success", False)
        state.setdefault("completed", False)
        state.setdefault("stream_steps", True)
        if not isinstance(state.get("visual_steps"), list):
            state["visual_steps"] = []
        return state

    async def _generating_step(self, state: JSMacroState) -> JSMacroState:
        """代码生成步骤"""
        state = self._hydrate_state(state)
        state["current_step"] = int(state.get("current_step") or 0) + 1
        state["total_steps"] = int(state.get("total_steps") or 0) + 1

        # Count one attempt per generation call (bounds retries across the workflow).
        state["attempt_count"] = int(state.get("attempt_count") or 0) + 1

        # 添加生成步骤（append-only：避免前端收到“processing 再 completed”的重复 step）
        generating_step = VisualStep(
            type="generating",
            title="代码生成中",
            content="正在生成JS宏代码...",
            timestamp=asyncio.get_event_loop().time(),
            status="processing"
        )

        if self.llm:
            try:
                # LLM生成代码（复用统一提示词，减少 tokens + 避免矛盾示例）
                from ah32.services.wps_js_prompts import get_wps_js_macro_generation_prompt

                host = (state.get("host_app") or "wps").strip().lower()
                if host not in ("wps", "et", "wpp"):
                    host = "wps"
                target = "WPS Writer" if host == "wps" else ("WPS 表格(ET)" if host == "et" else "WPS 演示(WPP)")

                style_spec = state.get("style_spec") or None
                style_spec_text = "（无）"
                if style_spec:
                    try:
                        style_spec_text = json.dumps(style_spec, ensure_ascii=False, indent=2, default=str)
                        if len(style_spec_text) > 1800:
                            style_spec_text = style_spec_text[:1800] + "\n... (truncated)"
                    except Exception:
                        style_spec_text = str(style_spec)

                generation_prompt = get_wps_js_macro_generation_prompt(host).format(
                    query=state["user_query"],
                    style_spec=style_spec_text,
                )
                caps = state.get("capabilities")
                if caps:
                    try:
                        # Keep this compact; the frontend probe may include a lot of detail.
                        caps_json = json.dumps(caps, ensure_ascii=False, default=str)
                        if len(caps_json) > 1200:
                            caps_json = caps_json[:1200] + "...(truncated)"
                        generation_prompt = (
                            generation_prompt
                            + "\n\n当前宿主能力探针（可能不完整，仅作参考）：\n"
                            + caps_json
                            + "\n\n请优先选择探针显示存在/可用的 API；如果某能力为 false/缺失，请改用更通用的替代方案。"
                        )
                    except Exception as e:
                        logger.warning(f"[workflow] serialize capabilities failed: {e}", exc_info=True)

                # Inject compact, learned hints (Top-K) to reduce repeated syntax/API mistakes without prompt bloat.
                try:
                    hints = self.code_quality_memory.get_prompt_hints(error_type=None, limit=3, max_chars=500)
                    if hints:
                        generation_prompt += "\n\n历史高频错误预防规则（Top-K）：\n" + hints
                except Exception as e:
                    logger.warning(f"[workflow] load code-quality hints failed: {e}", exc_info=True)
                response = await asyncio.shield(self.llm.ainvoke(
                    [
                        (
                            "system",
                            (
                                f"你是一个 {target} 的 JS 宏代码生成专家。"
                                "仅使用 ES5 语法：只用 var/function/for/try-catch；禁止 let/const、=>、class、async/await。"
                                "只实现当前用户需求这一件事；不要输出多套备用方案/不要把多个需求塞到同一个脚本里；尽量短小。"
                                "注意：BID.upsertBlock 正确签名是 BID.upsertBlock(blockId, function(){...}, opts?)；"
                                "不要写成 BID.upsertBlock({id, content})。"
                            ),
                        ),
                        ("user", generation_prompt),
                    ]
                ))

                if hasattr(response, 'content'):
                    llm_response = response.content
                else:
                    llm_response = str(response)

                # 提取代码块
                code_match = re.search(r'```(?:javascript|js)?\n(.*?)```', llm_response, re.DOTALL)
                generated_code = ""
                if code_match:
                    generated_code = code_match.group(1).strip()
                else:
                    # Some models return plain JS without fences; accept it if it looks like a macro.
                    candidate = (llm_response or "").strip()
                    if candidate and "```" not in candidate:
                        try:
                            from ah32.services.js_sanitize import sanitize_wps_js, looks_like_wps_js_macro

                            candidate2, _ = sanitize_wps_js(candidate)
                            if looks_like_wps_js_macro(candidate2):
                                generated_code = candidate2.strip()
                        except Exception as e:
                            logger.warning(f"[workflow] sanitize candidate macro failed: {e}", exc_info=True)

                if generated_code:
                    # Sanitize common TS/ESM/unicode punctuation issues early to reduce frontend failure rate.
                    try:
                        from ah32.services.js_sanitize import sanitize_wps_js

                        generated_code, _notes = sanitize_wps_js(generated_code)
                    except Exception as e:
                        logger.warning(f"[workflow] sanitize generated macro failed: {e}", exc_info=True)

                    state["original_code"] = generated_code
                    state["current_code"] = generated_code

                    # 更新生成步骤
                    generating_step["status"] = "completed"
                    generating_step["content"] = "JS宏代码生成完成"
                    if self._emit_code_diff:
                        generating_step["code_diff"] = {
                            "type": "generated",
                            "code": generated_code,
                            "explanation": "新生成的代码",
                        }

                    logger.info(f"[生成] 代码生成成功，长度: {len(generated_code)}")

                else:
                    generating_step["status"] = "error"
                    generating_step["content"] = "代码生成失败：未找到代码块"

            except Exception as e:
                logger.error(f"代码生成失败: {e}")
                generating_step["status"] = "error"
                generating_step["content"] = f"生成失败: {str(e)}"

        # Emit one step per node (the final state of this step).
        state["visual_steps"].append(generating_step)
        return state

    async def _basic_check_step(self, state: JSMacroState) -> JSMacroState:
        """基础检查步骤"""
        state = self._hydrate_state(state)
        state["current_step"] = int(state.get("current_step") or 0) + 1
        state["total_steps"] = int(state.get("total_steps") or 0) + 1

        # 添加检查步骤（append-only）
        checking_step = VisualStep(
            type="checking",
            title="基础检查中",
            content="正在检查代码质量...",
            timestamp=asyncio.get_event_loop().time(),
            status="processing"
        )

        errors = []
        code = state.get("current_code") or ""

        # 检查VBA语法残留
        vba_patterns = [
            (r'\bDim\s+\w+', "Dim 变量声明"),
            (r'\bSet\s+\w+\s*=', "Set 赋值语句"),
            (r'\bEnd\s+\w+\b', "End 语句"),
            (r'\bNext\b', "Next 循环"),
            (r'\bFor\s+\w+', "For 循环"),
            (r'\bIf\s+.*\s+Then', "If Then 语句"),
        ]

        for pattern, description in vba_patterns:
            if re.search(pattern, code, re.IGNORECASE):
                errors.append(f"VBA语法残留: {description}")

        # 检查括号匹配
        if code.count('(') != code.count(')'):
            errors.append("括号不匹配")

        # 检查 TypeScript/ESM 语法（WPS new Function 执行会直接语法错误）
        ts_esm_patterns = [
            (r'^\s*import\s+', "ESM import 语句"),
            (r'^\s*export\s+', "ESM export 语句"),
            (r'^\s*interface\s+\w+', "TypeScript interface 声明"),
            (r'^\s*type\s+\w+\s*=', "TypeScript type 别名"),
            (r'\b(const|let|var)\s+\w+\s*:\s*[^=;\n]+[=;]', "TypeScript 类型注解（变量）"),
            (r'[\(,]\s*\w+\s*:\s*[^,\)\n]+', "TypeScript 类型注解（参数）"),
            (r'\)\s*:\s*[^=\n{]+(?=\{|=>)', "TypeScript 返回类型注解"),
        ]
        for pattern, description in ts_esm_patterns:
            if re.search(pattern, code, re.IGNORECASE | re.MULTILINE):
                errors.append(f"TypeScript/ESM 语法不兼容: {description}")

        # 经验规则：WPS 环境通常不支持 selection.TypeText，优先提示使用 Range.Text
        if re.search(r'\bTypeText\s*\(', code):
            errors.append("不推荐使用 selection.TypeText（可能不兼容），请改用 selection.Range.Text = ...")

        state["errors_found"] = errors

        # 更新检查步骤
        if errors:
            checking_step["status"] = "completed"
            checking_step["content"] = f"发现 {len(errors)} 个基础问题"
            checking_step["code_diff"] = {
                "type": "error_found",
                "errors": errors,
                "explanation": "需要进一步分析和修复"
            }
        else:
            checking_step["status"] = "completed"
            checking_step["content"] = "基础检查通过"

        logger.info(f"[检查] 基础检查完成，发现 {len(errors)} 个问题")

        state["visual_steps"].append(checking_step)
        return state

    async def _code_fix_step(self, state: JSMacroState) -> JSMacroState:
        """代码修复步骤"""
        state = self._hydrate_state(state)
        state["current_step"] = int(state.get("current_step") or 0) + 1
        state["total_steps"] = int(state.get("total_steps") or 0) + 1

        # Count one attempt per fix call (bounds retries across the workflow).
        state["attempt_count"] = int(state.get("attempt_count") or 0) + 1

        # 添加修复步骤（append-only）
        fixing_step = VisualStep(
            type="fixing",
            title="代码修复中",
            content="正在修复代码...",
            timestamp=asyncio.get_event_loop().time(),
            status="processing"
        )

        if self.llm and state.get("errors_found"):
            try:
                # LLM修复代码
                fix_prompt = f"""请修复以下代码中的问题：

原始代码：
```javascript
{state.get('current_code', '')}
```

发现的问题：
{chr(10).join(f"- {error}" for error in (state.get('errors_found') or []))}

要求：
1. 只修复发现的问题，不要改变其他代码
2. 保持代码逻辑不变
3. 确保修复后的代码符合JavaScript和WPS JS规范
4. 返回修复后的完整代码
5. 不要输出TypeScript语法（类型注解、interface/type、as断言、非空断言!）
6. 若有 TypeText，请尽量改为 selection.Range.Text 方式
7. 可选：可使用 BID 助手对象（表格/图表/艺术字）来替代不稳定的直接调用

历史高频错误修复规则（Top-K）：
{self.code_quality_memory.get_prompt_hints(error_type=None, limit=3, max_chars=500)}

请返回格式：
```javascript
修复后的代码
```"""

                response = await asyncio.shield(self.llm.ainvoke([
                    ("system", "你是一个代码修复专家，专注于修复VBA语法残留和JavaScript错误。"),
                    ("user", fix_prompt)
                ]))

                if hasattr(response, 'content'):
                    llm_response = response.content
                else:
                    llm_response = str(response)

                # 提取修复后的代码
                code_match = re.search(r'```(?:javascript|js)?\n(.*?)```', llm_response, re.DOTALL)
                fixed_code = ""
                if code_match:
                    fixed_code = code_match.group(1).strip()
                else:
                    candidate = (llm_response or "").strip()
                    if candidate and "```" not in candidate:
                        try:
                            from ah32.services.js_sanitize import sanitize_wps_js, looks_like_wps_js_macro

                            candidate2, _ = sanitize_wps_js(candidate)
                            if looks_like_wps_js_macro(candidate2):
                                fixed_code = candidate2.strip()
                        except Exception:
                            fixed_code = candidate

                if fixed_code:
                    try:
                        from ah32.services.js_sanitize import sanitize_wps_js

                        fixed_code, _notes = sanitize_wps_js(fixed_code)
                    except Exception as e:
                        logger.warning(f"[workflow] sanitize repaired macro failed: {e}", exc_info=True)

                    fixed_code = fixed_code.strip()
                    # Be defensive: LangGraph nodes may pass partial state dicts; avoid KeyError.
                    old_code = state.get("current_code", "")
                    state["fixed_code"] = fixed_code
                    state["current_code"] = fixed_code

                    # 更新修复步骤
                    fixing_step["status"] = "completed"
                    fixing_step["content"] = "代码修复完成"
                    if self._emit_code_diff:
                        fixing_step["code_diff"] = {
                            "type": "modified",
                            "old_code": old_code,
                            "new_code": fixed_code,
                            "explanation": f"修复了 {len(state['errors_found'])} 个问题",
                        }

                    logger.info(f"[修复] 代码修复成功，长度: {len(fixed_code)}")

                else:
                    fixing_step["status"] = "error"
                    fixing_step["content"] = "修复失败：未找到修复后的代码"

            except Exception as e:
                logger.error(f"代码修复失败: {e}")
                fixing_step["status"] = "error"
                fixing_step["content"] = f"修复失败: {str(e)}"

        state["visual_steps"].append(fixing_step)
        return state

    async def _validating_step(self, state: JSMacroState) -> JSMacroState:
        """验证步骤"""
        state = self._hydrate_state(state)
        state["current_step"] = int(state.get("current_step") or 0) + 1
        state["total_steps"] = int(state.get("total_steps") or 0) + 1

        # 添加验证步骤（append-only）
        validating_step = VisualStep(
            type="validating",
            title="验证中",
            content="正在验证修复结果...",
            timestamp=asyncio.get_event_loop().time(),
            status="processing"
        )

        # 重新检查
        code = state.get("current_code") or ""
        remaining_errors = []

        # 再次检查VBA语法
        vba_patterns = [
            (r'\bDim\s+\w+', "Dim 变量声明"),
            (r'\bSet\s+\w+\s*=', "Set 赋值语句"),
            (r'\bEnd\s+\w+\b', "End 语句"),
            (r'\bNext\b', "Next 循环"),
            (r'\bFor\s+\w+', "For 循环"),
            (r'\bIf\s+.*\s+Then', "If Then 语句"),
        ]

        for pattern, description in vba_patterns:
            if re.search(pattern, code, re.IGNORECASE):
                remaining_errors.append(f"VBA语法残留: {description}")

        # 检查括号匹配
        if code.count('(') != code.count(')'):
            remaining_errors.append("括号不匹配")

        state["errors_found"] = remaining_errors
        # This workflow only *produces* executable code; actual execution happens on the frontend.
        # Treat "success" as "code validated & ready".
        state["success"] = (len(remaining_errors) == 0) and bool((state.get("current_code") or "").strip())

        # 更新验证步骤
        if not remaining_errors:
            validating_step["status"] = "completed"
            validating_step["content"] = "验证通过，代码质量良好"
        else:
            validating_step["status"] = "completed"
            validating_step["content"] = f"验证失败，仍有 {len(remaining_errors)} 个问题"

        logger.info(f"[验证] 验证完成，剩余 {len(remaining_errors)} 个问题")

        state["visual_steps"].append(validating_step)
        return state

    async def _error_recovery_step(self, state: JSMacroState) -> JSMacroState:
        """错误恢复步骤"""
        state = self._hydrate_state(state)
        # attempt_count is incremented by generating/fixing; here we only decide whether to retry.

        # 添加恢复步骤（append-only）
        recovery_step = VisualStep(
            type="fixing",
            title="错误恢复中",
            content=f"第 {state.get('attempt_count', 0)} 次尝试修复...",
            timestamp=asyncio.get_event_loop().time(),
            status="processing"
        )

        if int(state.get("attempt_count") or 0) >= int(state.get("max_attempts") or self.max_attempts):
            # 达到最大尝试次数
            recovery_step["status"] = "error"
            recovery_step["content"] = f"已达到最大尝试次数 ({state.get('max_attempts') or self.max_attempts})，停止修复"
            state["needs_retry"] = False
        else:
            # 继续重试
            recovery_step["status"] = "completed"
            recovery_step["content"] = f"准备第 {int(state.get('attempt_count') or 0) + 1} 次尝试"
            state["needs_retry"] = True

        state["visual_steps"].append(recovery_step)
        return state

    async def _finalize_step(self, state: JSMacroState) -> JSMacroState:
        """最终步骤"""
        state = self._hydrate_state(state)
        state["completed"] = True
        state["current_step"] = state["total_steps"]

        # 添加完成步骤
        final_step = VisualStep(
            type="completed",
            title="完成",
            content="JS宏处理完成" if state.get("success") else "JS宏处理失败",
            timestamp=asyncio.get_event_loop().time(),
            status="completed"
        )
        state["visual_steps"].append(final_step)

        logger.info(f"[最终] 处理完成，成功: {state.get('success')}")

        # 记录尝试到记忆系统
        if hasattr(self, '_workflow_start_time'):
            self._record_attempt_to_memory(state, self._workflow_start_time)

        return state

    def _should_continue(self, state: JSMacroState) -> str:
        """判断是否继续"""
        if not (state.get("current_code") or ""):
            return "generate"
        return "end"

    def _check_generation(self, state: JSMacroState) -> str:
        """检查生成结果"""
        if (state.get("current_code") or ""):
            return "check"
        return "error"

    def _check_basic_issues(self, state: JSMacroState) -> str:
        """检查基础问题"""
        if state.get("errors_found"):
            # Go straight to fix; analysis step is optional and disabled by default for speed.
            return "fix"
        return "validating"

    def _check_llm_analysis(self, state: JSMacroState) -> str:
        """检查LLM分析结果"""
        if state.get("errors_found"):
            return "fix"
        return "validating"

    def _check_fix_result(self, state: JSMacroState) -> str:
        """检查修复结果"""
        if (state.get("fixed_code") or "") and (state.get("fixed_code") != state.get("original_code")):
            return "validate"
        if int(state.get("attempt_count") or 0) < int(state.get("max_attempts") or self.max_attempts):
            return "retry"
        return "validate"

    def _check_validation(self, state: JSMacroState) -> str:
        """检查验证结果"""
        if not state.get("errors_found"):
            return "finalize"
        # Validation failed: try fixing within attempt budget.
        if int(state.get("attempt_count") or 0) < int(state.get("max_attempts") or self.max_attempts):
            return "retry_fix"
        return "finalize"

    def _check_execution(self, state: JSMacroState) -> str:
        """检查执行结果"""
        if bool(state.get("success")):
            return "success"
        elif int(state.get("attempt_count") or 0) < int(state.get("max_attempts") or self.max_attempts):
            return "retry"
        return "error"

    def _check_recovery(self, state: JSMacroState) -> str:
        """检查恢复结果"""
        if bool(state.get("needs_retry")) and int(state.get("attempt_count") or 0) < int(state.get("max_attempts") or self.max_attempts):
            return "retry"
        return "finalize"

    async def process_with_visualization(
        self,
        user_query: str,
        session_id: str,
        host_app: str = "wps",
        capabilities: Optional[Dict[str, Any]] = None,
        style_spec: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """带可视化的处理流程"""
        # 记录工作流开始时间
        self._workflow_start_time = asyncio.get_event_loop().time()

        # NOTE:
        # TypedDict default values are only for type checking; at runtime missing keys raise KeyError.
        # LangGraph conditional edges and later steps access these keys directly, so we must
        # initialize them explicitly.
        initial_state: JSMacroState = {
            "user_query": user_query,
            "session_id": session_id,
            "host_app": (host_app or "wps").strip().lower(),
            "capabilities": capabilities,
            "style_spec": style_spec,
            # code related
            "original_code": "",
            "current_code": "",
            "fixed_code": "",
            "current_step": 0,
            "total_steps": 0,
            "visual_steps": [],
            "thinking_content": "",
            # error & fix
            "errors_found": [],
            "fixes_applied": [],
            "attempt_count": 0,
            "max_attempts": self.max_attempts,
            # execution
            "execution_result": None,
            "needs_retry": False,
            "completed": False,
            "success": False,
            "stream_steps": True,
        }

        last_step_sig: str | None = None
        try:
            # 流式执行工作流
            async for event in self.graph.astream(initial_state):
                for node_name, node_state in event.items():
                    if self._emit_node_state:
                        yield {
                            "type": "node_update",
                            "node": node_name,
                            "state": node_state,
                            "timestamp": asyncio.get_event_loop().time(),
                        }

                    # 发送可视化步骤更新（支持“原地更新”的 step：如 status/内容变化）
                    if "visual_steps" in node_state:
                        new_steps = node_state.get("visual_steps") or []
                        if isinstance(new_steps, list) and new_steps:
                            latest_step = new_steps[-1]
                            try:
                                sig = json.dumps(latest_step, ensure_ascii=False, sort_keys=True, default=str)
                            except Exception:
                                sig = None
                            if sig and sig != last_step_sig:
                                last_step_sig = sig
                                yield {
                                    "type": "visual_step",
                                    "step": latest_step,
                                    "timestamp": latest_step.get("timestamp", asyncio.get_event_loop().time()),
                                }

                    # 更新初始状态
                    initial_state.update(node_state)

        except asyncio.CancelledError:
            # Normal cancellation (client disconnected / user cancelled). Do not convert to "error" event.
            raise
        except Exception as e:
            logger.error(f"工作流执行失败: {e}")
            yield {
                "type": "error",
                "error": str(e),
                "timestamp": asyncio.get_event_loop().time()
            }

        # 发送最终结果
        yield {
            "type": "final_result",
            "result": {
                "success": bool(initial_state.get("success")),
                "code": initial_state.get("current_code", "") or "",
                "visual_steps": initial_state.get("visual_steps", []) or [],
                "attempt_count": int(initial_state.get("attempt_count") or 0),
                "execution_result": initial_state.get("execution_result")
            },
            "timestamp": asyncio.get_event_loop().time()
        }
