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

**Progress, playlists and the watch-state filter live in `localStorage`**, so
they do not follow you between devices. Moving them server-side is the top
outstanding task. One consequence shows in the UI: the server cannot select
on watch state, so the Progress filter is applied to each page *after* it
arrives — which is why that view reports "297 shown · 300 of 359 checked"
rather than pretending the server's total is the answer. Paging still
advances by what the server sent; advancing by the filtered count would
re-request the dropped rows forever.

**Playlists come in two kinds.** A manual one stores ids; a smart one stores
the `filters` object and is therefore never stale. Entries written before
smart playlists existed have no `kind` field, so absent means manual and
there is no migration. A smart playlist opens through the ordinary catalog
path, which makes it both less code and faster than a manual one — the
manual opener fetches its members one id at a time.

**Queues come in two kinds, and ownership is the whole rule.** An
*inherited* queue is read off the DOM — `play(item, queue)` takes whatever
list you pressed play inside, because `appendCards` hangs the item on the
card element. That is why continuous playback works everywhere without any
list knowing queues exist, and it is never written to `localStorage`:
finding yesterday's half-finished rail waiting for you would be a bug.

An *owned* queue is one you built with Play next / Add to queue on a card's
`+` menu, or rearranged in the panel. Any manual edit sets `owned` and
persists it, which is also what stops a 300-row grid queue from quietly
overwriting the handful you assembled yesterday — only owned queues are
written, so clicking a card can never clobber the stored one. It comes back
as a pinned "▶ Queue" row above the playlists.

Unlike playlists, a queue stores whole items rather than ids. Playlists hold
ids so a re-titled video stays put; a queue is a short-lived working set,
and copies make restore cost zero API calls. `QUEUE_MAX_PERSIST` guards
against writing an entire result set.

**The front page is a resume card, not a poster.** Every streaming service
opens on something you have not seen, because their question is "what should
I watch tonight". This library's is "where was I" — the syllabus was already
chosen. So the hero shows the one lecture you stopped in the middle of, with
the progress bar as the largest graphic on the page, and carries the "also
taught by" row from `/api/related`, because 431 topics exist in two to four
publishers' versions and switching teacher mid-concept is the thing no
commercial library can do. Resume hands the whole folder over as the queue,
which is why there is no separate "and then keep going" button. With nothing
watched it inverts into an invitation rather than an apology.

The hero is a **fan**, not a filmstrip: absolutely positioned panes on a
`perspective` stage, side ones rotated inward with `rotateY`. That rotation
is the entire difference between an arc and a row of shrinking cards. The
ring wraps, because centring the most recent lecture would otherwise leave
nothing to its left and the whole thing would lean off one side; offsets are
computed as the shortest signed way round. Panes are a uniform size and the
title, progress and buttons live *below* the stage, so nothing reflows as it
moves — only that block changes. It never auto-advances: this is a list of
things you left unfinished, and having it move while you read a title would
be hostile.

**`/api/suggest-similar` is the only endpoint that leaves the machine.**
Hugging Face embeds the title, Pinecone returns neighbours. Unconfigured it
returns 503 and nothing else is affected — deliberately absent from
`missing_required()`, because refusing to boot over a recommendation service
would trade a working site for a broken one. Worth knowing before extending
it: at 7,333 titles this is two network hops to do what a numpy dot product
does faster than the round trip, and for video-to-video the query vector
could be precomputed. See `server/similar.py`.

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
will appear to do nothing. Currently `?v=28`. Note this does not cover
`index.html` itself — a cached index keeps asking for the old version, so
"nothing changed" after a bump usually means a hard refresh is needed.

**`font: inherit` is a shorthand.** `.brand` sets `font-weight: 700` in the
topbar block; a later rule used `font: inherit` to strip the button's
user-agent styling and silently reset the weight with it. The wordmark
rendered at 400 for months. Restate weight and tracking *after* any `font:`
shorthand.

**Two keydown handlers for the same keys is one too many.** There used to be
a second listener duplicating the player shortcuts, and both ran: ArrowRight
seeked 20s instead of 10, `f` toggled fullscreen off and back on. The single
handler in "Playback speed and keyboard control" is the one that stays.

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
is used. A JSON file plus two endpoints. The blocker is not accounts: there
is one user and the passphrase already identifies them. It is that Render's
free filesystem is ephemeral, so a JSON file there loses data on every
deploy and idle restart. Options, cheapest first: an UpCloud €3/mo Starter
box (1 GB / 1 vCPU / 10 GB *persistent* disk, less than half Render's $7/mo
paid tier); a single `state.json` PUT/GET against Bunny Storage, which adds
no new vendor; or a Render disk. A URL-fragment export is the zero-infra
stopgap — a 40-id playlist is about 1 KB.

**Do not move the video to object storage.** Checked August 2026: UpCloud
Managed Object Storage is €5/mo per 250 GB — €0.02/GB against Bunny Stream's
$0.01/GB, so roughly double, before losing free transcoding and the CDN. The
decisive part is signing: S3-compatible presigned URLs are query-style only,
which is exactly the failure documented under "Two token styles" — the
master playlist authorises and every variant 403s. Replicating Bunny's
path-style token means putting a signing proxy in the delivery path.

**Transcript search.** 1,838 subtitle files sit unused on disk. Uploading
them to Bunny as captions and indexing them would let you search what was
*said* across 1,400 hours. Whisper locally could cover the rest. Highest
value item on this list.

**151 videos failed transcoding** on Bunny and are excluded from the
catalogue. Real content, worth investigating.

**Asset share links.** `data/assets.json` has 1,251 files and no URLs, so
the Materials tab is browsable and entirely unopenable. The files themselves
are all present: matching filenames against the index's `source_root` —
`OneDrive - rush.edu/updated resources 11.09.24`, 37,564 files — resolves
1,078 of 1,251 exactly (103.8 GB), leaves 173 ambiguous because the filename
repeats across folders, and finds none missing. Blocked only on a Bunny
**Storage** zone: that is a separate product from Stream and has no
credentials in `.env` yet. Two things to know before starting — 75 archive
files are 73.6 GB of the 103.8, so the 574 PDFs at 30 GB are the cheaper
first pass; and resolve the ambiguous 173 by folder path rather than
picking, because a wrong file is invisible once uploaded.

**A collection called "IBM" with 4 videos** looks out of place.

**Populate the Pinecone index, or drop `/api/suggest-similar`.** Nothing
writes to it, so the endpoint returns an empty array against an empty index —
indistinguishable from a title with no neighbours. Either add an upsert
script or take the local-embeddings path described under Architecture. The
index must be 384-dimensional to match MiniLM.

---

## Conventions

Comments explain *why*, not what. Several here record a decision that looked
wrong later — the token style, the two allowlists, refusing to guess a
folder. Keep that: the reasoning is what stops the mistake being remade.

When a placement or match is uncertain, **decline rather than guess**. A
missing folder is visible; a wrong one is invisible and gets trusted.

Never commit `.env` or `bunny.config.local.json`. Verify against the pushed
tree, not just the ignore rules.
