from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, Optional

from ah32.integrations.browser.api import (
    BrowserSessionConfig,
    detect_captcha,
    navigate_to,
    open_browser_session,
    require_playwright,
    take_snapshot,
)
from ah32.knowledge.url_ingest import (
    DEFAULT_MAX_CHARS,
    DEFAULT_MIN_NON_WS_CHARS,
    apply_quality_gate,
    clean_extracted_text,
    decide_scope,
    non_whitespace_len,
    truncate_text,
)
from ah32.server import rag_api

logger = logging.getLogger(__name__)


def _looks_like_login_page(text: str) -> bool:
    s = (text or "").lower()
    # Heuristic: only treat as login when it's mostly about credentials.
    hits = 0
    for k in ("登录", "登陆", "sign in", "log in", "账号", "用户名", "密码", "验证码"):
        if k.lower() in s:
            hits += 1
    return hits >= 2 and len(s) < 10_000


def ingest_url_to_rag(
    *,
    url: str,
    title: Optional[str] = None,
    scope: Optional[str] = None,  # global|project
    context_document_path: Optional[str] = None,
    record_trace: bool = False,
    timeout_ms: Optional[int] = None,
    min_non_ws_chars: int = DEFAULT_MIN_NON_WS_CHARS,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> Dict[str, Any]:
    """Fetch a URL (Playwright) and ingest extracted body text into RAG.

    Returns a structured payload for LLM consumption. This tool never returns raw HTML.
    """
    start = time.time()
    raw_url = str(url or "").strip()
    if not raw_url:
        return {"ok": False, "error_type": "invalid_url", "message": "url is empty"}
    if not (
        re.match(r"^https?://", raw_url, re.IGNORECASE)
        or raw_url.lower().startswith("data:text/")
    ):
        return {
            "ok": False,
            "error_type": "invalid_url",
            "message": "url must start with http://, https://, or data:text/",
        }

    try:
        require_playwright()
    except Exception as e:
        logger.warning("[ingest_url_to_rag] playwright unavailable: %s", e, exc_info=True)
        return {
            "ok": False,
            "error_type": "browser_unavailable",
            "message": str(e),
        }

    try:
        with open_browser_session(BrowserSessionConfig(record_trace=bool(record_trace))) as session:
            nav = navigate_to(session, url=raw_url, timeout_ms=timeout_ms)
            if not nav.get("ok"):
                err = nav.get("error") or {}
                return {
                    "ok": False,
                    "error_type": "unreachable_or_timeout",
                    "message": str(err.get("message") or "navigation failed"),
                    "meta": nav.get("meta") or {},
                }

            nav_data = nav.get("data") or {}
            final_url = str(nav_data.get("final_url") or raw_url)
            page_title = str(nav_data.get("title") or "")

            cap = detect_captcha(session)
            if cap.get("ok") and (cap.get("data") or {}).get("detected"):
                return {
                    "ok": False,
                    "error_type": "captcha",
                    "message": "captcha detected",
                    "captcha_kind": (cap.get("data") or {}).get("kind") or "unknown",
                    "meta": cap.get("meta") or {},
                }

            snap = take_snapshot(session)
            if not snap.get("ok"):
                err = snap.get("error") or {}
                return {
                    "ok": False,
                    "error_type": "snapshot_failed",
                    "message": str(err.get("message") or "snapshot failed"),
                    "meta": snap.get("meta") or {},
                }

            raw_text = str((snap.get("data") or {}).get("text") or "")
            cleaned = clean_extracted_text(raw_text)
            non_ws = non_whitespace_len(cleaned)
            if not apply_quality_gate(cleaned, min_non_ws_chars=min_non_ws_chars):
                return {
                    "ok": False,
                    "error_type": "empty_content",
                    "message": f"extracted text too short (non_ws_chars={non_ws})",
                    "final_url": final_url,
                    "page_title": page_title,
                    "trace_id": session.trace_id,
                }

            if _looks_like_login_page(cleaned):
                return {
                    "ok": False,
                    "error_type": "login_required",
                    "message": "page looks like a login/verification page",
                    "final_url": final_url,
                    "page_title": page_title,
                    "trace_id": session.trace_id,
                }

            text, original_len, truncated = truncate_text(cleaned, max_chars=max_chars)

            name = (title or "").strip() or page_title.strip() or final_url

            scope_decision = decide_scope(
                requested_scope=scope,
                context_document_path=context_document_path,
            )

            vector_store = rag_api.get_vector_store()
            extra_meta: Dict[str, Any] = {
                "url": raw_url,
                "final_url": final_url,
                "page_title": page_title,
                "ingest_type": "url",
                "original_length": int(original_len),
                "truncated": bool(truncated),
                "non_ws_chars": int(non_ws),
                "crawler": "playwright",
                "crawler_trace_id": session.trace_id,
                "scope_used": scope_decision.scope_used,
                "scope_warning": scope_decision.warning or "",
            }
            if scope_decision.project_context is not None:
                extra_meta["project_id"] = scope_decision.project_context.project_id
                extra_meta["project_label"] = scope_decision.project_context.label
                extra_meta["project_root"] = scope_decision.project_context.root

            ingest_result = rag_api._upsert_text_to_vector_store(
                vector_store,
                text,
                name,
                "url",
                final_url,
                extra_meta,
            )
            src = str((ingest_result or {}).get("source") or "")

            warning: str = ""
            try:
                proj_idx = rag_api._get_project_index(vector_store)
                if src:
                    if scope_decision.scope_used == "project" and scope_decision.project_context is not None:
                        proj_idx.add_project(src, scope_decision.project_context)
                    else:
                        proj_idx.add_global(src)
                    proj_idx.save()
                warning = scope_decision.warning or ""
            except Exception as e:
                logger.warning("[ingest_url_to_rag] project membership update failed: %s", e, exc_info=True)
                warning = warning or "project_index_update_failed"

            return {
                "ok": True,
                "url": raw_url,
                "final_url": final_url,
                "page_title": page_title,
                "name": name,
                "source_id": src,
                "scope_used": scope_decision.scope_used,
                "warning": warning,
                "ingest": ingest_result or {},
                "meta": {
                    "trace_id": session.trace_id,
                    "non_ws_chars": int(non_ws),
                    "original_length": int(original_len),
                    "truncated": bool(truncated),
                    "elapsed_ms": int((time.time() - start) * 1000),
                },
            }
    except Exception as e:
        logger.warning("[ingest_url_to_rag] failed: %s", e, exc_info=True)
        return {
            "ok": False,
            "error_type": "unexpected",
            "message": str(e),
            "meta": {"elapsed_ms": int((time.time() - start) * 1000)},
        }
