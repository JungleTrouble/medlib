/* ============================================================
   Filter state + facet counting for the sidebar.

   Kept out of the component so the same predicate runs in the grid, in
   tests, and (if you ever move filtering server-side) in the API layer.

   Facet counts are computed with the facet's own selections excluded —
   selecting "Cardiology" must not collapse every other subject's count to
   zero, or the sidebar becomes a dead end after the first click.
   ============================================================ */

import { BUCKETS, UNCATEGORIZED, getBucket } from "./classify-video.js";

export const EMPTY_FILTERS = Object.freeze({
  categories: [],
  levels: [],
  tags: [],
  search: "",
});

/** Add/remove a value, returning a new array. */
export function toggleValue(list, value) {
  const set = new Set(list);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

/** Fill in any facet a caller left off, so a partial object is safe. */
function normalize(filters) {
  return {
    categories: filters?.categories || [],
    levels: filters?.levels || [],
    tags: filters?.tags || [],
    search: filters?.search || "",
  };
}

export function isEmptyFilters(filters) {
  const f = normalize(filters);
  return !f.categories.length && !f.levels.length && !f.tags.length && !f.search.trim();
}

export function countActive(filters) {
  const f = normalize(filters);
  return f.categories.length + f.levels.length + f.tags.length + (f.search.trim() ? 1 : 0);
}

/* Searchable text per video, memoised on the object so a keystroke does not
   rebuild it for all 6,500 entries. */
const HAYSTACK = new WeakMap();

function haystack(video) {
  if (typeof video !== "object" || video === null) return String(video).toLowerCase();
  const cached = HAYSTACK.get(video);
  if (cached) return cached;

  const built = [
    video.title,
    video.displayTitle,
    video.description,
    video.brandLabel,
    getBucket(video.category).label,
    ...(video.tags || []),
    ...(video.keywords || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  HAYSTACK.set(video, built);
  return built;
}

/**
 * @param {Object} video     a classified entry
 * @param {Object} filters
 * @param {string} [skip]    facet to ignore, for facet counting
 */
export function matchesFilters(video, rawFilters, skip) {
  const filters = normalize(rawFilters);

  if (skip !== "categories" && filters.categories.length &&
      !filters.categories.includes(video.category)) return false;

  if (skip !== "levels" && filters.levels.length &&
      !filters.levels.includes(video.level)) return false;

  /* Tags are AND-ed: picking two narrows, it does not widen. */
  if (skip !== "tags" && filters.tags.length) {
    const tags = video.tags || [];
    if (!filters.tags.every((t) => tags.includes(t))) return false;
  }

  if (skip !== "search") {
    const q = filters.search.trim().toLowerCase();
    if (q) {
      const hay = haystack(video);
      if (!q.split(/\s+/).every((term) => hay.includes(term))) return false;
    }
  }

  return true;
}

export function applyFilters(videos, filters) {
  if (isEmptyFilters(filters)) return videos;
  return videos.filter((v) => matchesFilters(v, filters));
}

/**
 * Counts for every facet value, each computed against the set filtered by
 * the *other* facets.
 *
 * @returns {{categories: Array, levels: Array, tags: Array, total: number}}
 */
export function computeFacets(videos, rawFilters) {
  const filters = normalize(rawFilters);
  const categoryCounts = new Map();
  const levelCounts = new Map();
  const tagCounts = new Map();
  let total = 0;

  for (const v of videos) {
    if (matchesFilters(v, filters)) total++;

    if (matchesFilters(v, filters, "categories")) {
      categoryCounts.set(v.category, (categoryCounts.get(v.category) || 0) + 1);
    }
    if (matchesFilters(v, filters, "levels")) {
      levelCounts.set(v.level, (levelCounts.get(v.level) || 0) + 1);
    }
    if (matchesFilters(v, filters, "tags")) {
      for (const tag of v.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  /* Subjects keep the BUCKETS order (foundational -> systems -> clinical);
     a zero-count subject is kept only while it is selected, so unticking it
     is always possible. */
  const categories = BUCKETS
    .map((b) => ({ ...b, count: categoryCounts.get(b.id) || 0 }))
    .filter((b) => b.count > 0 || filters.categories.includes(b.id))
    .sort((a, b) => {
      // Uncategorized sinks to the bottom regardless of size.
      if (a.id === UNCATEGORIZED) return 1;
      if (b.id === UNCATEGORIZED) return -1;
      return 0;
    });

  const levels = [...levelCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  const tags = [...tagCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return { categories, levels, tags, total };
}
