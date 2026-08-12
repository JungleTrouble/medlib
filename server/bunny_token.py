"""
Bunny CDN URL token signer.

Two schemes live here:

`sign_bunny_url()` implements Bunny's own Token Authentication, which is what
the edge actually validates. Despite the "HMAC" shorthand it is a keyed SHA-256
digest over a concatenation, not RFC 2104 HMAC:

    token = b64url( SHA256( key || signed_path || expires || [ip] || params ) )

`sign_hmac_url()` is true HMAC-SHA256 over a canonical string, for a non-Bunny
origin (nginx `secure_link`, a Worker, your own range server) where you control
both sides. Do not point it at Bunny — the edge will reject it.

Referrer gating is two-layered, because either layer alone is weak:
  * The pull zone's own allowed-referrer list, configured in the Bunny
    dashboard under Security. The edge refuses a request whose Referer does
    not match, so a signed URL is useless pasted into someone else's page.
    This is not part of the token — see the note in sign_bunny_url.
  * `server/main.py` checks Referer/Origin before minting at all.
Neither is a substitute for authenticating the caller — a Referer header is
client-controlled and trivially forged with curl. Keep the session gate on.

TTL is clamped to HARD_MAX_TTL (12h) no matter what a caller asks for.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

HARD_MAX_TTL = 12 * 60 * 60  # 43200s — policy ceiling, never exceeded
MIN_TTL = 60


class TokenError(ValueError):
    """Raised for a signing request that violates policy."""


@dataclass(frozen=True)
class SignedURL:
    url: str
    expires: int          # unix seconds
    ttl: int              # seconds actually granted after clamping
    token: str
    scope: str            # the path the token covers (a file, or a directory prefix)

    def as_dict(self) -> dict:
        return {
            "url": self.url,
            "expires": self.expires,
            "ttl": self.ttl,
            "scope": self.scope,
        }


def clamp_ttl(requested: int, configured_max: int = HARD_MAX_TTL) -> int:
    """Never return more than 12h, never less than a minute."""
    ceiling = min(int(configured_max), HARD_MAX_TTL)
    if ceiling < MIN_TTL:
        raise TokenError(f"configured TTL ceiling {ceiling}s is below the {MIN_TTL}s minimum")
    return max(MIN_TTL, min(int(requested), ceiling))


def _b64url(digest: bytes) -> str:
    return (
        base64.b64encode(digest)
        .decode("ascii")
        .replace("\n", "")
        .replace("+", "-")
        .replace("/", "_")
        .replace("=", "")
    )


# --------------------------------------------------------------------------
#  Bunny Token Authentication
# --------------------------------------------------------------------------


def sign_bunny_url(
    url: str,
    security_key: str,
    *,
    ttl: int = 3600,
    max_ttl: int = HARD_MAX_TTL,
    user_ip: str | None = None,
    path_allowed: str | None = None,
    countries_allowed: list[str] | None = None,
    countries_blocked: list[str] | None = None,
    is_directory: bool = False,
    now: int | None = None,
) -> SignedURL:
    """
    Sign `url` for the Bunny edge.

    path_allowed
        Widen the token from the single file to a path prefix, e.g.
        "/e34b1431-.../". Required for HLS: the player fetches playlist.m3u8 and
        then dozens of .ts segments, and a file-scoped token covers only the
        first of them. Sent as the `token_path` query parameter.
    is_directory
        Emit Bunny's path-style token (`/bcdn_token=.../path`) instead of query
        parameters — for players that drop the query string on segment requests.
    """
    if not security_key:
        raise TokenError("no Bunny token authentication key configured")

    granted = clamp_ttl(ttl, max_ttl)
    expires = int(now if now is not None else time.time()) + granted

    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        raise TokenError(f"absolute URL required, got {url!r}")

    # Caller-supplied token/expires are never trusted; we mint our own.
    params: dict[str, str] = {
        k: v for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k not in ("token", "expires", "token_path")
    }
    # NOTE: there is no `token_referer`. Bunny's token parameters are
    # token_path, token_countries, token_countries_blocked, token_ignore_params
    # and limit — nothing else. An earlier version folded a token_referer field
    # into the signature; the edge does not recognise it and rejected every
    # signed URL with a 403. Referrer restriction belongs on the pull zone
    # (Security -> allowed referrers), where it is already configured and
    # enforced. Verified against the live CDN: without this field a signed URL
    # returns 200, with it 403.
    if countries_allowed:
        params["token_countries"] = ",".join(countries_allowed)
    if countries_blocked:
        params["token_countries_blocked"] = ",".join(countries_blocked)

    if path_allowed:
        signature_path = path_allowed
        # Query-style tokens declare their scope with a token_path parameter.
        # Path-style ones must not: the scope is already implied by what was
        # signed, and sending the parameter as well makes the edge 403. Both
        # forms verified against the live CDN — see test_pipeline.py.
        if not is_directory:
            params["token_path"] = path_allowed
    else:
        signature_path = unquote(parts.path)

    # Bunny hashes the parameters raw (not percent-encoded), sorted by key,
    # joined with "&" — while the URL carries the encoded form.
    parameter_data = "&".join(f"{k}={params[k]}" for k in sorted(params))

    hashable = f"{security_key}{signature_path}{expires}{user_ip or ''}{parameter_data}"
    token = _b64url(hashlib.sha256(hashable.encode("utf-8")).digest())

    encoded = urlencode({k: params[k] for k in sorted(params)}, quote_via=quote, safe=",/")

    if is_directory:
        prefix = f"bcdn_token={token}&expires={expires}"
        if encoded:
            prefix += f"&{encoded}"
        signed = urlunsplit((parts.scheme, parts.netloc, f"/{prefix}{parts.path}", "", ""))
    else:
        query = f"token={token}&expires={expires}"
        if encoded:
            query += f"&{encoded}"
        signed = urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))

    return SignedURL(url=signed, expires=expires, ttl=granted, token=token, scope=signature_path)


def verify_bunny_token(
    signed_url: str,
    security_key: str,
    *,
    user_ip: str | None = None,
    now: int | None = None,
) -> bool:
    """
    Re-derive the token for a signed URL and compare in constant time.

    Purpose-built for tests and for a self-hosted origin that wants to reject
    forged links itself; the Bunny edge does this for you in production.
    """
    parts = urlsplit(signed_url)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    token = params.pop("token", "")
    expires_raw = params.pop("expires", "")
    if not token or not expires_raw.isdigit():
        return False

    expires = int(expires_raw)
    if expires < int(now if now is not None else time.time()):
        return False

    signature_path = params.get("token_path") or unquote(parts.path)
    parameter_data = "&".join(f"{k}={params[k]}" for k in sorted(params))
    hashable = f"{security_key}{signature_path}{expires}{user_ip or ''}{parameter_data}"
    expected = _b64url(hashlib.sha256(hashable.encode("utf-8")).digest())
    return hmac.compare_digest(expected, token)


def directory_scope_for(path: str) -> str | None:
    """
    Widen an object path to the directory prefix a token should cover.

        "e34b1431-.../playlist.m3u8"  ->  "/e34b1431-.../"
        "cardio/014/index.m3u8"       ->  "/cardio/014/"
        "lecture.mp4"                 ->  None

    Keeps HLS segment requests inside the same token instead of needing one
    signature per .ts file. Returns None for an object sitting at the zone root:
    its "directory" is `/`, and a token scoped to `/` would authorise the entire
    pull zone. Callers fall back to a file-scoped token in that case.
    """
    clean = "/" + unquote(path).lstrip("/")
    head, sep, _tail = clean.rpartition("/")
    if not sep or not head:
        return None
    return head + "/"


# --------------------------------------------------------------------------
#  Generic HMAC-SHA256 (non-Bunny origins)
# --------------------------------------------------------------------------


def sign_hmac_url(
    url: str,
    secret: str,
    *,
    ttl: int = 3600,
    max_ttl: int = HARD_MAX_TTL,
    user_ip: str | None = None,
    referer: str | None = None,
    now: int | None = None,
) -> SignedURL:
    """
    True HMAC-SHA256 over a newline-delimited canonical string:

        v1\\n<path>\\n<expires>\\n<ip>\\n<referer>

    Newline framing keeps the fields unambiguous — plain concatenation lets a
    path ending in digits blur into the timestamp.
    """
    if not secret:
        raise TokenError("no signing secret configured")

    granted = clamp_ttl(ttl, max_ttl)
    expires = int(now if now is not None else time.time()) + granted

    parts = urlsplit(url)
    canonical = "\n".join(["v1", unquote(parts.path), str(expires), user_ip or "", referer or ""])
    mac = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).digest()
    token = _b64url(mac)

    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params.update({"token": token, "expires": str(expires)})
    signed = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), parts.fragment))
    return SignedURL(url=signed, expires=expires, ttl=granted, token=token, scope=parts.path)


def verify_hmac_url(
    signed_url: str,
    secret: str,
    *,
    user_ip: str | None = None,
    referer: str | None = None,
    now: int | None = None,
) -> bool:
    parts = urlsplit(signed_url)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    token = params.get("token", "")
    expires_raw = params.get("expires", "")
    if not token or not expires_raw.isdigit():
        return False
    expires = int(expires_raw)
    if expires < int(now if now is not None else time.time()):
        return False
    canonical = "\n".join(["v1", unquote(parts.path), str(expires), user_ip or "", referer or ""])
    mac = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).digest()
    return hmac.compare_digest(_b64url(mac), token)
