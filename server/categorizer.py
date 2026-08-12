"""
Prefix-driven categorizer.

Reads the rule tiers out of config/buckets.yaml and assigns every media file in
the library to a subject bucket. Built for libraries in the thousands: keywords
are compiled into one alternation regex per bucket, so a title costs ~35 regex
scans rather than ~800 substring probes.

CLI
---
    python -m server.categorizer --root "D:/Library"
    python -m server.categorizer --root "D:/Library" --dry-run --list-unmatched
    python -m server.categorizer --from-bunny js/videos.generated.js
    python -m server.categorizer --root "D:/Library" --out data/catalog.json --csv report.csv

Rule tiers, first hit wins:
    patterns -> prefixes -> ranges -> keywords -> default_bucket
A file's own name is tried first; if that yields nothing and --use-parent-dir is
on (the default), the containing folder name is run through the same tiers.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import yaml

DEFAULT_CONFIG = Path("config/buckets.yaml")
DEFAULT_OUT = Path("data/catalog.json")


# --------------------------------------------------------------------------
#  Config model
# --------------------------------------------------------------------------


@dataclass
class Pattern:
    name: str
    regex: re.Pattern
    field: str
    map: dict[str, str]
    skip_values: set[str]


@dataclass
class NumericRange:
    lo: int
    hi: int
    bucket: str


@dataclass
class BucketConfig:
    raw: dict[str, Any]
    buckets: dict[str, dict[str, str]]
    default_bucket: str
    min_keyword_score: int
    high_confidence_score: int
    case_sensitive: bool
    strip_extension: bool
    separators: str
    strip_leading: str
    patterns: list[Pattern]
    prefixes: dict[str, str]
    ranges: list[NumericRange]
    keyword_scanners: dict[str, tuple[re.Pattern, dict[str, int]]]
    tag_rules: list[tuple[re.Pattern, str]]
    level_rules: list[tuple[re.Pattern, str]]
    level_fallback: str
    media_extensions: set[str]
    ignore_dirs: set[str]

    @classmethod
    def load(cls, path: Path) -> "BucketConfig":
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}

        buckets = raw.get("buckets") or {}
        default_bucket = raw.get("default_bucket", "uncategorized")
        if default_bucket not in buckets:
            buckets[default_bucket] = {"label": default_bucket.title(), "color": "#5a5f6b"}

        match = raw.get("match") or {}

        patterns: list[Pattern] = []
        for spec in raw.get("patterns") or []:
            compiled = re.compile(spec["regex"])
            if spec["field"] not in compiled.groupindex:
                raise ValueError(
                    f"pattern {spec.get('name', '?')!r}: regex has no named group "
                    f"{spec['field']!r} (groups: {sorted(compiled.groupindex)})"
                )
            patterns.append(
                Pattern(
                    name=spec.get("name", spec["field"]),
                    regex=compiled,
                    field=spec["field"],
                    map={_norm_key(k): v for k, v in (spec.get("map") or {}).items()},
                    skip_values={_norm_key(v) for v in spec.get("skip_values") or []},
                )
            )

        prefixes = {_norm_key(str(k)): v for k, v in (raw.get("prefixes") or {}).items()}

        ranges = [
            NumericRange(int(r["from"]), int(r["to"]), r["bucket"])
            for r in raw.get("ranges") or []
        ]

        keyword_scanners: dict[str, tuple[re.Pattern, dict[str, int]]] = {}
        for bucket, kws in (raw.get("keywords") or {}).items():
            if not kws:
                continue
            weights = {str(k).lower(): int(v) for k, v in kws.items()}
            # Longest first so "heart failure" is preferred over "heart" by the
            # alternation engine; overlapping shorter terms still score via
            # finditer on their own non-overlapping positions.
            terms = sorted(weights, key=len, reverse=True)
            scanner = re.compile("|".join(re.escape(t) for t in terms))
            keyword_scanners[bucket] = (scanner, weights)

        tag_rules = [
            (re.compile(t["regex"], re.IGNORECASE), t["tag"]) for t in raw.get("tags") or []
        ]

        levels = raw.get("levels") or {}
        level_rules = [
            (re.compile(r["regex"], re.IGNORECASE), r["level"]) for r in levels.get("rules") or []
        ]

        unknown = {
            b
            for b in (
                list(prefixes.values())
                + [r.bucket for r in ranges]
                + list(keyword_scanners)
                + [v for p in patterns for v in p.map.values()]
            )
            if b not in buckets
        }
        if unknown:
            raise ValueError(f"rules reference undeclared buckets: {sorted(unknown)}")

        return cls(
            raw=raw,
            buckets=buckets,
            default_bucket=default_bucket,
            min_keyword_score=int(raw.get("min_keyword_score", 6)),
            high_confidence_score=int(raw.get("high_confidence_score", 10)),
            case_sensitive=bool(match.get("case_sensitive", False)),
            strip_extension=bool(match.get("strip_extension", True)),
            separators="".join(match.get("separators") or ["_", "-", " ", "."]),
            strip_leading="".join(match.get("strip_leading") or []),
            patterns=patterns,
            prefixes=prefixes,
            ranges=ranges,
            keyword_scanners=keyword_scanners,
            tag_rules=tag_rules,
            level_rules=level_rules,
            level_fallback=levels.get("fallback", "Uncategorized"),
            media_extensions={e.lower() for e in raw.get("media_extensions") or [".mp4"]},
            ignore_dirs=set(raw.get("ignore_dirs") or []),
        )


def _norm_key(value: str) -> str:
    return re.sub(r"\s+", " ", str(value)).strip().lower()


# --------------------------------------------------------------------------
#  Assignment
# --------------------------------------------------------------------------


@dataclass
class Assignment:
    bucket: str
    rule: str          # which tier decided: pattern:<name> | prefix | range | keyword | default
    confidence: str    # high | low | none
    score: int = 0
    matched: str = ""  # the token/keyword that carried the decision


class Categorizer:
    def __init__(self, config: BucketConfig):
        self.cfg = config

    # -- tiers -------------------------------------------------------------

    def _leading_token(self, name: str) -> str:
        s = name.lstrip(self.cfg.strip_leading) if self.cfg.strip_leading else name
        s = s.lstrip()
        idx = len(s)
        for i, ch in enumerate(s):
            if ch in self.cfg.separators:
                idx = i
                break
        token = s[:idx].strip()
        return token if self.cfg.case_sensitive else token.lower()

    def _try_patterns(self, title: str) -> tuple[Assignment | None, bool]:
        """
        Returns (assignment, structured).

        `structured` says a pattern recognised the *shape* of the name even if
        it could not map it to a bucket — "088 - Other Topics - DKA" is a
        numbered section whose label happens to carry no subject signal. That
        distinction matters downstream: the leading 088 is a section index, not
        a lecture number, so the prefix and range tiers must not read meaning
        into it. They would otherwise file it under whatever bucket owns 1-99.
        """
        structured = False
        for pat in self.cfg.patterns:
            m = pat.regex.match(title)
            if not m:
                continue
            structured = True
            value = _norm_key(m.group(pat.field) or "")
            if not value or any(value.startswith(skip) for skip in pat.skip_values):
                continue
            bucket = pat.map.get(value)
            if bucket:
                return Assignment(bucket, f"pattern:{pat.name}", "high", matched=value), True
        return None, structured

    def _try_prefix(self, title: str) -> Assignment | None:
        token = self._leading_token(title)
        if not token:
            return None
        bucket = self.cfg.prefixes.get(token)
        if bucket:
            return Assignment(bucket, "prefix", "high", matched=token)
        return None

    def _try_range(self, title: str) -> Assignment | None:
        token = self._leading_token(title)
        if not token.isdigit():
            return None
        n = int(token)
        for rng in self.cfg.ranges:
            if rng.lo <= n <= rng.hi:
                return Assignment(rng.bucket, "range", "high", matched=token)
        return None

    def _try_keywords(self, title: str) -> Assignment | None:
        text = _normalize_text(title)
        best_bucket, best_score, best_term = None, 0, ""
        for bucket, (scanner, weights) in self.cfg.keyword_scanners.items():
            score = 0
            top_term, top_weight = "", 0
            seen: set[str] = set()
            for m in scanner.finditer(text):
                term = m.group(0)
                if term in seen:
                    continue
                seen.add(term)
                w = weights[term]
                score += w
                if w > top_weight:
                    top_term, top_weight = term, w
            if score > best_score:
                best_bucket, best_score, best_term = bucket, score, top_term

        if not best_bucket or best_score < self.cfg.min_keyword_score:
            return None
        confidence = "high" if best_score >= self.cfg.high_confidence_score else "low"
        return Assignment(best_bucket, "keyword", confidence, score=best_score, matched=best_term)

    # -- public ------------------------------------------------------------

    def categorize(self, title: str, parent: str | None = None) -> Assignment:
        stem = _strip_ext(title) if self.cfg.strip_extension else title
        probes = [(stem, False)]
        if parent:
            probes.append((parent, True))

        for probe, is_parent in probes:
            if not probe:
                continue

            hit, structured = self._try_patterns(probe)
            if not hit:
                # A recognised-but-unmapped structure disqualifies the tiers that
                # interpret the leading token; go straight to keyword scoring.
                tiers = ((self._try_keywords,) if structured
                         else (self._try_prefix, self._try_range, self._try_keywords))
                for tier in tiers:
                    hit = tier(probe)
                    if hit:
                        break

            if hit:
                if is_parent:
                    hit.rule += "@parent"
                return hit

        return Assignment(self.cfg.default_bucket, "default", "none")

    def tags_for(self, title: str, bucket: str) -> list[str]:
        tags = {tag for rx, tag in self.cfg.tag_rules if rx.search(title)}
        if bucket != self.cfg.default_bucket:
            tags.add(bucket)
        return sorted(tags)

    def level_for(self, title: str) -> str:
        for rx, level in self.cfg.level_rules:
            if rx.search(title):
                return level
        return self.cfg.level_fallback


# A real extension is a short run of alphanumerics. Matching on length alone
# turns "1. Skin" into "1" and throws away the only word that can categorize it.
_EXT = re.compile(r"\.[A-Za-z0-9]{1,5}$")


def _strip_ext(name: str) -> str:
    m = _EXT.search(name)
    return name[: m.start()] if m else name


_PUNCT = re.compile(r"[^a-z0-9\s'\-]")
_WS = re.compile(r"\s+")


def _normalize_text(title: str) -> str:
    text = _strip_ext(title).lower()
    text = _PUNCT.sub(" ", text)
    return _WS.sub(" ", text).strip()


# --------------------------------------------------------------------------
#  Sources
# --------------------------------------------------------------------------


@dataclass
class MediaItem:
    id: str
    title: str
    path: str                 # library-relative POSIX path; the token subject
    bucket: str = ""
    level: str = ""
    tags: list[str] = field(default_factory=list)
    confidence: str = ""
    rule: str = ""
    duration: str = ""
    size: int = 0
    mtime: float = 0.0
    source: str = "file"


def scan_directory(root: Path, cfg: BucketConfig) -> Iterator[MediaItem]:
    """Walk `root`, yielding one MediaItem per media file. Follows no symlinks."""
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in cfg.ignore_dirs and not d.startswith(".")]
        here = Path(dirpath)
        for name in filenames:
            if Path(name).suffix.lower() not in cfg.media_extensions:
                continue
            full = here / name
            try:
                st = full.stat()
            except OSError:
                continue
            rel = full.relative_to(root).as_posix()
            yield MediaItem(
                id=stable_id(rel),
                title=_strip_ext(name),
                path=rel,
                size=st.st_size,
                mtime=st.st_mtime,
                source="file",
            )


_BUNNY_BLOCK = re.compile(
    r'\{\s*id:\s*"(?P<id>[^"]+)".*?title:\s*"(?P<title>(?:[^"\\]|\\.)*)".*?'
    r'(?:duration:\s*"(?P<duration>[^"]*)".*?)?\}',
    re.DOTALL,
)


def read_bunny_generated(path: Path) -> Iterator[MediaItem]:
    """Parse js/videos.generated.js — Bunny Stream GUIDs instead of file paths."""
    src = path.read_text(encoding="utf-8")
    for m in _BUNNY_BLOCK.finditer(src):
        guid = m.group("id")
        title = json.loads(f'"{m.group("title")}"')
        yield MediaItem(
            id=guid,
            title=title,
            path=f"{guid}/playlist.m3u8",
            duration=m.group("duration") or "",
            source="bunny-stream",
        )


#: Placeholders accepted in --path-template.
PATH_TEMPLATE_KEYS = ("id", "zone", "title")
DEFAULT_PATH_TEMPLATE = "{id}/playlist.m3u8"


def render_path_template(template: str, *, video_id: str, zone: str) -> str:
    """
    Build the CDN object path for one video.

    The template is what maps a Bunny video GUID onto the object the pull zone
    actually serves, so it is also what the token gets signed against. Get it
    wrong and every URL is a valid signature over a path that does not exist.
    """
    try:
        rendered = template.format(id=video_id, zone=zone, title=video_id)
    except KeyError as exc:
        raise ValueError(
            f"unknown placeholder {exc} in --path-template; "
            f"supported: {', '.join('{' + k + '}' for k in PATH_TEMPLATE_KEYS)}"
        ) from exc
    return rendered.strip("/")


def read_bunny_catalog(
    path: Path,
    *,
    template: str = DEFAULT_PATH_TEMPLATE,
    zone: str = "",
    include_unfinished: bool = False,
) -> Iterator[MediaItem]:
    """
    Read scripts/sync_bunny.py output (a flat array of Bunny Stream records).

    That file carries no `path`: the Stream API describes videos, not CDN
    objects. The path is synthesised here from --path-template so the signer and
    the player agree on exactly one string per video.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data["videos"] if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError(f"{path} is not a JSON array of video records")

    if "{zone}" in template and not zone:
        raise ValueError("--path-template contains {zone} but --zone was not given")

    for row in rows:
        video_id = row.get("id") or ""
        if not video_id:
            continue
        if not include_unfinished and row.get("status") not in (None, "finished"):
            continue
        yield MediaItem(
            id=video_id,
            title=row.get("title") or video_id,
            path=render_path_template(template, video_id=video_id, zone=zone),
            duration=row.get("duration", ""),
            mtime=0.0,
            source="bunny-stream",
        )


