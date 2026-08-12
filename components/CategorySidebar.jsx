"use client";

/* ============================================================
   CategorySidebar — subject / level / tag filtering.

       import CategorySidebar, { useVideoFilters } from "@/components/CategorySidebar";
       import { classifyAll } from "@/lib/classify-video";
       import { applyFilters } from "@/lib/video-filters";

       const videos  = useMemo(() => classifyAll(library), [library]);
       const [filters, actions] = useVideoFilters();
       const visible = useMemo(() => applyFilters(videos, filters), [videos, filters]);

       <CategorySidebar
         videos={videos}
         filters={filters}
         onFiltersChange={actions.set}
         open={drawerOpen}
         onClose={() => setDrawerOpen(false)}
       />

   Counts come from lib/video-filters and exclude the facet's own
   selections, so every subject still shows how many entries it would add
   after you have already picked one.

   Filtering the full library on the client is fine at this size — 6.5k
   entries is a sub-millisecond pass. If the library grows past ~50k, move
   applyFilters behind /api/catalog and feed this component the facet
   counts the server returns; the props do not need to change.
   ============================================================ */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { LEVELS, UNCATEGORIZED } from "@/lib/classify-video";
import {
  EMPTY_FILTERS,
  computeFacets,
  countActive,
  isEmptyFilters,
  toggleValue,
} from "@/lib/video-filters";

import styles from "./CategorySidebar.module.css";

/* Tags run to a long tail; show the head and let the rest expand. */
const TAG_HEAD = 12;
/* Below this many subjects the filter-the-filters box is noise. */
const SUBJECT_SEARCH_THRESHOLD = 14;

const numberFormat = new Intl.NumberFormat();

/* ---------------------------------------------------------------
   Filter state. Exported so a page can own it without re-deriving the
   shape, and so the grid and the sidebar cannot drift apart.
   --------------------------------------------------------------- */
export function useVideoFilters(initial = EMPTY_FILTERS) {
  const [filters, setFilters] = useState(initial);

  const actions = useMemo(
    () => ({
      set: setFilters,
      toggleCategory: (id) =>
        setFilters((f) => ({ ...f, categories: toggleValue(f.categories, id) })),
      toggleLevel: (id) => setFilters((f) => ({ ...f, levels: toggleValue(f.levels, id) })),
      toggleTag: (id) => setFilters((f) => ({ ...f, tags: toggleValue(f.tags, id) })),
      setSearch: (search) => setFilters((f) => ({ ...f, search })),
      clear: () => setFilters(EMPTY_FILTERS),
    }),
    []
  );

  return [filters, actions];
}

/* ---------------------------------------------------------------
   Component
   --------------------------------------------------------------- */

