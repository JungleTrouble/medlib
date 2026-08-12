"""
FastAPI front door.

    uvicorn server.main:app --host 127.0.0.1 --port 8000

Endpoints
    POST /api/login             passphrase -> session cookie
    POST /api/logout
    GET  /api/me
    GET  /api/catalog           buckets, levels, tags, paged items
    GET  /api/catalog/{key}     one item by id or path
    GET  /api/token/{path}      mint a short-lived signed playback URL
    GET  /api/health

Every /api route except health and login requires the session cookie, and the
token route additionally requires an allowed Referer/Origin.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import COOKIE_NAME, SessionCodec, verify_password
from .bunny_token import TokenError, directory_scope_for, sign_bunny_url
from .catalog import Catalog, CatalogError
from .settings import get_settings

log = logging.getLogger("medlib")

PLAYER_DIR = Path("player")
HLS_SUFFIXES = (".m3u8", ".mpd")

settings = get_settings()
catalog = Catalog(settings.catalog_path)
sessions: SessionCodec | None = None

# Login throttle: 10 attempts per IP per 15 minutes. Enough to stop a script,
# small enough to keep in a dict for a single-user app.
_LOGIN_WINDOW = 900
_LOGIN_MAX = 10
_login_hits: dict[str, list[float]] = defaultdict(list)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global sessions
    gaps = settings.missing_required()
    if gaps:
        log.warning("missing config: %s — see .env.example", ", ".join(gaps))
    if settings.session_secret:
        sessions = SessionCodec(settings.session_secret, settings.session_ttl_seconds)
    try:
        catalog.load()
        _, total = catalog.query(limit=1)
        log.info("catalog: %d items, generated %s", total, catalog.generated_at)
    except CatalogError as exc:
        log.warning("%s", exc)
    yield


app = FastAPI(title="MedLib", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------
#  Dependencies
# --------------------------------------------------------------------------


#  Hosts that are unambiguously this machine. AUTH_DISABLED is honoured for
#  these and nothing else.
_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})


def require_session(request: Request) -> dict:
    if settings.auth_disabled:
        # The peer address off the socket, deliberately not client_ip(): that
        # helper trusts X-Forwarded-For, which the client controls. With the
        # gate off this check is the only thing between an unauthenticated
        # library and whoever can reach the port, so it cannot be spoofable.
        peer = request.client.host if request.client else None
        if peer not in _LOOPBACK:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "AUTH_DISABLED only permits connections from this machine",
            )
        return {"sub": "local", "auth": "disabled"}

    if sessions is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "SESSION_SECRET is not configured")
    claims = sessions.read(request.cookies.get(COOKIE_NAME))
    if not claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in required")
    return claims


def _header_host(value: str | None) -> str | None:
    if not value:
        return None
    parts = urlsplit(value if "//" in value else f"//{value}")
    return (parts.netloc or parts.path).lower().strip("/") or None


def require_referrer(request: Request) -> str | None:
    """
    Gate on Referer, falling back to Origin (browsers omit Referer on some
    navigations but keep Origin on fetch). This is a cheap filter against a
    signed URL being embedded elsewhere, not an authentication check — the
    session cookie is what actually protects the endpoint.
    """
    allowed = settings.referrer_hosts
    if not allowed:
        return None

    host = _header_host(request.headers.get("referer")) or \
        _header_host(request.headers.get("origin"))

    if host is None:
        if settings.require_referrer:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "missing referrer")
        return None

    bare = host.split(":")[0]
    for entry in allowed:
        if host == entry or bare == entry.split(":")[0]:
            return host
    raise HTTPException(status.HTTP_403_FORBIDDEN, f"referrer not allowed: {host}")


def client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


# --------------------------------------------------------------------------
#  Auth
# --------------------------------------------------------------------------


class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


@app.post("/api/login")
def login(body: LoginBody, request: Request, response: Response):
    ip = client_ip(request) or "unknown"
    now = time.time()
    hits = [t for t in _login_hits[ip] if now - t < _LOGIN_WINDOW]
    _login_hits[ip] = hits
    if len(hits) >= _LOGIN_MAX:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many attempts, wait 15 minutes")

    if sessions is None or not settings.app_password_hash:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "auth not configured — set APP_PASSWORD_HASH and SESSION_SECRET")

    if not verify_password(body.password, settings.app_password_hash):
        _login_hits[ip].append(now)
        log.warning("failed login from %s", ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "incorrect passphrase")

    _login_hits.pop(ip, None)
    response.set_cookie(
        COOKIE_NAME,
        sessions.issue(),
        max_age=settings.session_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(claims: dict = Depends(require_session)):
    return {"authenticated": True, "subject": claims.get("sub")}


# --------------------------------------------------------------------------
#  Catalog
# --------------------------------------------------------------------------


@app.get("/api/catalog")
def get_catalog(
    _: dict = Depends(require_session),
    bucket: str | None = None,
    level: str | None = None,
    tag: list[str] | None = Query(None, description="repeat to require several"),
    collection: str | None = None,
    section: str | None = None,
    folder: str | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=5000),
):
    try:
        catalog.refresh_if_stale()
    except CatalogError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    items, total = catalog.query(
        bucket=bucket, level=level, tags=tag, collection=collection, section=section,
        folder=folder, search=search, offset=offset, limit=limit,
    )
    return {
        "generated_at": catalog.generated_at,
        "buckets": catalog.buckets,
        "levels": catalog.levels,
        "tags": catalog.tags,
        "tagFacets": catalog.tag_facets,
        "collections": catalog.collections,
        "folders": catalog.folders,
        "stats": catalog.stats,
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [_public_item(i) for i in items],
    }


@app.get("/api/catalog/{key:path}")
def get_item(key: str, _: dict = Depends(require_session)):
    try:
        catalog.refresh_if_stale()
    except CatalogError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))
    item = catalog.get(key)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not in catalog")
    return _public_item(item)


def _public_item(item: dict) -> dict:
    return {
        "id": item["id"],
        "title": item["title"],
        "path": item["path"],
        "bucket": item["bucket"],
        "level": item.get("level", ""),
        "tags": item.get("tags", []),
        "duration": item.get("duration", ""),
        "confidence": item.get("confidence", ""),
        "collection": item.get("collection", ""),
        "section": item.get("section", ""),
        "folder": item.get("folder", ""),
    }


# --------------------------------------------------------------------------
#  Token minting
# --------------------------------------------------------------------------


@app.get("/api/token/{path:path}")
def mint_token(
    path: str,
    request: Request,
    _: dict = Depends(require_session),
    referer: str | None = Depends(require_referrer),
    ttl: int | None = Query(None, ge=60, description="requested seconds; clamped to policy max"),
):
    """
    Mint a signed URL for one catalog entry.

    `path` is an item id or the exact library-relative path. Anything not in the
    catalog is a 404 — the endpoint will not sign a path it did not index, which
    is what keeps it from being a general-purpose signing oracle for the pull zone.
    """
    if not settings.bunny_token_key or not settings.bunny_cdn_hostname:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "BUNNY_TOKEN_KEY / BUNNY_CDN_HOSTNAME not configured")

    try:
        catalog.refresh_if_stale()
    except CatalogError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    item = catalog.get(path)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not in catalog")

    object_path = item["path"].lstrip("/")
    base = f"https://{settings.bunny_cdn_hostname}/{object_path}"
    scope = directory_scope_for(object_path) if settings.token_directory_scope else None
    is_hls = object_path.lower().endswith(HLS_SUFFIXES)

    try:
        signed = sign_bunny_url(
            base,
            settings.bunny_token_key,
            ttl=ttl or settings.effective_ttl,
            max_ttl=settings.token_max_ttl_seconds,
            user_ip=client_ip(request) if settings.token_bind_ip else None,
            path_allowed=scope,
            # HLS must use the path-style token. A master playlist lists its
            # variants as relative paths ("360p/video.m3u8"), and players do
            # not copy the parent's query string onto those requests — so a
            # query-style token authorises the master and nothing beneath it,
            # and playback dies at the first variant. Carrying the token in
            # the path means every relative child inherits it.
            is_directory=is_hls,
        )
    except TokenError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc))

    payload = signed.as_dict()
    payload.update({
        "id": item["id"],
        "title": item["title"],
        "type": "hls" if object_path.lower().endswith(HLS_SUFFIXES) else "file",
        "referrer": referer,
    })

    if item.get("source") == "bunny-stream":
        guid = object_path.split("/", 1)[0]
        poster = sign_bunny_url(
            f"https://{settings.bunny_cdn_hostname}/{guid}/thumbnail.jpg",
            settings.bunny_token_key,
            ttl=ttl or settings.effective_ttl,
            max_ttl=settings.token_max_ttl_seconds,
            path_allowed=scope,
        )
        payload["poster"] = poster.url

    # A signed URL is a bearer credential for its TTL — keep it out of caches.
    return JSONResponse(payload, headers={"Cache-Control": "no-store, private"})


# --------------------------------------------------------------------------
#  Asset library — reference material, not video
# --------------------------------------------------------------------------

_assets_cache: dict | None = None
_assets_mtime: float = 0.0


def _load_assets() -> dict:
    """
    data/assets.json, reloaded when it changes on disk.

    Kept separate from the video Catalog: assets are standalone downloads
    with no playback, no signing and no token. They share only the subject
    buckets, folder tree and tags, which is what lets one filter serve both.
    """
    global _assets_cache, _assets_mtime
    path = Path("data/assets.json")
    if not path.exists():
        return {"items": [], "buckets": [], "tags": [], "kinds": [], "folders": [],
                "counts": {"assets": 0}}
    mtime = path.stat().st_mtime
    if _assets_cache is None or mtime != _assets_mtime:
        _assets_cache = json.loads(path.read_text(encoding="utf-8"))
        _assets_mtime = mtime
    return _assets_cache


@app.get("/api/assets")
def get_assets(
    _: dict = Depends(require_session),
    bucket: str | None = None,
    tag: list[str] | None = Query(None, description="repeat to require several"),
    folder: str | None = None,
    kind: str | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
):
    data = _load_assets()
    rows = data.get("items", [])

    if bucket:
        rows = [r for r in rows if r.get("bucket") == bucket]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    if tag:
        wanted = set(tag)
        rows = [r for r in rows if wanted.issubset(set(r.get("tags", [])))]
    if folder:
        prefix = folder.rstrip("/")
        rows = [
            r for r in rows
            if (f := r.get("folder", "")) == prefix or f.startswith(prefix + "/")
        ]
    if search:
        needle = search.lower().strip()
        if needle:
            rows = [
                r for r in rows
                if needle in r.get("title", "").lower()
                or needle in r.get("filename", "").lower()
                or needle in r.get("folder", "").lower()
                or any(needle in t for t in r.get("tags", []))
            ]

    total = len(rows)
    page = rows[offset: offset + limit]

    return {
        "generated_at": data.get("generated_at", ""),
        "counts": data.get("counts", {}),
        "kinds": data.get("kinds", []),
        "buckets": data.get("buckets", []),
        "folders": data.get("folders", []),
        "tags": data.get("tags", [])[:400],
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": page,
    }


@app.get("/api/posters")
def mint_posters(
    request: Request,
    ids: str = Query(..., description="comma-separated catalog ids, max 60"),
    _: dict = Depends(require_session),
    referer: str | None = Depends(require_referrer),
):
    """
    Sign poster and hover-preview URLs for several videos at once.

    A shelf of 24 cards would otherwise be 24 calls to /api/token. Bunny
    generates both assets per video: thumbnail.jpg is the still, preview.webp
    is a short animated scrub used on hover.

    Only ids already in the catalogue are signed, same as /api/token — this
    is not a general signing oracle for the pull zone.
    """
    if not settings.bunny_token_key or not settings.bunny_cdn_hostname:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "BUNNY_TOKEN_KEY / BUNNY_CDN_HOSTNAME not configured")

    wanted = [i.strip() for i in ids.split(",") if i.strip()][:60]
    if not wanted:
        return JSONResponse({}, headers={"Cache-Control": "no-store, private"})

    try:
        catalog.refresh_if_stale()
    except CatalogError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    ttl = settings.effective_ttl
    out: dict[str, dict] = {}

    for key in wanted:
        item = catalog.get(key)
        if not item or item.get("source") != "bunny-stream":
            continue

        guid = item["path"].lstrip("/").split("/", 1)[0]
        scope = f"/{guid}/" if settings.token_directory_scope else None
        entry = {}

        for field, asset in (("poster", "thumbnail.jpg"), ("preview", "preview.webp")):
            try:
                signed = sign_bunny_url(
                    f"https://{settings.bunny_cdn_hostname}/{guid}/{asset}",
                    settings.bunny_token_key,
                    ttl=ttl,
                    max_ttl=settings.token_max_ttl_seconds,
                    path_allowed=scope,
                )
                entry[field] = signed.url
                entry["expires"] = signed.expires
            except TokenError:
                continue

        if entry:
            out[item["id"]] = entry

    # Signed URLs are bearer credentials for their TTL.
    return JSONResponse(out, headers={"Cache-Control": "no-store, private"})


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "catalog_loaded": catalog.loaded,
        "generated_at": catalog.generated_at,
        "ttl_seconds": settings.effective_ttl,
        "missing_config": settings.missing_required(),
    }


# Mounted last so /api/* wins; html=True serves player/index.html at "/".
if PLAYER_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(PLAYER_DIR), html=True), name="player")