def read_manifest(path: Path) -> Iterator[MediaItem]:
    """Parse a plain JSON list of {title, path, [id], [duration]} objects."""
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data["items"] if isinstance(data, dict) else data
    for row in rows:
        rel = row["path"]
        yield MediaItem(
            id=row.get("id") or stable_id(rel),
            title=row.get("title") or _strip_ext(Path(rel).name),
            path=rel,
            duration=row.get("duration", ""),
            size=int(row.get("size", 0)),
            source=row.get("source", "manifest"),
        )


def stable_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------
#  Catalog build
# --------------------------------------------------------------------------


def build_catalog(
    items: Iterable[MediaItem],
    cfg: BucketConfig,
    *,
    overrides: dict[str, dict[str, Any]] | None = None,
    use_parent_dir: bool = True,
) -> dict[str, Any]:
    cat = Categorizer(cfg)
    overrides = overrides or {}
    out: list[MediaItem] = []
    counts: dict[str, int] = {}
    by_confidence: dict[str, int] = {}
    by_rule: dict[str, int] = {}
    manual = 0

    for item in items:
        ov = overrides.get(item.id)
        if ov and not ov.get("_auto", False):
            # Hand-tagged entries are authoritative; never recomputed.
            item.bucket = ov.get("category", cfg.default_bucket)
            item.level = ov.get("level", cfg.level_fallback)
            item.tags = list(ov.get("tags", []))
            item.confidence = "manual"
            item.rule = "override"
            manual += 1
        else:
            parent = Path(item.path).parent.name if use_parent_dir else None
            a = cat.categorize(item.title, parent=parent or None)
            item.bucket = a.bucket
            item.rule = a.rule
            item.confidence = a.confidence
            item.level = cat.level_for(item.title)
            item.tags = cat.tags_for(item.title, a.bucket)

        counts[item.bucket] = counts.get(item.bucket, 0) + 1
        by_confidence[item.confidence] = by_confidence.get(item.confidence, 0) + 1
        by_rule[item.rule] = by_rule.get(item.rule, 0) + 1
        out.append(item)

    out.sort(key=lambda i: (i.bucket, i.title.lower()))

    bucket_rows = [
        {"id": bid, "label": meta.get("label", bid), "color": meta.get("color", "#5a5f6b"),
         "count": counts.get(bid, 0)}
        for bid, meta in cfg.buckets.items()
        if counts.get(bid, 0) or bid == cfg.default_bucket
    ]
    all_tags = sorted({t for i in out for t in i.tags})
    levels = sorted({i.level for i in out})

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(out),
        "buckets": bucket_rows,
        "levels": levels,
        "tags": all_tags,
        "stats": {
            "by_confidence": by_confidence,
            "by_rule": dict(sorted(by_rule.items(), key=lambda kv: -kv[1])),
            "manual_overrides": manual,
            "unmatched": counts.get(cfg.default_bucket, 0),
        },
        "items": [asdict(i) for i in out],
    }


