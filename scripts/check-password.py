"""
Check a passphrase against the hash in .env, without changing anything.

    python scripts/check-password.py

Answers one question: does the phrase you are typing match the hash stored
locally? Nothing is echoed and nothing is written.

Use it to split a failed sign-in into two very different problems:

    matches here, fails on the host  -> the host has a stale or truncated
                                        APP_PASSWORD_HASH, or has not
                                        restarted since it changed
    fails here too                   -> the phrase itself is wrong; reset
                                        with scripts/set-password.py
"""

from __future__ import annotations

import sys
from getpass import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.auth import verify_password  # noqa: E402


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def main() -> int:
    env = read_env(ROOT / ".env")
    stored = env.get("APP_PASSWORD_HASH", "")

    if not stored:
        print("No APP_PASSWORD_HASH in .env — run scripts/set-password.py first.")
        return 1

    print(f"Stored hash: {len(stored)} characters, "
          f"{'valid format' if stored.startswith('pbkdf2_sha256$') else 'NOT A VALID HASH'}")

    phrase = getpass("Passphrase: ") if sys.stdin.isatty() else input("Passphrase: ")

    if verify_password(phrase, stored):
        print("\nMATCH. This phrase is correct for the hash in .env.")
        print("If the hosted copy still rejects it, its APP_PASSWORD_HASH")
        print("does not match this one — re-copy it and let the service restart.")
        return 0

    print("\nNO MATCH. This phrase does not correspond to the stored hash.")
    print("Run scripts/set-password.py to set a new one.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
