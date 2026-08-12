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
  offset: 0,
  loading: false,
  exhausted: false,
  view: "videos",
  filters: { bucket: null, level: null, tag: null, collection: null, section: null, folder: null, tags: [], playlist: null, search: "" },
  current: null,      // { id, expires, type }
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
  resultsTitle: $("resultsTitle"), resultsCount: $("resultsCount"),
  activeFilters: $("activeFilters"), grid: $("grid"), sentinel: $("sentinel"),
  shelves: $("shelves"),
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
  if (f.search) p.set("search", f.search);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

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

    if (reset || !el.bucketList.childElementCount) renderFilters(data);
    if (data.generated_at) el.buildStamp.textContent = `Indexed ${data.generated_at}`;

    state.items.push(...data.items);
    state.offset += data.items.length;
    state.exhausted = data.items.length < PAGE_SIZE || state.offset >= data.total;

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
      appendCards(data.items);
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
  const f = state.filters;
  const bucket = state.buckets.find((b) => b.id === f.bucket);
  el.resultsTitle.textContent =
    f.folder ? f.folder.split("/").join(" › ")
    : f.section ? `${f.collection} › ${f.section}`
    : f.collection ? f.collection
    : bucket ? bucket.label
    : "All subjects";
  el.resultsCount.textContent = browsing()
    ? `${state.total.toLocaleString()} videos`
    : `${state.items.length.toLocaleString()} of ${state.total.toLocaleString()}`;
  el.empty.hidden = browsing() || state.total !== 0;

  el.activeFilters.innerHTML = "";
  const chips = [
    ["bucket", bucket ? bucket.label : null],
    ["level", f.level],
    ["collection", f.collection],
    ["section", f.section],
    ["folder", f.folder ? f.folder.split("/").slice(-2).join(" › ") : null],
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
    "#bucketGroups .on, #collectionGroups .on, #tagCloud .on, #levelList .on"
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
    const open = () => play(item);
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
    !f.folder && !f.search.trim();
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
  const ids = resumableIds();
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

function renamePlaylist(id, name) {
  const pl = loadPlaylists()[id];
  if (!pl) return;
  pl.name = name.trim() || pl.name;
  persistPlaylists();
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
  return Object.values(loadPlaylists()).filter((pl) => pl.ids.includes(videoId));
}

/* ---- sidebar ---- */

function renderPlaylistNav() {
  const box = el.playlistList;
  if (!box) return;
  box.innerHTML = "";

  const lists = Object.values(loadPlaylists()).sort((a, b) => b.at - a.at);

  for (const pl of lists) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.playlist = pl.id;
    btn.className = state.filters.playlist === pl.id ? "on" : "";
    btn.innerHTML =
      `<span class="lbl">${escapeHtml(pl.name)}</span><span class="n">${pl.ids.length}</span>`;
    btn.addEventListener("click", () => openPlaylist(pl.id));

    const kill = document.createElement("button");
    kill.className = "pl-del";
    kill.title = `Delete ${pl.name}`;
    kill.setAttribute("aria-label", `Delete playlist ${pl.name}`);
    kill.textContent = "×";
    kill.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Delete the playlist "${pl.name}"? The videos stay in the library.`)) {
        deletePlaylist(pl.id);
      }
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

  el.resultsCount.textContent = `${items.length.toLocaleString()} saved`;
  el.loading.hidden = true;
  if (!items.length) {
    el.grid.innerHTML =
      `<p class="empty">Nothing in this playlist yet. Use the + on any video to add one.</p>`;
    return;
  }
  appendCards(items, el.grid);
}

/* ---- the + control on a card ---- */

function openPlaylistMenu(anchor, videoId) {
  document.querySelector(".pl-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "pl-menu";
  const lists = Object.values(loadPlaylists()).sort((a, b) => b.at - a.at);

  if (!lists.length) {
    menu.innerHTML = `<p class="pl-menu-empty">No playlists yet.</p>`;
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
           folder: null, tags: [], playlist: null, search: "" };
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
   Playback
   --------------------------------------------------------------- */

async function play(item) {
  openPlayer(item);
  remintAttempts = 0;
  setMsg("Requesting playback token…");
  try {
    const tok = await api(`/api/token/${encodeURIComponent(item.id)}`);
    state.current = { id: item.id, expires: tok.expires, type: tok.type };
    if (tok.poster) el.video.poster = tok.poster;
    await attach(tok);
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

document.addEventListener("keydown", (e) => {
  if (el.backdrop.hidden) return;
  if (e.key === "Escape") closePlayer();
  if (e.key === "f") el.video.requestFullscreen && el.video.requestFullscreen();
  if (e.key === "ArrowRight") el.video.currentTime += 10;
  if (e.key === "ArrowLeft") el.video.currentTime -= 10;
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
