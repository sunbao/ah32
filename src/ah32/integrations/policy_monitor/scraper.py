from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

from ..browser import BrowserContextConfig, BrowserSessionConfig, open_browser_session
from ..browser.errors import BrowserUnavailableError
from ..browser.api import DEFAULT_TIMEOUT_MS as BROWSER_DEFAULT_TIMEOUT_MS
from ..browser.api import detect_captcha, navigate_to
from .models import PolicyDocument, PolicyListItem
from .policy_cache import PolicyCache

logger = logging.getLogger(__name__)


_DATE_RE = re.compile(r"\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b")
_DOCNUM_RE = re.compile(r"(?:〔|\\[)?(20\\d{2})(?:〕|\\])\\s*\\D{0,6}(\\d{1,4})\\s*号")


class PolicyMonitorResult(TypedDict, total=False):
    ok: bool
    from_cache: bool
    message: str
    last_checked_at: Optional[str]
    items: List[Dict[str, Any]]
    new_items: List[Dict[str, Any]]
    updated_items: List[Dict[str, Any]]
    major_items: List[Dict[str, Any]]
    error: Dict[str, Any]
    ingest: Dict[str, Any]


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.utcnow().isoformat(timespec="microseconds") + "Z"


def _extract_date(text: str) -> Optional[str]:
    s = str(text or "")
    m = _DATE_RE.search(s)
    if not m:
        return None
    y, mm, dd = m.group(1), int(m.group(2)), int(m.group(3))
    return f"{y}-{mm:02d}-{dd:02d}"


def _extract_doc_number(text: str) -> Optional[str]:
    s = str(text or "")
    m = _DOCNUM_RE.search(s)
    if not m:
        return None
    year = m.group(1)
    num = m.group(2)
    return f"{year}_{num}"


def _is_major(title: str) -> bool:
    t = str(title or "")
    return ("修订" in t) or ("草案" in t) or ("专项整治" in t)


def _extract_keywords(title: str, *, limit: int = 10) -> List[str]:
    raw = str(title or "")
    tokens = []
    # Chinese sequences.
    tokens.extend(re.findall(r"[\u4e00-\u9fff]{2,8}", raw))
    # ASCII words/numbers.
    tokens.extend(re.findall(r"[A-Za-z0-9]{3,20}", raw))
    out: List[str] = []
    seen: set[str] = set()
    for t in tokens:
        t = t.strip()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
        if len(out) >= limit:
            break
    return out


def _make_policy_id(item: PolicyListItem) -> str:
    base = (item.document_number or "").strip() or (item.source_url or "").strip()
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def _safe_policy_filename(item: PolicyListItem) -> str:
    if item.document_number:
        slug = re.sub(r"[^0-9a-zA-Z_\\-]+", "_", str(item.document_number)).strip("_")
        slug = slug[:60] if slug else ""
        if slug:
            return f"{slug}.json"
    digest = hashlib.sha1(str(item.source_url or "").encode("utf-8")).hexdigest()[:12]
    return f"url_{digest}.json"


def _read_policy_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        return raw if isinstance(raw, dict) else None
    except Exception as e:
        logger.warning("[policy-monitor] read policy json failed: %s err=%s", path, e, exc_info=True)
        return None


def _policy_content_fingerprint(payload: Dict[str, Any]) -> str:
    """Return a stable fingerprint for change detection (ignores timestamps)."""
    obj = dict(payload or {})
    obj.pop("scraped_at", None)
    obj.pop("updated_at", None)
    try:
        blob = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except Exception:
        blob = repr(obj).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _rag_policies_dir() -> Path:
    try:
        from ah32.knowledge.rag_library import get_rag_data_dir

        root = get_rag_data_dir() / "policies"
        root.mkdir(parents=True, exist_ok=True)
        return root
    except Exception as e:
        logger.warning("[policy-monitor] resolve policies dir failed: %s", e, exc_info=True)
        from ah32.config import settings as _settings

        alt = _settings.storage_root / "rag_data" / "policies"
        alt.mkdir(parents=True, exist_ok=True)
        logger.info("[policy-monitor] fallback policies dir: %s", alt)
        return alt


def _truthy_env(name: str, *, default: bool = False) -> bool:
    s = str(os.environ.get(name, "") or "").strip().lower()
    if not s:
        return bool(default)
    return s in ("1", "true", "yes", "y", "on")


