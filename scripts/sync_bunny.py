#!/usr/bin/env python3
"""
Bunny Stream -> bunny_catalog.json metadata sync.

Reads every video in the library and writes a flat local JSON catalog.
Read-only against Bunny; the only thing it writes is the output file.

Credentials
-----------
The Stream API authenticates with the library's **AccessKey**, sent as an HTTP
header. That is a different secret from the URL Token Authentication key used to
sign playback URLs (server/bunny_token.py) -- the token key will not authenticate
an API call. Config is read from bunny.config.local.json, the same file
scripts/sync-bunny.js already uses, with environment overrides.

Usage
-----
    python scripts/sync_bunny.py
    python scripts/sync_bunny.py --out data/bunny_catalog.json
    python scripts/sync_bunny.py --all          # include still-processing videos
    python scripts/sync_bunny.py --dry-run      # fetch and report, write nothing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterator

import httpx

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "bunny.config.local.json"
DEFAULT_OUT = ROOT / "bunny_catalog.json"

API_BASE = "https://video.bunnycdn.com"
ITEMS_PER_PAGE = 100          # Bunny's maximum
MAX_PAGES = 1000              # runaway guard; 100k videos
REQUEST_TIMEOUT = 30.0
MAX_ATTEMPTS = 4

# Bunny's numeric video status enum.
STATUS_NAMES = {
    0: "created",
    1: "uploaded",
    2: "processing",
    3: "transcoding",
    4: "finished",
    5: "error",
    6: "upload_failed",
    7: "jit_segmenting",
    8: "jit_playlists_created",
}
STATUS_FINISHED = 4


class SyncError(RuntimeError):
    pass


# --------------------------------------------------------------------------
#  Config
# --------------------------------------------------------------------------


def load_config(args: argparse.Namespace) -> dict[str, str]:
    """bunny.config.local.json, overridden by env, overridden by CLI flags."""
    cfg: dict[str, str] = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SyncError(f"{CONFIG_PATH.name} is not valid JSON: {exc}") from exc

    resolved = {
        "libraryId": args.library_id or os.getenv("BUNNY_LIBRARY_ID") or cfg.get("libraryId", ""),
        "apiKey": os.getenv("BUNNY_API_KEY") or cfg.get("apiKey", ""),
        "cdnHostname": (
            args.cdn_hostname or os.getenv("BUNNY_CDN_HOSTNAME") or cfg.get("cdnHostname", "")
        ),
    }
    resolved["cdnHostname"] = (
        resolved["cdnHostname"].replace("https://", "").replace("http://", "").strip().rstrip("/")
    )

    missing = [
        k for k, v in resolved.items()
        if not str(v).strip() or str(v).startswith("your ")
    ]
    if missing:
        raise SyncError(
            "missing config: " + ", ".join(missing) + "\n"
            f"Set them in {CONFIG_PATH.name} (copy bunny.config.example.json), or export\n"
            "BUNNY_LIBRARY_ID / BUNNY_API_KEY / BUNNY_CDN_HOSTNAME.\n"
            "apiKey is the library AccessKey from Stream -> your library -> API, "
            "not the URL token authentication key."
        )
    return {k: str(v).strip() for k, v in resolved.items()}


# --------------------------------------------------------------------------
#  Fetch
# --------------------------------------------------------------------------


def _get_page(client: httpx.Client, library_id: str, page: int) -> dict[str, Any]:
    """One page, with backoff on rate limits and transient server errors."""
    url = f"{API_BASE}/library/{library_id}/videos"
    params = {"page": page, "itemsPerPage": ITEMS_PER_PAGE, "orderBy": "date"}

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            res = client.get(url, params=params)
        except httpx.RequestError as exc:
            if attempt == MAX_ATTEMPTS:
                raise SyncError(f"network error talking to Bunny: {exc}") from exc
            time.sleep(2 ** attempt)
            continue

        if res.status_code == 200:
            return res.json()

        if res.status_code in (401, 403):
            raise SyncError(
                f"Bunny rejected the credentials ({res.status_code}). The AccessKey must be the "
                "library's API key from Stream -> your library -> API. The URL token "
                "authentication key will not work here."
            )
        if res.status_code == 404:
            raise SyncError(f"library {library_id} not found (404) -- check libraryId.")

        if res.status_code == 429 or res.status_code >= 500:
            if attempt == MAX_ATTEMPTS:
                raise SyncError(f"Bunny returned {res.status_code} after {MAX_ATTEMPTS} attempts.")
            delay = float(res.headers.get("Retry-After") or 2 ** attempt)
            print(f"  {res.status_code} from Bunny; retrying in {delay:.0f}s "
                  f"(attempt {attempt}/{MAX_ATTEMPTS})", file=sys.stderr)
            time.sleep(delay)
            continue

        raise SyncError(f"Bunny API error {res.status_code}: {res.text[:300]}")

    raise SyncError("exhausted retries")  # unreachable


def fetch_videos(cfg: dict[str, str]) -> Iterator[dict[str, Any]]:
    headers = {"AccessKey": cfg["apiKey"], "accept": "application/json"}
    seen = 0
    total: int | None = None

    with httpx.Client(headers=headers, timeout=REQUEST_TIMEOUT) as client:
        for page in range(1, MAX_PAGES + 1):
            data = _get_page(client, cfg["libraryId"], page)
            items = data.get("items")
            if not isinstance(items, list):
                raise SyncError(f"unexpected response shape on page {page}: {str(data)[:200]}")
            if not items:
                break

            if total is None:
                total = data.get("totalItems")
                if isinstance(total, int):
                    print(f"Library reports {total} video(s).")

            yield from items
            seen += len(items)
            print(f"  page {page}: {len(items)} (running total {seen})")

            if isinstance(total, int) and seen >= total:
                break
            if len(items) < ITEMS_PER_PAGE:
                break
        else:
            raise SyncError(f"stopped after {MAX_PAGES} pages -- pagination looks stuck.")


# --------------------------------------------------------------------------
#  Transform
# --------------------------------------------------------------------------


def format_duration(seconds: Any) -> str:
    try:
        total = max(0, int(round(float(seconds or 0))))
    except (TypeError, ValueError):
        total = 0
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def to_record(video: dict[str, Any], cdn_hostname: str) -> dict[str, Any]:
    guid = video.get("guid", "")
    thumb = video.get("thumbnailFileName") or "thumbnail.jpg"
    status_code = video.get("status")
    seconds = video.get("length", 0)

    return {
        "id": guid,
        "title": video.get("title", "") or "(untitled)",
        "duration": format_duration(seconds),
        # Keep the raw value too: the formatted string cannot be sorted or summed.
        "duration_seconds": int(seconds or 0),
        "thumbnail_url": f"https://{cdn_hostname}/{guid}/{thumb}" if guid else "",
        "created_at": video.get("dateUploaded", ""),
        "status": STATUS_NAMES.get(status_code, f"unknown_{status_code}"),
    }


# --------------------------------------------------------------------------
#  CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="sync_bunny.py",
        description="Sync Bunny Stream video metadata to a local JSON catalog.",
    )
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"default: {DEFAULT_OUT.name}")
    p.add_argument("--library-id", help="override the configured library id")
    p.add_argument("--cdn-hostname", help="override the configured CDN hostname")
    p.add_argument("--all", action="store_true",
                   help="include videos that are not finished transcoding")
    p.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    args = p.parse_args(argv)

    try:
        cfg = load_config(args)
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Fetching library {cfg['libraryId']} from {API_BASE} ...")
    try:
        raw = list(fetch_videos(cfg))
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted; nothing written.", file=sys.stderr)
        return 130

    skipped = 0
    records = []
    for v in raw:
        if not args.all and v.get("status") != STATUS_FINISHED:
            skipped += 1
            continue
        records.append(to_record(v, cfg["cdnHostname"]))

    records.sort(key=lambda r: r["title"].lower())

    by_status: dict[str, int] = {}
    for r in records:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1

    print(f"\nFetched {len(raw)} video(s) from Bunny.")
    if skipped:
        print(f"  skipped {skipped} not finished transcoding (use --all to include)")
    print(f"  writing {len(records)} record(s)")
    if len(by_status) > 1:
        print(f"  by status: {json.dumps(by_status)}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Write via a temp file so an interrupted run cannot truncate a good catalog.
    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    tmp.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(args.out)

    print(f"\nWrote {args.out}  ({len(records)} videos)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
