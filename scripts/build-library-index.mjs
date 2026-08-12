/* ============================================================
   Build the site's category / tag / navigation structures from the
   Resource Guide index.

       node scripts/build-library-index.mjs [--source <Ollama.json>]

   Reads Medical_Resource_Library_Ollama.json (the file-level catalogue of
   the source library on disk) and writes three files:

       data/library-index.json   Collection > Section > videos
       data/library-nav.json     sidebar structure, no video payload
       data/library-tags.json    unique tags with counts

   WHY THIS SOURCE. The Bunny catalogue is flat GUIDs with no paths, which
   is why lib/classify-video.js could never use its folder tier and left 27%
   of titles unplaced. This index carries a folder breadcrumb for every file
   —"Sketchy > Anatomy > Abdomen > Abdominal Overview" — which is a far
   better subject signal than any keyword rule. Feeding it through the same
   classifier is the point of this script.

   BRANDS ARE PLAIN STRINGS. Collection names are treated as folder labels
   and nothing more: they group and tag, they never select a player. Every
   entry here is a direct file; nothing in this pipeline emits an embed.

   IDENTICAL TITLES. 399 titles occur more than once. Each stays its own
   entry with its own id and path, distinguished by collection and section
   rather than merged.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVideo, getBucket, BUCKETS } from "../lib/classify-video.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_SOURCE = path.join(
  "C:", "Users", "micha", "OneDrive", "Resource Guide AI", "outputs",
  "019ff41f-0454-7e81-82f8-44dbf17b8fca", "Medical_Resource_Library_Ollama.json"
);

const argi = process.argv.indexOf("--source");
const SOURCE = argi > -1 ? process.argv[argi + 1] : DEFAULT_SOURCE;

const VIDEO_FORMATS = new Set(
  ["MP4", "M4V", "MKV", "MOV", "WEBM", "AVI", "WMV", "FLV", "TS", "MPG", "MPEG"]
);
const CAPTION_FORMATS = new Set(["SRT", "VTT"]);

/* The index's 28 topics mapped onto the site's existing bucket ids, so this
   data and js/data.js agree on what a subject is called. "General /
   Multi-system" deliberately maps to null: it covers 41% of the videos and
   asserts nothing, so those fall through to the classifier instead. */
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

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Depth-first walk of the folder tree; every node carries its own files. */
function collectResources(nodes, out = []) {
  for (const node of nodes) {
    out.push(...(node.resources || []));
    collectResources(node.subfolders || [], out);
  }
  return out;
}

