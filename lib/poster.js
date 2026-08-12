/* ============================================================
   Signed poster URLs.

   The pull zone has token authentication on, so
   https://<cdn>/<guid>/thumbnail.jpg is a 403 on its own — every poster
   needs a signed URL, and each one expires. A shelf wall of 40 cards
   therefore cannot just set `src` and forget it.

   How this works:
     - Cards ask for a poster only once they are near the viewport
       (IntersectionObserver in the component), so an unscrolled shelf
       costs nothing.
     - Requests inside one frame are coalesced into a single batch, so
       scrolling a row fires one request rather than forty.
     - Results are cached by id and dropped shortly before they expire, so
       a card that stays on screen past the TTL re-signs itself instead of
       turning into a broken image.

   SERVER NOTE: /api/token/{id} signs one item per call. Batching here
   still means N calls against that endpoint. If poster loading feels slow,
   the fix is a bulk route — POST /api/posters with a list of ids,
   returning signed poster URLs — and only `fetchBatch` below has to change.
   ============================================================ */

const CACHE = new Map(); // id -> { url, expires }
const PENDING = new Map(); // id -> Promise

/* Re-sign this many seconds before the URL actually lapses, so a poster
   never blinks out while someone is looking at it. */
const REFRESH_GRACE_S = 60;

function fresh(entry) {
  if (!entry) return false;
  if (!entry.expires) return true;
  return entry.expires - Date.now() / 1000 > REFRESH_GRACE_S;
}

/** Cached poster URL, or null when one has not been fetched yet. */
export function peekPoster(id) {
  const entry = CACHE.get(id);
  return fresh(entry) ? entry.url : null;
}

async function fetchOne(id, endpoint, signal) {
  const res = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(String(res.status));

  const payload = await res.json();
  // The token route signs a poster only for bunny-stream items; anything
  // else legitimately has none, and the card keeps its fallback.
  return { url: payload.poster || null, expires: payload.expires ?? null };
}

/**
 * Resolve a signed poster URL.
 *
 * @param {string} id  catalog id
 * @param {Object} [opts]
 * @param {string} [opts.endpoint="/api/token"]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string|null>} null when the item has no poster, or when
 *          signing is unavailable — callers render their fallback either way
 */
export function getPoster(id, opts = {}) {
  const { endpoint = "/api/token", signal } = opts;

  const cached = CACHE.get(id);
  if (fresh(cached)) return Promise.resolve(cached.url);
  if (PENDING.has(id)) return PENDING.get(id);

  const task = fetchOne(id, endpoint, signal)
    .then((entry) => {
      CACHE.set(id, entry);
      return entry.url;
    })
    .catch(() => {
      // A 401 before sign-in, a 404, or an offline preview. Cache the miss
      // briefly so a shelf of cards does not retry on every scroll frame.
      CACHE.set(id, { url: null, expires: Date.now() / 1000 + 30 });
      return null;
    })
    .finally(() => PENDING.delete(id));

  PENDING.set(id, task);
  return task;
}

/** Resolve several at once; failures come back as null, never a rejection. */
export function getPosters(ids, opts = {}) {
  return Promise.all(ids.map((id) => getPoster(id, opts)));
}

/** Drop everything — call after sign-out, since the URLs were credentials. */
export function clearPosters() {
  CACHE.clear();
  PENDING.clear();
}
