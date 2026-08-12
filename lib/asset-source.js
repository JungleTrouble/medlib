/* ============================================================
   Asset parsing and share-link conversion.

   Reference material — PDFs, Anki decks, slide decks, archives — lives
   outside the video pipeline. These are standalone downloads, not timed
   companions to a lecture, so nothing here touches playback.

       import { parseAsset, toEmbedUrl, toDownloadUrl } from "@/lib/asset-source";

       parseAsset({ name: "First Aid 2026.pdf", url: driveShareLink });
       // { kind: "pdf", viewer: "embed", embedUrl: "...", downloadUrl: "...", ... }

   PUBLISHER NAMES ARE IGNORED. Behaviour is decided by extension alone: a
   file called "Pathoma.pdf" is routed exactly like "notes.pdf". Names never
   select a viewer.

   ON IFRAMES. Video playback deliberately avoids them — signed HLS goes
   straight to a <video> element. PDFs are the opposite case: Google Drive's
   only preview surface is an iframe, and there is no direct-render URL to
   use instead. The rule was about not handing video playback to someone
   else's player, and it still holds.
   ============================================================ */

/** Extensions that get an inline viewer. Everything else is download-only. */
const VIEWABLE = new Set(["pdf"]);

/** Recognised so the UI can label and icon them; still download-only. */
const KIND_BY_EXT = {
  pdf: "pdf",
  apkg: "anki",
  colpkg: "anki",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  pptx: "slides",
  ppt: "slides",
  docx: "document",
  doc: "document",
  odt: "document",
  rtf: "document",
  txt: "document",
  xlsx: "spreadsheet",
  csv: "spreadsheet",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
};

const LABEL_BY_KIND = {
  pdf: "PDF",
  anki: "Anki deck",
  archive: "Archive",
  slides: "Slides",
  document: "Document",
  spreadsheet: "Spreadsheet",
  image: "Image",
  other: "File",
};

export function extensionOf(name) {
  const m = String(name || "").match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? m[1].toLowerCase() : "";
}

export function kindOf(name) {
  return KIND_BY_EXT[extensionOf(name)] || "other";
}

export function labelForKind(kind) {
  return LABEL_BY_KIND[kind] || LABEL_BY_KIND.other;
}

/* ---------------------------------------------------------------
   Google Drive
   --------------------------------------------------------------- */

/**
 * Pull the file id out of any Drive share URL shape.
 * Handles /file/d/<id>/view, ?id=<id>, /d/<id>/ for Docs/Sheets/Slides.
 * Returns null for anything that is not recognisably Drive.
 */
/** Hostname of a URL, or "" when it does not parse. Used instead of matching
 *  the host inside the whole string: "https://drive.google.com/..." has no
 *  dot or string-start before the host, so a naive anchor never matches. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(url, suffixes) {
  const host = hostOf(url);
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

export function driveFileId(url) {
  const raw = String(url || "");
  if (!hostMatches(raw, ["drive.google.com", "docs.google.com"])) return null;

  const patterns = [
    /\/file\/d\/([A-Za-z0-9_-]{10,})/,          // /file/d/<id>/view
    /\/d\/([A-Za-z0-9_-]{10,})/,                 // /document/d/<id>/edit
    /[?&]id=([A-Za-z0-9_-]{10,})/,               // open?id= / uc?id=
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Native Google editors preview under their own path; an uploaded file
 *  (a PDF, an .apkg) previews under /file/d/. Using the file path for a
 *  Doc yields a broken frame, so the type is preserved when present. */
export function driveEmbedUrl(id, docType = null) {
  return docType
    ? `https://docs.google.com/${docType}/d/${id}/preview`
    : `https://drive.google.com/file/d/${id}/preview`;
}

/** "document" | "spreadsheets" | "presentation" for a native Google file. */
export function driveDocType(url) {
  const m = String(url || "").match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\//);
  return m ? m[1] : null;
}
export const driveDownloadUrl = (id) =>
  `https://drive.google.com/uc?export=download&id=${id}`;

/* ---------------------------------------------------------------
   OneDrive / SharePoint
   --------------------------------------------------------------- */