function breadcrumbParts(resource) {
  return String(resource.folder_breadcrumb || "")
    .split(BREADCRUMB_SEP)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Subject for one video. The index's own topic wins when it says something;
 * otherwise the classifier runs over the title *and* the breadcrumb, which
 * is where the folder tier finally earns its keep.
 */
function resolveSubject(resource, parts) {
  const topic = (resource.topics || [])[0];
  const mapped = TOPIC_TO_BUCKET[topic];

  if (mapped) {
    return { bucket: mapped, source: "topic", topic };
  }

  // Skip the collection name at parts[0] — "Sketchy" is not a subject.
  const folder = parts.slice(1).join("/");
  const result = classifyVideo(
    { title: resource.display_title, folder },
    { preferFilename: true }
  );

  return {
    bucket: result.category,
    source: result.category === "uncategorized" ? "unplaced" : `classifier:${result.source}`,
    topic: topic || null,
    keywords: result.keywords,
  };
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source not found: ${SOURCE}`);
    console.error("Pass --source <path to Medical_Resource_Library_Ollama.json>");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const all = collectResources(raw.folder_tree || []);

  const videos = all.filter((r) => VIDEO_FORMATS.has((r.format || "").toUpperCase()));
  const captions = all.filter((r) => CAPTION_FORMATS.has((r.format || "").toUpperCase()));

  /* Captions sit beside their video as <same stem>.srt. Matching on the stem
     lets the site offer a transcript, and eventually search inside one. */
  const captionByStem = new Map();
  for (const c of captions) {
    const stem = (c.relative_path || "").replace(/\.[^.]+$/, "").toLowerCase();
    captionByStem.set(stem, c.relative_path);
  }

  /* Which breadcrumb level to treat as the section, decided per collection.
     Most sit one below the collection name, but some wrap everything in a
     single passthrough folder — Osmosis puts all 1,669 videos under
     "Osmosis Vids", which would give that whole collection one useless
     section. Descend to the first level that actually divides it. */
  const sectionDepth = new Map();
  {
    const perCollection = new Map();
    for (const r of videos) {
      const key = r.collection || "Uncategorized";
      if (!perCollection.has(key)) perCollection.set(key, []);
      perCollection.get(key).push(breadcrumbParts(r));
    }
    for (const [name, rows] of perCollection) {
      let depth = 1;
      for (; depth <= 3; depth++) {
        const distinct = new Set(rows.map((p) => p[depth]).filter(Boolean));
        if (distinct.size > 1) break;
      }
      sectionDepth.set(name, Math.min(depth, 3));
    }
  }

  const tagCounts = new Map();
  const addTag = (id, label, kind) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (!tagCounts.has(key)) tagCounts.set(key, { id, label, kind, count: 0 });
    tagCounts.get(key).count += 1;
  };

  /* Category > Sub-Category > videos, keyed by insertion order so the
     output follows the library's own arrangement. */
  const tree = new Map();
  const stats = { bySource: {}, byBucket: {}, withCaptions: 0 };

  for (const r of videos) {
    const parts = breadcrumbParts(r);
    const category = r.collection || parts[0] || "Uncategorized";
    // Anything deeper than the section stays on the entry as `path` rather
    // than becoming another nesting level — three levels of sidebar is
    // already one more than anyone opens.
    const depth = sectionDepth.get(category) ?? 1;
    const section = parts[depth] || parts[1] || "General";

    const subject = resolveSubject(r, parts);
    const bucket = getBucket(subject.bucket);
    const stem = (r.relative_path || "").replace(/\.[^.]+$/, "").toLowerCase();
    const caption = captionByStem.get(stem) || null;
    if (caption) stats.withCaptions += 1;

    const exam = (r.exam_tags || []).filter((t) => t && t !== "Not specified");

    const tags = [
      slug(category),
      ...parts.slice(1, 4).map(slug),
      subject.bucket !== "uncategorized" ? subject.bucket : null,
      ...exam.map(slug),
    ].filter(Boolean);

    addTag(slug(category), category, "collection");
    addTag(subject.bucket, bucket.label, "subject");
    for (const e of exam) addTag(slug(e), e, "exam");
    for (const p of parts.slice(1, 3)) addTag(slug(p), p, "section");

    stats.bySource[subject.source] = (stats.bySource[subject.source] || 0) + 1;
    stats.byBucket[subject.bucket] = (stats.byBucket[subject.bucket] || 0) + 1;

    if (!tree.has(category)) tree.set(category, new Map());
    const sections = tree.get(category);
    if (!sections.has(section)) sections.set(section, []);

    sections.get(section).push({
      id: r.id,
      title: r.display_title,
      filename: r.exact_filename,
      path: r.relative_path,
      subject: subject.bucket,
      subjectLabel: bucket.label,
      subjectSource: subject.source,
      topic: subject.topic,
      section,
      subsection: parts[depth + 1] || null,
      // Full folder path, filename dropped. This is what the site's Sources
      // tree is built from — the library is up to six levels deep and
      // flattening it to one is what leaves 368 videos in a single list.
      folder: parts.join("/"),
      format: r.format,
      sizeBytes: r.size_bytes,
      captions: caption,
      exam,
      tags: [...new Set(tags)],
      duplicateCopies: r.duplicate_copies || 1,
    });
  }

  /* ---- assemble outputs ---- */

  const indexOut = {
    generated_at: new Date().toISOString(),
    source: SOURCE,
    counts: {
      resourcesInSource: all.length,
      videos: videos.length,
      captionFiles: captions.length,
      videosWithCaptions: stats.withCaptions,
      categories: tree.size,
    },
    categories: [...tree.entries()].map(([name, sections]) => ({
      id: slug(name),
      name,
      count: [...sections.values()].reduce((n, v) => n + v.length, 0),
      subcategories: [...sections.entries()]
        .map(([sectionName, items]) => ({
          id: slug(sectionName),
          name: sectionName,
          count: items.length,
          videos: items,
        }))
        .sort((a, b) => b.count - a.count),
    })).sort((a, b) => b.count - a.count),
  };

  const navOut = {
    generated_at: indexOut.generated_at,
    total: videos.length,
    /* Two independent axes. Subject is the primary one because it matches
       the site's existing sidebar; collection answers "everything from this
       source", which is the other question people actually ask. */
    subjects: BUCKETS
      .map((b) => ({ id: b.id, label: b.label, color: b.color, group: b.group,
                     count: stats.byBucket[b.id] || 0 }))
      .filter((b) => b.count > 0),
    collections: indexOut.categories.map((c) => ({
      id: c.id,
      label: c.name,
      count: c.count,
      sections: c.subcategories.map((s) => ({ id: s.id, label: s.name, count: s.count })),
    })),
    exams: [...tagCounts.values()].filter((t) => t.kind === "exam")
      .sort((a, b) => b.count - a.count),
  };

  const tagsOut = {
    generated_at: indexOut.generated_at,
    count: tagCounts.size,
    tags: [...tagCounts.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    ),
  };

  const outDir = path.join(ROOT, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, data) => {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return `${name} (${(fs.statSync(p).size / 1048576).toFixed(1)} MB)`;
  };

  console.log(`Source resources : ${all.length.toLocaleString()}`);
  console.log(`Videos           : ${videos.length.toLocaleString()}`);
  console.log(`Caption files    : ${captions.length.toLocaleString()} (${stats.withCaptions.toLocaleString()} matched to a video)`);
  console.log(`Categories       : ${tree.size}`);
  console.log(`Unique tags      : ${tagCounts.size}`);

  console.log("\nSubject assigned by:");
  for (const [k, v] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }

  console.log("\nWrote:");
  console.log("  " + write("library-index.json", indexOut));
  console.log("  " + write("library-nav.json", navOut));
  console.log("  " + write("library-tags.json", tagsOut));
}

main();
