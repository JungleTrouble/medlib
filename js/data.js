/* ============================================================
   CONFIGURATION
   Fill these in with your own Bunny Stream details.
   Dashboard: https://dash.bunny.net/stream  ->  your library  ->  API
   ============================================================ */
const CONFIG = {
  // Bunny Stream "Video Library ID" (numeric, shown in the library's API page)
  bunnyLibraryId: "724698",

  // The CDN hostname Bunny generated for this library's Pull Zone,
  // used to build thumbnail/poster URLs: https://<hostname>/<videoId>/thumbnail.jpg
  bunnyCdnHostname: "vz-26e92cee-791.b-cdn.net",

  // If the library has Token Authentication enabled for embeds, generate a
  // signed token/expires pair server-side and set them per-video instead
  // (see the `bunnyToken` / `bunnyExpires` fields on a video entry below).
};

/* ============================================================
   PLATFORMS
   "id" is used as the value stored on each video's `platform` field.
   Bunny Stream is the primary host; the others are here so you can tag
   and filter videos you've mirrored or only bookmarked elsewhere.
   ============================================================ */
const PLATFORMS = [
  { id: "bunny",   label: "Bunny Stream", color: "var(--plat-bunny)" },
  { id: "youtube", label: "YouTube",      color: "var(--plat-youtube)" },
  { id: "vimeo",   label: "Vimeo",        color: "var(--plat-vimeo)" },
  { id: "khan",    label: "Khan Academy", color: "var(--plat-khan)" },
  { id: "osmosis", label: "Osmosis",      color: "var(--plat-osmosis)" },
  { id: "local",   label: "Local File",   color: "var(--plat-local)" },
  { id: "other",   label: "Other",        color: "var(--plat-other)" },
];

const LEVELS = ["Preclinical", "Clinical", "Board Review", "Advanced", "Uncategorized"];

/* ============================================================
   SUBJECT CATEGORIES
   Ordered roughly foundational -> organ system -> clinical.
   Videos are assigned by scripts/categorize.js; anything it can't
   place confidently lands in "uncategorized".
   ============================================================ */
const CATEGORIES = [
  // Foundational sciences
  { id: "anatomy",       label: "Anatomy",              color: "#4f6bf6" },
  { id: "physiology",    label: "Physiology",           color: "#14bf96" },
  { id: "biochemistry",  label: "Biochemistry",         color: "#00b3a4" },
  { id: "histology",     label: "Histology",            color: "#9b6dff" },
  { id: "embryology",    label: "Embryology",           color: "#4dbcff" },
  { id: "genetics",      label: "Genetics",             color: "#2e9bd6" },
  { id: "pathology",     label: "Pathology",            color: "#e0526c" },
  { id: "pharmacology",  label: "Pharmacology",         color: "#f5a623" },
  { id: "microbiology",  label: "Microbiology",         color: "#7c5cff" },
  { id: "immunology",    label: "Immunology",           color: "#c060d8" },

  // Organ systems
  { id: "cardiology",    label: "Cardiology",           color: "#ff5a5f" },
  { id: "pulmonology",   label: "Pulmonology",          color: "#3fb8e8" },
  { id: "neurology",     label: "Neurology",            color: "#3fa7ff" },
  { id: "gastro",        label: "Gastroenterology",     color: "#d98324" },
  { id: "renal",         label: "Renal & Urology",      color: "#4a90d9" },
  { id: "endocrine",     label: "Endocrinology",        color: "#e8a33d" },
  { id: "heme",          label: "Hematology",           color: "#c0392b" },
  { id: "oncology",      label: "Oncology",             color: "#8e44ad" },
  { id: "musculoskeletal", label: "Musculoskeletal",    color: "#7f8c8d" },
  { id: "rheumatology",  label: "Rheumatology",         color: "#b5651d" },
  { id: "dermatology",   label: "Dermatology",          color: "#e8896b" },
  { id: "reproductive",  label: "Reproductive",         color: "#e56fa6" },
  { id: "ophthalmology", label: "Ophthalmology",        color: "#00a0b0" },
  { id: "ent",           label: "ENT & Audiology",      color: "#6c8ebf" },

  // Clinical specialties
  { id: "obgyn",         label: "OB/GYN",               color: "#f06ea9" },
  { id: "pediatrics",    label: "Pediatrics",           color: "#5ec8a0" },
  { id: "psychiatry",    label: "Psychiatry",           color: "#a678de" },
  { id: "surgery",       label: "Surgery & Anesthesia", color: "#5d8aa8" },
  { id: "emergency",     label: "Emergency & Critical Care", color: "#e74c3c" },
  { id: "radiology",     label: "Radiology",            color: "#8a8f98" },
  { id: "infectious",    label: "Infectious Disease",   color: "#6ab04c" },

  // Practice of medicine
  { id: "publichealth",  label: "Public Health & Ethics", color: "#95a5a6" },
  { id: "biostats",      label: "Biostatistics",        color: "#7d8ca3" },
  { id: "nursing",       label: "Nursing Assistant",    color: "#59a5a5" },

  { id: "uncategorized", label: "Uncategorized",        color: "#5a5f6b" },
];

/* ============================================================
   VIDEO LIBRARY
   The `VIDEOS` array itself lives in js/videos.generated.js, produced by
   `node scripts/sync-bunny.js`. That file is rebuilt from your Bunny
   Stream library every time you run the script, so don't hand-edit it —
   per-video tagging (category/level/tags/description/featured) belongs in
   js/overrides.json instead, keyed by the video's Bunny GUID.
   ============================================================ */
