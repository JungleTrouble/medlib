"""
Semantic "more like this" over an external vector index.

Two hops, both HTTP, neither of them optional:

    title -> Hugging Face (all-MiniLM-L6-v2) -> 384-float vector
    vector -> Pinecone (usme-prep-library)   -> nearest neighbours

Kept out of main.py because it is the only part of the server that depends on
a third party being awake. Everything else here answers from data on disk; if
Hugging Face is cold or Pinecone is unreachable, that must degrade this one
endpoint and nothing else — hence the narrow exception type and the explicit
status codes rather than letting httpx errors escape as 500s.

The index is *not* populated from here. This module reads; something else has
to have written. An empty index is indistinguishable from a title with no
neighbours, and both correctly return an empty list.
"""

from __future__ import annotations

import math
from typing import Any

import httpx

# Pins the response shape. Pinecone has changed `matches` between versions and
# an unpinned request silently follows whatever is current, so the parsing
# below would break on their release schedule rather than ours.
PINECONE_API_VERSION = "2025-04"

# Hugging Face's serverless inference endpoint. The bare model URL routes to
# the model's default pipeline — sentence-similarity for this one, which wants
# a source_sentence/sentences pair and rejects a single string. The explicit
# feature-extraction route is what returns a plain embedding.
HF_PIPELINE_BASE = "https://api-inference.huggingface.co/pipeline/feature-extraction"

# Cold models take ~20s to load on the free tier; warm ones answer in ~200ms.
HF_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
PINECONE_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# Titles repeat constantly — the same page asks about the same video every
# time it is opened. Bounded because this process is long-lived and the free
# tier is rate-limited, not because memory is scarce.
_EMBED_CACHE: dict[tuple[str, str], list[float]] = {}
_EMBED_CACHE_MAX = 512

# Resolving an index name to its data-plane host is a second round trip. It
# never changes for the life of an index, so it is worth exactly one call.
_HOST_CACHE: dict[str, str] = {}


