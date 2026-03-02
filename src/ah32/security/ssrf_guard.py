from __future__ import annotations

import fnmatch
import ipaddress
import json
import logging
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

from ah32.config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SsrfDecision:
    ok: bool
    url: str
    tenant_id: str
    trace_id: str
    tool: str
    decision: str  # allow|deny
    reason: str
    resolved_ips: List[str]
    elapsed_ms: int


def _tenant_root(tenant_id: str) -> Path:
    return Path(settings.storage_root) / "tenants" / str(tenant_id)


def _blacklist_path(tenant_id: str) -> Path:
    return _tenant_root(tenant_id) / "policy" / "ssrf_blacklist.json"


def _audit_path(tenant_id: str) -> Path:
    return _tenant_root(tenant_id) / "audit" / "ssrf.jsonl"


def _load_blacklist(tenant_id: str) -> Dict[str, Any]:
    p = _blacklist_path(tenant_id)
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception as e:
        logger.error("[ssrf] blacklist load failed tenant_id=%s path=%s err=%s", tenant_id, p, e, exc_info=True)
        return {}


def _iter_str_list(obj: Any) -> List[str]:
    if not isinstance(obj, list):
        return []
    out: List[str] = []
    for x in obj:
        s = str(x or "").strip()
        if s:
            out.append(s)
    return out


def _match_host(host: str, patterns: Iterable[str]) -> bool:
    h = str(host or "").strip().lower()
    if not h:
        return False
    for pat in patterns:
        p = str(pat or "").strip().lower()
        if not p:
            continue
        # Support both exact and wildcard patterns.
        if "*" in p or "?" in p:
            if fnmatch.fnmatch(h, p):
                return True
        else:
            if h == p:
                return True
    return False


def _parse_blocked_networks(items: Iterable[str]) -> List[ipaddress._BaseNetwork]:
    nets: List[ipaddress._BaseNetwork] = []
    for s in items:
        v = str(s or "").strip()
        if not v:
            continue
        try:
            if "/" not in v:
                ip = ipaddress.ip_address(v)
                v = f"{ip}/{ip.max_prefixlen}"
            nets.append(ipaddress.ip_network(v, strict=False))
        except Exception:
            continue
    return nets


def _resolve_ips(host: str) -> List[str]:
    h = str(host or "").strip()
    if not h:
        return []
    ips: List[str] = []
    try:
        infos = socket.getaddrinfo(h, None)
        for info in infos:
            try:
                addr = info[4][0]
                if addr and addr not in ips:
                    ips.append(addr)
            except Exception:
                continue
    except Exception:
        return []
    return ips


def _audit(tenant_id: str, payload: Dict[str, Any]) -> None:
    p = _audit_path(tenant_id)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(payload, ensure_ascii=False, default=str)
        with p.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        logger.error("[ssrf] audit write failed tenant_id=%s path=%s err=%s", tenant_id, p, e, exc_info=True)


def check_url(*, url: str, tenant_id: str, trace_id: str, tool: str) -> SsrfDecision:
    t0 = time.perf_counter()
    u = str(url or "").strip()
    tid = str(tenant_id or "").strip() or str(getattr(settings, "default_tenant_id", "public") or "public").strip()
    tr = str(trace_id or "").strip()
    tool_name = str(tool or "").strip() or "unknown"

    resolved_ips: List[str] = []
    decision = "deny"
    reason = ""

    try:
        if not u:
            reason = "missing_url"
            return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision=decision, reason=reason, resolved_ips=resolved_ips)

        parsed = urlparse(u)
        scheme = (parsed.scheme or "").lower()
        if scheme not in ("http", "https"):
            reason = "scheme_not_allowed"
            return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision=decision, reason=reason, resolved_ips=resolved_ips)

        # userinfo is forbidden (even in allow-by-default mode) to avoid credential exfil.
        if parsed.username or parsed.password:
            reason = "userinfo_not_allowed"
            return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision=decision, reason=reason, resolved_ips=resolved_ips)

        host = str(parsed.hostname or "").strip()
        if not host:
            reason = "missing_host"
            return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision=decision, reason=reason, resolved_ips=resolved_ips)

        bl = _load_blacklist(tid)
        blocked_hosts = _iter_str_list(bl.get("blocked_hosts") or bl.get("blockedHosts"))
        blocked_ips = _iter_str_list(bl.get("blocked_ips") or bl.get("blockedIps"))
        blocked_url_prefixes = _iter_str_list(bl.get("blocked_url_prefixes") or bl.get("blockedUrlPrefixes"))

        # URL prefix blacklist (cheap).
        for prefix in blocked_url_prefixes:
            if u.startswith(prefix):
                reason = "blacklist_url_prefix"
                return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision="deny", reason=reason, resolved_ips=resolved_ips)

        # Host blacklist.
        if _match_host(host, blocked_hosts):
            reason = "blacklist_host"
            return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision="deny", reason=reason, resolved_ips=resolved_ips)

        # Resolve IPs for ip/cidr blacklist.
        resolved_ips = _resolve_ips(host)
        nets = _parse_blocked_networks(blocked_ips)
        for ip_s in resolved_ips:
            try:
                ip = ipaddress.ip_address(ip_s)
            except Exception:
                continue
            for net in nets:
                try:
                    if ip in net:
                        reason = "blacklist_ip"
                        return _finalize(t0, ok=False, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision="deny", reason=reason, resolved_ips=resolved_ips)
                except Exception:
                    continue

        decision = "allow"
        reason = "ok"
        return _finalize(t0, ok=True, url=u, tenant_id=tid, trace_id=tr, tool=tool_name, decision=decision, reason=reason, resolved_ips=resolved_ips)
    finally:
        pass


def _finalize(
    t0: float,
    *,
    ok: bool,
    url: str,
    tenant_id: str,
    trace_id: str,
    tool: str,
    decision: str,
    reason: str,
    resolved_ips: List[str],
) -> SsrfDecision:
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    payload = {
        "ts": time.time(),
        "tenant_id": tenant_id,
        "trace_id": trace_id,
        "tool": tool,
        "url": url,
        "decision": decision,
        "reason": reason,
        "elapsed_ms": elapsed_ms,
        "resolved_ips": resolved_ips,
    }
    _audit(tenant_id, payload)
    return SsrfDecision(
        ok=bool(ok),
        url=str(url or ""),
        tenant_id=str(tenant_id or ""),
        trace_id=str(trace_id or ""),
        tool=str(tool or ""),
        decision=str(decision or ""),
        reason=str(reason or ""),
        resolved_ips=list(resolved_ips or []),
        elapsed_ms=elapsed_ms,
    )

