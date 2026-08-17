"""
Map every catalogued video to its source file on disk.

    python scripts/map_sources.py
    python scripts/map_sources.py --root "D:/library" --out data/source-map.json

Writes {bunny_video_id: "relative/path/on/disk.mp4"}.

This is the foundation of the Storage migration, and the reason it is safe:
the catalogue keeps its existing Bunny GUID as `id` and only `path` changes.
Ids key the watch history and every playlist, so anything that renamed them
would silently throw away months of progress.

Matching runs in three passes, each only used when the one before is
ambiguous:

  1. filename stem, with the extension stripped from *both* sides — some
     Bunny titles carry ".MP4" in the title itself
  2. the collection's own folder path, since 46 filenames repeat across
     publishers ("Antibody Structure atf" exists under Sketchy and Bootcamp)
  3. runtime via ffprobe — two lectures with the same name in different
     folders are almost never the same length

Anything still ambiguous is left out. A missing entry is visible the moment
the video will not play; a wrong one points a lesson at another lecture and
is invisible forever.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

VIDEO_EXT = {".mp4", ".m4v", ".mkv", ".mov", ".webm", ".ts"}

# Encoders disagree on duration by a few frames, never by seconds.
DURATION_TOLERANCE = 2.0

DEFAULT_ROOT = Path(
    r"C:\Users\micha\OneDrive - rush.edu\updated resources 11.09.24"
)


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def strip_video_ext(name: str) -> str:
    stem, ext = os.path.splitext(name or "")
    return stem if ext.lower() in VIDEO_EXT else name


def index_disk(root: Path) -> dict[str, list[str]]:
    by_stem: dict[str, list[str]] = defaultdict(list)
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            stem, ext = os.path.splitext(f)
            if ext.lower() in VIDEO_EXT:
                rel = os.path.relpath(os.path.join(dirpath, f), root)
                by_stem[norm(stem)].append(rel.replace("\\", "/"))
    return by_stem


def ffprobe_seconds(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                    help="source library root")
    ap.add_argument("--catalog", type=Path, default=Path("data/catalog.json"))
    ap.add_argument("--bunny", type=Path, default=Path("bunny_catalog.json"))
    ap.add_argument("--collections", type=Path, default=Path("bunny_collections.json"))
    ap.add_argument("--out", type=Path, default=Path("data/source-map.json"))
    args = ap.parse_args(argv)

    if not args.root.is_dir():
        print(f"source root not found: {args.root}", file=sys.stderr)
        return 2

    cat = json.loads(args.catalog.read_text(encoding="utf-8"))["items"]
    bunny = {b["id"]: b for b in json.loads(args.bunny.read_text(encoding="utf-8"))}
    colls = {c["id"]: c["name"]
             for c in json.loads(args.collections.read_text(encoding="utf-8"))}

    by_stem = index_disk(args.root)
    print(f"indexed {sum(len(v) for v in by_stem.values()):,} video files "
          f"under {args.root}")

    durations: dict[str, float | None] = {}
    mapping: dict[str, str] = {}
    ambiguous: list[tuple[str, list[str]]] = []
    missing: list[str] = []
    resolved_by_duration = 0

    for item in cat:
        meta = bunny.get(item["id"])
        if not meta:
            missing.append(item.get("title", item["id"]))
            continue

        hits = by_stem.get(norm(strip_video_ext(meta["title"])), [])

        if len(hits) > 1:
            want = norm(colls.get(meta.get("collection_id"), ""))
            for rule in (lambda h: norm(os.path.dirname(h)) == want,
                         lambda h: bool(want) and want in norm(os.path.dirname(h))):
                narrowed = [h for h in hits if rule(h)]
                if len(narrowed) == 1:
                    hits = narrowed
                    break

        if len(hits) > 1 and meta.get("duration_seconds"):
            target = meta["duration_seconds"]
            close = []
            for h in hits:
                if h not in durations:
                    durations[h] = ffprobe_seconds(args.root / h.replace("/", os.sep))
                d = durations[h]
                if d and abs(d - target) <= DURATION_TOLERANCE:
                    close.append(h)
            if len(close) == 1:
                hits = close
                resolved_by_duration += 1

        if len(hits) == 1:
            mapping[item["id"]] = hits[0]
        elif hits:
            ambiguous.append((meta["title"], hits))
        else:
            missing.append(meta["title"])

    total = len(cat)
    print(f"\ncatalogued videos      {total:,}")
    print(f"  mapped               {len(mapping):,}   ({len(mapping)/total*100:.2f}%)")
    print(f"    by runtime         {resolved_by_duration:,}")
    print(f"  ambiguous (declined) {len(ambiguous):,}")
    print(f"  no file on disk      {len(missing):,}")

    for title, hits in ambiguous[:10]:
        print(f"\n  ambiguous: {title}")
        for h in hits[:4]:
            print(f"      {h}")
    if missing:
        print("\n  missing:")
        for t in missing[:10]:
            print(f"      {t}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(mapping, indent=0), encoding="utf-8")
    print(f"\nwrote {args.out} — {len(mapping):,} entries")

    # Ambiguity is a correctness problem; a handful of absent files is not.
    return 1 if ambiguous else 0


if __name__ == "__main__":
    raise SystemExit(main())
