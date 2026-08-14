/* ============================================================
   MedLib player — vanilla JS, no build step.

   Playback flow: a card click calls GET /api/token/<id>, gets back a signed
   URL with a short TTL, and hands it to the <video>. Nothing durable is ever
   put in the DOM — the URL dies with its token, and a token is re-minted on
   demand if the user leaves a card open past its expiry.

   HLS: everything except Safari needs Media Source Extensions via hls.js.
   Vendor it next to this file so playback does not depend on a CDN being
   reachable from wherever you are:

       curl -o player/hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js

   The remote URL is only a fallback for when the local copy is missing.
   ============================================================ */

const HLS_JS_LOCAL = "hls.min.js";
const HLS_JS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
const PAGE_SIZE = 300;
/* Re-mint if the token has under this many seconds left when playback starts. */
const EXPIRY_GRACE_S = 120;

const state = {
  items: [],
  buckets: [],
  levels: [],
  tags: [],
  total: 0,
  stats: {},
  offset: 0,
  loading: false,
  exhausted: false,
  view: "videos",
  filters: { bucket: null, level: null, tag: null, collection: null, section: null, folder: null, tags: [], playlist: null, progress: null, confidence: null, search: "" },
  sort: null,         // null = catalogue order; see SORTS
  fuzzy: false,       // last search fell back to approximate matching
  current: null,      // { id, expires, type }
  queue: null,        // { items, at } — see the Queue section
  hls: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  gate: $("gate"), loginForm: $("loginForm"), password: $("password"),
  loginBtn: $("loginBtn"), gateError: $("gateError"), app: $("app"),
  menuToggle: $("menuToggle"), sidebar: $("sidebar"), scrim: $("scrim"),
  searchInput: $("searchInput"), signOut: $("signOut"),
  bucketList: $("bucketList"), levelList: $("levelList"), tagCloud: $("tagCloud"),
  bucketGroups: $("bucketGroups"), collectionGroups: $("collectionGroups"),
  tabSubjects: $("tabSubjects"), tabSources: $("tabSources"),
  paneSubjects: $("paneSubjects"), paneSources: $("paneSources"),
  clearFilters: $("clearFilters"), buildStamp: $("buildStamp"), homeBtn: $("homeBtn"),
  playlistList: $("playlistList"), assetList: $("assetList"), viewVideos: $("viewVideos"), viewAssets: $("viewAssets"),
  docBackdrop: $("docBackdrop"), docFrame: $("docFrame"), docTitle: $("docTitle"),
  docDownload: $("docDownload"), docClose: $("docClose"),
  relatedBox: $("relatedBox"), speedBox: $("speedBox"), queueBox: $("queueBox"),
  saveView: $("saveView"), progressList: $("progressList"),
  reviewList: $("reviewList"), sortBox: $("sortBox"), fuzzyNote: $("fuzzyNote"),
  speedTrigger: $("speedTrigger"), helpToggle: $("helpToggle"), shortcuts: $("shortcuts"),
  queuePanel: $("queuePanel"), queueList: $("queueList"), queueAuto: $("queueAuto"),
  queueClose: $("queueClose"), queuePanelCount: $("queuePanelCount"),
  queueClear: $("queueClear"),
  resultsTitle: $("resultsTitle"), resultsCount: $("resultsCount"),
  activeFilters: $("activeFilters"), grid: $("grid"), sentinel: $("sentinel"),
  shelves: $("shelves"), hero: $("hero"),
  empty: $("empty"), loading: $("loading"),
  backdrop: $("playerBackdrop"), video: $("video"),
  videoMsg: $("videoMsg"), playerTitle: $("playerTitle"),
  playerBucket: $("playerBucket"), playerExpiry: $("playerExpiry"),
  playerClose: $("playerClose"),
};

/* ---------------------------------------------------------------
   API
   --------------------------------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    showGate();
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* non-JSON body */ }
    throw new Error(detail);
  }
  return res.json();
}

/* ---------------------------------------------------------------
   Auth gate
   --------------------------------------------------------------- */

function showGate() {
  el.gate.hidden = false;
  el.app.hidden = true;
  closePlayer();
}

function showApp() {
  el.gate.hidden = true;
  el.app.hidden = false;
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.gateError.hidden = true;
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = "Signing in…";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: el.password.value }),
    });
    el.password.value = "";
    showApp();
    await bootstrap();
  } catch (err) {
    el.gateError.textContent = err.message;
    el.gateError.hidden = false;
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = "Sign in";
  }
});

el.signOut.addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); }
  finally { location.reload(); }
});

/* ---------------------------------------------------------------
   Catalog
   --------------------------------------------------------------- */

function queryString(extra = {}) {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.bucket) p.set("bucket", f.bucket);
  if (f.level) p.set("level", f.level);
  for (const tag of f.tags || []) p.append("tag", tag);
  if (f.collection) p.set("collection", f.collection);
  if (f.section) p.set("section", f.section);
  if (f.folder) p.set("folder", f.folder);
  if (f.confidence) p.set("confidence", f.confidence);
  if (f.search) p.set("search", f.search);
  if (state.sort) p.set("sort", state.sort);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

/* Ordering is a server concern: sorting only the page you happen to have
   would put the shortest video *of the first 300* at the top and call it the
   shortest. "Recently added" is deliberately absent — every item carries
   mtime 0, so there is no honest date to sort on. */
const SORTS = [
  ["relevance", "Catalogue order"],
  ["title", "Title A–Z"],
  ["-title", "Title Z–A"],
  ["duration", "Shortest first"],
  ["-duration", "Longest first"],
];

/* Bumped on every reset. An in-flight response from an older generation is
   discarded rather than painted, so changing a filter mid-load cannot be
   silently dropped, and a slow response cannot overwrite a newer view. */
let loadGeneration = 0;

async function loadPage(reset = false) {
  // In the materials view a filter change reloads assets, not videos.
  if (state.view === "assets") return loadAssets();

  // A reset always wins: it is a direct response to something the user
  // clicked, and dropping it leaves the UI showing the wrong filter.
  if (state.loading && !reset) return;
  if (reset) {
    loadGeneration += 1;
    state.offset = 0;
    state.items = [];
    state.exhausted = false;
    el.grid.innerHTML = "";
  }
  if (state.exhausted) return;

  state.loading = true;
  el.loading.textContent = "Loading catalog…";
  el.loading.hidden = false;
  try {
    const mine = loadGeneration;
    const data = await api(
      `/api/catalog?${queryString({ offset: state.offset, limit: PAGE_SIZE })}`
    );
    if (mine !== loadGeneration) return;   // superseded while in flight
    state.buckets = data.buckets;
    state.levels = data.levels;
    state.tags = data.tags;
    state.total = data.total;
    state.fuzzy = !!data.fuzzy;
    state.stats = data.stats || state.stats;

    if (reset || !el.bucketList.childElementCount) renderFilters(data);
    if (data.generated_at) el.buildStamp.textContent = `Indexed ${data.generated_at}`;

    /* Paging is counted in what the server sent; the grid is filled with
       what survives the watch-state filter. Advancing the offset by the
       filtered count instead would re-request the rows it just dropped and
       loop forever on a page where nothing matches. */
    state.offset += data.items.length;
    state.exhausted = data.items.length < PAGE_SIZE || state.offset >= data.total;
    const shown = state.filters.progress
      ? data.items.filter((i) => passesProgress(i.id))
      : data.items;
    state.items.push(...shown);

    const folderNode = state.filters.folder ? folderIndex.get(state.filters.folder) : null;
    const stackable = folderNode && folderNode.children && folderNode.children.length;

    if (browsing()) {
      // Browse mode: the fetch above was only for the facet counts. Shelves
      // fetch their own rows, and infinite scroll stays parked.
      state.exhausted = true;
      el.shelves.hidden = false;
      el.grid.hidden = true;
      el.sentinel.hidden = true;
      renderShelves();
      renderHero();
    } else if (stackable && !state.filters.search.trim()) {
      // A folder with children: stack them as rows instead of pouring every
      // video in the branch into one grid.
      state.exhausted = true;
      el.shelves.hidden = false;
      el.grid.hidden = true;
      el.sentinel.hidden = true;
      renderFolderShelves(folderNode);
    } else {
      el.shelves.hidden = true;
      el.grid.hidden = false;
      el.sentinel.hidden = false;
      if (el.hero) el.hero.hidden = true;
      appendCards(shown);
    }
    renderSummary();
    el.loading.hidden = true;
  } catch (err) {
    if (err.message === "unauthenticated") {
      el.loading.hidden = true;
    } else {
      // Leave the banner visible — it is now carrying the error, not "Loading…".
      el.loading.textContent = `Could not load catalog: ${err.message}`;
      el.loading.hidden = false;
      state.exhausted = true;
    }
  } finally {
    state.loading = false;
  }

  // A short page can leave the sentinel still on screen; top it up.
  if (!state.exhausted) setTimeout(loadMoreIfNeeded, 0);
}

function renderSummary() {
  syncUrl();
  const f = state.filters;
  const bucket = state.buckets.find((b) => b.id === f.bucket);
  const smart = f.playlist ? smartPlaylist(f.playlist) : null;
  el.resultsTitle.textContent =
    smart ? smart.name
    : f.folder ? f.folder.split("/").join(" › ")
    : f.section ? `${f.collection} › ${f.section}`
    : f.collection ? f.collection
    : bucket ? bucket.label
    : "All subjects";

  /* With a watch-state filter the server's total is not the answer — it
     counts rows before localStorage got a say. Saying how far the scan has
     got is honest; showing "12 of 7,333" would not be. */
  el.resultsCount.textContent = browsing()
    ? `${state.total.toLocaleString()} videos`
    : f.progress
      ? `${state.items.length.toLocaleString()} shown · ` +
        `${state.offset.toLocaleString()} of ${state.total.toLocaleString()} checked`
      : `${state.items.length.toLocaleString()} of ${state.total.toLocaleString()}`;

  el.empty.hidden = browsing() ||
    (f.progress ? state.items.length !== 0 || !state.exhausted : state.total !== 0);

  for (const old of el.activeFilters.querySelectorAll(".chip")) old.remove();
  const chips = [
    ["bucket", bucket ? bucket.label : null],
    ["level", f.level],
    ["collection", f.collection],
    ["section", f.section],
    ["folder", f.folder ? f.folder.split("/").slice(-2).join(" › ") : null],
    ["progress", progressLabel(f.progress)],
    ["confidence", confidenceLabel(f.confidence)],
    ["search", f.search ? `“${f.search}”` : null],
  ];
  // One chip per selected tag, each removable on its own.
  for (const tag of f.tags || []) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(tag)} <span aria-hidden="true">&times;</span>`;
    chip.setAttribute("aria-label", `Remove tag ${tag}`);
    chip.addEventListener("click", () => {
      state.filters.tags = state.filters.tags.filter((x) => x !== tag);
      syncFilterUI();
      loadPage(true);
    });
    el.activeFilters.appendChild(chip);
  }

  for (const [key, label] of chips) {
    if (!label) continue;
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(label)} <span aria-hidden="true">&times;</span>`;
    chip.setAttribute("aria-label", `Remove filter ${label}`);
    chip.addEventListener("click", () => {
      state.filters[key] = key === "search" ? "" : null;
      if (key === "collection") state.filters.section = null;
      if (key === "search") el.searchInput.value = "";
      syncFilterUI();
      loadPage(true);
    });
    el.activeFilters.appendChild(chip);
  }

  renderSaveView();
  renderSortControl();

  /* Say when a result set is approximate. Silently showing near misses for a
     query that matched nothing reads as the search being bad at its job. */
  if (el.fuzzyNote) {
    el.fuzzyNote.hidden = !(state.fuzzy && f.search);
    if (!el.fuzzyNote.hidden) {
      el.fuzzyNote.textContent =
        `Nothing matched “${f.search}” exactly — showing close spellings.`;
    }
  }
}

/* Offered whenever the current view is something worth naming. appendChild
   on an element already in the box moves it, which keeps the button after
   the chips however many were just rebuilt. */
function renderSaveView() {
  if (!el.saveView) return;
  el.activeFilters.appendChild(el.saveView);
  const already = state.filters.playlist && smartPlaylist(state.filters.playlist);
  el.saveView.hidden = browsing() || state.view === "assets" || !!already;
}

function renderFilters(data) {
  renderSubjectGroups(data.buckets);
  noteCollectionColors(data.collections);
  indexFolders(data.folders);
  renderCollections(data.folders || []);

  el.levelList.innerHTML = "";
  for (const lvl of data.levels || []) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.level = lvl;
    btn.innerHTML = `<span class="lbl">${escapeHtml(lvl)}</span>`;
    btn.addEventListener("click", () => {
      state.filters.level = state.filters.level === lvl ? null : lvl;
      syncFilterUI();
      loadPage(true);
    });
    li.appendChild(btn);
    el.levelList.appendChild(li);
  }

  renderTagCloud(data.tagFacets || (data.tags || []).map((id) => ({ id, label: id, count: 0 })));
  renderProgressFilter();
  renderReviewFilter();
  renderPlaylistNav();

  /* The sidebar is rebuilt from scratch on every load, which throws away the
     `on` classes that syncFilterUI applied to the previous DOM. Re-applying
     here is what makes a selection survive the reload it triggered. */
  syncFilterUI();
}

/* Tags are multi-select and AND together, so each one you add narrows the
   result. With ~950 of them the list is searchable rather than a wall;
   whatever is currently selected always stays visible. */