export default function CategorySidebar({
  videos = [],
  filters = EMPTY_FILTERS,
  onFiltersChange,
  open = false,
  onClose,
  className = "",
}) {
  const asideRef = useRef(null);
  const [subjectQuery, setSubjectQuery] = useState("");
  const [showAllTags, setShowAllTags] = useState(false);

  const facets = useMemo(() => computeFacets(videos, filters), [videos, filters]);

  const update = useCallback(
    (patch) => onFiltersChange?.({ ...filters, ...patch }),
    [filters, onFiltersChange]
  );

  const toggleCategory = useCallback(
    (id) => update({ categories: toggleValue(filters.categories, id) }),
    [filters.categories, update]
  );
  const toggleLevel = useCallback(
    (id) => update({ levels: toggleValue(filters.levels, id) }),
    [filters.levels, update]
  );
  const toggleTag = useCallback(
    (id) => update({ tags: toggleValue(filters.tags, id) }),
    [filters.tags, update]
  );

  /* Escape closes the mobile drawer. Bound only while it is open so the
     handler is not sitting on the document for the whole session. */
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  /* Opening the drawer moves focus into it; without this a keyboard user
     tabs through the whole page behind the scrim to reach the filters. */
  useEffect(() => {
    if (open) asideRef.current?.querySelector("button, input")?.focus();
  }, [open]);

  const activeCount = countActive(filters);
  const showSubjectSearch = facets.categories.length >= SUBJECT_SEARCH_THRESHOLD;

  const visibleSubjects = useMemo(() => {
    const q = subjectQuery.trim().toLowerCase();
    if (!q) return facets.categories;
    // A selected subject stays visible even when it is filtered out, so the
    // list never hides a filter that is currently doing something.
    return facets.categories.filter(
      (c) => c.label.toLowerCase().includes(q) || filters.categories.includes(c.id)
    );
  }, [facets.categories, subjectQuery, filters.categories]);

  const groupedSubjects = useMemo(() => groupBy(visibleSubjects, (c) => c.group), [visibleSubjects]);

  const visibleTags = showAllTags ? facets.tags : facets.tags.slice(0, TAG_HEAD);

  return (
    <>
      <div
        className={`${styles.scrim} ${open ? styles.scrimOpen : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        ref={asideRef}
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""} ${className}`}
        aria-label="Filter library"
      >
        <header className={styles.header}>
          <span className={styles.resultCount}>
            {numberFormat.format(facets.total)}
            <span className={styles.resultCountLabel}>
              {facets.total === 1 ? " video" : " videos"}
            </span>
          </span>

          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => onFiltersChange?.(EMPTY_FILTERS)}
            disabled={isEmptyFilters(filters)}
          >
            Clear{activeCount ? ` (${activeCount})` : ""}
          </button>
        </header>

        <div className={styles.scrollArea}>
          <Section title="Subjects" count={facets.categories.length} defaultOpen>
            {showSubjectSearch && (
              <input
                type="search"
                className={styles.inlineSearch}
                value={subjectQuery}
                onChange={(e) => setSubjectQuery(e.target.value)}
                placeholder="Find a subject…"
                aria-label="Find a subject"
              />
            )}

            {visibleSubjects.length === 0 && (
              <p className={styles.empty}>No subjects match “{subjectQuery}”.</p>
            )}

            {groupedSubjects.map(([group, items]) => (
              <div key={group} className={styles.group}>
                {!subjectQuery && <h4 className={styles.groupLabel}>{group}</h4>}
                <ul className={styles.list}>
                  {items.map((c) => (
                    <FilterRow
                      key={c.id}
                      label={c.label}
                      count={c.count}
                      color={c.color}
                      muted={c.id === UNCATEGORIZED}
                      selected={filters.categories.includes(c.id)}
                      onToggle={() => toggleCategory(c.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          <Section title="Level" defaultOpen>
            <ul className={styles.list}>
              {LEVELS.filter((l) => facets.levels.some((f) => f.id === l)).map((level) => {
                const facet = facets.levels.find((f) => f.id === level);
                return (
                  <FilterRow
                    key={level}
                    label={level}
                    count={facet.count}
                    muted={level === "Uncategorized"}
                    selected={filters.levels.includes(level)}
                    onToggle={() => toggleLevel(level)}
                  />
                );
              })}
            </ul>
          </Section>

          <Section title="Tags" count={facets.tags.length} defaultOpen={false}>
            <div className={styles.tagCloud}>
              {visibleTags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.tag} ${filters.tags.includes(t.id) ? styles.tagOn : ""}`}
                  aria-pressed={filters.tags.includes(t.id)}
                  onClick={() => toggleTag(t.id)}
                >
                  {humanizeTag(t.id)}
                  <span className={styles.tagCount}>{numberFormat.format(t.count)}</span>
                </button>
              ))}
            </div>

            {facets.tags.length > TAG_HEAD && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => setShowAllTags((v) => !v)}
              >
                {showAllTags ? "Show fewer" : `Show all ${facets.tags.length} tags`}
              </button>
            )}
          </Section>
        </div>
      </aside>
    </>
  );
}

/* ---------------------------------------------------------------
   Pieces
   --------------------------------------------------------------- */

function Section({ title, count, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionHeading}>
        <button
          type="button"
          className={styles.sectionToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {title}
          {count != null && <span className={styles.sectionCount}>{count}</span>}
        </button>
      </h3>

      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function FilterRow({ label, count, color, selected, muted, onToggle }) {
  return (
    <li>
      <button
        type="button"
        className={`${styles.row} ${selected ? styles.rowOn : ""} ${muted ? styles.rowMuted : ""}`}
        aria-pressed={selected}
        onClick={onToggle}
      >
        <span className={styles.dot} style={color ? { background: color } : undefined} aria-hidden="true" />
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowCount}>{numberFormat.format(count)}</span>
      </button>
    </li>
  );
}

/* ---------------------------------------------------------------
   Helpers
   --------------------------------------------------------------- */

/** Group preserving first-seen order — BUCKETS order, not alphabetical. */
function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const key = keyOf(item) ?? "Other";
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return [...out.entries()];
}

/** "board-style-question" -> "Board style question" */
function humanizeTag(tag) {
  const text = String(tag).replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