function isOneDrive(url) {
  return hostMatches(url, ["1drv.ms", "onedrive.live.com", "sharepoint.com"]);
}

/**
 * OneDrive share links carry their identity in opaque query parameters, so
 * unlike Drive there is no id to extract — the conversion is done by adding
 * parameters to the link you were given.
 *
 * `download=1` forces the file rather than the web viewer; `action=embedview`
 * is the documented embed mode. A 1drv.ms short link cannot be converted
 * without following the redirect first, which the browser cannot do
 * cross-origin, so those are left as plain links.
 */
function oneDriveUrls(url) {
  const raw = String(url);
  if (/1drv\.ms/i.test(raw)) {
    return { embedUrl: null, downloadUrl: raw, note: "short-link" };
  }
  const join = raw.includes("?") ? "&" : "?";
  return {
    embedUrl: `${raw}${join}action=embedview`,
    downloadUrl: `${raw}${join}download=1`,
    note: null,
  };
}

/* ---------------------------------------------------------------
   Public conversion helpers
   --------------------------------------------------------------- */

/**
 * A URL that renders the file inline, or null when the host offers no
 * embed surface. Never guesses: an unknown host returns null rather than
 * being dropped into an iframe and failing silently.
 */
export function toEmbedUrl(url) {
  if (!url) return null;
  const id = driveFileId(url);
  if (id) return driveEmbedUrl(id, driveDocType(url));
  if (isOneDrive(url)) return oneDriveUrls(url).embedUrl;
  return null;
}

/** A URL that downloads rather than opening a viewer. */
export function toDownloadUrl(url) {
  if (!url) return null;
  const id = driveFileId(url);
  if (id) return driveDownloadUrl(id);
  if (isOneDrive(url)) return oneDriveUrls(url).downloadUrl;
  return url;
}

/* ---------------------------------------------------------------
   parseAsset
   --------------------------------------------------------------- */

/**
 * @typedef {Object} ParsedAsset
 * @property {string}  ext          lowercase extension, "" when absent
 * @property {string}  kind         pdf | anki | archive | slides | document |
 *                                  spreadsheet | image | other
 * @property {string}  kindLabel    human label for that kind
 * @property {"embed"|"download"} viewer  how the UI should present it
 * @property {string|null} embedUrl  inline viewer URL, null when unavailable
 * @property {string|null} downloadUrl
 * @property {boolean} canPreview   true only when an embed URL really exists
 * @property {string|null} host     drive | onedrive | other | null
 * @property {string|null} warning  why preview is unavailable, when it is not
 */

/**
 * Route one asset to its viewer, by extension only.
 *
 * @param {Object|string} input  a filename, or { name, url, ... }
 * @returns {ParsedAsset}
 */
export function parseAsset(input) {
  const item = typeof input === "string" ? { name: input } : input || {};
  const name = String(item.name ?? item.filename ?? item.title ?? "");
  const url = item.url ?? item.link ?? null;

  const ext = extensionOf(name);
  const kind = kindOf(name);
  const embedUrl = VIEWABLE.has(ext) ? toEmbedUrl(url) : null;
  const downloadUrl = toDownloadUrl(url);

  let host = null;
  if (url) {
    if (driveFileId(url)) host = "drive";
    else if (isOneDrive(url)) host = "onedrive";
    else host = "other";
  }

  let warning = null;
  if (!url) {
    warning = "No share link yet";
  } else if (VIEWABLE.has(ext) && !embedUrl) {
    warning = host === "onedrive"
      ? "Short OneDrive links cannot be embedded; opens in a new tab"
      : "This host offers no inline preview; opens in a new tab";
  }

  // A 1drv.ms link is OneDrive even though it cannot be embedded, and the
  // UI should say so rather than calling it an unknown host.

  return {
    name,
    ext,
    kind,
    kindLabel: labelForKind(kind),
    viewer: embedUrl ? "embed" : "download",
    embedUrl,
    downloadUrl,
    canPreview: Boolean(embedUrl),
    host,
    warning,
  };
}
