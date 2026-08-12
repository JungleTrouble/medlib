(() => {
  const state = {
    category: null,
    platform: null,
    level: null,
    tags: new Set(),
    search: "",
  };

  const els = {
    categoryList: document.getElementById("categoryList"),
    platformList: document.getElementById("platformList"),
    levelList: document.getElementById("levelList"),
    tagCloud: document.getElementById("tagCloud"),
    clearFilters: document.getElementById("clearFilters"),
    activeFilters: document.getElementById("activeFilters"),
    searchInput: document.getElementById("searchInput"),

    rowsView: document.getElementById("rowsView"),
    categoryRows: document.getElementById("categoryRows"),
    gridView: document.getElementById("gridView"),
    cardGrid: document.getElementById("cardGrid"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsCount: document.getElementById("resultsCount"),
    emptyState: document.getElementById("emptyState"),

    hero: document.getElementById("hero"),
    heroMedia: document.getElementById("heroMedia"),
    heroPlatform: document.getElementById("heroPlatform"),
    heroTitle: document.getElementById("heroTitle"),
    heroMeta: document.getElementById("heroMeta"),
    heroDesc: document.getElementById("heroDesc"),
    heroPlay: document.getElementById("heroPlay"),

    modalBackdrop: document.getElementById("modalBackdrop"),
    modalClose: document.getElementById("modalClose"),
    modalMedia: document.getElementById("modalMedia"),
    modalPlatform: document.getElementById("modalPlatform"),
    modalTitle: document.getElementById("modalTitle"),
    modalMeta: document.getElementById("modalMeta"),
    modalDesc: document.getElementById("modalDesc"),
    modalTags: document.getElementById("modalTags"),

    menuToggle: document.getElementById("menuToggle"),
    sidebar: document.getElementById("sidebar"),
    sidebarScrim: document.getElementById("sidebarScrim"),
    themeToggle: document.getElementById("themeToggle"),
  };

  /* ---------- lookups ---------- */
  const getCategory = (id) => CATEGORIES.find((c) => c.id === id);
  const getPlatform = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS.find((p) => p.id === "other");

  const isPlaceholder = (val) => !val || String(val).startsWith("REPLACE");

  function getInitials(title) {
    return title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function getThumbnailUrl(video) {
    if (video.platform === "bunny" && !isPlaceholder(video.bunnyVideoId)) {
      return `https://${CONFIG.bunnyCdnHostname}/${video.bunnyVideoId}/thumbnail.jpg`;
    }
    if (video.platform === "youtube" && !isPlaceholder(video.embedId)) {
      return `https://img.youtube.com/vi/${video.embedId}/hqdefault.jpg`;
    }
    return null;
  }

  /* ---------- embed builder ---------- */
  function getEmbedNode(video) {
    const plat = video.platform;

    if (plat === "bunny" && !isPlaceholder(video.bunnyVideoId)) {
      const iframe = document.createElement("iframe");
      let src = `https://iframe.mediadelivery.net/embed/${CONFIG.bunnyLibraryId}/${video.bunnyVideoId}?autoplay=true&responsive=true`;
      if (video.bunnyToken && video.bunnyExpires) {
        src += `&token=${encodeURIComponent(video.bunnyToken)}&expires=${encodeURIComponent(video.bunnyExpires)}`;
      }
      iframe.src = src;
      iframe.setAttribute("allow", "accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;");
      iframe.allowFullscreen = true;
      iframe.loading = "lazy";
      return iframe;
    }

    if (plat === "youtube" && !isPlaceholder(video.embedId)) {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube.com/embed/${video.embedId}?autoplay=1`;
      iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
      iframe.allowFullscreen = true;
      return iframe;
    }

    if (plat === "vimeo" && !isPlaceholder(video.embedId)) {
      const iframe = document.createElement("iframe");
      iframe.src = `https://player.vimeo.com/video/${video.embedId}?autoplay=1`;
      iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
      iframe.allowFullscreen = true;
      return iframe;
    }

    if (plat === "local" && video.fileUrl) {
      const v = document.createElement("video");
      v.src = video.fileUrl;
      v.controls = true;
      v.autoplay = true;
      return v;
    }

    const wrap = document.createElement("div");
    wrap.className = "no-embed";
    const p = document.createElement("p");
    p.textContent = video.externalUrl
      ? "This video isn't embedded directly. Open it on the source platform:"
      : "No playable source is configured for this video yet.";
    wrap.appendChild(p);
    if (video.externalUrl) {
      const a = document.createElement("a");
      a.href = video.externalUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open on " + getPlatform(plat).label;
      wrap.appendChild(a);
    }
    return wrap;
  }

  /* ---------- card / thumb builder ---------- */
  function buildThumb(video) {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const cat = getCategory(video.category);
    const thumbUrl = getThumbnailUrl(video);

    if (thumbUrl) {
      const img = document.createElement("img");
      img.src = thumbUrl;
      img.alt = video.title;
      img.loading = "lazy";
      img.onerror = () => img.remove();
      thumb.appendChild(img);
      thumb.style.background = cat ? cat.color : "var(--surface-2)";
    } else {
      thumb.style.background = cat
        ? `linear-gradient(135deg, ${cat.color}, ${cat.color}cc)`
        : "var(--surface-2)";
      thumb.textContent = getInitials(video.title);
    }

    const plat = getPlatform(video.platform);
    const badge = document.createElement("span");
    badge.className = "platform-badge";
    badge.style.background = plat.color;
    badge.textContent = plat.label;
    thumb.appendChild(badge);

    const dur = document.createElement("span");
    dur.className = "duration";
    dur.textContent = video.duration;
    thumb.appendChild(dur);

    return thumb;
  }

  function createVideoCard(video) {
    const card = document.createElement("article");
    card.className = "video-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Play ${video.title}`);

    card.appendChild(buildThumb(video));

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = video.title;
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const cat = getCategory(video.category);
    const catSpan = document.createElement("span");
    catSpan.textContent = cat ? cat.label : video.category;
    meta.appendChild(catSpan);
    const levelSpan = document.createElement("span");
    levelSpan.className = "level-badge";
    levelSpan.textContent = video.level;
    meta.appendChild(levelSpan);
    body.appendChild(meta);

    const tagsRow = document.createElement("div");
    tagsRow.className = "card-tags";
    video.tags.slice(0, 3).forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "mini-tag";
      chip.textContent = t;
      tagsRow.appendChild(chip);
    });
    body.appendChild(tagsRow);

    card.appendChild(body);

    const open = () => openModal(video);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });

    return card;
  }

  /* ---------- filtering ---------- */
  function hasActiveFilters() {
    return Boolean(
      state.category || state.platform || state.level || state.tags.size || state.search.trim()
    );
  }

  function getFilteredVideos() {
    const search = state.search.trim().toLowerCase();
    return VIDEOS.filter((v) => {
      if (state.category && v.category !== state.category) return false;
      if (state.platform && v.platform !== state.platform) return false;
      if (state.level && v.level !== state.level) return false;
      if (state.tags.size && ![...state.tags].every((t) => v.tags.includes(t))) return false;
      if (search) {
        const hay = `${v.title} ${v.description} ${v.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  /* ---------- sidebar ---------- */
  function countBy(getKey) {
    const counts = {};
    VIDEOS.forEach((v) => {
      const key = getKey(v);
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  function buildFilterItem({ label, count, active, dotColor, onClick }) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "filter-item" + (active ? " active" : "");
    btn.type = "button";

    const left = document.createElement("span");
    left.style.display = "flex";
    left.style.alignItems = "center";
    if (dotColor) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = dotColor;
      left.appendChild(dot);
    }
    left.appendChild(document.createTextNode(label));
    btn.appendChild(left);

    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = count;
    btn.appendChild(countSpan);

    btn.addEventListener("click", onClick);
    li.appendChild(btn);
    return li;
  }

  function renderSidebar() {
    const catCounts = countBy((v) => v.category);
    els.categoryList.innerHTML = "";
    els.categoryList.appendChild(
      buildFilterItem({
        label: "All Subjects",
        count: VIDEOS.length,
        active: !state.category,
        onClick: () => {
          state.category = null;
          render();
        },
      })
    );
    CATEGORIES.forEach((cat) => {
      if (!catCounts[cat.id]) return;
      els.categoryList.appendChild(
        buildFilterItem({
          label: cat.label,
          count: catCounts[cat.id],
          active: state.category === cat.id,
          dotColor: cat.color,
          onClick: () => {
            state.category = state.category === cat.id ? null : cat.id;
            render();
          },
        })
      );
    });

    const platCounts = countBy((v) => v.platform);
    els.platformList.innerHTML = "";
    PLATFORMS.forEach((plat) => {
      if (!platCounts[plat.id]) return;
      els.platformList.appendChild(
        buildFilterItem({
          label: plat.label,
          count: platCounts[plat.id],
          active: state.platform === plat.id,
          dotColor: plat.color,
          onClick: () => {
            state.platform = state.platform === plat.id ? null : plat.id;
            render();
          },
        })
      );
    });

    const levelCounts = countBy((v) => v.level);
    els.levelList.innerHTML = "";
    LEVELS.forEach((level) => {
      if (!levelCounts[level]) return;
      els.levelList.appendChild(
        buildFilterItem({
          label: level,
          count: levelCounts[level],
          active: state.level === level,
          onClick: () => {
            state.level = state.level === level ? null : level;
            render();
          },
        })
      );
    });

    const tagCounts = {};
    VIDEOS.forEach((v) => v.tags.forEach((t) => (tagCounts[t] = (tagCounts[t] || 0) + 1)));
    const sortedTags = Object.keys(tagCounts).sort(
      (a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b)
    );
    els.tagCloud.innerHTML = "";
    sortedTags.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip" + (state.tags.has(tag) ? " active" : "");
      chip.textContent = tag;
      chip.addEventListener("click", () => {
        if (state.tags.has(tag)) state.tags.delete(tag);
        else state.tags.add(tag);
        render();
      });
      els.tagCloud.appendChild(chip);
    });
  }

  /* ---------- active filter pills ---------- */
  function renderActiveFilters() {
    els.activeFilters.innerHTML = "";
    const pills = [];

    if (state.category) {
      const cat = getCategory(state.category);
      pills.push({ label: `Subject: ${cat.label}`, clear: () => (state.category = null) });
    }
    if (state.platform) {
      pills.push({
        label: `Platform: ${getPlatform(state.platform).label}`,
        clear: () => (state.platform = null),
      });
    }
    if (state.level) {
      pills.push({ label: `Level: ${state.level}`, clear: () => (state.level = null) });
    }
    state.tags.forEach((tag) => {
      pills.push({ label: `Tag: ${tag}`, clear: () => state.tags.delete(tag) });
    });
    if (state.search.trim()) {
      pills.push({
        label: `Search: "${state.search.trim()}"`,
        clear: () => {
          state.search = "";
          els.searchInput.value = "";
        },
      });
    }

    pills.forEach((p) => {
      const pill = document.createElement("span");
      pill.className = "active-filter-pill";
      pill.appendChild(document.createTextNode(p.label));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", "Remove filter");
      btn.textContent = "×";
      btn.addEventListener("click", () => {
        p.clear();
        render();
      });
      pill.appendChild(btn);
      els.activeFilters.appendChild(pill);
    });
  }

  /* ---------- hero ---------- */
  function renderHero() {
    const featured = VIDEOS.find((v) => v.featured) || VIDEOS[0];
    if (!featured) {
      els.hero.hidden = true;
      return;
    }
    els.hero.hidden = false;
    const cat = getCategory(featured.category);
    const thumbUrl = getThumbnailUrl(featured);
    els.heroMedia.style.backgroundImage = thumbUrl
      ? `url("${thumbUrl}")`
      : `linear-gradient(135deg, ${cat ? cat.color : "#333"}, #0d0e12)`;

    const plat = getPlatform(featured.platform);
    els.heroPlatform.textContent = plat.label;
    els.heroPlatform.style.background = plat.color;
    els.heroTitle.textContent = featured.title;
    els.heroMeta.textContent = `${cat ? cat.label : ""} • ${featured.level} • ${featured.duration}`;
    els.heroDesc.textContent = featured.description;
    els.heroPlay.onclick = () => openModal(featured);
  }

  /* ---------- rows (browse view) ---------- */
  function renderRows() {
    els.categoryRows.innerHTML = "";
    CATEGORIES.forEach((cat) => {
      const vids = VIDEOS.filter((v) => v.category === cat.id);
      if (!vids.length) return;

      const row = document.createElement("div");
      row.className = "category-row";

      const header = document.createElement("div");
      header.className = "category-row-header";
      const h2 = document.createElement("h2");
      h2.textContent = cat.label;
      header.appendChild(h2);
      const seeAll = document.createElement("button");
      seeAll.type = "button";
      seeAll.textContent = `See all (${vids.length}) →`;
      seeAll.addEventListener("click", () => {
        state.category = cat.id;
        render();
      });
      header.appendChild(seeAll);
      row.appendChild(header);

      const scroll = document.createElement("div");
      scroll.className = "row-scroll";
      vids.forEach((v) => scroll.appendChild(createVideoCard(v)));
      row.appendChild(scroll);

      els.categoryRows.appendChild(row);
    });
  }

  /* ---------- grid (filtered view) ---------- */
  function renderGrid() {
    const filtered = getFilteredVideos();

    if (state.category) {
      els.resultsTitle.textContent = getCategory(state.category).label;
    } else if (state.search.trim()) {
      els.resultsTitle.textContent = "Search Results";
    } else {
      els.resultsTitle.textContent = "All Subjects";
    }
    els.resultsCount.textContent = `${filtered.length} video${filtered.length === 1 ? "" : "s"}`;

    els.cardGrid.innerHTML = "";
    filtered.forEach((v) => els.cardGrid.appendChild(createVideoCard(v)));
    els.emptyState.hidden = filtered.length !== 0;
  }

  /* ---------- modal ---------- */
  function openModal(video) {
    els.modalMedia.innerHTML = "";
    els.modalMedia.appendChild(getEmbedNode(video));

    const plat = getPlatform(video.platform);
    els.modalPlatform.textContent = plat.label;
    els.modalPlatform.style.background = plat.color;
    els.modalTitle.textContent = video.title;
    const cat = getCategory(video.category);
    els.modalMeta.textContent = `${cat ? cat.label : ""} • ${video.level} • ${video.duration}`;
    els.modalDesc.textContent = video.description;

    els.modalTags.innerHTML = "";
    video.tags.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = t;
      els.modalTags.appendChild(chip);
    });

    els.modalBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    els.modalBackdrop.classList.remove("open");
    els.modalMedia.innerHTML = "";
    document.body.style.overflow = "";
  }

  els.modalClose.addEventListener("click", closeModal);
  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.modalBackdrop.classList.contains("open")) closeModal();
  });

  /* ---------- top-level render ---------- */
  function render() {
    renderSidebar();
    renderActiveFilters();

    const active = hasActiveFilters();
    els.rowsView.hidden = active;
    els.gridView.hidden = !active;
    els.hero.style.display = active ? "none" : "";

    if (active) {
      renderGrid();
    } else {
      renderHero();
      renderRows();
    }
  }

  els.clearFilters.addEventListener("click", () => {
    state.category = null;
    state.platform = null;
    state.level = null;
    state.tags.clear();
    state.search = "";
    els.searchInput.value = "";
    render();
  });

  els.searchInput.addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  /* ---------- mobile sidebar ---------- */
  function setSidebarOpen(open) {
    els.sidebar.classList.toggle("open", open);
    els.sidebarScrim.classList.toggle("open", open);
    els.menuToggle.setAttribute("aria-expanded", String(open));
  }
  els.menuToggle.addEventListener("click", () => {
    setSidebarOpen(!els.sidebar.classList.contains("open"));
  });
  els.sidebarScrim.addEventListener("click", () => setSidebarOpen(false));

  /* ---------- theme ---------- */
  function initTheme() {
    const saved = localStorage.getItem("medlib-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  }
  els.themeToggle.addEventListener("click", () => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("medlib-theme", next);
  });

  initTheme();
  render();
})();
