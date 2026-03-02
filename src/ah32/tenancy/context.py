from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator, Optional


_tenant_id_var: ContextVar[Optional[str]] = ContextVar("ah32_tenant_id", default=None)
_user_id_var: ContextVar[Optional[str]] = ContextVar("ah32_user_id", default=None)
_trace_id_var: ContextVar[Optional[str]] = ContextVar("ah32_trace_id", default=None)


@dataclass(frozen=True)
class RequestTenancy:
    tenant_id: str
    user_id: str
    trace_id: str
    auth_kind: str = ""


def get_tenant_id() -> Optional[str]:
    return _tenant_id_var.get()


def get_user_id() -> Optional[str]:
    return _user_id_var.get()


def get_trace_id() -> Optional[str]:
    return _trace_id_var.get()


def set_trace_id(trace_id: str | None) -> None:
    _trace_id_var.set((trace_id or "").strip() or None)


def set_tenant_user(*, tenant_id: str | None, user_id: str | None) -> None:
    _tenant_id_var.set((tenant_id or "").strip() or None)
    _user_id_var.set((user_id or "").strip() or None)


@contextmanager
def tenancy_context(*, tenant_id: str, user_id: str, trace_id: str, auth_kind: str = "") -> Iterator[RequestTenancy]:
    t0 = _tenant_id_var.set((tenant_id or "").strip() or None)
    u0 = _user_id_var.set((user_id or "").strip() or None)
    r0 = _trace_id_var.set((trace_id or "").strip() or None)
    try:
        yield RequestTenancy(
            tenant_id=str(tenant_id or "").strip(),
            user_id=str(user_id or "").strip(),
            trace_id=str(trace_id or "").strip(),
            auth_kind=str(auth_kind or "").strip(),
        )
    finally:
        _tenant_id_var.reset(t0)
        _user_id_var.reset(u0)
        _trace_id_var.reset(r0)

