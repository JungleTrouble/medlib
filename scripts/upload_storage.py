"""
Push the source videos to Bunny Storage.

    python scripts/upload_storage.py --limit 20      # try a few first
    python scripts/upload_storage.py                 # the whole library
    python scripts/upload_storage.py --verify        # confirm what is up there

Reads `data/source-map.json` (written by scripts/map_sources.py) and uploads
each video to

    {zone}/{bunny_guid}/video.mp4

A directory per video, keyed by the GUID the catalogue already uses. That
layout is not cosmetic: `directory_scope_for()` returns `/{guid}/` for it, so
directory-scoped tokens keep working unchanged, one token covers the video
and its thumbnail together, and no lecture title — several of which contain
spaces, ampersands and at least one `⍺` — ever has to survive URL encoding.

Resume is a local state file rather than a remote listing. Bunny's list API
is per-directory, so checking 7,329 directories would cost 7,329 round trips
before the first byte moves. PUT is idempotent, so the worst case after an
interrupted run is re-sending one file.

Nothing here deletes anything. The Stream library stays exactly as it is
until playback has been verified against the new path.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.settings import get_settings  # noqa: E402

DEFAULT_ROOT = Path(r"C:\Users\micha\OneDrive - rush.edu\updated resources 11.09.24")
STATE = Path("data/upload-state.json")

# Big sequential PUTs over a home connection: more threads mostly just
# fragments the upstream. Six keeps the pipe full without thrashing.
WORKERS = 6
RETRIES = 4
TIMEOUT = httpx.Timeout(600.0, connect=20.0)


def endpoint(region: str) -> str:
    # Falkenstein is the unprefixed default; every other region is a subdomain.
    region = (region or "").strip().lower()
    return "storage.bunnycdn.com" if region in ("", "de", "falkenstein") \
        else f"{region}.storage.bunnycdn.com"


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n:,.1f} PB"


class State:
    """Which GUIDs are already up, persisted so a killed run resumes."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.done = set(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            self.done = set()

    def add(self, guid: str) -> None:
        with self.lock:
            self.done.add(guid)
            # Flushed every time. A crash mid-run should cost one file, not
            # the record of everything before it.
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(sorted(self.done)), encoding="utf-8")
            tmp.replace(self.path)


def put_one(client: httpx.Client, base: str, key: str, guid: str,
            src: Path) -> tuple[str, int, str | None]:
    url = f"{base}/{guid}/video.mp4"
    size = src.stat().st_size
    for attempt in range(1, RETRIES + 1):
        try:
            with src.open("rb") as fh:
                res = client.put(
                    url,
                    content=fh,
                    headers={"AccessKey": key, "Content-Type": "video/mp4"},
                    timeout=TIMEOUT,
                )
            if res.status_code in (200, 201):
                return guid, size, None
            # 4xx that is not a rate limit will not fix itself.
            if 400 <= res.status_code < 500 and res.status_code != 429:
                return guid, 0, f"HTTP {res.status_code}: {res.text[:120]}"
            last = f"HTTP {res.status_code}"
        except (httpx.HTTPError, OSError) as exc:
            last = str(exc)[:120]
        if attempt < RETRIES:
            time.sleep(2 ** attempt)
    return guid, 0, last


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--map", type=Path, default=Path("data/source-map.json"))
    ap.add_argument("--limit", type=int, default=0, help="upload at most N (0 = all)")
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true",
                    help="HEAD everything recorded as done and report gaps")
    args = ap.parse_args(argv)

    s = get_settings()
    if not s.bunny_storage_zone or not s.bunny_storage_password:
        print("BUNNY_STORAGE_ZONE / BUNNY_STORAGE_PASSWORD are not set in .env",
              file=sys.stderr)
        return 2

    host = endpoint(s.bunny_storage_region)
    base = f"https://{host}/{s.bunny_storage_zone}"
    mapping: dict[str, str] = json.loads(args.map.read_text(encoding="utf-8"))
    state = State(STATE)

    print(f"zone      {s.bunny_storage_zone} @ {host}")
    print(f"mapped    {len(mapping):,} videos")
    print(f"already   {len(state.done):,} uploaded")

    if args.verify:
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            missing = []
            for n, guid in enumerate(sorted(state.done), 1):
                r = client.head(f"{base}/{guid}/video.mp4",
                                headers={"AccessKey": s.bunny_storage_password})
                if r.status_code != 200:
                    missing.append(guid)
                if n % 250 == 0:
                    print(f"  checked {n:,}…")
            print(f"\nrecorded {len(state.done):,}, missing on the zone {len(missing):,}")
            for g in missing[:10]:
                print(f"  {g}")
        return 1 if missing else 0

    todo = [(g, r) for g, r in mapping.items() if g not in state.done]
    if args.limit:
        todo = todo[:args.limit]

    total_bytes = 0
    for _g, rel in todo:
        try:
            total_bytes += (args.root / rel.replace("/", os.sep)).stat().st_size
        except OSError:
            pass

    print(f"to send   {len(todo):,} files, {human(total_bytes)}\n")
    if args.dry_run or not todo:
        for g, rel in todo[:10]:
            print(f"  {g}/video.mp4  <-  {rel}")
        return 0

    sent = failed = 0
    sent_bytes = 0
    started = time.time()

    with httpx.Client(timeout=TIMEOUT) as client:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(put_one, client, base, s.bunny_storage_password,
                            guid, args.root / rel.replace("/", os.sep)): guid
                for guid, rel in todo
            }
            for fut in as_completed(futures):
                guid, size, err = fut.result()
                if err:
                    failed += 1
                    print(f"  FAILED {guid}: {err}")
                    continue
                state.add(guid)
                sent += 1
                sent_bytes += size
                if sent % 25 == 0 or sent == len(todo):
                    rate = sent_bytes / max(1e-9, time.time() - started)
                    left = (total_bytes - sent_bytes) / rate if rate else 0
                    print(f"  {sent:,}/{len(todo):,}  {human(sent_bytes)}  "
                          f"{human(rate)}/s  ~{left/60:,.0f} min left")

    print(f"\nuploaded {sent:,}, failed {failed:,}, {human(sent_bytes)} "
          f"in {(time.time()-started)/60:,.1f} min")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