def _auto_ingest_policies(*, force: bool = False) -> Dict[str, Any]:
    """Best-effort: vectorize local policies into storage/embeddings.

    This keeps:
    - Source files under data/rag/policies (or storage fallback when runtime is read-only)
    - Vector store under storage/embeddings
    """
    try:
        from ah32.knowledge.ingest import ingest_rag_library
        from ah32.knowledge.rag_library import get_rag_data_dir

        data_dir = get_rag_data_dir()
        summary = ingest_rag_library(data_dir=data_dir, force=bool(force), only_types=["policy"])

        try:
            from ah32.config import settings as _settings

            persist_path = str(_settings.embeddings_path)
        except Exception:
            persist_path = ""

        return {
            "ok": True,
            "data_dir": str(data_dir),
            "persist_path": persist_path,
            "summary": summary.to_dict(),
        }
    except Exception as e:
        logger.warning("[policy-monitor] auto ingest failed: %s", e, exc_info=True)
        return {"ok": False, "message": "auto ingest failed", "error": {"message": str(e)}}


def _save_policy_json(
    doc: PolicyDocument,
    *,
    filename: str,
    out_dir: Path | None = None,
    keep_scraped_at: str | None = None,
) -> Path:
    out_dir = Path(out_dir) if out_dir else _rag_policies_dir()
    path = out_dir / filename

    # Preserve first-seen time for updates (scenario: 更新已有政策).
    if keep_scraped_at:
        try:
            doc.scraped_at = keep_scraped_at
        except Exception:
            logger.debug("[policy-monitor] set doc.scraped_at failed (ignored)", exc_info=True)
    try:
        doc.updated_at = PolicyDocument.now_iso()
    except Exception:
        logger.debug("[policy-monitor] set doc.updated_at failed (ignored)", exc_info=True)

    payload = doc.to_storage_dict()
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


