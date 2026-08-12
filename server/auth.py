"""
Single-user session gate.

Referer checking alone does not gate anything — the header is set by the client
and `curl -H 'Referer: ...'` walks straight past it. Once this app is reachable
from outside your LAN (which is the point of watching on the go), the token
endpoint is an open signing oracle without a real credential check. This module
is that check: a PBKDF2 passphrase hash plus a signed, expiring cookie.

Generate a hash:

    python -m server.auth hash "correct horse battery staple"

Paste the output into APP_PASSWORD_HASH, and put 32+ random bytes in
SESSION_SECRET (`python -m server.auth secret` prints one).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sys

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

PBKDF2_ROUNDS = 240_000
SALT_BYTES = 16
COOKIE_NAME = "medlib_session"


def hash_password(password: str, *, rounds: int = PBKDF2_ROUNDS) -> str:
    """-> 'pbkdf2_sha256$<rounds>$<b64 salt>$<b64 digest>'"""
    salt = os.urandom(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return "$".join([
        "pbkdf2_sha256",
        str(rounds),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    ])


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, rounds_s, salt_b64, digest_b64 = encoded.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
    except (ValueError, TypeError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(rounds_s))
    return hmac.compare_digest(dk, expected)


class SessionCodec:
    """Signed, timestamped cookie payloads."""

    def __init__(self, secret: str, ttl_seconds: int):
        if not secret:
            raise ValueError("SESSION_SECRET is not set")
        self._s = URLSafeTimedSerializer(secret, salt="medlib-session")
        self.ttl = ttl_seconds

    def issue(self, subject: str = "owner") -> str:
        return self._s.dumps({"sub": subject, "jti": secrets.token_hex(8)})

    def read(self, raw: str | None) -> dict | None:
        if not raw:
            return None
        try:
            return self._s.loads(raw, max_age=self.ttl)
        except (SignatureExpired, BadSignature):
            return None


def _cli(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "hash":
        print(hash_password(" ".join(argv[1:])))
        return 0
    if argv and argv[0] == "secret":
        print(secrets.token_urlsafe(48))
        return 0
    print(__doc__.strip(), file=sys.stderr)
    print('\nusage: python -m server.auth hash "<passphrase>" | secret', file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
