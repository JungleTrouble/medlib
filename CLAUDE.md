# MedLib

A private video library for one person: ~7,300 medical-education lectures
hosted on Bunny Stream, plus ~1,250 reference files (PDFs, Anki decks).
Single user, no accounts beyond one passphrase.

Local: `http://127.0.0.1:8000` · Hosted: `https://medlib-har1.onrender.com`

```bash
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
python -m pytest tests -q
```

---

## Architecture

**FastAPI + vanilla JS.** No build step, no framework. `server/` serves the
API and the static player; `player/` is the whole front end.

**Playback is direct HLS, never an embed.** The server mints a short-lived
signed URL and hands it to a `<video>` element via hls.js. Bunny's iframe
player is deliberately unused — which also means every setting on Bunny's
player configuration page is irrelevant here, including its custom CSS box.

**Two token styles, and the difference matters.** HLS uses Bunny's
*path-style* token (`/bcdn_token=…/path`). A master playlist lists its
variants as relative paths, and players do not copy the parent's query
string onto those requests — so a query-style token authorises the master
and nothing beneath it, and playback dies at the first variant. Query-style
is correct for single files like thumbnails. See `server/bunny_token.py`;
`token_path` must be omitted from path-style tokens or the edge 403s.

**Progress and playlists live in `localStorage`**, so they do not follow you
between devices. Moving them server-side is the top outstanding task.

---

## Data pipeline

```
python scripts/sync_bunny.py --all     # Bunny API -> bunny_catalog.json
                                       #            + bunny_collections.json
node scripts/build-catalog.mjs         # -> data/catalog.json   (the site reads this)
node scripts/build-asset-index.mjs     # -> data/assets.json
```

`data/catalog.json` and `data/assets.json` are **committed deliberately** —
the server reads them at runtime, and a deployment without them has an empty
library. Everything else generated is gitignored.

### Placement is a lookup, not a guess

Every Bunny video carries a `collectionId`, and every collection is named
with its full source path:

    Sketchy / Microbiology / Bacteria / Gram-Positive Bacilli

So `build-catalog.mjs` splits that name and the folder is known exactly.
All 7,333 videos are placed with nothing inferred.

**Superseded, kept only for reference:** `reconcile-bunny.mjs` (title
matching) and `match_by_duration.py` (runtime tie-breaking). Both existed
only because an earlier sync did not record `collectionId`, leaving the
folder unknowable. Do not reach for them unless collections disappear.

`scripts/audit-placement.mjs` reconciles the source library against the
catalogue and separates *not uploaded* from *unplaced*.

### Subjects

`lib/classify-video.js` assigns one of 35 subject buckets from the title and
folder, in tiers: explicit → section → qualified → brand-hint → prefix →
path → keyword → default. Every result reports which tier decided it, so a
bad assignment is traceable. Publisher names are stripped, never used to
choose behaviour. ~193 videos remain unresolved.

The same taxonomy lives in three places — `lib/classify-video.js`,
`config/buckets.yaml`, and `server/categorizer.py`. Retune one, retune all.

---

## Things that have each cost an hour

**Settings are read once at startup.** Change `.env` and nothing happens
until the server restarts. Same on Render: an environment variable change
needs a redeploy.

**Bump `?v=` in `player/index.html`** after editing `player.js` or
`player.css`. The browser will otherwise serve a stale copy and your change
will appear to do nothing. Currently `?v=22`.

**There are two referrer allowlists.** The app checks `ALLOWED_REFERRERS`
before signing; Bunny's pull zone checks its own list before serving. Both
need every hostname. Bunny's dashboard *replaces* the list rather than
appending — adding the Render host silently removed `localhost`, which broke
local thumbnails and playback.

**Render must actually deploy.** Pushing to `main` is not enough if
auto-deploy is off or failing. `curl -s <host>/api/health` returns the
catalogue's `generated_at`; if it is older than your last build, the running
service is stale. This masqueraded as "collections show nothing".

**The sidebar re-renders on every load**, discarding `on` classes. State is
re-applied at the end of `renderFilters()`; without that, a selection is
erased by the reload it triggered.

**`player.css` uses `--bg-2` / `--fg` / `--line`,** not the `--surface` /
`--text` / `--border` names in `css/styles.css`. Aliases are defined at the
bottom of the file. Using the wrong ones fails silently — undefined
variables produce no style at all.

---

## Outstanding

**Bunny encoding settings.** 234 GB of source is stored as 2,639 GB — 11×.
"Keep original files" is on, and 600 kbps slide recordings are being
upscaled to a 1080p/5,000 kbps ladder. Turning off originals and dropping
1080p should cut it 4–6×. Do this before considering any migration; object
storage is not meaningfully cheaper once the footprint is sane.

**Progress and playlists server-side** — needed the moment a second device
is used. A JSON file plus two endpoints, or a Render disk.

**Transcript search.** 1,838 subtitle files sit unused on disk. Uploading
them to Bunny as captions and indexing them would let you search what was
*said* across 1,400 hours. Whisper locally could cover the rest. Highest
value item on this list.

**151 videos failed transcoding** on Bunny and are excluded from the
catalogue. Real content, worth investigating.

**Asset share links.** `data/assets.json` has 1,251 files and no URLs — the
index was built from OneDrive paths. Supply `data/asset-links.json` mapping
filenames to links, or serve them from Bunny Storage instead.

**A collection called "IBM" with 4 videos** looks out of place.

---

## Conventions

Comments explain *why*, not what. Several here record a decision that looked
wrong later — the token style, the two allowlists, refusing to guess a
folder. Keep that: the reasoning is what stops the mistake being remade.

When a placement or match is uncertain, **decline rather than guess**. A
missing folder is visible; a wrong one is invisible and gets trusted.

Never commit `.env` or `bunny.config.local.json`. Verify against the pushed
tree, not just the ignore rules.