function renderTagCloud(facets) {
  el.tagCloud.innerHTML = "";

  const box = document.createElement("input");
  box.type = "search";
  box.className = "tag-search";
  box.placeholder = `Filter ${facets.length.toLocaleString()} tags…`;
  box.setAttribute("aria-label", "Filter the tag list");
  el.tagCloud.appendChild(box);

  const list = document.createElement("div");
  list.className = "tag-list";
  el.tagCloud.appendChild(list);

  const paint = (needle = "") => {
    const q = needle.trim().toLowerCase();
    const shown = facets
      .filter((f) => !q || f.label.toLowerCase().includes(q) || f.id.includes(q)
                     || state.filters.tags.includes(f.id))
      .slice(0, 80);

    list.innerHTML = "";
    for (const f of shown) {
      const btn = document.createElement("button");
      btn.className = "tag";
      btn.dataset.tag = f.id;
      btn.setAttribute("aria-pressed", String(state.filters.tags.includes(f.id)));
      btn.innerHTML = `${escapeHtml(f.label)}` +
        (f.count ? `<span class="n">${f.count.toLocaleString()}</span>` : "");
      btn.addEventListener("click", () => {
        const at = state.filters.tags.indexOf(f.id);
        if (at > -1) state.filters.tags.splice(at, 1);
        else state.filters.tags.push(f.id);
        syncFilterUI();
        loadPage(true);
      });
      list.appendChild(btn);
    }
    if (!shown.length) {
      list.innerHTML = `<p class="side-note">No tag matches “${escapeHtml(needle)}”.</p>`;
    }
  };

  let paintTimer = null;
  box.addEventListener("input", () => {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(() => paint(box.value), 120);
  });
  paint();
}

/* Subjects, grouped and collapsible. Groups holding the current selection
   open on render, so a filter is never hidden inside a closed drawer. */