class PolicyMonitor:
    def __init__(
        self,
        *,
        list_url: str = "https://www.ccgp.gov.cn/zcfg/mof/",
        request_interval_s: float = 0.6,
        policies_dir: Path | None = None,
        cache: PolicyCache | None = None,
    ) -> None:
        self.list_url = str(list_url or "").strip() or "https://www.ccgp.gov.cn/zcfg/mof/"
        self.request_interval_s = float(request_interval_s)
        self.policies_dir = Path(policies_dir) if policies_dir else None
        self.cache = cache or PolicyCache.default()

    def check_updates(
        self,
        *,
        force_refresh: bool = False,
        ttl_hours: int = 24,
        max_items: int = 10,
        record_trace: bool = False,
        timeout_ms: int | None = None,
        auto_ingest: bool | None = None,
    ) -> PolicyMonitorResult:
        # Ensure the intended data dir exists (data/rag/policies) when writable.
        try:
            _rag_policies_dir()
        except Exception:
            logger.warning("[policy-monitor] ensure policies dir failed (ignored)", exc_info=True)

        auto_ingest_effective = (
            bool(auto_ingest)
            if auto_ingest is not None
            else _truthy_env("AH32_POLICY_MONITOR_AUTO_INGEST", default=False)
        )

        state = self.cache.load()
        prev_checked_at = state.get("last_checked_at")
        prev_items = list(state.get("items") or [])

        if (not force_refresh) and self.cache.is_fresh(state, ttl_hours=ttl_hours):
            items = prev_items
            major = [i for i in items if isinstance(i, dict) and i.get("is_major")]
            return {
                "ok": True,
                "from_cache": True,
                "message": f"使用缓存（TTL={ttl_hours}h），上次检查: {prev_checked_at}",
                "last_checked_at": prev_checked_at,
                "items": items,
                "new_items": [],
                "updated_items": [],
                "major_items": major,
            }

        timeout = int(timeout_ms) if timeout_ms is not None else BROWSER_DEFAULT_TIMEOUT_MS
        policies_dir = Path(self.policies_dir) if self.policies_dir else _rag_policies_dir()
        items: List[PolicyListItem] = []
        errors: List[str] = []

        try:
            items = self._scrape_latest_list(max_items=max_items, record_trace=record_trace, timeout_ms=timeout)
        except BrowserUnavailableError as e:
            logger.warning("[policy-monitor] browser unavailable: %s", e, exc_info=True)
            errors.append(str(e))
        except Exception as e:
            logger.warning("[policy-monitor] scrape list failed: %s", e, exc_info=True)
            errors.append(str(e))

        known = self.cache.known_policy_ids(state)
        new_items: List[Dict[str, Any]] = []
        updated_items: List[Dict[str, Any]] = []
        out_items: List[Dict[str, Any]] = []

        for it in items:
            pid = _make_policy_id(it)
            file_name = _safe_policy_filename(it)
            meta = it.model_dump()
            meta["policy_id"] = pid
            meta["file_name"] = file_name
            out_items.append(meta)

            existing_path = policies_dir / file_name
            has_existing_file = existing_path.exists()
            is_known = (pid in known) or has_existing_file

            try:
                doc = self._fetch_policy_detail(it, record_trace=record_trace, timeout_ms=timeout)
            except Exception as e:
                logger.warning("[policy-monitor] fetch detail failed: %s", e, exc_info=True)
                errors.append(f"detail_failed:{file_name}:{e}")
                continue

            # Determine new/updated by comparing persisted JSON (ignoring timestamps).
            old_payload = _read_policy_json(existing_path) if has_existing_file else None
            old_read_failed = bool(has_existing_file and old_payload is None)
            old_fp = _policy_content_fingerprint(old_payload) if old_payload else None
            new_fp = _policy_content_fingerprint(doc.to_storage_dict())

            # New policy: not in cache and no local file.
            is_new = (not is_known) and (not has_existing_file)
            is_updated = bool(old_fp and old_fp != new_fp)

            try:
                if is_new or (not has_existing_file) or old_read_failed or is_updated:
                    keep_scraped_at = None
                    if old_payload and isinstance(old_payload.get("scraped_at"), str):
                        keep_scraped_at = str(old_payload.get("scraped_at") or "").strip() or None

                    # Temp-file -> atomic replace to avoid partial writes.
                    tmp_name = f".{file_name}.{secrets.token_hex(4)}.tmp"
                    tmp_path = policies_dir / tmp_name
                    _save_policy_json(doc, filename=tmp_name, out_dir=policies_dir, keep_scraped_at=keep_scraped_at)
                    tmp_path.replace(existing_path)
            except Exception as e:
                logger.warning("[policy-monitor] save policy json failed: %s", e, exc_info=True)
                errors.append(f"save_failed:{file_name}:{e}")
                continue

            if is_new or (not is_known):
                new_items.append(meta)
            elif is_updated or old_read_failed:
                updated_items.append(meta)

            # Gentle throttling.
            try:
                time.sleep(max(0.0, self.request_interval_s))
            except Exception:
                pass

        # Persist runtime state only when we got valid items.
        if out_items:
            state["last_checked_at"] = _now_iso()
            state["items"] = out_items
            self.cache.save(state)

        major = [i for i in out_items if isinstance(i, dict) and i.get("is_major")]

        if errors and not out_items:
            # Hard failure: return cached data (if any). Do NOT wipe cache.
            cached_items = prev_items
            result: PolicyMonitorResult = {
                "ok": False,
                "from_cache": True,
                "message": "抓取失败，已返回本地缓存（如有）。",
                "last_checked_at": prev_checked_at,
                "items": cached_items,
                "new_items": [],
                "updated_items": [],
                "major_items": [i for i in cached_items if isinstance(i, dict) and i.get("is_major")],
                "error": {"message": "; ".join(errors)},
            }
            if auto_ingest_effective:
                # Only ingest when we actually wrote new policy JSONs.
                if new_items:
                    result["ingest"] = _auto_ingest_policies()
            return result

        result: PolicyMonitorResult = {
            "ok": True,
            "from_cache": False,
            "message": f"检查完成：总计{len(out_items)}条，新{len(new_items)}条，更新{len(updated_items)}条。",
            "last_checked_at": state.get("last_checked_at"),
            "items": out_items,
            "new_items": new_items,
            "updated_items": updated_items,
            "major_items": major,
            "error": {"message": "; ".join(errors)} if errors else {},
        }
        if auto_ingest_effective:
            # Only ingest when we actually wrote new policy JSONs.
            if new_items:
                result["ingest"] = _auto_ingest_policies()
        return result

    def _scrape_latest_list(
        self,
        *,
        max_items: int,
        record_trace: bool,
        timeout_ms: int,
    ) -> List[PolicyListItem]:
        max_items = max(1, int(max_items))
        cfg = BrowserSessionConfig(context=BrowserContextConfig(), record_trace=bool(record_trace))
        out: List[PolicyListItem] = []
        seen_urls: set[str] = set()

        with open_browser_session(cfg) as session:
            nav = navigate_to(session, url=self.list_url, wait_until="domcontentloaded", timeout_ms=timeout_ms)
            if not nav.get("ok"):
                raise RuntimeError(f"navigate failed: {nav.get('error')}")

            cap = detect_captcha(session)
            if cap.get("ok") and (cap.get("data") or {}).get("detected"):
                raise RuntimeError("captcha detected on policy list page")

            anchors = session.page.query_selector_all("a")
            for a in anchors:
                try:
                    title = (a.inner_text() or "").strip()
                    if not title or len(title) < 6:
                        continue

                    href = a.get_attribute("href") or ""
                    if not href:
                        continue

                    # Absolute URL when possible.
                    try:
                        url = a.evaluate("el => el.href")  # type: ignore[attr-defined]
                    except Exception:
                        url = href
                    url = str(url or "").strip()
                    if not url or url in seen_urls:
                        continue

                    if not (url.startswith("http://") or url.startswith("https://")):
                        continue

                    # Use surrounding <li> text for date/doc number hints.
                    try:
                        li_text = a.evaluate(
                            "el => (el.closest('li') ? el.closest('li').innerText : el.innerText) || ''"
                        )  # type: ignore[attr-defined]
                    except Exception:
                        li_text = title
                    li_text = str(li_text or "")

                    issue_date = _extract_date(li_text)
                    if not issue_date:
                        continue

                    doc_num = _extract_doc_number(li_text) or _extract_doc_number(title)

                    item = PolicyListItem(
                        policy_name=title,
                        issue_date=issue_date,
                        document_number=doc_num,
                        source_url=url,
                        is_major=_is_major(title),
                    )
                    out.append(item)
                    seen_urls.add(url)
                    if len(out) >= max_items:
                        break
                except Exception:
                    logger.debug("[policy-monitor] parse anchor failed (ignored)", exc_info=True)
                    continue

        return out

    def _fetch_policy_detail(
        self,
        item: PolicyListItem,
        *,
        record_trace: bool,
        timeout_ms: int,
    ) -> PolicyDocument:
        # Best-effort: only extract body text and make key points by paragraphs.
        cfg = BrowserSessionConfig(context=BrowserContextConfig(), record_trace=bool(record_trace))
        with open_browser_session(cfg) as session:
            nav = navigate_to(session, url=item.source_url, wait_until="domcontentloaded", timeout_ms=timeout_ms)
            if not nav.get("ok"):
                logger.warning(
                    "[policy-monitor] navigate detail failed: %s",
                    nav.get("error"),
                    exc_info=True,
                )
                return PolicyDocument(
                    policy_name=item.policy_name,
                    issue_date=item.issue_date,
                    document_number=item.document_number,
                    source_url=item.source_url,
                    keywords=_extract_keywords(item.policy_name),
                    key_points=[],
                    category="政策",
                    is_major=bool(item.is_major),
                    scraped_at=PolicyDocument.now_iso(),
                    updated_at=PolicyDocument.now_iso(),
                )

            cap = detect_captcha(session)
            if cap.get("ok") and (cap.get("data") or {}).get("detected"):
                logger.warning("[policy-monitor] captcha detected on detail page: %s", item.source_url)

            body = ""
            try:
                body = session.page.inner_text("body") or ""
            except Exception:
                body = ""

            paragraphs = [p.strip() for p in re.split(r"\\r?\\n+", body) if p.strip()]
            key_points = [p for p in paragraphs if len(p) >= 20][:12]
            if not key_points and paragraphs:
                key_points = paragraphs[:8]

            return PolicyDocument(
                policy_name=item.policy_name,
                issued_by=None,
                issue_date=item.issue_date,
                document_number=item.document_number,
                source_url=item.source_url,
                key_points=key_points,
                category="政策",
                keywords=_extract_keywords(item.policy_name),
                is_major=bool(item.is_major),
                scraped_at=PolicyDocument.now_iso(),
                updated_at=PolicyDocument.now_iso(),
            )
