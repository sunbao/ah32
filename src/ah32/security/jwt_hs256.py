from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional


class JwtError(Exception):
    pass


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    s = str(data or "").strip()
    if not s:
        return b""
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def encode_hs256(*, payload: Dict[str, Any], secret: str, header: Optional[Dict[str, Any]] = None) -> str:
    hdr = {"alg": "HS256", "typ": "JWT"}
    if isinstance(header, dict):
        hdr.update({k: v for k, v in header.items() if k})

    secret_b = str(secret or "").encode("utf-8")
    if not secret_b:
        raise JwtError("missing jwt secret")

    h = _b64url_encode(json.dumps(hdr, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    p = _b64url_encode(json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{h}.{p}".encode("ascii")
    sig = hmac.new(secret_b, signing_input, hashlib.sha256).digest()
    s = _b64url_encode(sig)
    return f"{h}.{p}.{s}"


def decode_hs256(
    *,
    token: str,
    secret: str,
    leeway_sec: int = 30,
    require_exp: bool = True,
    now: Optional[int] = None,
) -> Dict[str, Any]:
    t = str(token or "").strip()
    if not t:
        raise JwtError("missing token")

    parts = t.split(".")
    if len(parts) != 3:
        raise JwtError("invalid token format")

    secret_b = str(secret or "").encode("utf-8")
    if not secret_b:
        raise JwtError("missing jwt secret")

    header_b = _b64url_decode(parts[0])
    payload_b = _b64url_decode(parts[1])
    sig_b = _b64url_decode(parts[2])

    try:
        header = json.loads(header_b.decode("utf-8"))
    except Exception as e:
        raise JwtError(f"invalid header json: {e}") from e
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise JwtError("unsupported jwt alg")

    signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
    expected = hmac.new(secret_b, signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, sig_b):
        raise JwtError("invalid signature")

    try:
        payload = json.loads(payload_b.decode("utf-8"))
    except Exception as e:
        raise JwtError(f"invalid payload json: {e}") from e
    if not isinstance(payload, dict):
        raise JwtError("invalid payload type")

    now_i = int(time.time()) if now is None else int(now)

    def _as_int(v: Any) -> Optional[int]:
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    exp = _as_int(payload.get("exp"))
    nbf = _as_int(payload.get("nbf"))
    iat = _as_int(payload.get("iat"))

    if require_exp and exp is None:
        raise JwtError("missing exp")
    if exp is not None and now_i > exp + int(leeway_sec):
        raise JwtError("token expired")
    if nbf is not None and now_i < nbf - int(leeway_sec):
        raise JwtError("token not yet valid")
    if iat is not None and iat > now_i + int(leeway_sec):
        raise JwtError("token iat in future")

    return payload