function renderSubjectGroups(buckets) {
  const byId = new Map((buckets || []).map((b) => [b.id, b]));
  el.bucketGroups.innerHTML = "";

  for (const [groupName, ids] of SUBJECT_GROUPS) {
    const present = ids.map((id) => byId.get(id)).filter((b) => b && b.count);
    if (!present.length) continue;

    const total = present.reduce((n, b) => n + b.count, 0);
    const holdsSelection = present.some((b) => b.id === state.filters.bucket);

    const box = document.createElement("details");
    box.className = "side-group";
    box.open = holdsSelection;
    box.innerHTML =
      `<summary>${escapeHtml(groupName)}<span class="n">${total.toLocaleString()}</span></summary>`;

    const list = document.createElement("ul");
    list.className = "filter-list";
    for (const b of present) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.dataset.bucket = b.id;
      btn.innerHTML =
        `<span class="dot" style="background:${b.color}"></span>` +
        `<span class="lbl">${escapeHtml(b.label)}</span>` +
        `<span class="n">${b.count.toLocaleString()}</span>`;
      btn.addEventListener("click", () => {
        state.filters.bucket = state.filters.bucket === b.id ? null : b.id;
        state.filters.collection = null;
        state.filters.section = null;
        syncFilterUI();
        loadPage(true);
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    box.appendChild(list);
    el.bucketGroups.appendChild(box);
  }
}

/* Sources: the library's own folder tree, at its real depth. Sketchy runs
   six levels down to "Old but Gold Sketchys > Micro > Bacteria > 01 - Gram
   Positive Cocci", and flattening that to one level is what leaves a few
   hundred videos sitting in an undifferentiated list.

   Children are built the first time a folder is opened. The tree is ~1,050
   nodes; rendering all of it up front would cost more DOM than the whole
   grid, to show rows nobody has asked for yet. */
function renderCollections(folders) {
  el.collectionGroups.innerHTML = "";

  if (!folders || !folders.length) {
    el.collectionGroups.innerHTML =
      `<p class="side-note">No source data yet. Run <code>node scripts/reconcile-bunny.mjs --write</code>.</p>`;
    return;
  }

  for (const node of folders) {
    el.collectionGroups.appendChild(folderNode(node, 0));
  }
}

function folderNode(node, depth) {
  const openPath = state.filters.folder || "";
  const onPath = openPath === node.path || openPath.startsWith(node.path + "/");

  // A leaf is a plain button; only a folder with children needs a disclosure.
  if (!node.children || !node.children.length) {
    const btn = folderButton(node, depth);
    const wrap = document.createElement("div");
    wrap.className = "folder-leaf";
    wrap.appendChild(btn);
    return wrap;
  }

  const box = document.createElement("details");
  box.className = "side-group folder-node";
  box.style.setProperty("--depth", String(depth));
  box.open = onPath;

  const sum = document.createElement("summary");
  sum.innerHTML =
    `${escapeHtml(node.label)}<span class="n">${node.count.toLocaleString()}</span>`;
  box.appendChild(sum);

  const body = document.createElement("div");
  body.className = "folder-children";
  box.appendChild(body);

  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    body.appendChild(folderButton(node, depth, `Everything in ${node.label}`));
    for (const child of node.children) body.appendChild(folderNode(child, depth + 1));
  };

  if (box.open) build();
  box.addEventListener("toggle", () => { if (box.open) build(); });

  return box;
}

function folderButton(node, depth, label) {
  const btn = document.createElement("button");
  btn.className = label ? "side-all" : "folder-item";
  btn.dataset.folder = node.path;
  btn.style.setProperty("--depth", String(depth));
  btn.innerHTML = label
    ? escapeHtml(label)
    : `<span class="lbl">${escapeHtml(node.label)}</span>` +
      `<span class="n">${node.count.toLocaleString()}</span>`;
  btn.addEventListener("click", () => {
    const same = state.filters.folder === node.path;
    state.filters.folder = same ? null : node.path;
    state.filters.collection = null;
    state.filters.section = null;
    state.filters.bucket = null;
    syncFilterUI();
    loadPage(true);
    closeSidebar();
  });
  return btn;
}

function selectSideTab(which) {
  const sources = which === "sources";
  el.tabSources.classList.toggle("on", sources);
  el.tabSubjects.classList.toggle("on", !sources);
  el.tabSources.setAttribute("aria-selected", String(sources));
  el.tabSubjects.setAttribute("aria-selected", String(!sources));
  el.paneSources.hidden = !sources;
  el.paneSubjects.hidden = sources;
}


function syncFilterUI() {
  for (const b of document.querySelectorAll("#bucketGroups button[data-bucket]"))
    b.classList.toggle("on", b.dataset.bucket === state.filters.bucket);
  for (const b of el.levelList.querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.level === state.filters.level);
  for (const b of el.progressList.querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.progress === state.filters.progress);
  for (const b of el.reviewList.querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.confidence === state.filters.confidence);
  for (const b of el.tagCloud.querySelectorAll("button[data-tag]")) {
    const on = state.filters.tags.includes(b.dataset.tag);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  for (const b of document.querySelectorAll("#collectionGroups button[data-folder]"))
    b.classList.toggle("on", b.dataset.folder === state.filters.folder);
  for (const b of document.querySelectorAll("#collectionGroups button[data-collection]"))
    b.classList.toggle("on",
      b.dataset.collection === state.filters.collection && !state.filters.section);
  for (const b of document.querySelectorAll("#collectionGroups button[data-section]"))
    b.classList.toggle("on",
      b.dataset.section === state.filters.section &&
      b.dataset.sectionCollection === state.filters.collection);

  markSelectedGroups();
}

/* Flag any <details> holding a selected control, and open it. Without this a
   filter can be active inside a closed drawer with nothing on screen saying
   so, which reads as the app ignoring your click. */
function markSelectedGroups() {
  for (const box of document.querySelectorAll(".side-group")) {
    box.classList.remove("has-selection");
  }
  for (const on of document.querySelectorAll(
    "#bucketGroups .on, #collectionGroups .on, #tagCloud .on, #levelList .on, "
    + "#progressList .on, #reviewList .on"
  )) {
    let box = on.closest("details.side-group");
    while (box) {
      box.classList.add("has-selection");
      box.open = true;
      box = box.parentElement ? box.parentElement.closest("details.side-group") : null;
    }
  }
}


/* A subject pill, unless the subject is unknown — in which case saying
   "Uncategorized" on the card tells you nothing you could act on, and the
   source is the more useful label. */
function subjectPill(item, bucket) {
  if (!bucket || item.bucket === "uncategorized") return "";
  return `<span class="pill" style="--accent:${bucket.color}">${escapeHtml(bucket.label)}</span>`;
}

/* Where it came from. Outlined rather than filled, so a source is never
   mistaken for a subject at a glance even though both carry colour. */
function sourcePill(item) {
  if (!item.collection) return "";
  const color = collectionColors.get(item.collection) || "var(--text-muted)";
  return `<span class="pill pill-source" style="--accent:${color}">` +
         `${escapeHtml(item.collection)}</span>`;
}

/* Source colours, keyed by collection name. Filled from /api/catalog so the
   palette lives with the data rather than being duplicated here. */
const collectionColors = new Map();

/* path -> node, so a folder filter can find its children without walking
   the tree on every render. */
const folderIndex = new Map();

function indexFolders(nodes) {
  for (const n of nodes || []) {
    folderIndex.set(n.path, n);
    indexFolders(n.children);
  }
}

function noteCollectionColors(collections) {
  for (const c of collections || []) {
    if (c.label && c.color) collectionColors.set(c.label, c.color);
  }
}

function appendCards(items, container = el.grid) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const bucket = state.buckets.find((b) => b.id === item.bucket);
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Play ${item.title}`);
    card.innerHTML = `
      <div class="thumb" style="--accent:${bucket ? bucket.color : "#5a5f6b"}">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M6 4l15 8-15 8V4z" fill="currentColor"/>
        </svg>
        ${item.duration ? `<span class="dur">${escapeHtml(item.duration)}</span>` : ""}
      </div>
      <div class="card-body">
        <h4>${escapeHtml(item.title)}</h4>
        <p class="card-sub">
          ${subjectPill(item, bucket)}
          ${sourcePill(item)}
        </p>
      </div>`;
    /* The card carries its own item so a queue can be read straight off the
       DOM at play time. That is what makes "play continues through whatever
       you were looking at" work in the grid, in a shelf rail and inside a
       playlist without any of them knowing about queues. */
    card._item = item;
    const open = () => play(item, queueFrom(card));
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    const plus = document.createElement("button");
    plus.className = "card-add";
    plus.type = "button";
    plus.title = "Add to a playlist";
    plus.setAttribute("aria-label", `Add ${item.title} to a playlist`);
    plus.textContent = "+";
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlaylistMenu(plus, item.id);
    });
    card.appendChild(plus);
    if (playlistsFor(item.id).length) card.classList.add("in-playlist");

    applyProgress(card, item.id);
    queuePoster(card, item.id);
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

/* ---------------------------------------------------------------
   Browse shelves — one horizontal row per subject.

   A flat grid is right once you have said what you want. Before that it is
   6,555 undifferentiated cards, which is no more navigable than the folder
   it came from. Shelves give the library a shape you can scan.

   Each row fetches its own first page only as it nears the viewport, so
   opening the page costs a request per visible shelf rather than 35.
   --------------------------------------------------------------- */

/* Subject groups, in the same order as BUCKETS in lib/classify-video.js.
   35 flat entries is a scroll; four labelled groups is a glance. */
const SUBJECT_GROUPS = [
  ["Foundational", ["anatomy", "physiology", "biochemistry", "histology", "embryology",
                    "genetics", "pathology", "pharmacology", "microbiology", "immunology"]],
  ["Organ systems", ["cardiology", "pulmonology", "neurology", "gastro", "renal", "endocrine",
                     "heme", "oncology", "musculoskeletal", "rheumatology", "dermatology",
                     "reproductive", "ophthalmology", "ent"]],
  ["Clinical", ["obgyn", "pediatrics", "psychiatry", "surgery", "emergency", "radiology",
                "infectious"]],
  ["Practice", ["publichealth", "biostats", "nursing", "uncategorized"]],
];

const SHELF_LIMIT = 24;

/* The top rows are above the fold by definition, so they load without
   waiting to be observed. IntersectionObserver does not fire in a tab that
   is not compositing — a background tab, or a window restored behind
   another — and a page of empty rows is worse than a page of slow ones. */
const EAGER_SHELVES = 3;

/* How many subject rows the front page opens with. The sidebar lists all 35
   with counts and is the way to reach any of them directly; the front page's
   job is to be short enough to scan, not to be a complete index. */
const FRONT_SHELVES = 8;
const SHELF_STEP = 8;

const shelfFilled = new Set();
let shelfObserver = null;
let shelfBudget = FRONT_SHELVES;

function browsing() {
  const f = state.filters;
  return !f.bucket && !f.level && !f.tags.length && !f.collection && !f.section &&
    !f.folder && !f.progress && !f.confidence && !state.sort && !f.search.trim();
}

/* ---------------------------------------------------------------
   The front page

   Every streaming service opens on a poster for something you have never
   seen, because their question is "what should I watch tonight". This
   library's question is "where was I, and what is next" — you already chose
   the syllabus. So the hero is a resume card: the one lecture you actually
   stopped in the middle of, with the progress bar as the largest graphic on
   the page.

   The other half is the thing no commercial service has. 431 of these
   topics exist in two to four publishers' versions, and /api/related
   already finds them. When an explanation is not landing, the useful move
   is the same lesson from someone else — so that sits inside the hero
   rather than three clicks into the player.

   With nothing watched the card inverts into an invitation, because an
   empty first screen should point somewhere rather than apologise.
   --------------------------------------------------------------- */

function libraryHours() {
  const secs = state.stats?.total_seconds || 0;
  return Math.round(secs / 3600);
}

/** Hours behind you and lectures finished, both exact from localStorage. */
function watchedTotals() {
  const all = loadProgress();
  let seconds = 0;
  let finished = 0;
  for (const p of Object.values(all)) {
    if (p.done) { seconds += p.d || 0; finished += 1; }
    else seconds += p.t || 0;
  }
  return { hours: seconds / 3600, finished };
}

function renderRibbon() {
  const { hours, finished } = watchedTotals();
  const total = libraryHours();
  const parts = [];
  if (hours >= 1) parts.push(`<b>${hours.toFixed(0)}</b> hours watched`);
  if (finished) parts.push(`<b>${finished.toLocaleString()}</b> finished`);
  // Inventory alone is not a statistic worth leading with, so the library's
  // size only appears next to what you have done with it.
  parts.push(`<b>${total.toLocaleString()}</b> hours in the library`);
  return `<p class="hero-ribbon">${parts.join("<span class='dot'>·</span>")}</p>`;
}

/* How many lectures the carousel will hold. Beyond this the Continue
   watching shelf takes over — a carousel you have to page through seven
   times is a list wearing a costume. */
const HERO_PANES = 7;

/* Geometry of the fan. The side panes rotate *inward* so the row reads as a
   shallow arc rather than a flat filmstrip; that rotation is the whole
   difference between this and a row of cards. */
const PANE_STEP = 58;     // % of pane width between neighbours
const PANE_TILT = 24;     // degrees of Y-rotation per step
const PANE_SHRINK = 0.17; // scale lost per step
const PANE_VISIBLE = 2;   // neighbours drawn either side

let heroItems = [];
let heroAt = 0;

async function renderHero() {
  const box = el.hero;
  if (!box) return;

  if (!browsing() || state.view === "assets") {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  const ids = resumableIds(HERO_PANES);
  if (!ids.length) return renderColdHero(box);

  const items = [];
  for (const id of ids) {
    try {
      items.push(await api(`/api/catalog/${encodeURIComponent(id)}`));
    } catch {
      forgetProgress(id);   // gone from the catalogue since it was watched
    }
  }
  if (!items.length) return renderColdHero(box);

  heroItems = items;
  heroAt = 0;

  box.innerHTML = `
    <p class="hero-eyebrow">Pick up where you left off</p>
    <div class="hero-stage" id="heroStage" role="group" aria-label="Lectures in progress"></div>
    <div class="hero-dots" id="heroDots" role="tablist" aria-label="Choose a lecture"></div>
    <div class="hero-detail" id="heroDetail"></div>
    ${renderRibbon()}`;

  buildHeroPanes();
  buildHeroDots();
  centreHero(0, { instant: true });
  wireHeroGestures();
  loadHeroPosters();
}

function buildHeroPanes() {
  const stage = el.hero.querySelector("#heroStage");
  stage.innerHTML = "";
  heroItems.forEach((item, i) => {
    const bucket = state.buckets.find((b) => b.id === item.bucket);
    const accent = bucket ? bucket.color : "var(--accent)";
    const pane = document.createElement("article");
    pane.className = "pane";
    pane.dataset.index = String(i);
    pane.dataset.id = item.id;
    pane.style.setProperty("--sub", accent);
    pane.innerHTML = `
      <div class="pane-art">
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <path d="M6 4l15 8-15 8V4z" fill="currentColor"/>
        </svg>
      </div>
      <div class="pane-veil"></div>
      <div class="pane-label">
        <span class="pane-pub">${escapeHtml(item.collection || "")}</span>
        <span class="pane-title">${escapeHtml(item.title)}</span>
      </div>
      <span class="pane-dur">${escapeHtml(item.duration || "")}</span>
      <div class="pane-bar"><i style="background:${accent}"></i></div>`;
    pane.querySelector(".pane-bar i").style.width =
      `${Math.round(progressFraction(item.id) * 100)}%`;

    // A side pane centres; the centre pane plays. Same click, read from
    // where the pane currently sits rather than from what it holds.
    pane.addEventListener("click", () => {
      if (Number(pane.dataset.index) === heroAt) playFromFolder(heroItems[heroAt]);
      else centreHero(Number(pane.dataset.index));
    });
    stage.appendChild(pane);
  });
}

function buildHeroDots() {
  const dots = el.hero.querySelector("#heroDots");
  dots.innerHTML = "";
  // One lecture is not a carousel; the dots would be a single dead dot.
  dots.hidden = heroItems.length < 2;
  if (dots.hidden) return;

  heroItems.forEach((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hero-dot";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", item.title);
    b.addEventListener("click", () => centreHero(i));
    dots.appendChild(b);
  });
}

/** Lay the fan out around `i`, and swap the detail block underneath. */
function centreHero(i, { instant = false } = {}) {
  const n = heroItems.length;
  if (!n) return;

  /* The ring wraps. Centring the most recent lecture would otherwise leave
     nothing to its left and the fan would lean off one side of the stage —
     and "cycle through" is what the dots imply anyway. */
  heroAt = ((i % n) + n) % n;
  const stage = el.hero.querySelector("#heroStage");
  if (!stage) return;

  stage.classList.toggle("no-anim", instant);

  for (const pane of stage.querySelectorAll(".pane")) {
    // Shortest signed way round, so pane 4 of 5 sits to the *left* of pane 0.
    let off = Number(pane.dataset.index) - heroAt;
    if (off > n / 2) off -= n;
    if (off < -n / 2) off += n;
    const dist = Math.abs(off);
    const beyond = dist > PANE_VISIBLE;
    const scale = Math.max(0.4, 1 - dist * PANE_SHRINK);

    pane.style.transform =
      `translate(-50%, 0) translateX(${off * PANE_STEP}%) ` +
      `rotateY(${off * -PANE_TILT}deg) scale(${scale})`;
    pane.style.zIndex = String(20 - dist);
    pane.style.opacity = beyond ? "0" : String(1 - dist * 0.22);
    pane.style.pointerEvents = beyond ? "none" : "auto";
    pane.classList.toggle("is-centre", off === 0);
    pane.setAttribute("aria-hidden", String(beyond));
  }

  for (const [n, dot] of [...el.hero.querySelectorAll(".hero-dot")].entries()) {
    dot.classList.toggle("on", n === heroAt);
    dot.setAttribute("aria-selected", String(n === heroAt));
  }

  if (instant) {
    // Force the layout in before animations are allowed again, or the first
    // paint animates every pane in from the centre.
    void stage.offsetWidth;
    stage.classList.remove("no-anim");
  }

  renderHeroDetail(heroItems[heroAt]);
}

/* The title, progress and actions live below the fan rather than inside the
   centre pane. Panes stay a uniform size that way, so nothing reflows as the
   carousel moves — only this block changes. */
function renderHeroDetail(item) {
  const box = el.hero.querySelector("#heroDetail");
  if (!box || !item) return;

  const p = getProgress(item.id) || { t: 0, d: 0 };
  const pct = Math.round(progressFraction(item.id) * 100);
  const left = Math.max(0, (p.d || 0) - (p.t || 0));
  const bucket = state.buckets.find((b) => b.id === item.bucket);
  const accent = bucket ? bucket.color : "var(--accent)";

  box.innerHTML = `
    <h2 class="hero-title">${escapeHtml(item.title)}</h2>
    <p class="hero-meta">
      ${item.collection ? `<span>${escapeHtml(item.collection)}</span>` : ""}
      ${bucket ? `<span style="color:${accent}">${escapeHtml(bucket.label)}</span>` : ""}
      <span>${formatClock(left)} left</span>
    </p>
    <div class="hero-bar" role="img" aria-label="${pct}% watched">
      <i style="width:${pct}%; background:${accent}"></i>
    </div>
    <div class="hero-actions">
      <button class="hero-go" type="button" id="heroResume">Resume at ${formatClock(p.t || 0)}</button>
      <button class="hero-alt" type="button" id="heroFolder">Rest of this section</button>
    </div>
    <div class="hero-also" id="heroAlso" hidden></div>`;

  box.querySelector("#heroResume").addEventListener("click", () => playFromFolder(item));
  box.querySelector("#heroFolder").addEventListener("click", () => {
    if (item.folder) openFolder(item.folder);
  });

  renderHeroAlso(item);
}

/* Arrow keys when the fan has focus, and a horizontal drag anywhere on it.
   No auto-advance: this is a list of things you left unfinished, and having
   it move on its own while you read a title would be hostile. */
function wireHeroGestures() {
  const stage = el.hero.querySelector("#heroStage");
  if (!stage || heroItems.length < 2) return;

  stage.tabIndex = 0;
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); centreHero(heroAt + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); centreHero(heroAt - 1); }
  });

  let startX = null;
  let moved = false;
  stage.addEventListener("pointerdown", (e) => { startX = e.clientX; moved = false; });
  stage.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    if (Math.abs(e.clientX - startX) > 8) moved = true;
  });
  const end = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) < 40) return;
    centreHero(heroAt + (dx < 0 ? 1 : -1));
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", () => { startX = null; });
  // A drag should not also count as a click on whichever pane it ended over.
  stage.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); moved = false; } }, true);
}

/** One signed request for every pane's still, rather than one per pane. */
async function loadHeroPosters() {
  const ids = heroItems.map((i) => i.id).join(",");
  if (!ids) return;
  try {
    const posters = await api(`/api/posters?ids=${encodeURIComponent(ids)}`);
    for (const pane of el.hero.querySelectorAll(".pane")) {
      const art = posters[pane.dataset.id];
      if (!art || !art.poster) continue;
      const img = pane.querySelector(".pane-art");
      img.style.backgroundImage = `url("${art.poster}")`;
      img.classList.add("has-art");
    }
  } catch {
    /* the gradient placeholder is a perfectly good fallback */
  }
}

/**
 * Resume, with the rest of the section queued behind it.
 *
 * Pressing play in a list is what normally builds a queue, and the hero is
 * not a list — so it fetches the folder and hands it over, which is also
 * what makes "and then keep going" work without a second button.
 */
async function playFromFolder(item) {
  if (!item.folder) return play(item);
  try {
    const data = await api(`/api/catalog?folder=${encodeURIComponent(item.folder)}&limit=200`);
    const items = data.items || [];
    const at = items.findIndex((i) => i.id === item.id);
    if (at < 0 || items.length < 2) return play(item);
    play(item, { items, at });
  } catch {
    play(item);
  }
}

/** The same lesson, taught by someone else. The library's one real edge. */
async function renderHeroAlso(item) {
  const box = el.hero.querySelector("#heroAlso");
  if (!box) return;
  try {
    const data = await api(`/api/related/${encodeURIComponent(item.id)}`);
    const related = data.related || [];
    if (!related.length) return;

    box.hidden = false;
    box.innerHTML = `<span class="hero-also-label">Also taught by</span>`;
    for (const r of related.slice(0, 4)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hero-also-item";
      btn.style.setProperty("--accent", collectionColors.get(r.collection) || "var(--accent)");
      btn.innerHTML =
        `<span>${escapeHtml(r.collection || "Another")}</span>` +
        `<span class="hero-also-dur">${escapeHtml(r.duration || "")}</span>`;
      btn.addEventListener("click", () => play(r));
      box.appendChild(btn);
    }
  } catch {
    /* related is a bonus; the hero stands without it */
  }
}

function renderColdHero(box) {
  const total = libraryHours();
  box.innerHTML = `
    <p class="hero-eyebrow">Nothing started yet</p>
    <h2 class="hero-title">${total.toLocaleString()} hours, ${state.total.toLocaleString()} lectures.</h2>
    <p class="hero-meta"><span>Begin anywhere — the short ones are a gentle way in.</span></p>
    <div class="hero-actions">
      <button class="hero-go" type="button" id="heroShort">Start with something short</button>
      <button class="hero-alt" type="button" id="heroBrowse">Browse by subject</button>
    </div>
    ${renderRibbon()}`;

  // No ribbon here: with nothing watched it could only repeat the library
  // size, which the headline just said.
  box.querySelector(".hero-ribbon")?.remove();

  box.querySelector("#heroShort").addEventListener("click", () => {
    state.sort = "duration";
    state.filters.progress = "unwatched";
    syncFilterUI();
    loadPage(true);
  });
  box.querySelector("#heroBrowse").addEventListener("click", () => {
    el.sidebar.classList.add("open");
    el.scrim.classList.add("on");
  });
}

function renderShelves(reset = true) {
  if (shelfObserver) shelfObserver.disconnect();
  el.shelves.innerHTML = "";
  shelfFilled.clear();
  if (reset) shelfBudget = FRONT_SHELVES;

  startShelfObserver();
  renderContinueShelf();

  const withVideos = state.buckets.filter((b) => b.count);
  const shown = withVideos.slice(0, shelfBudget);

  shown.forEach((bucket, index) => {
    const shelf = createShelf({
      label: bucket.label,
      color: bucket.color,
      count: bucket.count,
      query: `bucket=${encodeURIComponent(bucket.id)}`,
      onSeeAll: () => {
        state.filters.bucket = bucket.id;
        state.filters.folder = null;
        syncFilterUI();
        loadPage(true);
        window.scrollTo({ top: 0 });
      },
    });
    mountShelf(shelf, index);
  });

  const remaining = withVideos.length - shown.length;
  if (remaining > 0) {
    const more = document.createElement("button");
    more.className = "shelf-more";
    more.type = "button";
    more.textContent = `Show more subjects (${remaining} left)`;
    more.addEventListener("click", () => {
      shelfBudget += SHELF_STEP;
      renderShelves(false);
    });
    el.shelves.appendChild(more);
  } else if (withVideos.length > FRONT_SHELVES) {
    const note = document.createElement("p");
    note.className = "shelf-end";
    note.textContent = "That's every subject. Use the sidebar to jump straight to one.";
    el.shelves.appendChild(note);
  }
}

/* Opening a folder shows its children stacked as rows, the same shape as the
   front page. Browsing "Everything in Sketchy" as one flat wall of 1,139
   cards tells you nothing about how it is organised; one row per section
   does. A folder with no children has nothing to stack, so it stays a grid. */
function renderFolderShelves(node) {
  if (shelfObserver) shelfObserver.disconnect();
  el.shelves.innerHTML = "";
  shelfFilled.clear();
  startShelfObserver();

  const crumb = document.createElement("p");
  crumb.className = "shelf-crumb";
  crumb.textContent = node.path.split("/").join(" › ");
  el.shelves.appendChild(crumb);

  node.children.forEach((child, index) => {
    const shelf = createShelf({
      label: child.label,
      color: collectionColors.get(node.path.split("/")[0]) || "var(--accent)",
      count: child.count,
      query: `folder=${encodeURIComponent(child.path)}`,
      onSeeAll: child.children && child.children.length
        ? () => { openFolder(child.path); }
        : null,
      seeAllLabel: child.children && child.children.length ? "Open" : null,
    });
    mountShelf(shelf, index);
  });
}

/* Continue watching: whatever you left part-finished, most recent first.
   Rendered before the subject rows because a half-watched lecture is almost
   always what you came back for. Absent entirely when there is nothing to
   resume, rather than sitting there empty.

   It cannot use createShelf: the entries come from localStorage as a list of
   ids, not from a catalog query, so it fetches them individually. */
async function renderContinueShelf() {
  // The carousel is holding the first HERO_PANES of these, so this row
  // picks up after them rather than repeating what is already on screen.
  const ids = resumableIds().slice(HERO_PANES);
  if (!ids.length) return;

  const shelf = document.createElement("section");
  shelf.className = "shelf shelf-continue";
  shelf.dataset.exhausted = "true";
  shelf.innerHTML = `
    <header class="shelf-head">
      <h3><span class="shelf-rule" style="background:var(--accent)"></span>Continue watching</h3>
      <span class="shelf-count">${ids.length}</span>
      <button class="shelf-all" type="button" id="clearContinue">Clear</button>
    </header>
    <div class="rail">
      <button class="rail-arrow back" type="button" hidden aria-label="Scroll back">&lsaquo;</button>
      <div class="rail-track"></div>
      <button class="rail-arrow fwd" type="button" aria-label="Scroll forward">&rsaquo;</button>
    </div>`;
  el.shelves.appendChild(shelf);

  const track = shelf.querySelector(".rail-track");
  const back = shelf.querySelector(".rail-arrow.back");
  const fwd = shelf.querySelector(".rail-arrow.fwd");
  const page = (dir) =>
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: "smooth" });
  back.addEventListener("click", () => page(-1));
  fwd.addEventListener("click", () => page(1));
  track.addEventListener("scroll", () => {
    back.hidden = track.scrollLeft <= 8;
    fwd.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
  });

  shelf.querySelector("#clearContinue").addEventListener("click", () => {
    for (const id of ids) forgetProgress(id);
    shelf.remove();
    refreshProgressUI();
  });

  const items = [];
  for (const id of ids) {
    try {
      items.push(await api(`/api/catalog/${encodeURIComponent(id)}`));
    } catch {
      // Gone from the catalogue since it was watched — drop it quietly.
      forgetProgress(id);
    }
  }
  if (!items.length) { shelf.remove(); return; }
  appendCards(items, track);
  track.dispatchEvent(new Event("scroll"));
}

function openFolder(path) {
  state.filters.folder = path;
  state.filters.bucket = null;
  state.filters.collection = null;
  state.filters.section = null;
  syncFilterUI();
  loadPage(true);
  window.scrollTo({ top: 0 });
}

function startShelfObserver() {
  if (typeof IntersectionObserver === "undefined") { shelfObserver = null; return; }
  shelfObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      shelfObserver.unobserve(entry.target);
      fillShelf(entry.target);
    }
  }, { rootMargin: "500px" });
}

function mountShelf(shelf, index) {
  el.shelves.appendChild(shelf);
  if (!shelfObserver || index < EAGER_SHELVES) fillShelf(shelf);
  else shelfObserver.observe(shelf);
}

/* One row. `query` is the catalog filter it pages through, so the same shelf
   serves a subject, a folder, or anything else the API can select. */
function createShelf({ label, color, count, query, onSeeAll, seeAllLabel }) {
  const shelf = document.createElement("section");
  shelf.className = "shelf";
  shelf.dataset.query = query;
  shelf.dataset.offset = "0";
  shelf.innerHTML = `
    <header class="shelf-head">
      <h3>
        <span class="shelf-rule" style="background:${color}"></span>
        ${escapeHtml(label)}
      </h3>
      <span class="shelf-count">${count.toLocaleString()}</span>
    </header>
    <div class="rail">
      <button class="rail-arrow back" type="button" hidden
              aria-label="Scroll ${escapeHtml(label)} back">&lsaquo;</button>
      <div class="rail-track"></div>
      <button class="rail-arrow fwd" type="button"
              aria-label="More in ${escapeHtml(label)}">&rsaquo;</button>
    </div>`;

  if (onSeeAll) {
    const btn = document.createElement("button");
    btn.className = "shelf-all";
    btn.type = "button";
    btn.textContent = seeAllLabel || "See all";
    btn.addEventListener("click", onSeeAll);
    shelf.querySelector(".shelf-head").appendChild(btn);
  }

  const track = shelf.querySelector(".rail-track");
  const back = shelf.querySelector(".rail-arrow.back");
  const fwd = shelf.querySelector(".rail-arrow.fwd");

  const page = (dir) =>
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: "smooth" });

  back.addEventListener("click", () => page(-1));
  fwd.addEventListener("click", () => {
    page(1);
    // Pressing forward near the end should keep the row going rather than
    // stopping at whatever the first page happened to contain.
    if (track.scrollLeft + track.clientWidth >= track.scrollWidth - track.clientWidth) {
      fillShelf(shelf, { more: true });
    }
  });

  track.addEventListener("scroll", () => {
    back.hidden = track.scrollLeft <= 8;
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
    fwd.hidden = atEnd && shelf.dataset.exhausted === "true";
    if (atEnd) fillShelf(shelf, { more: true });
  });

  return shelf;
}

/* Fetch one page for a shelf and append it. Called on first mount and again
   whenever the rail reaches its end, so a long section keeps unrolling
   instead of stopping at 24. */
async function fillShelf(shelf, { more = false } = {}) {
  const query = shelf.dataset.query;
  const offset = Number(shelf.dataset.offset || 0);

  if (shelf.dataset.loading === "true") return;
  if (shelf.dataset.exhausted === "true") return;
  if (!more && offset > 0) return;

  shelf.dataset.loading = "true";
  try {
    const data = await api(`/api/catalog?${query}&offset=${offset}&limit=${SHELF_LIMIT}`);
    const items = data.items || [];
    const track = shelf.querySelector(".rail-track");
    appendCards(items, track);

    shelf.dataset.offset = String(offset + items.length);
    if (items.length < SHELF_LIMIT || offset + items.length >= data.total) {
      shelf.dataset.exhausted = "true";
    }
    track.dispatchEvent(new Event("scroll"));
  } catch {
    // One failed row should not take the page down with it.
    if (offset === 0) shelf.remove();
  } finally {
    shelf.dataset.loading = "false";
  }
}

/* ---------------------------------------------------------------
   Asset library

   PDFs, Anki decks, slide decks, archives. Standalone reference material:
   nothing here syncs to a video timeline, and none of it goes through the
   token endpoint — these are links to files on Drive, not signed CDN URLs.

   The sidebar's subject, tag and folder filters apply unchanged, which is
   the point: "Microbiology" should mean the same thing whether you are
   after a lecture or a deck.
   --------------------------------------------------------------- */

const ASSET_PAGE = 120;

function assetQuery() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.bucket) p.set("bucket", f.bucket);
  if (f.folder) p.set("folder", f.folder);
  for (const tag of f.tags || []) p.append("tag", tag);
  if (f.search) p.set("search", f.search);
  p.set("limit", String(ASSET_PAGE));
  return p.toString();
}

async function loadAssets() {
  el.loading.textContent = "Loading materials…";
  el.loading.hidden = false;
  try {
    const data = await api(`/api/assets?${assetQuery()}`);
    renderAssets(data);
    el.loading.hidden = true;
  } catch (err) {
    if (err.message !== "unauthenticated") {
      el.loading.textContent = `Could not load materials: ${err.message}`;
    }
  }
}

function renderAssets(data) {
  el.assetList.innerHTML = "";
  el.resultsCount.textContent =
    `${data.total.toLocaleString()} of ${(data.counts?.assets || 0).toLocaleString()}`;

  if (!data.items.length) {
    el.assetList.innerHTML = `<p class="empty">No materials match those filters.</p>`;
    return;
  }

  /* One banner rather than a warning per row: with no links loaded yet every
     card would carry the same notice, which is noise, not information. */
  const missing = data.items.filter((a) => !a.url).length;
  if (missing) {
    const note = document.createElement("p");
    note.className = "asset-note";
    note.innerHTML = missing === data.items.length
      ? `None of these have a share link yet. Add <code>data/asset-links.json</code> ` +
        `and re-run <code>node scripts/build-asset-index.mjs</code>.`
      : `${missing.toLocaleString()} of these have no share link yet.`;
    el.assetList.appendChild(note);
  }

  const frag = document.createDocumentFragment();
  for (const a of data.items) {
    const row = document.createElement("article");
    row.className = "asset";
    row.dataset.kind = a.kind;

    const actions = a.canPreview
      ? `<button class="asset-btn primary" data-act="view">View</button>
         <a class="asset-btn" href="${escapeHtml(a.downloadUrl)}" target="_blank"
            rel="noopener noreferrer" download>Download</a>`
      : a.downloadUrl
        ? `<a class="asset-btn primary" href="${escapeHtml(a.downloadUrl)}" target="_blank"
              rel="noopener noreferrer" download>Download</a>`
        : `<span class="asset-btn disabled" aria-disabled="true">No link</span>`;

    row.innerHTML = `
      <span class="asset-kind" data-kind="${escapeHtml(a.kind)}">${escapeHtml(a.kindLabel)}</span>
      <span class="asset-main">
        <span class="asset-title" title="${escapeHtml(a.filename)}">${escapeHtml(a.title)}</span>
        <span class="asset-meta">${escapeHtml(a.folder || "")}</span>
      </span>
      <span class="asset-size">${formatBytes(a.sizeBytes)}</span>
      <span class="asset-actions">${actions}</span>`;

    const view = row.querySelector('[data-act="view"]');
    if (view) view.addEventListener("click", () => openDoc(a));
    frag.appendChild(row);
  }
  el.assetList.appendChild(frag);
}

function formatBytes(n) {
  if (!n) return "";
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function openDoc(asset) {
  el.docTitle.textContent = asset.title;
  el.docDownload.href = asset.downloadUrl || "#";
  el.docFrame.src = asset.embedUrl;
  el.docBackdrop.hidden = false;
  document.body.classList.add("locked");
}

function closeDoc() {
  // Clear the src so the embedded viewer stops loading in the background.
  el.docFrame.src = "about:blank";
  el.docBackdrop.hidden = true;
  document.body.classList.remove("locked");
}

/* Switch between the video library and the material library. Filters are
   shared, so whatever is selected carries across. */
function setView(view, { reload = true } = {}) {
  const assets = view === "assets";
  state.view = assets ? "assets" : "videos";

  el.viewAssets.classList.toggle("on", assets);
  el.viewVideos.classList.toggle("on", !assets);
  el.viewAssets.setAttribute("aria-selected", String(assets));
  el.viewVideos.setAttribute("aria-selected", String(!assets));

  el.assetList.hidden = !assets;
  if (assets) {
    el.shelves.hidden = true;
    el.grid.hidden = true;
    el.sentinel.hidden = true;
    el.empty.hidden = true;
    el.resultsTitle.textContent = "Study materials";
    loadAssets();
  } else if (reload) {
    el.resultsTitle.textContent = "All subjects";
    loadPage(true);
  }
}

/* ---------------------------------------------------------------
   Playlists

   Your own groupings — a course, a weak topic, a shortlist. Stored in
   localStorage beside the watch progress, for the same reason: there are no
   accounts here, and a private library on one machine does not need a
   server round trip to remember that you like a video.

   A playlist holds ids, not copies. Renaming or re-tagging a video in the
   catalogue leaves playlists intact, and an id that disappears is dropped
   quietly when the playlist is opened.
   --------------------------------------------------------------- */

const PLAYLIST_KEY = "medlib:playlists:v1";

let playlistCache = null;

function loadPlaylists() {
  if (playlistCache) return playlistCache;
  try {
    playlistCache = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || "{}");
  } catch {
    playlistCache = {};
  }
  return playlistCache;
}

function persistPlaylists() {
  try {
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify(loadPlaylists()));
  } catch {
    /* quota or private mode; the list simply will not survive a reload */
  }
  renderPlaylistNav();
}

function createPlaylist(name) {
  const all = loadPlaylists();
  const id = `pl_${Date.now().toString(36)}`;
  all[id] = { id, name: name.trim() || "Untitled", ids: [], at: Date.now() };
  persistPlaylists();
  return all[id];
}

/* A smart playlist stores the filters, not the results, so it is never out
   of date — a video added to the library next week is in it already.
   Entries written before this existed have no `kind`, which is why absent
   means "manual" rather than there being a migration. */
function createSmartPlaylist(name, filters) {
  const all = loadPlaylists();
  const id = `pl_${Date.now().toString(36)}`;
  all[id] = {
    id,
    kind: "smart",
    name: name.trim() || "Untitled view",
    // Snapshot, and without `playlist` — a saved view that remembers being
    // opened as a playlist would reopen itself forever.
    filters: { ...EMPTY_STATE_FILTERS(), ...filters, playlist: null },
    at: Date.now(),
  };
  persistPlaylists();
  return all[id];
}

function isSmart(pl) {
  return !!pl && pl.kind === "smart";
}

/** The playlist behind an id, but only if it is a smart one. */
function smartPlaylist(id) {
  const pl = loadPlaylists()[id];
  return isSmart(pl) ? pl : null;
}

function renamePlaylist(id, name) {
  const pl = loadPlaylists()[id];
  if (!pl) return;
  pl.name = name.trim() || pl.name;
  persistPlaylists();
  // The heading is only rewritten by a load, and a rename does not trigger
  // one — so the open list would keep its old name until the next click.
  if (state.filters.playlist === id) el.resultsTitle.textContent = pl.name;
}

function deletePlaylist(id) {
  delete loadPlaylists()[id];
  if (state.filters.playlist === id) {
    state.filters.playlist = null;
    loadPage(true);
  }
  persistPlaylists();
}

function togglePlaylistItem(playlistId, videoId) {
  const pl = loadPlaylists()[playlistId];
  if (!pl) return false;
  const at = pl.ids.indexOf(videoId);
  if (at > -1) pl.ids.splice(at, 1);
  else pl.ids.push(videoId);
  pl.at = Date.now();
  persistPlaylists();
  return at === -1;
}

function playlistsFor(videoId) {
  return manualPlaylists().filter((pl) => pl.ids.includes(videoId));
}

/** Only these can hold a video; a smart playlist has filters, not members. */
function manualPlaylists() {
  return Object.values(loadPlaylists()).filter((pl) => !isSmart(pl) && Array.isArray(pl.ids));
}

/* ---- sidebar ---- */

function renderPlaylistNav() {
  const box = el.playlistList;
  if (!box) return;
  box.innerHTML = "";

  /* A queue you built by hand outlives the player it was built in, so it
     needs a way back. Pinned above the playlists because it is the thing
     you are most likely to be returning to. */
  const stored = state.queue?.owned ? state.queue : loadStoredQueue();
  if (stored) {
    const li = document.createElement("li");
    li.className = "queue-nav";

    const resume = document.createElement("button");
    resume.innerHTML =
      `<span class="lbl">▶ Queue</span><span class="n">${stored.items.length}</span>`;
    resume.title = `Resume: ${stored.items[stored.at]?.title || ""}`;
    resume.addEventListener("click", () => {
      closeSidebar();
      play(stored.items[stored.at], stored);
    });

    const kill = document.createElement("button");
    kill.className = "pl-del";
    kill.textContent = "×";
    kill.setAttribute("aria-label", "Clear the queue");
    kill.addEventListener("click", (e) => {
      e.stopPropagation();
      clearStoredQueue();
    });

    li.appendChild(resume);
    li.appendChild(kill);
    box.appendChild(li);
  }

  const lists = Object.values(loadPlaylists()).sort((a, b) => b.at - a.at);

  for (const pl of lists) {
    const smart = isSmart(pl);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.playlist = pl.id;
    btn.className = state.filters.playlist === pl.id ? "on" : "";
    // A saved view has no fixed size to report, so it gets a marker where a
    // manual list gets its count. Printing a stale number would be worse.
    btn.innerHTML =
      `<span class="lbl">${escapeHtml(pl.name)}</span>` +
      (smart ? `<span class="n pl-smart" title="Saved view">⌁</span>`
             : `<span class="n">${pl.ids.length}</span>`);
    btn.addEventListener("click", () => (smart ? openSmartPlaylist(pl.id) : openPlaylist(pl.id)));
    // Double-click to rename: discoverable enough for a control you use
    // once per playlist, and it costs no sidebar width.
    btn.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const name = prompt("Rename", pl.name);
      if (name !== null) renamePlaylist(pl.id, name);
    });

    const kill = document.createElement("button");
    kill.className = "pl-del";
    kill.title = `Delete ${pl.name}`;
    kill.setAttribute("aria-label", `Delete playlist ${pl.name}`);
    kill.textContent = "×";
    kill.addEventListener("click", (e) => {
      e.stopPropagation();
      const warn = smart
        ? `Delete the saved view "${pl.name}"?`
        : `Delete the playlist "${pl.name}"? The videos stay in the library.`;
      if (confirm(warn)) deletePlaylist(pl.id);
    });

    li.appendChild(btn);
    li.appendChild(kill);
    box.appendChild(li);
  }

  const add = document.createElement("button");
  add.className = "pl-new";
  add.type = "button";
  add.textContent = lists.length ? "New playlist" : "Create your first playlist";
  add.addEventListener("click", () => {
    const name = prompt("Name this playlist");
    if (name !== null) createPlaylist(name);
  });
  box.appendChild(add);
}

async function openPlaylist(id) {
  const pl = loadPlaylists()[id];
  if (!pl) return;

  state.filters = { ...EMPTY_STATE_FILTERS(), playlist: id };
  el.searchInput.value = "";
  syncFilterUI();
  renderPlaylistNav();
  closeSidebar();
  setView("videos", { reload: false });

  el.shelves.hidden = true;
  el.grid.hidden = false;
  el.sentinel.hidden = true;
  el.grid.innerHTML = "";
  el.resultsTitle.textContent = pl.name;
  el.activeFilters.innerHTML = "";
  el.loading.textContent = "Loading playlist…";
  el.loading.hidden = false;

  const items = [];
  for (const videoId of pl.ids) {
    try {
      items.push(await api(`/api/catalog/${encodeURIComponent(videoId)}`));
    } catch {
      // Dropped from the catalogue since it was added.
      const at = pl.ids.indexOf(videoId);
      if (at > -1) pl.ids.splice(at, 1);
      persistPlaylists();
    }
  }

  el.resultsCount.textContent = rollup(items);
  el.loading.hidden = true;
  if (!items.length) {
    el.grid.innerHTML =
      `<p class="empty">Nothing in this playlist yet. Use the + on any video to add one.</p>`;
    return;
  }
  appendCards(items, el.grid);
}

/**
 * Open a saved view: restore its filters and let the ordinary catalog path
 * do the rest.
 *
 * This is the whole reason smart playlists are cheap. A manual playlist has
 * to fetch its members one id at a time; a saved view is one paginated
 * request that already knows how to infinite-scroll, so it is both less
 * code and faster the moment a list gets long.
 */
async function openSmartPlaylist(id) {
  const pl = smartPlaylist(id);
  if (!pl) return;

  state.filters = { ...EMPTY_STATE_FILTERS(), ...pl.filters, playlist: id };
  el.searchInput.value = state.filters.search || "";
  syncFilterUI();
  renderPlaylistNav();
  closeSidebar();
  setView("videos", { reload: false });
  loadPage(true);
}

/* ---- how much of a list is left ---- */

/** "12:04" or "1:02:03" back into seconds. The inverse of formatClock. */
function parseClock(text) {
  if (!text) return 0;
  const parts = String(text).split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * "12 of 40 watched · 6.2 h left".
 *
 * Only offered where the whole list is known. A saved view is paged, so its
 * count says how far the scan has got instead — a rollup over the first page
 * would read as a total and be wrong.
 */
function rollup(items) {
  if (!items.length) return "0 saved";
  let done = 0;
  let left = 0;
  for (const item of items) {
    const secs = parseClock(item.duration);
    const frac = progressFraction(item.id);
    if (frac >= 1) done += 1;
    left += secs * (1 - frac);
  }
  const hours = left / 3600;
  const remaining = hours >= 1 ? `${hours.toFixed(1)} h left`
    : `${Math.max(0, Math.round(left / 60))} min left`;
  return `${done} of ${items.length} watched · ${remaining}`;
}

/* ---- the + control on a card ---- */

function openPlaylistMenu(anchor, videoId) {
  document.querySelector(".pl-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "pl-menu";

  /* Queueing sits above the playlists because it is the lighter action.
     Lining something up for the next twenty minutes should not require
     inventing and naming a playlist first. */
  const item = state.items.find((i) => i.id === videoId) ||
    document.querySelector(`.card[data-id="${CSS.escape(videoId)}"]`)?._item;

  if (item) {
    const said = {
      started: "Queue started",
      added: "Added to the queue",
      moved: "Moved in the queue",
      current: "That one is playing now",
    };
    for (const [label, where] of [["Play next", "next"], ["Add to queue", "end"]]) {
      const row = document.createElement("button");
      row.className = "pl-menu-item pl-menu-queue";
      row.textContent = label;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        toast(said[queueInsert(item, where)] || "Queued");
        menu.remove();
      });
      menu.appendChild(row);
    }
    /* Progress you did not earn by playing. You learn things elsewhere, and
       a library that only believes its own player will drift away from what
       you actually still need to watch — which is exactly what the Progress
       filters and smart playlists are reading. */
    const done = progressFraction(item.id) >= 1;
    const mark = document.createElement("button");
    mark.className = "pl-menu-item pl-menu-queue";
    mark.textContent = done ? "Mark as unwatched" : "Mark as watched";
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      if (done) {
        forgetProgress(item.id);
      } else {
        const secs = parseClock(item.duration) || 1;
        recordProgress(item.id, secs, secs, item.title);
      }
      refreshProgressUI();
      toast(done ? "Marked unwatched" : "Marked watched");
      menu.remove();
    });
    menu.appendChild(mark);

    const rule = document.createElement("div");
    rule.className = "pl-menu-rule";
    menu.appendChild(rule);
  }

  const lists = manualPlaylists().sort((a, b) => b.at - a.at);

  if (!lists.length) {
    // Appended, not assigned: innerHTML here would wipe the queue rows above.
    const none = document.createElement("p");
    none.className = "pl-menu-empty";
    none.textContent = "No playlists yet.";
    menu.appendChild(none);
  }
  for (const pl of lists) {
    const row = document.createElement("button");
    const inIt = pl.ids.includes(videoId);
    row.className = `pl-menu-item${inIt ? " on" : ""}`;
    row.innerHTML = `<span>${escapeHtml(pl.name)}</span><span>${inIt ? "✓" : "+"}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlaylistItem(pl.id, videoId);
      openPlaylistMenu(anchor, videoId);   // repaint the ticks in place
    });
    menu.appendChild(row);
  }

  const make = document.createElement("button");
  make.className = "pl-menu-new";
  make.textContent = "New playlist…";
  make.addEventListener("click", (e) => {
    e.stopPropagation();
    const name = prompt("Name this playlist");
    if (name === null) return;
    const pl = createPlaylist(name);
    togglePlaylistItem(pl.id, videoId);
    menu.remove();
  });
  menu.appendChild(make);

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 240)}px`;
  document.body.appendChild(menu);

  const away = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      menu.remove();
      document.removeEventListener("click", away);
    }
  };
  setTimeout(() => document.addEventListener("click", away), 0);
}

function EMPTY_STATE_FILTERS() {
  return { bucket: null, level: null, collection: null, section: null,
           folder: null, tags: [], playlist: null, progress: null,
           confidence: null, search: "" };
}

/* ---------------------------------------------------------------
   Watch-state filter

   The one filter the server cannot answer. Progress lives in localStorage,
   so these are applied to each page after it arrives — which is why the
   result count has to say how much was scanned rather than pretending the
   server's total is the answer.
   --------------------------------------------------------------- */

const PROGRESS_MODES = [
  ["unwatched", "Not started"],
  ["inprogress", "In progress"],
  ["done", "Finished"],
];

function passesProgress(id) {
  const mode = state.filters.progress;
  if (!mode) return true;
  const p = getProgress(id);
  // Below RESUME_MIN_SECONDS you did not really start it, which is the same
  // threshold the Continue shelf uses. Two definitions of "started" would be
  // one too many.
  const started = !!p && !p.done && p.t >= RESUME_MIN_SECONDS;
  if (mode === "unwatched") return !p || (!p.done && !started);
  if (mode === "inprogress") return started;
  if (mode === "done") return !!p && p.done;
  return true;
}

function renderProgressFilter() {
  if (!el.progressList) return;
  el.progressList.innerHTML = "";
  for (const [id, label] of PROGRESS_MODES) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.progress = id;
    btn.innerHTML = `<span class="lbl">${label}</span>`;
    btn.addEventListener("click", () => {
      state.filters.progress = state.filters.progress === id ? null : id;
      syncFilterUI();
      loadPage(true);
    });
    li.appendChild(btn);
    el.progressList.appendChild(li);
  }
}

function progressLabel(mode) {
  return (PROGRESS_MODES.find(([id]) => id === mode) || [null, null])[1];
}

/* ---------------------------------------------------------------
   Needs review

   1,248 videos were placed by the weakest tier and 193 by none at all.
   Until they can be reached they can only be fixed as a batch job, which
   means never. One filter turns them into something you can chip at while
   you are already here.
   --------------------------------------------------------------- */

function renderReviewFilter() {
  if (!el.reviewList) return;
  el.reviewList.innerHTML = "";
  for (const [id, label] of [["review", "Low confidence"], ["none", "No subject at all"]]) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.confidence = id;
    btn.innerHTML = `<span class="lbl">${label}</span>`;
    btn.addEventListener("click", () => {
      state.filters.confidence = state.filters.confidence === id ? null : id;
      syncFilterUI();
      loadPage(true);
    });
    li.appendChild(btn);
    el.reviewList.appendChild(li);
  }
}

function confidenceLabel(mode) {
  return mode === "review" ? "Low confidence" : mode === "none" ? "No subject" : null;
}

/* ---- ordering ---- */

/* Built once and then only re-synced. renderSummary runs on every load, and
   rebuilding the <select> there would drop keyboard focus out of the control
   the moment your choice took effect. */
function renderSortControl() {
  const box = el.sortBox;
  if (!box) return;

  let sel = box.querySelector("select");
  if (!sel) {
    sel = document.createElement("select");
    sel.setAttribute("aria-label", "Sort order");
    for (const [id, label] of SORTS) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      state.sort = sel.value === "relevance" ? null : sel.value;
      loadPage(true);
    });
    box.appendChild(sel);
  }
  sel.value = state.sort || "relevance";
}

/* ---------------------------------------------------------------
   Card previews

   Bunny renders two assets per video: thumbnail.jpg (a still) and
   preview.webp (a few seconds of animated scrub). Both sit behind token
   auth, so both need signing — but a shelf of 24 cards must not be 24
   calls, hence /api/posters taking a batch.

   Stills load as cards approach the viewport. The animated preview is only
   fetched on hover: it is the larger asset and most cards are never
   hovered, so loading it eagerly would spend bandwidth on nothing.
   --------------------------------------------------------------- */

const posterCache = new Map();   // id -> { poster, preview }
let posterQueue = [];
let posterTimer = null;

function queuePoster(card, id) {
  const known = posterCache.get(id);
  if (known) { paintPoster(card, known); return; }

  posterQueue.push({ card, id });
  clearTimeout(posterTimer);
  // Coalesce everything queued in the same tick into one request.
  posterTimer = setTimeout(flushPosters, 60);
}

async function flushPosters() {
  const batch = posterQueue.splice(0, 60);
  if (!batch.length) return;
  if (posterQueue.length) posterTimer = setTimeout(flushPosters, 60);

  const ids = [...new Set(batch.map((b) => b.id))];
  try {
    const data = await api(`/api/posters?ids=${ids.map(encodeURIComponent).join(",")}`);
    for (const [id, entry] of Object.entries(data)) posterCache.set(id, entry);
    for (const { card, id } of batch) {
      const entry = posterCache.get(id);
      if (entry) paintPoster(card, entry);
    }
  } catch {
    /* No posters is the pre-existing look, not a failure state. */
  }
}

function paintPoster(card, entry) {
  const thumb = card.querySelector(".thumb");
  if (!thumb || !entry.poster) return;

  const img = new Image();
  img.onload = () => {
    thumb.style.backgroundImage = `url("${entry.poster}")`;
    thumb.classList.add("has-poster");
  };
  img.src = entry.poster;

  if (!entry.preview) return;

  // Swap to the animated scrub on hover, fetched the first time it is needed.
  let hoverLoaded = false;
  const enter = () => {
    if (hoverLoaded) { thumb.classList.add("playing-preview"); return; }
    hoverLoaded = true;
    const anim = new Image();
    anim.onload = () => {
      thumb.style.setProperty("--preview", `url("${entry.preview}")`);
      thumb.classList.add("playing-preview");
    };
    anim.src = entry.preview;
  };
  const leave = () => thumb.classList.remove("playing-preview");

  card.addEventListener("mouseenter", enter);
  card.addEventListener("mouseleave", leave);
  card.addEventListener("focusin", enter);
  card.addEventListener("focusout", leave);
}

/* ---------------------------------------------------------------
   Watch progress

   Kept in localStorage, keyed by video id. No account, no server write —
   the browser remembers where you stopped, which is how streaming sites do
   this for signed-out visitors.

   The trade-off is worth knowing: this is per browser and per machine.
   Clearing site data forgets it, and your phone will not know what your
   laptop watched. Moving it server-side is a small change (see the note in
   the response) and is what to do if you ever want it to follow you.
   --------------------------------------------------------------- */

const PROGRESS_KEY = "medlib:progress:v1";

/* Below this, you did not really start; above it, you effectively finished.
   Both ends exist to stop the row filling with noise — a video you poked at
   for 10 seconds is not something to resume. */
const RESUME_MIN_SECONDS = 20;
const COMPLETE_FRACTION = 0.93;

/* Cap the store so a long history cannot grow without bound. */
const PROGRESS_MAX_ENTRIES = 400;

let progressCache = null;

function loadProgress() {
  if (progressCache) return progressCache;
  try {
    progressCache = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch {
    progressCache = {};
  }
  return progressCache;
}

function persistProgress() {
  const all = loadProgress();
  const ids = Object.keys(all);
  if (ids.length > PROGRESS_MAX_ENTRIES) {
    // Drop the least recently watched.
    ids.sort((a, b) => (all[b].at || 0) - (all[a].at || 0))
      .slice(PROGRESS_MAX_ENTRIES)
      .forEach((id) => delete all[id]);
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* private mode or a full quota — progress is a nicety, not a failure */
  }
}

function getProgress(id) {
  return loadProgress()[id] || null;
}

function recordProgress(id, seconds, duration, title) {
  if (!id || !Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return;
  const all = loadProgress();
  const done = seconds / duration >= COMPLETE_FRACTION;
  all[id] = {
    t: done ? 0 : Math.floor(seconds),
    d: Math.floor(duration),
    done,
    at: Date.now(),
    title: title || all[id]?.title || "",
  };
  persistProgress();
}

function forgetProgress(id) {
  const all = loadProgress();
  delete all[id];
  persistProgress();
}

/** Fraction watched, 0..1, for the bar on a card. */
function progressFraction(id) {
  const p = getProgress(id);
  if (!p) return 0;
  if (p.done) return 1;
  return p.d ? Math.min(1, p.t / p.d) : 0;
}

/** Videos worth offering to resume, most recent first. */
function resumableIds(limit = SHELF_LIMIT) {
  const all = loadProgress();
  return Object.entries(all)
    .filter(([, p]) => !p.done && p.t >= RESUME_MIN_SECONDS)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, limit)
    .map(([id]) => id);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/* ---------------------------------------------------------------
   URL state

   Every filter lives in the query string, so a view can be bookmarked,
   sent to yourself, or reached with the back button. Without this the app
   has exactly one address and the browser's own navigation does nothing,
   which is the kind of gap you stop noticing and never stop being annoyed
   by.

   replaceState on the first paint, pushState afterwards: the initial
   render should not add a history entry you have to press back through.
   --------------------------------------------------------------- */

let urlPrimed = false;

function filtersToQuery() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.bucket) p.set("subject", f.bucket);
  if (f.level) p.set("level", f.level);
  if (f.folder) p.set("folder", f.folder);
  if (f.collection) p.set("source", f.collection);
  if (f.section) p.set("section", f.section);
  if (f.playlist) p.set("playlist", f.playlist);
  if (f.progress) p.set("progress", f.progress);
  if (f.confidence) p.set("review", f.confidence);
  if (state.sort) p.set("sort", state.sort);
  for (const tag of f.tags || []) p.append("tag", tag);
  if (f.search) p.set("q", f.search);
  if (state.view === "assets") p.set("view", "materials");
  return p.toString();
}

function syncUrl() {
  const qs = filtersToQuery();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  // Prime on the very first call even when the URL is unchanged. Returning
  // early without priming meant the first real filter change still used
  // replaceState, so it created no history entry and back did nothing.
  if (url === location.pathname + location.search) {
    urlPrimed = true;
    return;
  }
  if (urlPrimed) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  urlPrimed = true;
}

/** Read filters back out of the address bar. */
function filtersFromUrl() {
  const p = new URLSearchParams(location.search);
  return {
    filters: {
      bucket: p.get("subject"),
      level: p.get("level"),
      folder: p.get("folder"),
      collection: p.get("source"),
      section: p.get("section"),
      playlist: p.get("playlist"),
      progress: PROGRESS_MODES.some(([id]) => id === p.get("progress")) ? p.get("progress") : null,
      confidence: ["review", "none"].includes(p.get("review")) ? p.get("review") : null,
      tags: p.getAll("tag"),
      search: p.get("q") || "",
    },
    view: p.get("view") === "materials" ? "assets" : "videos",
  };
}

function applyUrlState({ replace = false } = {}) {
  const { filters, view } = filtersFromUrl();
  const sort = new URLSearchParams(location.search).get("sort");
  state.sort = SORTS.some(([id]) => id === sort) && sort !== "relevance" ? sort : null;
  state.filters = { ...EMPTY_STATE_FILTERS(), ...filters, tags: filters.tags || [] };
  el.searchInput.value = state.filters.search;
  urlPrimed = !replace;

  const saved = state.filters.playlist && loadPlaylists()[state.filters.playlist];
  if (saved) {
    // A smart playlist's filters are already in the URL, so it takes the
    // ordinary path; a manual one has to be fetched by id.
    if (isSmart(saved)) {
      syncFilterUI();
      renderPlaylistNav();
      setView(view === "assets" ? "assets" : "videos");
    } else {
      openPlaylist(saved.id);
    }
    return;
  }
  syncFilterUI();
  setView(view === "assets" ? "assets" : "videos");
}

window.addEventListener("popstate", () => applyUrlState({ replace: true }));

/* ---------------------------------------------------------------
   Related lessons

   The same topic taught by a different publisher. 399 titles appear in more
   than one collection, which was an obstacle when placing videos and is the
   useful thing when watching one: if an explanation does not land, the next
   move is hearing it explained by someone else.
   --------------------------------------------------------------- */

async function renderRelated(item) {
  el.relatedBox.innerHTML = "";
  el.relatedBox.hidden = true;
  try {
    const data = await api(`/api/related/${encodeURIComponent(item.id)}`);
    if (!data.related.length) return;

    const head = document.createElement("p");
    head.className = "related-head";
    head.textContent = data.related.length === 1
      ? "Also explained by"
      : `Also explained by ${data.related.length} others`;
    el.relatedBox.appendChild(head);

    for (const r of data.related) {
      const btn = document.createElement("button");
      btn.className = "related-item";
      btn.type = "button";
      const colour = collectionColors.get(r.collection) || "var(--fg-dim)";
      btn.innerHTML =
        `<span class="related-src" style="border-color:${colour};color:${colour}">` +
        `${escapeHtml(r.collection)}</span>` +
        `<span class="related-dur">${escapeHtml(r.duration || "")}</span>`;
      btn.addEventListener("click", () => play(r));
      el.relatedBox.appendChild(btn);
    }
    el.relatedBox.hidden = false;
  } catch {
    /* related is a bonus; its absence is not worth an error */
  }
}

/* ---------------------------------------------------------------
   Playback speed and keyboard control

   Lectures get watched at 1.5x and above, so speed is a primary control
   rather than a setting buried in a menu. The chosen rate is remembered and
   applied to the next video, because nobody wants to set it every time.
   --------------------------------------------------------------- */

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const SPEED_KEY = "medlib:speed";

function preferredSpeed() {
  const v = parseFloat(localStorage.getItem(SPEED_KEY) || "1");
  return SPEEDS.includes(v) ? v : 1;
}

function setSpeed(rate) {
  el.video.playbackRate = rate;
  try { localStorage.setItem(SPEED_KEY, String(rate)); } catch { /* private mode */ }
  for (const b of el.speedBox.querySelectorAll("button")) {
    b.classList.toggle("on", Number(b.dataset.speed) === rate);
  }
  // The trigger is the only speed indicator left on screen, so it has to
  // carry the current rate.
  if (el.speedTrigger) {
    el.speedTrigger.textContent = `${rate}x`;
    el.speedTrigger.classList.toggle("on", rate !== 1);
  }
}

function buildSpeedControls() {
  el.speedBox.innerHTML = "";
  for (const rate of SPEEDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.speed = String(rate);
    b.textContent = `${rate}x`;
    b.addEventListener("click", () => { setSpeed(rate); closeSpeedMenu(); });
    el.speedBox.appendChild(b);
  }
}

function nudgeSpeed(direction) {
  const i = SPEEDS.indexOf(el.video.playbackRate);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 1 : i) + direction))];
  setSpeed(next);
  setMsg(`${next}x`, { transient: true });
}

/* Shortcuts apply only while the player is open, and never while typing in
   a field — otherwise space would pause a video mid-search. */
document.addEventListener("keydown", (e) => {
  if (el.backdrop.hidden) return;
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  const v = el.video;
  switch (e.key) {
    case " ": case "k":
      e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); break;
    case "ArrowRight": e.preventDefault(); v.currentTime += e.shiftKey ? 30 : 10; break;
    case "ArrowLeft":  e.preventDefault(); v.currentTime -= e.shiftKey ? 30 : 10; break;
    case "j": v.currentTime -= 10; break;
    case "l": v.currentTime += 10; break;
    case "ArrowUp":   e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
    case "ArrowDown": e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
    case "m": v.muted = !v.muted; setMsg(v.muted ? "Muted" : "Unmuted", { transient: true }); break;
    case "f":
      if (document.fullscreenElement) document.exitFullscreen();
      else v.requestFullscreen?.().catch(() => {});
      break;
    case ">": case ".": nudgeSpeed(1); break;
    case "<": case ",": nudgeSpeed(-1); break;
    case "n": if (!stepQueue(1)) setMsg("End of the queue", { transient: true }); break;
    case "p": if (!stepQueue(-1)) setMsg("Start of the queue", { transient: true }); break;
    case "q": if (state.queue) toggleQueuePanel(); break;
    /* Escape unwinds one layer at a time. Closing the whole player because a
       popover happened to be open loses your place for the sake of a menu. */
    case "Escape":
      if (speedMenuOpen()) closeSpeedMenu();
      else if (queuePanelOpen()) closeQueuePanel();
      else closePlayer();
      break;
    default: break;
  }
});

/* ---------------------------------------------------------------
   The queue

   Most of the time nothing has to be assembled: the queue is whatever list
   you pressed play inside — the grid, one shelf rail, or a playlist — read
   off the DOM at play time from the cards sitting next to the one you
   clicked. That is why a card carries its own item in appendCards, and it
   is what makes continuous playback work in every list in the app without
   any of those lists knowing that queues exist.

   That covers the common case but not the deliberate one, so a card's +
   menu also offers Play next and Add to queue, and the panel can reorder
   and drop rows. See "Owning a queue" for why only the hand-built kind
   survives the sitting.
   --------------------------------------------------------------- */

const AUTOPLAY_KEY = "medlib:autoplay";
const QUEUE_KEY = "medlib:queue:v1";

/* An inherited queue can be 300 rows of a filtered grid; a hand-built one is
   a handful. Only the second is worth keeping, so the cap is really a guard
   against writing a whole result set into localStorage by accident. */
const QUEUE_MAX_PERSIST = 500;

/* Long enough to reach for the mouse, short enough not to feel stalled.
   Advancing the instant a video ends is the thing people hate about
   autoplay, and it is entirely avoidable. */
const NEXT_DELAY_MS = 6000;

function autoplayOn() {
  return localStorage.getItem(AUTOPLAY_KEY) !== "0";
}

function setAutoplay(on) {
  try { localStorage.setItem(AUTOPLAY_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  syncAutoplayButton();
}

/* Autoplay lives in the queue panel's header rather than on the control row.
   It is a property of the queue, not a transport control, and the row it used
   to sit on is the one thing that has to stay readable at 375px. */
function syncAutoplayButton() {
  const on = autoplayOn();
  if (!el.queueAuto) return;
  el.queueAuto.classList.toggle("on", on);
  el.queueAuto.setAttribute("aria-pressed", String(on));
  el.queueAuto.textContent = on ? "Autoplay on" : "Autoplay off";
}

/* ---------------------------------------------------------------
   Owning a queue

   Two kinds, and the difference is who built it. An *inherited* queue is
   whatever list you pressed play in: disposable by design, because finding
   yesterday's half-finished rail waiting for you would be a bug. An *owned*
   queue is one you assembled yourself with Play next / Add to queue or
   rearranged by hand — that is work, and losing it on close would be rude.

   So ownership is the persistence rule. Any manual edit marks the queue
   owned and writes it; inherited queues are never written, which is also
   why clicking a card in a grid cannot quietly overwrite the queue you
   built yesterday.

   Items are stored whole rather than as ids. Playlists deliberately hold
   ids so a re-titled video stays put, but a queue is a short-lived working
   set — copies keep restore to zero API calls, and a stale title for one
   sitting is a fair price.
   --------------------------------------------------------------- */

function ownQueue() {
  if (!state.queue) return;
  const wasOwned = state.queue.owned;
  state.queue.owned = true;
  persistQueue();
  // Only the first edit changes what the sidebar shows; later ones just move
  // the position, and rebuilding that list on every video change is waste.
  if (!wasOwned) renderPlaylistNav();
}

function persistQueue() {
  const q = state.queue;
  if (!q || !q.owned) return;
  if (q.items.length > QUEUE_MAX_PERSIST) return;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ items: q.items, at: q.at }));
  } catch {
    /* quota or private mode — the queue simply will not outlive the tab */
  }
}

function loadStoredQueue() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
    if (!raw || !Array.isArray(raw.items) || !raw.items.length) return null;
    const at = Number.isInteger(raw.at) ? Math.min(raw.at, raw.items.length - 1) : 0;
    return { items: raw.items, at: Math.max(0, at), owned: true };
  } catch {
    return null;
  }
}

function clearStoredQueue() {
  try { localStorage.removeItem(QUEUE_KEY); } catch { /* private mode */ }
  if (state.queue && state.queue.owned) {
    state.queue = null;
    closeQueuePanel();
    renderQueueControls();
  }
  renderPlaylistNav();
  toast("Queue cleared");
}

/**
 * Put a video into the queue, at the front of what is coming or at the end.
 *
 * Any existing copy is pulled out first, so a video cannot appear twice and
 * "play next" on something already further down moves it rather than
 * duplicating it.
 */
function queueInsert(item, where) {
  const q = state.queue;

  if (!q) {
    // Nothing playing. Start a queue rather than start playback — you asked
    // to line something up, not to interrupt yourself.
    state.queue = { items: [item], at: 0, owned: true };
    persistQueue();
    renderPlaylistNav();
    return "started";
  }

  const found = q.items.findIndex((i) => i.id === item.id);
  if (found === q.at) return "current";
  if (found > -1) {
    q.items.splice(found, 1);
    if (found < q.at) q.at -= 1;
  }

  q.items.splice(where === "next" ? q.at + 1 : q.items.length, 0, item);
  ownQueue();
  renderQueueControls();
  return found > -1 ? "moved" : "added";
}

function queueRemove(i) {
  const q = state.queue;
  // Never drop what is playing: the row would vanish from under the video.
  if (!q || i === q.at || i < 0 || i >= q.items.length) return;
  q.items.splice(i, 1);
  if (i < q.at) q.at -= 1;
  ownQueue();
  renderQueueControls();
}

function queueMove(i, delta) {
  const q = state.queue;
  const j = i + delta;
  if (!q || j < 0 || j >= q.items.length) return;
  [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
  // The pointer follows whichever row it was on, so the video keeps playing
  // and the ▶ marker stays with it.
  if (q.at === i) q.at = j;
  else if (q.at === j) q.at = i;
  ownQueue();
  renderQueueControls();
}

/* ---- a word outside the player ----

   setMsg writes into the player overlay, which is no help when the queue is
   being built from a card in the grid with nothing playing. */

let toastTimer = null;

function toast(text) {
  let box = document.querySelector(".toast");
  if (!box) {
    box = document.createElement("div");
    box.className = "toast";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("on"), 2400);
}

/** The cards either side of this one, and where in them it sits. */
function queueFrom(card) {
  const box = card.parentElement;
  if (!box) return null;
  const items = [];
  let at = -1;
  for (const sibling of box.querySelectorAll(":scope > .card")) {
    if (!sibling._item) continue;
    if (sibling === card) at = items.length;
    items.push(sibling._item);
  }
  // A queue of one is just a video; leaving it null keeps the controls hidden.
  return at < 0 || items.length < 2 ? null : { items, at };
}

function queueAt(delta) {
  const q = state.queue;
  if (!q) return null;
  const i = q.at + delta;
  return i >= 0 && i < q.items.length ? q.items[i] : null;
}

/** Move by one. Returns false when there is nothing there, so callers can
    decide whether that is the end of a run or a no-op. */
function stepQueue(delta) {
  const q = state.queue;
  const next = queueAt(delta);
  if (!next) return false;
  q.at += delta;
  play(next, q);          // same object back, so `at` survives the hop
  return true;
}

function renderQueueControls() {
  const box = el.queueBox;
  if (!box) return;
  const q = state.queue;
  box.innerHTML = "";
  box.hidden = !q;
  if (!q) {
    closeQueuePanel();
    return;
  }

  const arrow = (glyph, aria, delta) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctl ctl-icon";
    b.textContent = glyph;
    b.setAttribute("aria-label", aria);
    b.disabled = !queueAt(delta);
    b.addEventListener("click", () => stepQueue(delta));
    return b;
  };

  box.appendChild(arrow("‹", "Previous in queue", -1));
  box.appendChild(arrow("›", "Next in queue", 1));

  /* Position doubles as the panel's handle. One control instead of two, and
     the number is the thing you were going to reach for anyway. */
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ctl queue-open";
  open.title = "Show the queue";
  open.setAttribute("aria-expanded", String(queuePanelOpen()));
  open.innerHTML =
    `<span class="queue-pos">${q.at + 1} / ${q.items.length}</span>` +
    `<span class="queue-caret" aria-hidden="true">⌃</span>`;
  open.addEventListener("click", toggleQueuePanel);
  box.appendChild(open);

  if (queuePanelOpen()) renderQueuePanel();
}

/* ---- the slide-out list ---- */

function queuePanelOpen() {
  return !!el.queuePanel && el.queuePanel.classList.contains("open");
}

function openQueuePanel() {
  if (!el.queuePanel || !state.queue) return;
  closeSpeedMenu();
  renderQueuePanel();
  el.queuePanel.classList.add("open");
  syncQueueOpenButton();
  // Land on the video you are actually watching rather than the top of 300.
  el.queueList.querySelector(".qp-item.current")
    ?.scrollIntoView({ block: "center" });
}

function closeQueuePanel() {
  if (!el.queuePanel) return;
  el.queuePanel.classList.remove("open");
  syncQueueOpenButton();
}

function toggleQueuePanel() {
  queuePanelOpen() ? closeQueuePanel() : openQueuePanel();
}

function syncQueueOpenButton() {
  el.queueBox?.querySelector(".queue-open")
    ?.setAttribute("aria-expanded", String(queuePanelOpen()));
}

function renderQueuePanel() {
  const q = state.queue;
  if (!el.queueList) return;
  el.queueList.innerHTML = "";
  syncAutoplayButton();
  if (!q) return;

  el.queuePanelCount.textContent = `${q.at + 1} of ${q.items.length}`;
  if (el.queueClear) el.queueClear.hidden = !q.owned;

  const frag = document.createDocumentFragment();
  q.items.forEach((item, i) => {
    const frac = progressFraction(item.id);
    const li = document.createElement("li");
    li.className = "qp-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qp-item" +
      (i === q.at ? " current" : "") +
      (frac >= 1 ? " done" : "");
    if (i === q.at) btn.setAttribute("aria-current", "true");
    btn.innerHTML =
      `<span class="qp-n">${i === q.at ? "▶" : frac >= 1 ? "✓" : i + 1}</span>` +
      `<span class="qp-title">${escapeHtml(item.title)}</span>` +
      `<span class="qp-dur">${escapeHtml(item.duration || "")}</span>` +
      // Part-watched only: a full bar on every finished row would be noise
      // next to the tick that already says the same thing.
      (frac > 0 && frac < 1
        ? `<span class="qp-bar"><i style="width:${Math.round(frac * 100)}%"></i></span>`
        : "");
    btn.addEventListener("click", () => jumpToQueue(i));
    li.appendChild(btn);

    /* Buttons rather than drag: dragging a row is miserable on a phone, and
       this list is most useful on one. Nested inside the row but as siblings
       of the jump button — a button cannot contain a button. */
    const tools = document.createElement("span");
    tools.className = "qp-tools";
    const tool = (glyph, aria, enabled, on) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qp-tool";
      b.textContent = glyph;
      b.setAttribute("aria-label", `${aria}: ${item.title}`);
      b.disabled = !enabled;
      b.addEventListener("click", (e) => { e.stopPropagation(); on(); });
      return b;
    };
    tools.appendChild(tool("▲", "Move up", i > 0, () => queueMove(i, -1)));
    tools.appendChild(tool("▼", "Move down", i < q.items.length - 1, () => queueMove(i, 1)));
    tools.appendChild(tool("×", "Remove from queue", i !== q.at, () => queueRemove(i)));
    li.appendChild(tools);

    frag.appendChild(li);
  });
  el.queueList.appendChild(frag);
}

function jumpToQueue(i) {
  const q = state.queue;
  if (!q || i < 0 || i >= q.items.length) return;
  if (i === q.at) return;
  q.at = i;
  play(q.items[i], q);
}

/* ---- speed, now behind a trigger ---- */

function speedMenuOpen() {
  return !!el.speedBox && !el.speedBox.hidden;
}

function closeSpeedMenu() {
  if (!el.speedBox) return;
  el.speedBox.hidden = true;
  el.speedTrigger?.setAttribute("aria-expanded", "false");
}

function toggleSpeedMenu() {
  if (speedMenuOpen()) return closeSpeedMenu();
  el.speedBox.hidden = false;
  el.speedTrigger?.setAttribute("aria-expanded", "true");
}

/* ---- the countdown between videos ---- */

let nextTimer = null;
let nextCountdown = null;

function cancelNextPrompt() {
  clearTimeout(nextTimer);
  clearInterval(nextCountdown);
  nextTimer = nextCountdown = null;
}

/**
 * Offer the next video, counting down if autoplay is on.
 *
 * Written into the same overlay setMsg uses, so any later status message
 * replaces it — but the timer would keep running behind that, which is why
 * every path that changes what is playing calls cancelNextPrompt first.
 */
function promptNext(item) {
  cancelNextPrompt();
  const auto = autoplayOn();

  el.videoMsg.hidden = false;
  el.videoMsg.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "next-up";

  const label = document.createElement("span");
  label.className = "next-up-title";
  wrap.appendChild(label);

  const go = document.createElement("button");
  go.type = "button";
  go.className = "next-up-go";
  go.textContent = "Play now";
  go.addEventListener("click", () => { cancelNextPrompt(); stepQueue(1); });
  wrap.appendChild(go);

  if (auto) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "next-up-stop";
    stop.textContent = "Stay here";
    stop.addEventListener("click", () => {
      cancelNextPrompt();
      setMsg(null);
    });
    wrap.appendChild(stop);
  }

  el.videoMsg.appendChild(wrap);

  let left = Math.round(NEXT_DELAY_MS / 1000);
  const paint = () => {
    label.textContent = auto
      ? `Next in ${left}s — ${item.title}`
      : `Next up — ${item.title}`;
  };
  paint();

  if (!auto) return;
  nextCountdown = setInterval(() => { left -= 1; paint(); }, 1000);
  nextTimer = setTimeout(() => { cancelNextPrompt(); stepQueue(1); }, NEXT_DELAY_MS);
}

/* ---------------------------------------------------------------
   Playback
   --------------------------------------------------------------- */

/* Two clicks on Next in quick succession start two mints. Without a
   generation the slower response wins and you land on the wrong video —
   the same race loadPage guards, for the same reason. */
let playGeneration = 0;

async function play(item, queue = null) {
  cancelNextPrompt();
  state.queue = queue;
  // Position is part of what was saved, so an owned queue has to be rewritten
  // every time it moves — otherwise resuming lands you back at the start.
  persistQueue();
  const mine = ++playGeneration;

  openPlayer(item);
  renderQueueControls();
  remintAttempts = 0;
  setMsg("Requesting playback token…");
  try {
    const tok = await api(`/api/token/${encodeURIComponent(item.id)}`);
    if (mine !== playGeneration) return;   // superseded while in flight
    state.current = { id: item.id, expires: tok.expires, type: tok.type };
    if (tok.poster) el.video.poster = tok.poster;
    await attach(tok);
    if (mine !== playGeneration) return;
    setMsg(null);
    renderExpiry(tok.expires);

    /* Resume where you stopped. Seeking before metadata is loaded is
       ignored by the element, so wait for it — once, then detach. */
    const saved = getProgress(item.id);
    if (saved && !saved.done && saved.t >= RESUME_MIN_SECONDS) {
      const seek = () => {
        if (Number.isFinite(el.video.duration) && saved.t < el.video.duration - 5) {
          el.video.currentTime = saved.t;
          setMsg(`Resumed at ${formatClock(saved.t)}`, { transient: true });
        }
      };
      if (el.video.readyState >= 1) seek();
      else el.video.addEventListener("loadedmetadata", seek, { once: true });
    }

    setSpeed(preferredSpeed());
    el.video.play().catch(() => { /* autoplay blocked; the controls still work */ });
  } catch (err) {
    if (err.message !== "unauthenticated") setMsg(`Could not start playback: ${err.message}`);
  }
}

async function attach(tok) {
  teardownHls();

  if (tok.type !== "hls") {
    el.video.src = tok.url;
    return;
  }

  // hls.js is tried BEFORE native. Chromium answers "maybe" to
  // canPlayType("application/vnd.apple.mpegurl") and then fails to play the
  // playlist, so trusting canPlayType first sends every desktop Chrome user
  // down a path that cannot work. Safari, where native HLS is real, has no
  // MSE-based hls.js support and falls through to the native branch.
  const Hls = await loadHlsJs();
  if (Hls && Hls.isSupported()) {
    // withCredentials stays off: the CDN authenticates via the signed URL, and
    // the session cookie has no business being sent to the edge.
    const hls = new Hls({ xhrSetup: (xhr) => { xhr.withCredentials = false; } });
    state.hls = hls;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const code = data.response && data.response.code;
      if (code === 403 || code === 401 || code === 410) maybeRemint("link rejected by the CDN");
      else setMsg(`Playback error: ${data.details}`);
    });
    hls.loadSource(tok.url);
    hls.attachMedia(el.video);
    return;
  }

  if (el.video.canPlayType("application/vnd.apple.mpegurl")) {
    el.video.src = tok.url;
    return;
  }

  throw new Error("this browser cannot play HLS and hls.js is unavailable offline");
}

/* A 403 from the edge means the token aged out mid-session — mint a new one and
   resume from the same position rather than bouncing the user back to the grid.
   Guarded against re-entry: a fatal HLS error and the <video> error event can
   both fire for the same expiry, and two concurrent mints would fight over the
   seek position. */
let reminting = false;

async function remint() {
  if (!state.current || reminting) return;
  reminting = true;
  const at = el.video.currentTime;
  setMsg("Link expired — refreshing…");
  try {
    const tok = await api(`/api/token/${encodeURIComponent(state.current.id)}`);
    state.current.expires = tok.expires;
    await attach(tok);
    // A fresh source has no buffered range yet; seeking before metadata lands
    // is silently dropped, so defer it to the first loadedmetadata.
    seekOnceLoaded(at);
    el.video.play().catch(() => {});
    setMsg(null);
    renderExpiry(tok.expires);
  } catch (err) {
    if (err.message !== "unauthenticated") setMsg(`Could not refresh link: ${err.message}`);
  } finally {
    reminting = false;
  }
}

function seekOnceLoaded(seconds) {
  if (!seconds) return;
  if (el.video.readyState >= 1) {
    el.video.currentTime = seconds;
    return;
  }
  el.video.addEventListener("loadedmetadata", () => {
    el.video.currentTime = seconds;
  }, { once: true });
}

/* An expired token and an unplayable format look identical from the <video>
   error event, so a bare "error -> re-mint" rule spins forever on a codec
   problem: mint, fail, mint, fail. One retry per playback, reset once media
   actually loads, then surface the real error. */
let remintAttempts = 0;
const MAX_REMINTS = 1;

function maybeRemint(reason) {
  if (!state.current) return;
  if (remintAttempts >= MAX_REMINTS) {
    setMsg(`Playback failed: ${reason}. The file may be unplayable in this browser.`);
    return;
  }
  remintAttempts++;
  remint();
}

el.video.addEventListener("loadeddata", () => { remintAttempts = 0; });

el.video.addEventListener("error", () => {
  const code = el.video.error && el.video.error.code;
  // MEDIA_ERR_NETWORK / MEDIA_ERR_SRC_NOT_SUPPORTED are what an expired token
  // looks like from the progressive (non-HLS) path.
  if (code === 2 || code === 4) maybeRemint("the media could not be loaded");
});

el.video.addEventListener("play", () => {
  if (!state.current) return;
  const left = state.current.expires - Math.floor(Date.now() / 1000);
  if (left < EXPIRY_GRACE_S) remint();
});

let hlsPromise = null;

function injectScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

/* Local copy first, CDN second. Vendoring matters here: on a phone with a
   captive portal or a blocked CDN the local file still loads, and without
   hls.js there is no playback at all outside Safari. */
async function loadHlsJs() {
  if (window.Hls) return window.Hls;
  if (hlsPromise) return hlsPromise;
  hlsPromise = (async () => (await injectScript(HLS_JS_LOCAL)) || (await injectScript(HLS_JS_URL)))();
  return hlsPromise;
}

function teardownHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function openPlayer(item) {
  renderRelated(item);
  const bucket = state.buckets.find((b) => b.id === item.bucket);
  el.playerTitle.textContent = item.title;
  el.playerBucket.textContent = bucket ? bucket.label : item.bucket;
  el.playerExpiry.textContent = "";
  el.video.poster = "";
  el.backdrop.hidden = false;
  document.body.classList.add("locked");
}

function closePlayer() {
  // Save before tearing down: currentTime is gone once the source is cleared.
  if (state.current && el.video.duration) {
    recordProgress(state.current.id, el.video.currentTime, el.video.duration,
                   el.playerTitle.textContent);
    refreshProgressUI();
  }

  // Closing ends the run: a queue is where you are in one sitting, and a
  // stale one left behind would silently auto-advance the next video you
  // open from a card.
  cancelNextPrompt();
  state.queue = null;
  closeQueuePanel();
  closeSpeedMenu();
  renderQueueControls();

  // Cleared first: load() on an empty source fires an async error event, and
  // the error handler must not read that as an expired token and re-mint.
  state.current = null;
  teardownHls();
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
  el.backdrop.hidden = true;
  document.body.classList.remove("locked");
  setMsg(null);
}

function renderExpiry(expires) {
  const mins = Math.max(0, Math.round((expires - Date.now() / 1000) / 60));
  el.playerExpiry.textContent = ` · link valid ${mins} min`;
}

let msgTimer = null;

function setMsg(text, { transient = false } = {}) {
  clearTimeout(msgTimer);
  el.videoMsg.textContent = text || "";
  el.videoMsg.hidden = !text;
  // A status like "Resumed at 4:12" is worth showing and not worth keeping.
  if (text && transient) {
    msgTimer = setTimeout(() => {
      el.videoMsg.textContent = "";
      el.videoMsg.hidden = true;
    }, 2600);
  }
}

/* Record position while playing. timeupdate fires 4-60x a second; writing
   localStorage that often would be absurd, so throttle to every few seconds
   and on the events that matter. */
const PROGRESS_SAVE_INTERVAL_MS = 5000;
let lastSaved = 0;

el.video.addEventListener("timeupdate", () => {
  if (!state.current || !el.video.duration) return;
  const now = Date.now();
  if (now - lastSaved < PROGRESS_SAVE_INTERVAL_MS) return;
  lastSaved = now;
  recordProgress(state.current.id, el.video.currentTime, el.video.duration,
                 el.playerTitle.textContent);
});

for (const evt of ["pause", "ended"]) {
  el.video.addEventListener(evt, () => {
    if (!state.current || !el.video.duration) return;
    recordProgress(state.current.id, el.video.currentTime, el.video.duration,
                   el.playerTitle.textContent);
    refreshProgressUI();
  });
}

/* Offer the next one. Separate from the progress listener above so the order
   is explicit: the finished video is recorded first, then the queue moves —
   otherwise advancing tears down the element whose currentTime we still need. */
el.video.addEventListener("ended", () => {
  const next = queueAt(1);
  if (next) promptNext(next);
});

/* Leaving the page mid-video is the common case, and it fires neither pause
   nor close. pagehide is the reliable one on mobile Safari. */
window.addEventListener("pagehide", () => {
  if (state.current && el.video.duration) {
    recordProgress(state.current.id, el.video.currentTime, el.video.duration,
                   el.playerTitle.textContent);
  }
});

/** Repaint the bars on cards already on screen, without a reload. */
function refreshProgressUI() {
  for (const card of document.querySelectorAll(".card[data-id]")) {
    applyProgress(card, card.dataset.id);
  }
}

function applyProgress(card, id) {
  const frac = progressFraction(id);
  const p = getProgress(id);
  card.classList.toggle("watched", Boolean(p && p.done));

  let bar = card.querySelector(".progress");
  if (!frac) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("span");
    bar.className = "progress";
    bar.innerHTML = '<span class="progress-fill"></span>';
    (card.querySelector(".thumb") || card).appendChild(bar);
  }
  bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  bar.title = p && p.done ? "Watched" : `${Math.round(frac * 100)}% watched`;
}

el.playerClose.addEventListener("click", closePlayer);
el.backdrop.addEventListener("click", (e) => { if (e.target === el.backdrop) closePlayer(); });

/* A second copy of these shortcuts used to live here, and both handlers ran:
   ArrowRight seeked 20s rather than 10, and `f` toggled fullscreen off and
   straight back on. The single handler in "Playback speed and keyboard
   control" is the one that stays — it also honours shift and skips keypresses
   made while typing in a field. */

el.speedTrigger.addEventListener("click", (e) => { e.stopPropagation(); toggleSpeedMenu(); });

el.helpToggle.addEventListener("click", () => {
  const show = el.shortcuts.hidden;
  el.shortcuts.hidden = !show;
  el.helpToggle.setAttribute("aria-expanded", String(show));
  el.helpToggle.classList.toggle("on", show);
});

el.queueAuto.addEventListener("click", () => setAutoplay(!autoplayOn()));
el.queueClose.addEventListener("click", closeQueuePanel);
el.queueClear.addEventListener("click", clearStoredQueue);

/* A popover that survives the next click is a popover you have to dismiss
   twice. The panel is excluded: it has a close button and holds a long list
   you scroll through. */
document.addEventListener("click", (e) => {
  if (speedMenuOpen() && !e.target.closest(".speed-wrap")) closeSpeedMenu();
});

/* ---------------------------------------------------------------
   Chrome: sidebar, search, infinite scroll
   --------------------------------------------------------------- */

function closeSidebar() {
  el.sidebar.classList.remove("open");
  el.scrim.classList.remove("on");
  el.menuToggle.setAttribute("aria-expanded", "false");
}

el.menuToggle.addEventListener("click", () => {
  const open = el.sidebar.classList.toggle("open");
  el.scrim.classList.toggle("on", open);
  el.menuToggle.setAttribute("aria-expanded", String(open));
});
el.scrim.addEventListener("click", closeSidebar);

/* The wordmark goes home: clear every filter, close the player, back to the
   front page with Continue watching at the top. The one control that always
   means the same thing. */
el.homeBtn.addEventListener("click", () => {
  if (!el.backdrop.hidden) closePlayer();
  state.filters = EMPTY_STATE_FILTERS();
  el.searchInput.value = "";
  syncFilterUI();
  setView("videos");
  selectSideTab("subjects");
  closeSidebar();
  loadPage(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
});

el.viewVideos.addEventListener("click", () => setView("videos"));
el.viewAssets.addEventListener("click", () => setView("assets"));
el.docClose.addEventListener("click", closeDoc);
el.docBackdrop.addEventListener("click", (e) => { if (e.target === el.docBackdrop) closeDoc(); });

el.tabSubjects.addEventListener("click", () => selectSideTab("subjects"));
el.tabSources.addEventListener("click", () => selectSideTab("sources"));

el.clearFilters.addEventListener("click", () => {
  state.filters = EMPTY_STATE_FILTERS();
  el.searchInput.value = "";
  syncFilterUI();
  closeSidebar();
  loadPage(true);
});

/* Saving a view names what the filters already describe. The default name is
   the heading you are looking at, because that is what you would have typed. */
el.saveView.addEventListener("click", () => {
  const name = prompt("Name this view", el.resultsTitle.textContent || "Saved view");
  if (name === null) return;
  const pl = createSmartPlaylist(name, state.filters);
  state.filters.playlist = pl.id;
  renderPlaylistNav();
  renderSummary();
});

/* "/" jumps to search, the way it does everywhere else. Only when the player
   is closed and you are not already typing — otherwise it would swallow the
   slash in a title. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!el.backdrop.hidden || !el.docBackdrop.hidden) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
  e.preventDefault();
  el.searchInput.focus();
  el.searchInput.select();
});

let searchTimer = null;
el.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.search = el.searchInput.value.trim();
    loadPage(true);
  }, 250);
});

/* IntersectionObserver alone is not enough here. It reports *changes*, and the
   sentinel starts intersecting while the first page is still in flight — that
   callback early-returns on the `state.loading` guard, and because the sentinel
   never stops intersecting no further callback ever arrives. Pagination would
   stick at one page forever. So: re-check explicitly after every load, and keep
   pulling while the sentinel is still on screen. Each page pushes it further
   down, so this terminates on its own. */
function sentinelVisible() {
  const r = el.sentinel.getBoundingClientRect();
  return r.top <= window.innerHeight + 600 && r.bottom >= -600;
}

/* Deliberately setTimeout and not requestAnimationFrame: rAF does not fire in a
   backgrounded or hidden tab, which would wedge this loop mid-await and stop
   pagination until the tab is looked at again. Timers keep running. */
const nextTick = () => new Promise((r) => setTimeout(r, 0));

let topUpRunning = false;

async function loadMoreIfNeeded() {
  if (topUpRunning) return;
  topUpRunning = true;
  try {
    while (!state.exhausted && !state.loading && sentinelVisible()) {
      const before = state.offset;
      await loadPage(false);
      if (state.offset === before) break;   // no progress; do not spin
      await nextTick();
    }
  } finally {
    topUpRunning = false;
  }
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMoreIfNeeded();
}, { rootMargin: "600px" }).observe(el.sentinel);

window.addEventListener("scroll", () => { loadMoreIfNeeded(); }, { passive: true });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------------------------------------- */

async function bootstrap() {
  buildSpeedControls();
  if (location.search) { applyUrlState({ replace: true }); return; }
  await loadPage(true);
}

(async function init() {
  try {
    await api("/api/me");
    showApp();
    await bootstrap();
  } catch {
    showGate();
  }
})();
