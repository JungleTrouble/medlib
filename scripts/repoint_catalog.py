"""
Repoint the catalogue from Bunny Stream to Bunny Storage.

    python scripts/repoint_catalog.py --dry-run
    python scripts/repoint_catalog.py
    python scripts/repoint_catalog.py --revert

Changes exactly one field per item:

    path:  {guid}/playlist.m3u8   ->   {guid}/video.mp4

and nothing else. `id` stays the Bunny GUID, which is the whole point — ids
key the watch history and every playlist, so renaming them would silently
discard months of progress. Buckets, tags, folders, durations and titles are
all untouched.

`type` needs no handling at all: mint_token derives it from the extension,
so dropping `.m3u8` makes it "file" on its own and the player's progressive
branch takes over. Poster paths need no handling either — mint_token and
/api/posters both take `path.split("/", 1)[0]` as the GUID and append
`thumbnail.jpg`, which is still true under the new layout.

The previous catalogue is kept beside the new one, so --revert is a rename
rather than a rebuild. Until BUNNY_CDN_HOSTNAME is switched too, this change
is inert: the catalogue would point at .mp4 files on a hostname that only
serves Stream.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

STREAM_SUFFIX = "/playlist.m3u8"
STORAGE_SUFFIX = "/video.mp4"


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalog", type=Path, default=Path("data/catalog.json"))
    ap.add_argument("--map", type=Path, default=Path("data/source-map.json"))
    ap.add_argument("--backup", type=Path, default=Path("data/catalog.stream.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args(argv)

    if args.revert:
        if not args.backup.exists():
            print(f"no backup at {args.backup}", file=sys.stderr)
            return 2
        shutil.copy2(args.backup, args.catalog)
        print(f"restored {args.catalog} from {args.backup}")
        print("remember to point BUNNY_CDN_HOSTNAME back at the Stream pull zone")
        return 0

    data = json.loads(args.catalog.read_text(encoding="utf-8"))
    items = data.get("items", [])
    mapping = json.loads(args.map.read_text(encoding="utf-8")) if args.map.exists() else {}

    changed = already = unmapped = odd = 0
    for item in items:
        path = item.get("path", "")

        # Only videos we can actually serve get repointed. Anything without a
        # source file stays on Stream rather than becoming a dead link.
        if mapping and item["id"] not in mapping:
            unmapped += 1
            continue

        if path.endswith(STORAGE_SUFFIX):
            already += 1
        elif path.endswith(STREAM_SUFFIX):
            item["path"] = path[: -len(STREAM_SUFFIX)] + STORAGE_SUFFIX
            changed += 1
        else:
            odd += 1

    print(f"items                {len(items):,}")
    print(f"  repointed          {changed:,}")
    print(f"  already storage    {already:,}")
    print(f"  left on stream     {unmapped:,}   (no source file)")
    print(f"  unrecognised path  {odd:,}")

    if odd:
        for item in items:
            p = item.get("path", "")
            if not p.endswith((STREAM_SUFFIX, STORAGE_SUFFIX)):
                print(f"    {item['id']}  {p[:70]}")
                break

    if args.dry_run:
        print("\ndry run — nothing written")
        return 0

    if not args.backup.exists():
        shutil.copy2(args.catalog, args.backup)
        print(f"\nkept the Stream catalogue at {args.backup}")

    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    args.catalog.write_text(json.dumps(data), encoding="utf-8")
    print(f"wrote {args.catalog}")
    print("\nnext: set BUNNY_CDN_HOSTNAME to the new pull zone and restart the server")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
