"use client";

/* ============================================================
   Shelves — the browse view: a spotlight plus one horizontal row per
   subject.

       <Shelves videos={classified} onPlay={playVideo} onSeeAll={filterTo} />

   Three components, kept in one file because they are one idea: a shelf is
   only ever a row of VideoCards, and the spotlight is a VideoCard's data
   at a different size.

   NO POSTER ART, BY CHOICE. Cards carry no thumbnail: a Bunny
   auto-thumbnail of a lecture is usually a half-drawn slide, which tells you
   less than the title does, and behind token auth each one costs a signed
   URL that arrives late and expires. So a card is subject colour, title and
   duration — nothing that can fail to load. lib/poster.js still implements
   signed poster fetching if you ever want to put images back; nothing
   imports it today.

   PERFORMANCE. 6,555 items across 35 subjects is far too much DOM to mount
   at once. Each shelf renders SHELF_LIMIT cards and offers "See all" to
   hand the rest to the filtered grid; shelves themselves only mount their
   contents once they approach the viewport.
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BUCKETS, UNCATEGORIZED } from "@/lib/classify-video";

import styles from "./Shelves.module.css";

/* Cards per shelf before deferring to the grid. Enough to scroll a few
   screens, few enough that 35 shelves stay light. */
const SHELF_LIMIT = 24;

/* Shelves within this margin of the viewport mount their cards. */
const NEAR_VIEWPORT = "600px";

/* The top shelves are above the fold by definition, so they skip the
   observer entirely. That avoids a flash of placeholders on load, and it
   means the page still shows content if IntersectionObserver never fires —
   which happens in a tab that has not been composited yet. */
const EAGER_SHELVES = 3;

