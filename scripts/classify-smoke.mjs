/* ============================================================
   Smoke-test lib/classify-video.js against the real library.

       node scripts/classify-smoke.mjs
       node scripts/classify-smoke.mjs --list uncategorized
       node scripts/classify-smoke.mjs --list keyword-low

   Prints the tier breakdown so a rule change can be judged by what moved,
   not by spot-checking a handful of titles.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyAll, classifyVideo, summarize } from "../lib/classify-video.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listArg = process.argv.indexOf("--list");
const listWhat = listArg > -1 ? process.argv[listArg + 1] : null;

/* ---- 1. the documented examples ---- */

const SAMPLE = [
  { title: "Pathoma_Ch1_General_Pathology.mp4", category: "General" },
  { title: "SketchyMicro_MRSA.mov", category: "Microbiology" },
  { title: "Osmosis_Pharm_BetaBlockers.mp4", category: "Pharmacology" },
  { title: "Commentary_SelfReview_01.mp4" },
  { title: "Cardiology_Commentary.mp4" },
  { title: "Commentary.mp4", path: "Neuro/Week 3/Commentary.mp4" },
  { title: "Commentary.mp4" },
  { title: "BnB_Cardio_Preload.mp4" },
  { title: "007 - General Topics - Informed Consent" },
  { title: "Cardio/014 - Preload" },
  { title: "05 Demyelinating Diseases" },
  { title: "Zolpidem Zaleplon Eszopiclone atf" },
];

console.log("=== sample ===");
for (const item of SAMPLE) {
  const r = classifyVideo(item);
  const flags = [r.isGeneric && "generic", r.conflict && "CONFLICT"].filter(Boolean).join(",");
  console.log(
    `${String(item.title).padEnd(40)} -> ${r.category.padEnd(15)} ` +
      `${r.source.padEnd(11)} ${r.confidence.padEnd(7)} ` +
      `brand=${String(r.brand).padEnd(9)} title="${r.displayTitle}"${flags ? ` [${flags}]` : ""}`
  );
}

/* Same three inputs with the hand-entered category ignored, which is what
   exercises the filename tiers the sample metadata would otherwise mask. */
console.log("\n=== sample, --preferFilename ===");
for (const item of SAMPLE.slice(0, 3)) {
  const r = classifyVideo(item, { preferFilename: true });
  console.log(
    `${String(item.title).padEnd(40)} -> ${r.category.padEnd(15)} ${r.source.padEnd(11)} ` +
      `conflict=${r.conflict}`
  );
}

/* ---- 2. the real catalog ---- */

const catalogPath = path.join(ROOT, "bunny_catalog.json");
if (!fs.existsSync(catalogPath)) {
  console.log("\nbunny_catalog.json not found — skipping the full-library pass.");
  process.exit(0);
}

const library = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const t0 = performance.now();
const classified = classifyAll(library, { preferFilename: true });
const ms = performance.now() - t0;

const bySource = {};
const byConfidence = {};
for (const v of classified) {
  const key = v.source === "keyword" ? `keyword-${v.confidence}` : v.source;
  bySource[key] = (bySource[key] || 0) + 1;
  byConfidence[v.confidence] = (byConfidence[v.confidence] || 0) + 1;
}

const placed = classified.filter((v) => v.category !== "uncategorized").length;

console.log(`\n=== ${library.length} titles from bunny_catalog.json ===`);
console.log(`classified in ${ms.toFixed(0)}ms (${(ms / library.length).toFixed(3)}ms/title)`);
console.log(`placed: ${placed} (${((placed / library.length) * 100).toFixed(1)}%)`);
console.log(`\ndeciding tier: ${JSON.stringify(bySource, null, 0)}`);
console.log(`confidence   : ${JSON.stringify(byConfidence, null, 0)}`);

console.log("\nby subject:");
for (const b of summarize(classified).sort((a, b) => b.count - a.count)) {
  console.log(`  ${String(b.count).padStart(5)}  ${b.label}`);
}

if (listWhat) {
  const matches = classified.filter((v) =>
    listWhat === "uncategorized"
      ? v.category === "uncategorized"
      : `${v.source}-${v.confidence}` === listWhat || v.source === listWhat
  );
  console.log(`\n=== ${matches.length} titles matching "${listWhat}" ===`);
  for (const v of matches.slice(0, 200)) console.log(`  ${v.title}`);
  if (matches.length > 200) console.log(`  … and ${matches.length - 200} more`);
}