JS_HEADER = """\
/* ============================================================
   AUTO-GENERATED by server/categorizer.py -- do not hand-edit.
   Generated {when} from {source}.
   Re-tag by editing js/overrides.json, then re-run the categorizer.
   ============================================================ */
"""


def write_videos_js(catalog: dict[str, Any], path: Path, source: str) -> None:
    """
    Emit js/videos.generated.js as `const VIDEOS = [{id, title, path, subject}]`.

    Note this is a different shape from the legacy file produced by
    scripts/sync-bunny.js, which carried category/platform/bunnyVideoId/level/
    duration/tags. Anything still reading those keys needs updating.
    """
    lines = [JS_HEADER.format(when=catalog["generated_at"], source=source), "const VIDEOS = ["]
    for item in catalog["items"]:
        lines.append("  {")
        lines.append(f"    id: {json.dumps(item['id'], ensure_ascii=False)},")
        lines.append(f"    title: {json.dumps(item['title'], ensure_ascii=False)},")
        lines.append(f"    path: {json.dumps(item['path'], ensure_ascii=False)},")
        lines.append(f"    subject: {json.dumps(item['bucket'], ensure_ascii=False)},")
        lines.append("  },")
    lines.append("];")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def verify_path_against_cdn(sample_path: str) -> tuple[bool, str]:
    """
    Sign one sample object and fetch it, to prove the path template points at
    something real before writing thousands of records built on it.

    A signature over a wrong path is still a valid signature — the failure only
    shows up as a 404 at playback time, per video, long after this ran.
    """
    try:
        import httpx

        from .bunny_token import directory_scope_for, sign_bunny_url
        from .settings import get_settings
    except ImportError as exc:  # httpx/pydantic not installed
        return False, f"cannot verify (missing dependency: {exc})"

    s = get_settings()
    if not s.bunny_token_key or not s.bunny_cdn_hostname:
        return False, "cannot verify: BUNNY_TOKEN_KEY / BUNNY_CDN_HOSTNAME not set in .env"

    url = f"https://{s.bunny_cdn_hostname}/{sample_path}"
    signed = sign_bunny_url(
        url,
        s.bunny_token_key,
        ttl=300,
        path_allowed=directory_scope_for(sample_path),
    )
    # The pull zone gates on Referer as well as the token, so send the same one
    # the browser will — ports included, exactly as configured.
    headers = {"Referer": f"http://{s.referrer_hosts[0]}/"} if s.referrer_hosts else {}
    try:
        res = httpx.get(signed.url, headers=headers, timeout=20, follow_redirects=True)
    except Exception as exc:
        return False, f"request failed: {exc}"

    if res.status_code == 200:
        return True, f"200 OK ({len(res.content)} bytes) for /{sample_path}"
    if res.status_code == 404:
        return False, f"404 for /{sample_path} -- the path template does not match this pull zone"
    if res.status_code in (401, 403):
        return False, (f"{res.status_code} for /{sample_path} -- signature rejected; "
                       "check BUNNY_TOKEN_KEY and the pull zone's token settings")
    return False, f"{res.status_code} for /{sample_path}"


