"""
Set (or reset) the MedLib sign-in passphrase.

    python scripts/set-password.py

Prompts twice, hashes, and writes APP_PASSWORD_HASH into .env for you.
Nothing is echoed and nothing lands in shell history, which is the whole
point of having this rather than pasting a hash by hand.

There is no recovery for a forgotten passphrase and there does not need to
be: the stored value is a one-way hash, so resetting is just writing a new
one over the old. Sessions already issued keep working until they expire.
"""

from __future__ import annotations

import sys
from getpass import getpass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
KEY = "APP_PASSWORD_HASH"

sys.path.insert(0, str(ROOT))

from server.auth import hash_password  # noqa: E402


def read_secret(prompt: str) -> str:
    """getpass needs a terminal; fall back loudly rather than silently echoing."""
    if sys.stdin.isatty():
        return getpass(prompt)
    print(f"{prompt}(warning: not a terminal, input will be visible)")
    return input()


def write_hash(env_path: Path, encoded: str) -> None:
    """Replace the APP_PASSWORD_HASH line, leaving every other line untouched."""
    lines = env_path.read_text(encoding="utf-8").splitlines()
    replaced = False

    for i, line in enumerate(lines):
        if line.strip().startswith(f"{KEY}="):
            lines[i] = f"{KEY}={encoded}"
            replaced = True
            break

    if not replaced:
        lines.append(f"{KEY}={encoded}")

    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    if not ENV_PATH.exists():
        print(f"No .env at {ENV_PATH} — copy .env.example to .env first.")
        return 1

    first = read_secret("New passphrase: ")
    if not first.strip():
        print("Nothing entered. Nothing changed.")
        return 1

    if first != read_secret("Type it again: "):
        print("Those did not match. Nothing changed.")
        return 1

    write_hash(ENV_PATH, hash_password(first))

    print(f"\nSaved to {ENV_PATH.name}. Restart the server, then sign in with it.")
    print("Note: your old sessions stay valid until they expire.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
