/* ============================================================
   Join the Resource Guide index to the Bunny catalogue.

       node scripts/reconcile-bunny.mjs            report only
       node scripts/reconcile-bunny.mjs --write    enrich data/catalog.json

   The two sides describe the same videos with no shared key. Bunny stores a
   GUID and a title; the index stores a path and a filename. The only join
   available is the title, so this matches on a normalised form of it and is
   honest about what does not line up.

   Matching, in order:
     1. exact normalised title, when that title is unique on both sides
     2. unique match after stripping trailing "atf", "(1)", "-converted"
        and similar upload noise
     3. everything else is left unmatched and reported

   Titles that occur more than once on either side are never guessed at. 399
   titles repeat in the source library, and picking the wrong "Commentary"
   would attach a Cardiology section to a Neurology video — worse than
   leaving it alone.

   With --write, matched Bunny items gain `collection`, `section` and a
   better `bucket` from the index. Unmatched items keep exactly what they
   had, so a partial join never degrades the catalogue.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "data", "library-index.json");
const CATALOG_PATH = path.join(ROOT, "data", "catalog.json");
const REPORT_PATH = path.join(ROOT, "data", "reconcile-report.json");

const WRITE = process.argv.includes("--write");

/** Lowercase, strip extension, collapse punctuation and whitespace. */
function normalize(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\.(mp4|m4v|mkv|mov|webm|avi|wmv|flv|ts|mpg|mpeg)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Additionally drop upload noise: series markers, copy suffixes, "converted". */
function loosen(normalized) {
  return normalized
    .replace(/\b(atf|converted|new|copy|final)\b/g, " ")
    .replace(/\b\d+\b\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index by key, keeping only keys that map to exactly one entry. */
function uniqueIndex(rows, keyOf) {
  const seen = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (seen.has(key)) seen.get(key).push(row);
    else seen.set(key, [row]);
  }
  const unique = new Map();
  const ambiguous = new Map();
  for (const [key, list] of seen) {
    if (list.length === 1) unique.set(key, list[0]);
    else ambiguous.set(key, list);
  }
  return { unique, ambiguous };
}

function main() {
  for (const p of [INDEX_PATH, CATALOG_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing ${path.relative(ROOT, p)} — run build-library-index.mjs first.`);
      process.exit(1);
    }
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

  const indexed = [];
  for (const category of index.categories) {
    for (const sub of category.subcategories) {
      for (const v of sub.videos) {
        indexed.push({ ...v, category: category.name, subcategory: sub.name });
      }
    }
  }

  const bunny = catalog.items || [];

  const idxExact = uniqueIndex(indexed, (r) => normalize(r.filename));
  const idxLoose = uniqueIndex(indexed, (r) => loosen(normalize(r.filename)));
  const bunnyExact = uniqueIndex(bunny, (r) => normalize(r.title));

  const matches = new Map(); // bunny id -> indexed row
  const how = { exact: 0, loose: 0 };
  const unmatchedBunny = [];
  const ambiguousBunny = [];

  for (const item of bunny) {
    const key = normalize(item.title);

    // A title that repeats inside Bunny cannot be resolved by title alone.
    if (!bunnyExact.unique.has(key)) {
      ambiguousBunny.push(item);
      continue;
    }

    const exact = idxExact.unique.get(key);
    if (exact) {
      matches.set(item.id, exact);
      how.exact += 1;
      continue;
    }

    const loose = idxLoose.unique.get(loosen(key));
    if (loose) {
      matches.set(item.id, loose);
      how.loose += 1;
      continue;
    }

    unmatchedBunny.push(item);
  }

  const matchedIndexIds = new Set([...matches.values()].map((r) => r.id));
  const notUploaded = indexed.filter((r) => !matchedIndexIds.has(r.id));

  /* ---- what changes if we write ---- */
  let bucketChanges = 0;
  for (const item of bunny) {
    const m = matches.get(item.id);
    if (m && m.subject !== "uncategorized" && m.subject !== item.bucket) bucketChanges += 1;
  }

  const pct = (n) => `${((n / bunny.length) * 100).toFixed(1)}%`;

  console.log(`Bunny items          : ${bunny.length.toLocaleString()}`);
  console.log(`Indexed videos       : ${indexed.length.toLocaleString()}`);
  console.log("");
  console.log(`Matched              : ${matches.size.toLocaleString()} (${pct(matches.size)})`);
  console.log(`  by exact title     : ${how.exact.toLocaleString()}`);
  console.log(`  after loosening    : ${how.loose.toLocaleString()}`);
  console.log(`Ambiguous in Bunny   : ${ambiguousBunny.length.toLocaleString()} (title repeats; not guessed)`);
  console.log(`No match in index    : ${unmatchedBunny.length.toLocaleString()}`);
  console.log("");
  console.log(`In index, not on Bunny: ${notUploaded.length.toLocaleString()}  <- local only`);
  console.log(`Bucket would change  : ${bucketChanges.toLocaleString()} of the matched`);

  const report = {
    generated_at: new Date().toISOString(),
    counts: {
      bunny: bunny.length,
      indexed: indexed.length,
      matched: matches.size,
      matchedExact: how.exact,
      matchedLoose: how.loose,
      ambiguousInBunny: ambiguousBunny.length,
      noMatchInIndex: unmatchedBunny.length,
      inIndexNotOnBunny: notUploaded.length,
      bucketChanges,
    },
    notUploaded: notUploaded.slice(0, 500).map((r) => ({
      title: r.title, collection: r.category, section: r.subcategory, path: r.path,
    })),
    noMatchInIndex: unmatchedBunny.slice(0, 500).map((r) => ({ id: r.id, title: r.title })),
    ambiguousInBunny: ambiguousBunny.slice(0, 200).map((r) => ({ id: r.id, title: r.title })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, REPORT_PATH)}`);

  if (!WRITE) {
    console.log("Report only. Re-run with --write to enrich data/catalog.json.");
    return;
  }

  /* ---- enrich, without losing anything ---- */
  fs.copyFileSync(CATALOG_PATH, `${CATALOG_PATH}.bak`);

  /* Source colours. Distinct from the 35 subject hues in use and rendered as
     an outlined pill rather than a filled one, so a source is never mistaken
     for a subject at a glance. */
  const COLLECTION_COLORS = [
    "#e2703a", "#7c5cff", "#14bf96", "#f5a623",
    "#4f6bf6", "#e0526c", "#00a0b0", "#a678de",
  ];

  const slugOf = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Human labels for slugged tags, so the sidebar shows "Old but Gold
  // Sketchys" rather than "old-but-gold-sketchys".
  const tagLabels = new Map();

  const collections = new Map();
  for (const item of bunny) {
    const m = matches.get(item.id);
    if (!m) continue;

    item.collection = m.category;
    item.section = m.subcategory;
    item.folder = m.folder || [m.category, m.subcategory].filter(Boolean).join("/");
    if (m.subject && m.subject !== "uncategorized") item.bucket = m.subject;
    if (m.captions) item.captions = m.captions;
    if (m.exam?.length) item.exam = m.exam;
    /* Every folder segment becomes a tag, at full depth. "Pixorize /
       Neurology / Cranial Nerves" tags all three, so a video is findable by
       its source, its subject area, and the specific series it belongs to.
       The earlier 3-level cap lost the deepest folder, which is usually the
       most specific thing anyone would search for. */
    const folderTags = (item.folder || "").split("/").filter(Boolean).map(slugOf);
    item.tags = [...new Set([...(item.tags || []), ...(m.tags || []), ...folderTags])]
      // "atf" is an upload marker on more than half the library, so as a
      // filter it separates nothing.
      .filter((tag) => tag !== "atf-series" && tag !== "atf");
    for (const seg of (item.folder || "").split("/").filter(Boolean)) {
      tagLabels.set(slugOf(seg), seg);
    }

    if (!collections.has(m.category)) collections.set(m.category, new Map());
    const sections = collections.get(m.category);
    sections.set(m.subcategory, (sections.get(m.subcategory) || 0) + 1);
  }

  /* Nested folder tree for the Sources tab, counted from what is actually on
     Bunny rather than from the source library. Counts are cumulative: a node
     reports everything in its branch, which is what a collapsed row has to
     say to be worth opening. */
  const folderRoot = new Map();
  for (const item of bunny) {
    if (!item.folder) continue;
    const segments = item.folder.split("/").filter(Boolean);
    let level = folderRoot;
    let trail = [];
    for (const name of segments) {
      trail.push(name);
      if (!level.has(name)) {
        level.set(name, { label: name, path: trail.join("/"), count: 0, children: new Map() });
      }
      const node = level.get(name);
      node.count += 1;
      level = node.children;
    }
  }

  const toTree = (level) =>
    [...level.values()]
      .map((n) => ({
        label: n.label,
        path: n.path,
        count: n.count,
        children: toTree(n.children),
      }))
      .sort((a, b) => b.count - a.count);

  catalog.folders = toTree(folderRoot);

  // Flat facet list kept alongside, for anything that just wants the top level.
  catalog.collections = [...collections.entries()]
    .map(([name, sections], i) => ({
      color: COLLECTION_COLORS[i % COLLECTION_COLORS.length],
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      label: name,
      count: [...sections.values()].reduce((a, b) => a + b, 0),
      sections: [...sections.entries()]
        .map(([label, count]) => ({
          id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
          label,
          count,
        }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  /* The tag facet in catalog.json was written before enrichment and lists 40
     entries while the items carry hundreds. Rebuild it from the items so the
     sidebar offers what is actually there, with counts and readable labels. */
  for (const item of bunny) {
    if (item.tags) {
      item.tags = item.tags.filter((tag) => tag !== "atf-series" && tag !== "atf");
    }
  }

  const tagCounts = new Map();
  for (const item of bunny) {
    for (const tag of item.tags || []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  catalog.tagFacets = [...tagCounts.entries()]
    .map(([id, count]) => ({ id, label: tagLabels.get(id) || id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  catalog.tags = catalog.tagFacets.map((t) => t.id);

  // Recount buckets so the sidebar totals match the enriched data.
  const bucketCounts = new Map();
  for (const item of bunny) bucketCounts.set(item.bucket, (bucketCounts.get(item.bucket) || 0) + 1);
  for (const b of catalog.buckets) b.count = bucketCounts.get(b.id) || 0;

  catalog.generated_at = new Date().toISOString();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
  console.log(`Enriched data/catalog.json (backup at catalog.json.bak)`);
  console.log(`  collections: ${catalog.collections.length}`);
}

main();
