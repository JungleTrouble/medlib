/* ============================================================
   Build the Asset Library from the Resource Guide index.

       node scripts/build-asset-index.mjs
       node scripts/build-asset-index.mjs --links data/asset-links.json

   Writes data/assets.json: every non-video resource — PDFs, Anki decks,
   slide decks, archives, images — carrying the same subject buckets, folder
   tree and tags as the videos, so one filter serves both.

   SHARE LINKS ARE A SEPARATE INPUT. The index was built from files on disk
   and knows filenames and folders, not Google Drive URLs. Supply them in
   data/asset-links.json as either shape:

       { "<relative path>": "https://drive.google.com/file/d/…/view" }
       { "<exact filename>": "https://drive.google.com/…" }

   Paths win over filenames, since 399 filenames repeat. Anything without a
   link is still indexed and listed — it simply shows as "no link yet"
   instead of offering a dead button.

   To produce that file from Drive: select the folder, and either use the
   Drive API's files.list (fields=files(id,name,parents)) or any Drive
   export tool, then map name -> https://drive.google.com/file/d/<id>/view.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVideo, getBucket, BUCKETS } from "../lib/classify-video.js";
import { kindOf, labelForKind, parseAsset } from "../lib/asset-source.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_SOURCE = path.join(
  "C:", "Users", "micha", "OneDrive", "Resource Guide AI", "outputs",
  "019ff41f-0454-7e81-82f8-44dbf17b8fca", "Medical_Resource_Library_Ollama.json"
);

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const SOURCE = arg("--source", DEFAULT_SOURCE);
const LINKS = arg("--links", path.join(ROOT, "data", "asset-links.json"));
const OUT = path.join(ROOT, "data", "assets.json");

/* Video and caption formats belong to the player, not here. */
const NOT_ASSETS = new Set([
  "MP4", "M4V", "MKV", "MOV", "WEBM", "AVI", "WMV", "FLV", "TS", "MPG", "MPEG",
  "SRT", "VTT",
]);

/* Same map as scripts/build-library-index.mjs — the index's own topics onto
   the site's bucket ids. Nulls fall through to the classifier. */
const TOPIC_TO_BUCKET = {
  "General / Multi-system": null,
  "Cardiovascular / Cardiology": "cardiology",
  "Biochemistry / Genetics": "biochemistry",
  "Anatomy / Histology / Embryology": "anatomy",
  "Musculoskeletal / Rheumatology": "musculoskeletal",
  "Gastrointestinal / Hepatology": "gastro",
  "Renal / Nephrology": "renal",
  "Pulmonary / Respiratory": "pulmonology",
  "Pharmacology": "pharmacology",
  "Neurology": "neurology",
  "Endocrine": "endocrine",
  "Internal Medicine": null,
  "Clinical Skills / Physical Exam": "publichealth",
  "Reproductive / OB-GYN": "obgyn",
  "Pathology / Pathophysiology": "pathology",
  "Hematology / Oncology": "heme",
  "Infectious Disease / Microbiology": "infectious",
  "Dermatology": "dermatology",
  "Surgery / Anesthesia": "surgery",
  "Psychiatry / Behavioral Science": "psychiatry",
  "Emergency Medicine": "emergency",
  "Ophthalmology": "ophthalmology",
  "Pediatrics": "pediatrics",
  "Biostatistics / Epidemiology / Ethics": "biostats",
  "Immunology": "immunology",
  "ENT / Otolaryngology": "ent",
  "Radiology / Imaging": "radiology",
  "Family Medicine / Primary Care": null,
};

