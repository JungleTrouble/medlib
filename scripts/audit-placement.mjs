/* ============================================================
   Audit: is every video where it should be?

       node scripts/audit-placement.mjs
       node scripts/audit-placement.mjs --folder "Sketchy/Old but Gold Sketchys/Micro"
       node scripts/audit-placement.mjs --worst 40

   Compares two things that should agree:

     data/library-index.json   what is in the source library on disk
     data/catalog.json         what the site can actually show

   A video goes missing from a folder for one of two reasons, and they need
   very different fixes:

     NOT UPLOADED  it exists on disk but has no counterpart in Bunny, so
                   there is nothing to stream. Fix by uploading.
     UNPLACED      it is on Bunny and playable, but the title-based join
                   could not decide which file on disk it corresponds to,
                   so it has no folder and appears under Subjects only.
                   Fix by disambiguating, not by uploading.

   The second is the one that makes a folder look short while the video is
   sitting right there in the library.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const ONLY = arg("--folder");
const WORST = Number(arg("--worst") || 25);

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\.(mp4|m4v|mkv|mov|webm|avi|wmv|flv|ts|mpg|mpeg)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function main() {
  const indexPath = path.join(ROOT, "data", "library-index.json");
  if (!fs.existsSync(indexPath)) {
    console.error("data/library-index.json missing — run build-library-index.mjs");
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalog.json"), "utf8"));

  // Everything on disk, by folder.
  const onDisk = [];
  for (const cat of index.categories) {
    for (const sub of cat.subcategories) {
      for (const v of sub.videos) onDisk.push(v);
    }
  }

  // Everything the site has, indexed by normalised title.
  const bunnyByTitle = new Map();
  for (const item of catalog.items) {
    const key = norm(item.title);
    if (!bunnyByTitle.has(key)) bunnyByTitle.set(key, []);
    bunnyByTitle.get(key).push(item);
  }

  const placedFolders = new Map(); // folder -> count actually showing
  for (const item of catalog.items) {
    if (!item.folder) continue;
    placedFolders.set(item.folder, (placedFolders.get(item.folder) || 0) + 1);
  }

  // Per-folder reconciliation.
  const folders = new Map();
  for (const v of onDisk) {
    const f = v.folder || "(none)";
    if (!folders.has(f)) {
      folders.set(f, { folder: f, onDisk: 0, showing: 0, notUploaded: [], unplaced: [] });
    }
    const row = folders.get(f);
    row.onDisk += 1;

    const candidates = bunnyByTitle.get(norm(v.filename)) || [];
    if (!candidates.length) {
      row.notUploaded.push(v.title);
    } else if (candidates.some((c) => c.folder === f)) {
      // present and filed correctly
    } else {
      // on Bunny, but the join left it without this folder
      row.unplaced.push(v.title);
    }
  }

  for (const [f, row] of folders) row.showing = placedFolders.get(f) || 0;

  const rows = [...folders.values()];
  const totals = rows.reduce(
    (a, r) => ({
      onDisk: a.onDisk + r.onDisk,
      notUploaded: a.notUploaded + r.notUploaded.length,
      unplaced: a.unplaced + r.unplaced.length,
    }),
    { onDisk: 0, notUploaded: 0, unplaced: 0 }
  );

  if (ONLY) {
    const matching = rows.filter((r) => r.folder === ONLY || r.folder.startsWith(ONLY + "/"));
    console.log(`Folders under "${ONLY}":\n`);
    for (const r of matching.sort((a, b) => a.folder.localeCompare(b.folder))) {
      const ok = r.onDisk - r.notUploaded.length - r.unplaced.length;
      console.log(`${r.folder}`);
      console.log(`   on disk ${r.onDisk}   showing ${ok}   not uploaded ${r.notUploaded.length}   unplaced ${r.unplaced.length}`);
      for (const t of r.notUploaded) console.log(`     [not uploaded] ${t}`);
      for (const t of r.unplaced) console.log(`     [unplaced]     ${t}`);
      console.log();
    }
    return;
  }

  console.log(`Videos on disk        : ${totals.onDisk.toLocaleString()}`);
  console.log(`  correctly placed    : ${(totals.onDisk - totals.notUploaded - totals.unplaced).toLocaleString()}`);
  console.log(`  not uploaded        : ${totals.notUploaded.toLocaleString()}`);
  console.log(`  uploaded but unplaced: ${totals.unplaced.toLocaleString()}`);

  const worst = rows
    .map((r) => ({ ...r, missing: r.notUploaded.length + r.unplaced.length }))
    .filter((r) => r.missing > 0)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, WORST);

  console.log(`\nWorst-affected folders (missing = not uploaded + unplaced):\n`);
  console.log(`${"folder".padEnd(62)}${"disk".padStart(6)}${"miss".padStart(6)}${"unpl".padStart(6)}`);
  for (const r of worst) {
    console.log(
      `${r.folder.slice(0, 60).padEnd(62)}${String(r.onDisk).padStart(6)}` +
      `${String(r.missing).padStart(6)}${String(r.unplaced.length).padStart(6)}`
    );
  }

  const fullyMissing = rows.filter((r) => r.onDisk > 0 && r.onDisk === r.notUploaded.length + r.unplaced.length);
  console.log(`\nFolders showing nothing at all: ${fullyMissing.length}`);
  for (const r of fullyMissing.slice(0, 12)) console.log(`  ${r.folder} (${r.onDisk} on disk)`);
}

main();
