/* ============================================================
   Playback source resolution — direct HLS/MP4 only.

   Every entry resolves to a media URL handed straight to a <video> element
   (via hls.js off Safari). Nothing here builds an iframe/embed URL, and
   `assertDirect` fails loudly if one ever reaches the player — that is the
   one invariant this module exists to hold. A publisher name in a title is
   just text; it never changes how the file is played.

   Two ways to get a URL, depending on whether the library has Bunny token
   authentication turned on:

     fetchSignedSource()  — asks the app's own /api/token/<id> for a
                            short-TTL signed URL. This is the path to use.
                            The server only signs paths it has indexed, so
                            it cannot be used as a general signing oracle,
                            and the URL is a bearer credential until it
                            expires: keep it out of caches, logs and the DOM.

     directSource()       — builds the plain pull-zone URL for a library
                            with token auth off. Use in local development.

   Bunny's per-video layout under the pull zone hostname:

       https://<cdn-hostname>/<video-guid>/playlist.m3u8     adaptive HLS
       https://<cdn-hostname>/<video-guid>/play_720p.mp4     fixed rendition
       https://<cdn-hostname>/<video-guid>/thumbnail.jpg     poster
   ============================================================ */

/** Hosts that serve the embed player rather than media. Never a source. */
const EMBED_HOSTS = [/(^|\.)iframe\.mediadelivery\.net$/i, /(^|\.)mediadelivery\.net$/i];

const EMBED_PATH = /\/embed\//i;

/**
 * Guard: a source URL must be a media file, not a player page.
 * @throws {Error} when handed an embed URL.
 */
export function assertDirect(url) {
  let parsed;
  try {
    parsed = new URL(url, "https://placeholder.invalid");
  } catch {
    throw new Error(`stream-source: not a URL: ${url}`);
  }
  if (EMBED_HOSTS.some((re) => re.test(parsed.hostname)) || EMBED_PATH.test(parsed.pathname)) {
    throw new Error(
      `stream-source: refusing an embed URL (${parsed.hostname}${parsed.pathname}). ` +
        "Playback is direct HLS/MP4 — see lib/stream-source.js."
    );
  }
  return url;
}

export const HLS_EXT = /\.m3u8(\?|$)/i;

export function isHls(url) {
  return HLS_EXT.test(String(url || ""));
}

/**
 * Build unsigned pull-zone URLs. Only valid when the library has token
 * authentication disabled — with it on, these return 403 and you want
 * fetchSignedSource instead.
 *
 * @param {string} videoId  Bunny video GUID
 * @param {Object} config   { cdnHostname }
 */
export function directSource(videoId, config, { rendition } = {}) {
  const host = config?.cdnHostname;
  if (!host) throw new Error("stream-source: config.cdnHostname is required");
  if (!videoId) throw new Error("stream-source: videoId is required");

  const base = `https://${host}/${encodeURIComponent(videoId)}`;
  const src = rendition ? `${base}/play_${rendition}.mp4` : `${base}/playlist.m3u8`;

  return {
    src: assertDirect(src),
    type: rendition ? "mp4" : "hls",
    poster: `${base}/thumbnail.jpg`,
    signed: false,
    expires: null,
  };
}

/**
 * Ask the app server to mint a signed URL for one catalog entry.
 * Mirrors the response of GET /api/token/{path} in server/main.py:
 * { url, expires, id, title, type, poster }.
 *
 * @param {string} id                catalog id or library-relative path
 * @param {Object} [opts]
 * @param {string} [opts.endpoint="/api/token"]
 * @param {number} [opts.ttl]        requested seconds; the server clamps it
 * @param {AbortSignal} [opts.signal]
 */
export async function fetchSignedSource(id, opts = {}) {
  const { endpoint = "/api/token", ttl, signal } = opts;

  const url = new URL(`${endpoint}/${String(id).replace(/^\/+/, "")}`, window.location.origin);
  if (ttl) url.searchParams.set("ttl", String(ttl));

  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });

  if (res.status === 401) throw new Error("unauthenticated");
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  const payload = await res.json();

  return {
    src: assertDirect(payload.url),
    type: payload.type === "hls" || isHls(payload.url) ? "hls" : "mp4",
    poster: payload.poster || null,
    signed: true,
    expires: payload.expires ?? null,
    title: payload.title,
    id: payload.id,
  };
}

/** Seconds left on a signed URL; Infinity for an unsigned one. */
export function secondsRemaining(source, now = Date.now()) {
  if (!source?.expires) return Infinity;
  return Math.floor(source.expires - now / 1000);
}

/**
 * A signed URL that is about to lapse mid-seek produces a 403 the user reads
 * as a broken video. Re-mint anything inside the grace window.
 */
export function isStale(source, graceSeconds = 120) {
  return secondsRemaining(source) < graceSeconds;
}

/**
 * Attach a source to a <video>. Safari plays HLS natively; everywhere else
 * needs Media Source Extensions, so hls.js is expected on the page.
 *
 * @param {HTMLVideoElement} video
 * @param {{src: string, type: string, poster?: string}} source
 * @param {{Hls?: Function}} [deps]  pass the hls.js constructor explicitly in
 *                                   a bundler setup; falls back to window.Hls
 * @returns {() => void}  detach function — call it on unmount, or the hls.js
 *                        instance keeps buffering against a dead element.
 */
export function attachSource(video, source, deps = {}) {
  assertDirect(source.src);
  if (source.poster) video.poster = source.poster;

  const Hls = deps.Hls ?? (typeof window !== "undefined" ? window.Hls : undefined);
  const nativeHls = video.canPlayType("application/vnd.apple.mpegurl");

  if (source.type === "hls" && !nativeHls && Hls?.isSupported?.()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.loadSource(source.src);
    hls.attachMedia(video);
    return () => {
      hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }

  video.src = source.src;
  return () => {
    video.removeAttribute("src");
    video.load();
  };
}