const BREADCRUMB_SEP = /\s*[›>/]\s*/;

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function collect(nodes, out = []) {
  for (const n of nodes) {
    out.push(...(n.resources || []));
    collect(n.subfolders || [], out);
  }
  return out;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source not found: ${SOURCE}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const all = collect(raw.folder_tree || []);
  const assets = all.filter((r) => !NOT_ASSETS.has((r.format || "").toUpperCase()));

  /* Share links, if supplied. Keys may be full relative paths or bare
     filenames; both are normalised so slash direction does not matter. */
  let links = {};
  if (fs.existsSync(LINKS)) {
    const parsed = JSON.parse(fs.readFileSync(LINKS, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      links[key.replace(/\\/g, "/").toLowerCase()] = value;
    }
  }

  const linkFor = (r) => {
    const byPath = links[(r.relative_path || "").replace(/\\/g, "/").toLowerCase()];
    return byPath || links[(r.exact_filename || "").toLowerCase()] || null;
  };

  const tagLabels = new Map();
  const tagCounts = new Map();
  const bucketCounts = new Map();
  const kindCounts = new Map();
  const folderRoot = new Map();

  let linked = 0;
  const items = [];

  for (const r of assets) {
    const parts = String(r.folder_breadcrumb || "")
      .split(BREADCRUMB_SEP).map((p) => p.trim()).filter(Boolean);

    const topic = (r.topics || [])[0];
    let bucket = TOPIC_TO_BUCKET[topic];
    if (!bucket) {
      // Same fallback as the videos: title plus folder, which is where the
      // classifier's folder tier does its work.
      bucket = classifyVideo(
        { title: r.display_title, folder: parts.slice(1).join("/") },
        { preferFilename: true }
      ).category;
    }

    const url = linkFor(r);
    if (url) linked += 1;

    const parsed = parseAsset({ name: r.exact_filename, url });
    const folder = parts.join("/");
    const folderTags = parts.map(slug);
    for (const seg of parts) tagLabels.set(slug(seg), seg);

    const tags = [...new Set([
      ...folderTags,
      bucket !== "uncategorized" ? bucket : null,
      parsed.kind,
    ].filter(Boolean))];

    for (const t of tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
    kindCounts.set(parsed.kind, (kindCounts.get(parsed.kind) || 0) + 1);

    // Folder tree, cumulative counts, same shape as the video Sources tab.
    let level = folderRoot;
    const trail = [];
    for (const name of parts) {
      trail.push(name);
      if (!level.has(name)) {
        level.set(name, { label: name, path: trail.join("/"), count: 0, children: new Map() });
      }
      const node = level.get(name);
      node.count += 1;
      level = node.children;
    }

    items.push({
      id: r.id,
      title: r.display_title,
      filename: r.exact_filename,
      folder,
      collection: r.collection || parts[0] || "",
      bucket,
      bucketLabel: getBucket(bucket).label,
      topic: topic || null,
      format: r.format || "",
      kind: parsed.kind,
      kindLabel: parsed.kindLabel,
      sizeBytes: r.size_bytes || 0,
      url: url || null,
      embedUrl: parsed.embedUrl,
      downloadUrl: parsed.downloadUrl,
      canPreview: parsed.canPreview,
      tags,
    });
  }

  const toTree = (level) =>
    [...level.values()]
      .map((n) => ({ label: n.label, path: n.path, count: n.count, children: toTree(n.children) }))
      .sort((a, b) => b.count - a.count);

  const out = {
    generated_at: new Date().toISOString(),
    source: SOURCE,
    linksFile: fs.existsSync(LINKS) ? LINKS : null,
    counts: {
      assets: items.length,
      withLinks: linked,
      withoutLinks: items.length - linked,
      previewable: items.filter((i) => i.canPreview).length,
    },
    kinds: [...kindCounts.entries()]
      .map(([id, count]) => ({ id, label: labelForKind(id), count }))
      .sort((a, b) => b.count - a.count),
    buckets: BUCKETS
      .map((b) => ({ id: b.id, label: b.label, color: b.color, count: bucketCounts.get(b.id) || 0 }))
      .filter((b) => b.count > 0),
    folders: toTree(folderRoot),
    tags: [...tagCounts.entries()]
      .map(([id, count]) => ({ id, label: tagLabels.get(id) || id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    items,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));

  console.log(`Assets indexed  : ${items.length.toLocaleString()}`);
  console.log(`  with a link   : ${linked.toLocaleString()}`);
  console.log(`  previewable   : ${out.counts.previewable.toLocaleString()}`);
  console.log(`\nBy kind:`);
  for (const k of out.kinds) console.log(`  ${String(k.count).padStart(5)}  ${k.label}`);
  console.log(`\nSubjects: ${out.buckets.length}   Folders: ${out.folders.length} roots   Tags: ${out.tags.length}`);
  console.log(`\nWrote data/assets.json (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
  if (!linked) {
    console.log(`\nNo share links yet. Create ${path.relative(ROOT, LINKS)} mapping`);
    console.log(`filenames or relative paths to Drive URLs, then re-run.`);
  }
}

main();
