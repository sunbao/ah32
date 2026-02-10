from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "failure_bundle.v1"
MAX_BUNDLE_BYTES = 1_200_000
MAX_DICT_ITEMS = 200
MAX_LIST_ITEMS = 200
MAX_STRING_CHARS = 20_000
MAX_CONTEXT_CHARS = 50_000
MAX_CODE_CHARS = 120_000
MAX_EXTRA_CHARS = 80_000

SENSITIVE_KEY_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
    "cookie",
    "set-cookie",
    "access_key",
    "private_key",
)

CONTEXT_COMPARE_FIELDS = (
    ("user_query", ("context", "chat", "message"), "last_user_query"),
    ("rag_summary", ("context", "rag", "summary"), "last_rag_summary"),
    ("skills", ("context", "skills", "skills"), "last_skills"),
    ("rule_files", ("context", "chat", "rule_files"), "rule_files"),
)


def _safe_slug(s: str, *, max_len: int = 80) -> str:
    t = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in (s or "").strip())
    t = t.strip("._")
    if not t:
        return ""
    if len(t) > max_len:
        return t[:max_len]
    return t


def _sha1_short(s: str) -> str:
    try:
        return hashlib.sha1((s or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
    except Exception:
        return ""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_sensitive_key(key: str) -> bool:
    k = (key or "").strip().lower()
    if not k:
        return False
    if any(marker in k for marker in SENSITIVE_KEY_MARKERS):
        return True
    if ("openai" in k or "deepseek" in k) and "key" in k:
        return True
    return False


def _limit_string(value: str, *, max_len: int) -> str:
    if not value:
        return ""
    if len(value) <= max_len:
        return value
    return f"{value[:max_len]}... [truncated {len(value) - max_len} chars]"


def _field_max_len(key: str) -> int:
    k = (key or "").strip().lower()
    if not k:
        return MAX_STRING_CHARS
    if any(x in k for x in ("code", "macro", "final_code", "finalcode", "script")):
        return MAX_CODE_CHARS
    if any(x in k for x in ("context", "prompt", "history", "memory", "rag", "rules", "skills")):
        return MAX_CONTEXT_CHARS
    if k == "extra":
        return MAX_EXTRA_CHARS
    return MAX_STRING_CHARS


def _sanitize_payload(
    obj: Any,
    *,
    path: str = "",
    stats: Optional[Dict[str, List[str]]] = None,
) -> Any:
    if stats is None:
        stats = {"redacted": [], "truncated": [], "dropped": []}

    try:
        if isinstance(obj, dict):
            out: Dict[str, Any] = {}
            for idx, (k, v) in enumerate(obj.items()):
                if idx >= MAX_DICT_ITEMS:
                    stats["dropped"].append(f"{path}.*")
                    break
                key = str(k)
                key_path = f"{path}.{key}" if path else key
                if _is_sensitive_key(key):
                    out[key] = "***redacted***"
                    stats["redacted"].append(key_path)
                    continue
                out[key] = _sanitize_payload(v, path=key_path, stats=stats)
            return out
        if isinstance(obj, (list, tuple)):
            out_list: List[Any] = []
            for idx, item in enumerate(obj):
                if idx >= MAX_LIST_ITEMS:
                    stats["dropped"].append(f"{path}[]")
                    break
                item_path = f"{path}[{idx}]"
                out_list.append(_sanitize_payload(item, path=item_path, stats=stats))
            return out_list
        if isinstance(obj, (bytes, bytearray)):
            stats["dropped"].append(path or "<bytes>")
            return f"<binary {len(obj)} bytes>"
        if isinstance(obj, str):
            max_len = _field_max_len(path.split(".")[-1] if path else "")
            trimmed = _limit_string(obj, max_len=max_len)
            if trimmed != obj:
                stats["truncated"].append(path or "<string>")
            return trimmed
        if isinstance(obj, (int, float, bool)) or obj is None:
            return obj
        return _limit_string(str(obj), max_len=MAX_STRING_CHARS)
    except Exception:
        stats["dropped"].append(path or "<unknown>")
        return "<unserializable>"


def _extract_frontend_hint(payload: Dict[str, Any]) -> str:
    try:
        extra = payload.get("extra") if isinstance(payload, dict) else None
        if isinstance(extra, dict):
            hint = extra.get("frontend_hint")
            if isinstance(hint, str) and hint.strip():
                return hint.strip()
        msg = str(payload.get("error_message") or "")
        marker = "[frontend_hint]"
        if marker in msg:
            return msg.split(marker, 1)[-1].strip()
        return ""
    except Exception:
        return ""


def _build_run_context(payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx: Dict[str, Any] = {}
    try:
        rc = payload.get("run_context")
        if isinstance(rc, dict):
            ctx.update(rc)
    except Exception:
        ctx = {}

    def _get(name: str, fallback: str = "") -> str:
        return str(payload.get(name) or ctx.get(name) or fallback or "")

    ctx.setdefault("run_id", _get("run_id"))
    ctx.setdefault("mode", _get("mode", "macro"))
    ctx.setdefault("host_app", _get("host_app"))
    ctx.setdefault("doc_id", _get("doc_id"))
    ctx.setdefault("doc_key", _get("doc_key"))
    ctx.setdefault("session_id", _get("session_id"))
    ctx.setdefault("block_id", _get("block_id"))
    ctx.setdefault("client_id", _get("client_id"))
    return ctx


def _build_summary(payload: Dict[str, Any], run_ctx: Dict[str, Any]) -> Dict[str, Any]:
    try:
        error_type = str(payload.get("error_type") or "")
        error_message = str(payload.get("error_message") or "")
        severity = str(payload.get("severity") or "")
        error_code = str(payload.get("error_code") or payload.get("code") or "")
        return {
            "error_type": error_type,
            "severity": severity or "unknown",
            "error_message": _limit_string(error_message, max_len=2000),
            "error_code_preview": _limit_string(error_code, max_len=600),
            "frontend_hint": _extract_frontend_hint(payload),
            "run_id": str(run_ctx.get("run_id") or ""),
            "session_id": str(run_ctx.get("session_id") or ""),
            "doc_id": str(run_ctx.get("doc_id") or ""),
            "doc_key": str(run_ctx.get("doc_key") or ""),
            "block_id": str(run_ctx.get("block_id") or ""),
            "host_app": str(run_ctx.get("host_app") or ""),
        }
    except Exception:
        return {}


def _get_nested_value(data: Any, path: tuple[str, ...]) -> Any:
    cur = data
    for key in path:
        if not isinstance(cur, dict):
            return None
        if key not in cur:
            return None
        cur = cur.get(key)
    return cur


def _values_equal(a: Any, b: Any) -> bool:
    try:
        return a == b
    except Exception:
        return False


def _summarize_value(value: Any, *, max_preview: int = 200) -> Dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, str):
        return {
            "type": "str",
            "len": len(value),
            "sha1": _sha1_short(value),
            "preview": _limit_string(value, max_len=max_preview),
        }
    if isinstance(value, list):
        preview = [_limit_string(str(item), max_len=80) for item in value[:6]]
        return {"type": "list", "len": len(value), "preview": preview}
    if isinstance(value, dict):
        keys = [str(k) for k in list(value.keys())[:12]]
        return {"type": "dict", "len": len(value), "keys": keys}
    return {"type": type(value).__name__, "value": _limit_string(str(value), max_len=max_preview)}


def _build_context_diff(payload: Dict[str, Any]) -> Dict[str, Any]:
    extra = payload.get("extra") if isinstance(payload, dict) else None
    if not isinstance(extra, dict):
        return {}
    server = extra.get("server_context")
    client = extra.get("client_context")
    has_server = isinstance(server, dict)
    has_client = isinstance(client, dict)
    if not has_server and not has_client:
        return {}

    server_ctx = {}
    if isinstance(server, dict):
        server_ctx = server.get("context")
    if not isinstance(server_ctx, dict):
        server_ctx = {}

    client_ctx = client if isinstance(client, dict) else {}

    diff: Dict[str, Any] = {
        "has_server_context": has_server,
        "has_client_context": has_client,
        "server_context_keys": sorted(server_ctx.keys())[:20],
        "client_context_keys": sorted(client_ctx.keys())[:20],
        "comparisons": [],
        "mismatch_count": 0,
    }

    if not has_server or not has_client:
        return diff

    for label, server_path, client_key in CONTEXT_COMPARE_FIELDS:
        server_val = _get_nested_value(server, server_path)
        client_val = client_ctx.get(client_key)
        if server_val is None and client_val is None:
            continue
        match = _values_equal(server_val, client_val)
        if not match:
            diff["mismatch_count"] = int(diff.get("mismatch_count", 0)) + 1
        diff["comparisons"].append(
            {
                "label": label,
                "server_path": ".".join(server_path),
                "client_key": client_key,
                "match": match,
                "server": _summarize_value(server_val),
                "client": _summarize_value(client_val),
            }
        )
    return diff


def _safe_json_dumps(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return json.dumps({"error": "bundle_serialize_failed"}, ensure_ascii=False)


def _append_index_line(index_path: Path, record: Dict[str, Any]) -> None:
    try:
        line = json.dumps(record, ensure_ascii=False, default=str)
        with index_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        logger.error("[failures] index append failed: %s", e, exc_info=True)


def save_failure_bundle(
    *,
    kind: str,
    payload: Dict[str, Any],
    storage_root: Path,
    subdir: str = "failures",
) -> Optional[Path]:
    """Persist a minimal "repro bundle" for a failed run.

    This writes to `storage_root/<subdir>/YYYY-MM-DD/<file>.json`.
    The caller is responsible for ensuring storage_root is ignored by VCS.
    """
    try:
        root = Path(storage_root)
        now = _utc_now()
        day = now.strftime("%Y-%m-%d")
        ts = now.strftime("%Y%m%d-%H%M%S")

        kind_s = _safe_slug(str(kind or "failure"), max_len=40) or "failure"
        run_ctx = _build_run_context(payload)

        run_id = _safe_slug(str(run_ctx.get("run_id") or ""), max_len=64)
        host_app = _safe_slug(str(run_ctx.get("host_app") or ""), max_len=16)
        session_id = _safe_slug(str(run_ctx.get("session_id") or ""), max_len=64)
        block_id = _safe_slug(str(run_ctx.get("block_id") or ""), max_len=64)

        code = str(payload.get("error_code") or payload.get("code") or payload.get("final_code") or "")
        code_hash = _sha1_short(code)

        parts = [ts, kind_s]
        if host_app:
            parts.append(host_app)
        if run_id:
            parts.append(run_id)
        if session_id and not run_id:
            parts.append(session_id)
        if block_id:
            parts.append(block_id)
        if code_hash:
            parts.append(code_hash)
        filename = "_".join([p for p in parts if p]) + ".json"

        out_dir = root / subdir / day
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / filename
        if out_path.exists():
            out_path = out_dir / f"{out_path.stem}_{_sha1_short(filename + ts)}.json"

        stats: Dict[str, List[str]] = {"redacted": [], "truncated": [], "dropped": []}
        sanitized = _sanitize_payload(payload, stats=stats)
        summary = _build_summary(payload, run_ctx)
        context_diff = _build_context_diff(sanitized)
        bundle = {
            "schema_version": SCHEMA_VERSION,
            "saved_at": now.isoformat(),
            "kind": kind_s,
            "meta": {
                "run_id": run_ctx.get("run_id", ""),
                "host_app": run_ctx.get("host_app", ""),
                "session_id": run_ctx.get("session_id", ""),
                "doc_id": run_ctx.get("doc_id", ""),
                "doc_key": run_ctx.get("doc_key", ""),
                "block_id": run_ctx.get("block_id", ""),
                "client_id": run_ctx.get("client_id", ""),
                "document_name": str(payload.get("document_name") or ""),
                "document_path": str(payload.get("document_path") or ""),
                "code_hash": code_hash,
                "stats": stats,
            },
            "summary": summary,
            "run_context": run_ctx,
            "payload": sanitized,
        }
        if context_diff:
            bundle["context_diff"] = context_diff

        data = _safe_json_dumps(bundle)
        if len(data.encode("utf-8")) > MAX_BUNDLE_BYTES:
            bundle["payload"] = {"note": "payload_dropped_due_to_size"}
            bundle["meta"]["stats"]["dropped"].append("payload")
            data = _safe_json_dumps(bundle)

        out_path.write_text(data, encoding="utf-8")
        logger.info("[failures] saved %s", out_path)

        index_record = {
            "saved_at": now.isoformat(),
            "kind": kind_s,
            "path": str(out_path),
            "run_id": run_ctx.get("run_id", ""),
            "session_id": run_ctx.get("session_id", ""),
            "doc_key": run_ctx.get("doc_key", ""),
            "block_id": run_ctx.get("block_id", ""),
            "host_app": run_ctx.get("host_app", ""),
            "error_type": summary.get("error_type", ""),
            "severity": summary.get("severity", ""),
            "code_hash": code_hash,
        }
        _append_index_line(out_dir / "index.jsonl", index_record)
        return out_path
    except Exception as e:
        logger.error("[failures] save failed: %s", e, exc_info=True)
        return None