export default function Shelves({ videos = [], onPlay, onSeeAll }) {
  const shelves = useMemo(() => {
    const byCategory = new Map();
    for (const v of videos) {
      if (!byCategory.has(v.category)) byCategory.set(v.category, []);
      byCategory.get(v.category).push(v);
    }
    return BUCKETS.map((b) => ({ ...b, items: byCategory.get(b.id) || [] })).filter(
      (s) => s.items.length > 0
    );
  }, [videos]);

  /* The spotlight: the longest lecture in the largest *classified* subject.
     Deterministic, so the page does not reshuffle on every render, and
     long-form means it is a real lecture rather than a 90-second fragment.
     Uncategorized is excluded — it is the biggest bucket by a wide margin,
     and leading the page with a video the classifier could not place says
     nothing about the library. */
  const spotlight = useMemo(() => {
    const named = shelves.filter((s) => s.id !== UNCATEGORIZED);
    if (!named.length) return null;
    const biggest = named.reduce((a, b) => (b.items.length > a.items.length ? b : a));
    return biggest.items.reduce((a, b) =>
      (b.duration_seconds || 0) > (a.duration_seconds || 0) ? b : a
    );
  }, [shelves]);

  if (!videos.length) {
    return (
      <div className={styles.blank}>
        <p>No videos match those filters.</p>
      </div>
    );
  }

  return (
    <div className={styles.shelves}>
      {spotlight && (
        <Spotlight video={spotlight} onPlay={onPlay} />
      )}

      {shelves.map((shelf, i) => (
        <Shelf
          key={shelf.id}
          shelf={shelf}
          eager={i < EAGER_SHELVES}
          onPlay={onPlay}
          onSeeAll={onSeeAll}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   Spotlight
   --------------------------------------------------------------- */

function Spotlight({ video, onPlay }) {
  return (
    <section className={styles.spotlight} style={tint(video.color)}>
      <div className={styles.spotlightBody}>
        <p className={styles.eyebrow}>
          <span className={styles.eyebrowDot} style={{ background: video.color }} />
          {video.label}
          {video.brandLabel && <span className={styles.eyebrowSep}>{video.brandLabel}</span>}
        </p>

        <h2 className={styles.spotlightTitle}>{video.displayTitle}</h2>

        <p className={styles.spotlightMeta}>
          {video.duration && <span className={styles.tabular}>{video.duration}</span>}
          <span>{video.level}</span>
        </p>

        <button type="button" className={styles.play} onClick={() => onPlay?.(video)}>
          <PlayGlyph />
          Play
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------
   Shelf
   --------------------------------------------------------------- */

function Shelf({ shelf, eager = false, onPlay, onSeeAll }) {
  const railRef = useRef(null);
  const shelfRef = useRef(null);
  const near = useNearViewport(shelfRef, NEAR_VIEWPORT, eager);
  const [edges, setEdges] = useState({ start: false, end: true });

  const items = shelf.items.slice(0, SHELF_LIMIT);
  const overflow = shelf.items.length - items.length;

  const readEdges = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft > 8,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
    });
  }, []);

  useEffect(() => {
    if (near) readEdges();
  }, [near, readEdges]);

  /* Page by a viewport-width so a click always lands on a card boundary —
     scroll snapping does the alignment. */
  const page = (direction) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: "smooth" });
  };

  return (
    <section className={styles.shelf} ref={shelfRef}>
      <header className={styles.shelfHead}>
        <h3 className={styles.shelfTitle}>
          <span className={styles.shelfRule} style={{ background: shelf.color }} aria-hidden="true" />
          {shelf.label}
        </h3>

        <span className={`${styles.shelfCount} ${styles.tabular}`}>{shelf.items.length}</span>

        {overflow > 0 && (
          <button type="button" className={styles.seeAll} onClick={() => onSeeAll?.(shelf.id)}>
            See all
          </button>
        )}
      </header>

      <div className={styles.rail}>
        <button
          type="button"
          className={`${styles.arrow} ${styles.arrowStart}`}
          onClick={() => page(-1)}
          hidden={!edges.start}
          aria-label={`Scroll ${shelf.label} back`}
        >
          <ChevronGlyph dir="left" />
        </button>

        <ul className={styles.track} ref={railRef} onScroll={readEdges}>
          {near
            ? items.map((v) => (
                <li key={v.key} className={styles.slot}>
                  <VideoCard video={v} onPlay={onPlay} />
                </li>
              ))
            : items.map((v) => <li key={v.key} className={`${styles.slot} ${styles.ghost}`} />)}
        </ul>

        <button
          type="button"
          className={`${styles.arrow} ${styles.arrowEnd}`}
          onClick={() => page(1)}
          hidden={!edges.end}
          aria-label={`Scroll ${shelf.label} forward`}
        >
          <ChevronGlyph dir="right" />
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------
   Card
   --------------------------------------------------------------- */

export function VideoCard({ video, onPlay }) {
  const ref = useRef(null);

  return (
    <article className={styles.card} ref={ref} style={tint(video.color)}>
      <button type="button" className={styles.cardHit} onClick={() => onPlay?.(video)}>
        <span className={styles.srOnly}>Play {video.displayTitle}</span>
      </button>

      <div className={styles.art}>
        <span className={styles.spine} style={{ background: video.color }} aria-hidden="true" />

        <span className={styles.artGlyph} aria-hidden="true">
          <PlayGlyph />
        </span>

        {video.duration && (
          <span className={`${styles.duration} ${styles.tabular}`}>{video.duration}</span>
        )}
      </div>

      <div className={styles.cardBody}>
        <h4 className={styles.cardTitle} title={video.title}>
          {video.displayTitle}
        </h4>
        <p className={styles.cardMeta}>
          <span style={{ color: video.color }}>{video.label}</span>
          {video.brandLabel && <span className={styles.cardBrand}>{video.brandLabel}</span>}
        </p>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------
   Hooks
   --------------------------------------------------------------- */

/** True once the element comes within `margin` of the viewport, and stays
 *  true — content that has been mounted is not worth unmounting. */
function useNearViewport(ref, margin = NEAR_VIEWPORT, eager = false) {
  const [near, setNear] = useState(eager);

  useEffect(() => {
    const el = ref.current;
    if (!el || near) return undefined;

    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: margin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near, margin]);

  return near;
}

/* ---------------------------------------------------------------
   Bits
   --------------------------------------------------------------- */

/** Expose the subject colour to CSS so the card's wash, focus ring and
 *  hover glow all derive from one value instead of three hardcoded ones. */
function tint(color) {
  return { "--tint": color };
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M7 4.5l13 7.5-13 7.5z" fill="currentColor" />
    </svg>
  );
}

function ChevronGlyph({ dir }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