def write_csv(catalog: dict[str, Any], path: Path) -> None:
    cols = ["id", "bucket", "confidence", "rule", "level", "title", "path", "tags"]
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for item in catalog["items"]:
            row = dict(item)
            row["tags"] = "|".join(row.get("tags", []))
            w.writerow([row.get(c, "") for c in cols])


# --------------------------------------------------------------------------
#  CLI
# --------------------------------------------------------------------------


def _report(catalog: dict[str, Any], cfg: BucketConfig) -> None:
    stats = catalog["stats"]
    total = catalog["count"]
    placed = total - stats["unmatched"]
    pct = (placed / total * 100) if total else 0.0

    print(f"\nIndexed {total} file(s).")
    print(f"  placed in a subject : {placed}  ({pct:.1f}%)")
    print(f"  left unmatched      : {stats['unmatched']}")
    print(f"  manual overrides    : {stats['manual_overrides']}")
    print(f"\nDeciding tier: {json.dumps(stats['by_rule'])}")
    print(f"Confidence   : {json.dumps(stats['by_confidence'])}")
    print("\nBy bucket:")
    for b in sorted(catalog["buckets"], key=lambda x: -x["count"]):
        if b["count"]:
            print(f"  {b['count']:>6}  {b['id']:<16} {b['label']}")


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="server.categorizer", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--root", type=Path, help="library root to walk for media files")
    src.add_argument("--from-bunny", type=Path, help="parse js/videos.generated.js")
    src.add_argument("--from-bunny-catalog", type=Path,
                     help="parse bunny_catalog.json from scripts/sync_bunny.py")
    src.add_argument("--from-manifest", type=Path, help="parse a JSON list of items")

    p.add_argument("--path-template", default=DEFAULT_PATH_TEMPLATE,
                   help=f"CDN object path per video (default: {DEFAULT_PATH_TEMPLATE}). "
                        "Placeholders: {id}, {zone}")
    p.add_argument("--zone", default="", help="value for {zone} in --path-template")
    p.add_argument("--include-unfinished", action="store_true",
                   help="also index videos that are not finished transcoding")
    p.add_argument("--verify-paths", action="store_true",
                   help="sign one sample path and fetch it from the CDN before writing")

    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--emit-js", type=Path,
                   help="also write a client-side VIDEOS array, e.g. js/videos.generated.js")
    p.add_argument("--csv", type=Path, help="also write a flat CSV audit of every assignment")
    p.add_argument("--overrides", type=Path, default=Path("js/overrides.json"),
                   help="hand-tagged entries that must not be recomputed")
    p.add_argument("--no-parent-dir", action="store_true",
                   help="do not fall back to the containing folder name")
    p.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    p.add_argument("--list-unmatched", action="store_true",
                   help="print every title that landed in the default bucket")
    args = p.parse_args(argv)

    try:
        cfg = BucketConfig.load(args.config)
    except FileNotFoundError:
        print(f"config not found: {args.config}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1

    source_label = ""
    try:
        if args.root:
            if not args.root.is_dir():
                print(f"not a directory: {args.root}", file=sys.stderr)
                return 1
            items = scan_directory(args.root, cfg)
            source_label = str(args.root)
        elif args.from_bunny:
            items = read_bunny_generated(args.from_bunny)
            source_label = str(args.from_bunny)
        elif args.from_bunny_catalog:
            items = read_bunny_catalog(
                args.from_bunny_catalog,
                template=args.path_template,
                zone=args.zone,
                include_unfinished=args.include_unfinished,
            )
            source_label = f"{args.from_bunny_catalog} via '{args.path_template}'"
        else:
            items = read_manifest(args.from_manifest)
            source_label = str(args.from_manifest)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    overrides: dict[str, dict[str, Any]] = {}
    if args.overrides and args.overrides.exists():
        loaded = json.loads(args.overrides.read_text(encoding="utf-8"))
        overrides = {k: v for k, v in loaded.items() if not k.startswith("_")}

    try:
        catalog = build_catalog(items, cfg, overrides=overrides,
                                use_parent_dir=not args.no_parent_dir)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    _report(catalog, cfg)

    # Prove the path template before committing thousands of records to it.
    if args.verify_paths:
        if not catalog["items"]:
            print("\nnothing to verify: no items.", file=sys.stderr)
            return 1
        sample = catalog["items"][0]["path"]
        print(f"\nVerifying path template against the CDN\n  sample: /{sample}")
        ok, detail = verify_path_against_cdn(sample)
        print(f"  {'OK' if ok else 'FAILED'}: {detail}")
        if not ok:
            print("\nRefusing to write: every record would carry a path the CDN does not serve.",
                  file=sys.stderr)
            return 1

    if args.list_unmatched:
        print(f"\n=== unmatched ({catalog['stats']['unmatched']}) ===")
        for item in catalog["items"]:
            if item["bucket"] == cfg.default_bucket:
                print(item["title"])

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {args.out}")
    if args.emit_js:
        write_videos_js(catalog, args.emit_js, source_label)
        print(f"Wrote {args.emit_js}")
    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        write_csv(catalog, args.csv)
        print(f"Wrote {args.csv}")

    total = catalog["count"]
    unmatched = catalog["stats"]["unmatched"]
    subjects = sum(1 for b in catalog["buckets"]
                   if b["count"] and b["id"] != cfg.default_bucket)
    print("\n" + "-" * 46)
    print(f"  total videos processed : {total}")
    print(f"  subjects mapped        : {subjects}")
    print(f"  uncategorized          : {unmatched}")
    print("-" * 46)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