class SimilarityError(RuntimeError):
    """Upstream failure, carrying the status the API should report."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------
#  Embedding
# --------------------------------------------------------------------------


def _as_vector(node: Any) -> list[float]:
    """
    Flatten whatever shape the inference API returned into one vector.

    The feature-extraction route returns a pooled [384] for a single string,
    but the same model is also served as [1, 384] and, when the raw
    transformer output comes through, [1, tokens, 384]. Mean-pooling the outer
    axis collapses all three to the same thing — unweighted, where
    sentence-transformers would mask padding, which is close enough for a
    fallback path that should not normally be taken.
    """
    if not isinstance(node, list) or not node:
        raise SimilarityError("embedding response was empty or not a list")

    if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in node):
        return [float(x) for x in node]

    rows = [_as_vector(child) for child in node]
    width = len(rows[0])
    if any(len(r) != width for r in rows):
        raise SimilarityError("embedding response had ragged dimensions")
    return [sum(col) / len(rows) for col in zip(*rows)]


def _l2_normalize(vec: list[float]) -> list[float]:
    """
    all-MiniLM-L6-v2 ships a Normalize layer, but the raw pipeline route does
    not always apply it. Cosine indexes do not care either way; a dotproduct
    index does, and would quietly rank by magnitude instead of direction.
    """
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        raise SimilarityError("embedding was all zeros")
    return [x / norm for x in vec]


async def embed_title(
    title: str,
    *,
    api_key: str,
    model: str,
    base_url: str = HF_PIPELINE_BASE,
    client: httpx.AsyncClient | None = None,
) -> list[float]:
    """Embed one title, cached by (model, title)."""
    key = (model, title.strip().lower())
    hit = _EMBED_CACHE.get(key)
    if hit is not None:
        return hit

    owned = client is None
    client = client or httpx.AsyncClient(timeout=HF_TIMEOUT)
    try:
        resp = await client.post(
            f"{base_url.rstrip('/')}/{model}",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "inputs": title,
                # Block on a cold start instead of returning a 503 the caller
                # would have to retry. Costs latency on the first request
                # after an idle period; costs a failed request otherwise.
                "options": {"wait_for_model": True},
            },
            timeout=HF_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise SimilarityError("Hugging Face timed out", status=504)
    except httpx.HTTPError as exc:
        raise SimilarityError(f"could not reach Hugging Face: {exc}", status=502)
    finally:
        if owned:
            await client.aclose()

    if resp.status_code == 401 or resp.status_code == 403:
        raise SimilarityError("Hugging Face rejected HF_API_KEY", status=502)
    if resp.status_code == 429:
        raise SimilarityError("Hugging Face rate limit reached", status=429)
    if resp.status_code >= 400:
        raise SimilarityError(
            f"Hugging Face returned {resp.status_code}: {resp.text[:200]}", status=502
        )

    try:
        payload = resp.json()
    except ValueError:
        raise SimilarityError("Hugging Face returned a non-JSON body", status=502)

    if isinstance(payload, dict):
        # Errors come back 200-with-a-body often enough to be worth checking.
        raise SimilarityError(
            f"Hugging Face returned an error: {payload.get('error', payload)}", status=502
        )

    vec = _l2_normalize(_as_vector(payload))

    if len(_EMBED_CACHE) >= _EMBED_CACHE_MAX:
        _EMBED_CACHE.pop(next(iter(_EMBED_CACHE)))
    _EMBED_CACHE[key] = vec
    return vec


# --------------------------------------------------------------------------
#  Pinecone
# --------------------------------------------------------------------------


async def resolve_host(
    index: str,
    *,
    api_key: str,
    client: httpx.AsyncClient | None = None,
) -> str:
    """
    Index name -> data-plane host, once per process.

    Pinecone's query endpoint lives on a per-index host that the control plane
    hands out. Hard-coding it in .env works until an index is recreated, so it
    is looked up instead — and cached, because it cannot change underneath a
    running index.
    """
    cached = _HOST_CACHE.get(index)
    if cached:
        return cached

    owned = client is None
    client = client or httpx.AsyncClient(timeout=PINECONE_TIMEOUT)
    try:
        resp = await client.get(
            f"https://api.pinecone.io/indexes/{index}",
            headers={
                "Api-Key": api_key,
                "X-Pinecone-API-Version": PINECONE_API_VERSION,
            },
            timeout=PINECONE_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise SimilarityError("Pinecone timed out resolving the index host", status=504)
    except httpx.HTTPError as exc:
        raise SimilarityError(f"could not reach Pinecone: {exc}", status=502)
    finally:
        if owned:
            await client.aclose()

    if resp.status_code == 404:
        raise SimilarityError(f"Pinecone has no index named {index!r}", status=502)
    if resp.status_code in (401, 403):
        raise SimilarityError("Pinecone rejected PINECONE_API_KEY", status=502)
    if resp.status_code >= 400:
        raise SimilarityError(
            f"Pinecone returned {resp.status_code}: {resp.text[:200]}", status=502
        )

    host = (resp.json() or {}).get("host", "")
    if not host:
        raise SimilarityError("Pinecone did not report a host for the index", status=502)

    host = host.replace("https://", "").rstrip("/")
    _HOST_CACHE[index] = host
    return host


async def query_index(
    vector: list[float],
    *,
    index: str,
    api_key: str,
    top_k: int = 3,
    namespace: str = "",
    host: str = "",
    client: httpx.AsyncClient | None = None,
) -> list[dict]:
    """Nearest neighbours, as Pinecone's raw match dicts."""
    host = host or await resolve_host(index, api_key=api_key, client=client)

    body: dict[str, Any] = {
        "vector": vector,
        "topK": top_k,
        "includeMetadata": True,
        "includeValues": False,
    }
    if namespace:
        body["namespace"] = namespace

    owned = client is None
    client = client or httpx.AsyncClient(timeout=PINECONE_TIMEOUT)
    try:
        resp = await client.post(
            f"https://{host}/query",
            headers={
                "Api-Key": api_key,
                "X-Pinecone-API-Version": PINECONE_API_VERSION,
                "Content-Type": "application/json",
            },
            json=body,
            timeout=PINECONE_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise SimilarityError("Pinecone timed out", status=504)
    except httpx.HTTPError as exc:
        raise SimilarityError(f"could not reach Pinecone: {exc}", status=502)
    finally:
        if owned:
            await client.aclose()

    if resp.status_code in (401, 403):
        raise SimilarityError("Pinecone rejected PINECONE_API_KEY", status=502)
    if resp.status_code == 400:
        # Overwhelmingly a dimension mismatch: the index was built for
        # something other than MiniLM's 384.
        raise SimilarityError(
            f"Pinecone rejected the query (vector is {len(vector)}-dimensional; "
            f"does the index match?): {resp.text[:200]}",
            status=502,
        )
    if resp.status_code >= 400:
        raise SimilarityError(
            f"Pinecone returned {resp.status_code}: {resp.text[:200]}", status=502
        )

    try:
        payload = resp.json()
    except ValueError:
        raise SimilarityError("Pinecone returned a non-JSON body", status=502)

    matches = payload.get("matches")
    return matches if isinstance(matches, list) else []


# --------------------------------------------------------------------------
#  Shaping the answer
# --------------------------------------------------------------------------


def _first_str(meta: dict, *keys: str) -> str:
    """
    First non-empty value among several spellings of the same field.

    The metadata was written by whatever populated the index, and there is no
    schema forcing it to agree with this file. Accepting `Title` and `title`
    costs one tuple; guessing wrong costs an endpoint that returns rows of
    empty strings and looks like a Pinecone problem.
    """
    for key in keys:
        val = meta.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, (int, float)):
            return str(val)
    return ""


def shape_matches(matches: list[dict], lookup=None) -> list[dict]:
    """
    Pinecone matches -> the id/title/category rows the client asked for.

    `lookup` is an optional id -> catalog item callable. Vector metadata is
    a copy made when the index was written and drifts; the catalogue on disk
    is current. So it fills gaps, and only gaps — an explicit value in the
    index still wins, because that is the thing that was actually searched.
    """
    out = []
    for match in matches:
        if not isinstance(match, dict):
            continue
        vid = str(match.get("id", "")).strip()
        if not vid:
            continue

        meta = match.get("metadata")
        meta = meta if isinstance(meta, dict) else {}

        title = _first_str(meta, "title", "Title", "videoTitle", "name")
        category = _first_str(meta, "category", "Category", "bucket", "subject", "folder")

        if lookup and (not title or not category):
            item = lookup(vid)
            if item:
                title = title or item.get("title", "")
                category = category or item.get("bucket", "")

        row = {"id": vid, "title": title, "category": category}
        # Additive, not part of the requested shape: without it there is no
        # way to tell a strong neighbour from the best of three bad ones.
        score = match.get("score")
        if isinstance(score, (int, float)):
            row["score"] = round(float(score), 4)
        out.append(row)
    return out
