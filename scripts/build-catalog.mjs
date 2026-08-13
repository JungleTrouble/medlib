/* ============================================================
   Build data/catalog.json from Bunny, using collections as folders.

       node scripts/build-catalog.mjs
       node scripts/build-catalog.mjs --all     keep non-finished videos too

   Every video in the library belongs to a Bunny collection, and each
   collection is named with its full source path —

       Sketchy / Microbiology / Bacteria / Gram-Positive Bacilli

   — so placement is a lookup, not an inference. This supersedes the
   title-matching in reconcile-bunny.mjs and the runtime tie-breaking in
   match_by_duration.py: both existed only because the earlier sync did not
   record collectionId, which left the folder unknowable. Neither is needed
   now, and neither can misplace anything, because nothing is being guessed.

   The subject still comes from lib/classify-video.js, but now with a real
   folder for every single video rather than for the 82% that happened to
   match by title. Its folder tier finally has complete input.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVideo, getBucket, BUCKETS, LEVELS } from "../lib/classify-video.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEOS = path.join(ROOT, "bunny_catalog.json");
const COLLECTIONS = path.join(ROOT, "bunny_collections.json");
const OUT = path.join(ROOT, "data", "catalog.json");

const KEEP_ALL = process.argv.includes("--all");

/* Bunny separates the path segments of a collection name with " / ". */
const NAME_SEP = /\s*\/\s*/;

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* Distinct from the 35 subject hues; the UI renders a source as an outlined
   pill so the two are never confused. */
const COLLECTION_COLORS = [
  "#e2703a", "#7c5cff", "#14bf96", "#f5a623",
  "#4f6bf6", "#e0526c", "#00a0b0", "#a678de",
  "#6ab04c", "#c0392b", "#3fb8e8", "#8e44ad",
];

function main() {
  for (const p of [VIDEOS, COLLECTIONS]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing ${path.basename(p)} — run: python scripts/sync_bunny.py --all`);
      process.exit(1);
    }
  }

  const videos = JSON.parse(fs.readFileSync(VIDEOS, "utf8"));
  const collections = JSON.parse(fs.readFileSync(COLLECTIONS, "utf8"));
  const nameById = new Map(collections.map((c) => [c.id, c.name]));

  const stats = { skipped: 0, noCollection: 0, bySource: {}, byStatus: {} };
  const items = [];

  for (const v of videos) {
    stats.byStatus[v.status] = (stats.byStatus[v.status] || 0) + 1;

    // A video that failed transcoding has no playable rendition; listing it
    // would be a card that always errors.
    if (!KEEP_ALL && v.status !== "finished") {
      stats.skipped += 1;
      continue;
    }

    const rawName = nameById.get(v.collection_id) || "";
    const parts = rawName.split(NAME_SEP).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) stats.noCollection += 1;

    const folder = parts.join("/");
    // Skip the collection name itself when classifying: "Sketchy" is a
    // publisher, not a subject, and would only add noise.
    const result = classifyVideo(
      { title: v.title, folder: parts.slice(1).join("/") },
      { preferFilename: true }
    );
    const bucket = getBucket(result.category);
    stats.bySource[result.source] = (stats.bySource[result.source] || 0) + 1;

    items.push({
      id: v.id,
      title: v.title,
      path: `${v.id}/playlist.m3u8`,
      bucket: bucket.id,
      level: result.level,
      tags: [...new Set([
        ...result.tags,
        ...parts.map(slug),
      ])].filter(Boolean),
      confidence: result.confidence,
      rule: result.source,
      duration: v.duration,
      size: v.storage_size || 0,
      mtime: 0,
      source: "bunny-stream",
      collection: parts[0] || "",
      section: parts[1] || "",
      folder,
    });
  }

  items.sort((a, b) => a.title.localeCompare(b.title));

  /* ---- facets ---- */

  const bucketCounts = new Map();
  const levelCounts = new Map();
  const tagCounts = new Map();
  const tagLabels = new Map();
  const folderRoot = new Map();
  const collCounts = new Map();

  for (const it of items) {
    bucketCounts.set(it.bucket, (bucketCounts.get(it.bucket) || 0) + 1);
    levelCounts.set(it.level, (levelCounts.get(it.level) || 0) + 1);
    for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    if (it.collection) collCounts.set(it.collection, (collCounts.get(it.collection) || 0) + 1);

    // Counts are cumulative: a collapsed row reports its whole branch.
    let level = folderRoot;
    const trail = [];
    for (const name of it.folder.split("/").filter(Boolean)) {
      tagLabels.set(slug(name), name);
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
      .map((n) => ({ label: n.label, path: n.path, count: n.count, children: toTree(n.children) }))
      .sort((a, b) => b.count - a.count);

  const collectionsOut = [...collCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], i) => ({
      id: slug(label),
      label,
      color: COLLECTION_COLORS[i % COLLECTION_COLORS.length],
      count,
    }));

  const catalog = {
    generated_at: new Date().toISOString(),
    count: items.length,
    buckets: BUCKETS
      .map((b) => ({ id: b.id, label: b.label, color: b.color, count: bucketCounts.get(b.id) || 0 }))
      .filter((b) => b.count > 0),
    levels: LEVELS.filter((l) => levelCounts.has(l)),
    tagFacets: [...tagCounts.entries()]
      .map(([id, count]) => ({ id, label: tagLabels.get(id) || id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    collections: collectionsOut,
    folders: toTree(folderRoot),
    stats: { videos: items.length },
    items,
  };
  catalog.tags = catalog.tagFacets.map((t) => t.id);

  if (fs.existsSync(OUT)) fs.copyFileSync(OUT, `${OUT}.bak`);
  fs.writeFileSync(OUT, JSON.stringify(catalog));

  console.log(`Videos in library     : ${videos.length.toLocaleString()}`);
  console.log(`  by status           : ${JSON.stringify(stats.byStatus)}`);
  if (stats.skipped) console.log(`  skipped, not finished: ${stats.skipped.toLocaleString()}`);
  console.log(`  written             : ${items.length.toLocaleString()}`);
  console.log(`  with a folder       : ${items.filter((i) => i.folder).length.toLocaleString()}`);
  console.log(`  no collection       : ${stats.noCollection.toLocaleString()}`);
  console.log(`\nSubjects ${catalog.buckets.length}   collections ${collectionsOut.length}   ` +
              `folder nodes ${(function c(n){return n.reduce((a,x)=>a+1+c(x.children),0);})(catalog.folders)}   ` +
              `tags ${catalog.tagFacets.length}`);
  console.log(`\nSubject decided by:`);
  for (const [k, n] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  console.log(`\nWrote data/catalog.json (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
}

main();
