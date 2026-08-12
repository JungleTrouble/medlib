/* ============================================================
   classifyVideo — filename/title -> subject bucket.

   Framework-agnostic ES module. Imported by the Next.js components in
   components/ and safe to run in Node (no DOM, no fetch).

       import { classifyVideo, classifyAll, BUCKETS } from "@/lib/classify-video";

       classifyVideo("SketchyMicro_MRSA.mov");
       // { category: "microbiology", source: "brand-hint", brand: "sketchy",
       //   displayTitle: "MRSA", confidence: "high", ... }

   RESOLUTION ORDER — first tier that fires wins. Each result reports which
   tier produced it in `source`, so a bad rule is traceable back to its tier
   instead of being an unexplained label on 400 files.

     0. explicit    — a `category` on the input that resolves to a known bucket
     1. section     — "007 - General Topics - Informed Consent" (publisher's
                      own section name; trusted over guessing)
     2. qualified   — "Cardio/014 - Preload", "Neuro__03 - Stroke"
     3. brand-hint  — a subject welded onto a publisher name: SketchyMicro,
                      OsmosisPharm, BnB_Cardio
     4. prefix      — leading token: "Cardiology_Commentary.mp4"
     5. path        — the same tiers re-run against parent folder names, for
                      files whose own title carries no signal ("Commentary.mp4")
     6. keyword     — weighted substring scoring over the whole title
     7. default     — uncategorized

   BRAND HANDLING ("raw string" mode). Publisher names are treated as generic
   prefixes: they are stripped from the display title and recorded in `brand`,
   never used to pick a player. A brand token that carries a subject
   ("SketchyMicro") contributes its subject at tier 3 and nothing else. See
   lib/stream-source.js — playback is direct HLS/MP4 for every entry
   regardless of what brand a title happens to name.

   RELATION TO THE OTHER TWO CATEGORIZERS IN THIS REPO. config/buckets.yaml +
   server/categorizer.py own the catalog build, and scripts/categorize.js owns
   js/overrides.json. This module is the browser-side copy for classifying
   entries the catalog has not been rebuilt for yet. The bucket ids, the
   section map and the keyword weights below are duplicated from those two —
   if you retune weights, retune them in all three or the sidebar will
   disagree with the catalog it is filtering.
   ============================================================ */

export const UNCATEGORIZED = "uncategorized";

/* Bucket ids/labels/colors mirror config/buckets.yaml and js/data.js. */
export const BUCKETS = [
  { id: "anatomy", label: "Anatomy", color: "#4f6bf6", group: "Foundational" },
  { id: "physiology", label: "Physiology", color: "#14bf96", group: "Foundational" },
  { id: "biochemistry", label: "Biochemistry", color: "#00b3a4", group: "Foundational" },
  { id: "histology", label: "Histology", color: "#9b6dff", group: "Foundational" },
  { id: "embryology", label: "Embryology", color: "#4dbcff", group: "Foundational" },
  { id: "genetics", label: "Genetics", color: "#2e9bd6", group: "Foundational" },
  { id: "pathology", label: "Pathology", color: "#e0526c", group: "Foundational" },
  { id: "pharmacology", label: "Pharmacology", color: "#f5a623", group: "Foundational" },
  { id: "microbiology", label: "Microbiology", color: "#7c5cff", group: "Foundational" },
  { id: "immunology", label: "Immunology", color: "#c060d8", group: "Foundational" },

  { id: "cardiology", label: "Cardiology", color: "#ff5a5f", group: "Organ systems" },
  { id: "pulmonology", label: "Pulmonology", color: "#3fb8e8", group: "Organ systems" },
  { id: "neurology", label: "Neurology", color: "#3fa7ff", group: "Organ systems" },
  { id: "gastro", label: "Gastroenterology", color: "#d98324", group: "Organ systems" },
  { id: "renal", label: "Renal & Urology", color: "#4a90d9", group: "Organ systems" },
  { id: "endocrine", label: "Endocrinology", color: "#e8a33d", group: "Organ systems" },
  { id: "heme", label: "Hematology", color: "#c0392b", group: "Organ systems" },
  { id: "oncology", label: "Oncology", color: "#8e44ad", group: "Organ systems" },
  { id: "musculoskeletal", label: "Musculoskeletal", color: "#7f8c8d", group: "Organ systems" },
  { id: "rheumatology", label: "Rheumatology", color: "#b5651d", group: "Organ systems" },
  { id: "dermatology", label: "Dermatology", color: "#e8896b", group: "Organ systems" },
  { id: "reproductive", label: "Reproductive", color: "#e56fa6", group: "Organ systems" },
  { id: "ophthalmology", label: "Ophthalmology", color: "#00a0b0", group: "Organ systems" },
  { id: "ent", label: "ENT & Audiology", color: "#6c8ebf", group: "Organ systems" },

  { id: "obgyn", label: "OB/GYN", color: "#f06ea9", group: "Clinical" },
  { id: "pediatrics", label: "Pediatrics", color: "#5ec8a0", group: "Clinical" },
  { id: "psychiatry", label: "Psychiatry", color: "#a678de", group: "Clinical" },
  { id: "surgery", label: "Surgery & Anesthesia", color: "#5d8aa8", group: "Clinical" },
  { id: "emergency", label: "Emergency & Critical Care", color: "#e74c3c", group: "Clinical" },
  { id: "radiology", label: "Radiology", color: "#8a8f98", group: "Clinical" },
  { id: "infectious", label: "Infectious Disease", color: "#6ab04c", group: "Clinical" },

  { id: "publichealth", label: "Public Health & Ethics", color: "#95a5a6", group: "Practice" },
  { id: "biostats", label: "Biostatistics", color: "#7d8ca3", group: "Practice" },
  { id: "nursing", label: "Nursing Assistant", color: "#59a5a5", group: "Practice" },

  { id: UNCATEGORIZED, label: "Uncategorized", color: "#5a5f6b", group: "Practice" },
];

const BUCKET_BY_ID = new Map(BUCKETS.map((b) => [b.id, b]));

export function getBucket(id) {
  return BUCKET_BY_ID.get(id) || BUCKET_BY_ID.get(UNCATEGORIZED);
}

/* ---------------------------------------------------------------
   Subject aliases — short forms, full names and the bucket ids
   themselves. Used by the qualified/brand-hint/prefix/path tiers, all of
   which look up a single token. Mirrors the `prefixes` tier in
   config/buckets.yaml, plus every bucket id and its label word so
   "Cardiology_Commentary.mp4" resolves without a second table.
   --------------------------------------------------------------- */
export const SUBJECT_ALIASES = {
  cardio: "cardiology", cards: "cardiology", cv: "cardiology", cardiac: "cardiology",
  cardiovascular: "cardiology", cardiology: "cardiology",
  pulm: "pulmonology", pulmo: "pulmonology", resp: "pulmonology", respiratory: "pulmonology",
  pulmonary: "pulmonology", pulmonology: "pulmonology",
  neuro: "neurology", neuroanat: "neurology", neurology: "neurology", neuroscience: "neurology",
  gi: "gastro", git: "gastro", hepat: "gastro", hepatology: "gastro", gastro: "gastro",
  gastroenterology: "gastro", gastrointestinal: "gastro",
  renal: "renal", nephro: "renal", nephrology: "renal", uro: "renal", urology: "renal",
  endo: "endocrine", endocrine: "endocrine", endocrinology: "endocrine",
  heme: "heme", hemeonc: "heme", hematology: "heme", hematologic: "heme", blood: "heme",
  onc: "oncology", onco: "oncology", oncology: "oncology",
  msk: "musculoskeletal", ortho: "musculoskeletal", orthopedics: "musculoskeletal",
  musculoskeletal: "musculoskeletal",
  rheum: "rheumatology", rheumatology: "rheumatology",
  derm: "dermatology", dermatology: "dermatology", skin: "dermatology",
  repro: "reproductive", reproductive: "reproductive",
  ophtho: "ophthalmology", ophthalmo: "ophthalmology", ophthalmology: "ophthalmology",
  eye: "ophthalmology",
  ent: "ent", oto: "ent", otolaryngology: "ent", audiology: "ent",
  obgyn: "obgyn", gyn: "obgyn", gynecology: "obgyn", obstetrics: "obgyn", ob: "obgyn",
  peds: "pediatrics", ped: "pediatrics", pediatrics: "pediatrics", pediatric: "pediatrics",
  psych: "psychiatry", psychiatry: "psychiatry", psychiatric: "psychiatry",
  behavioral: "psychiatry",
  surg: "surgery", surgery: "surgery", surgical: "surgery", anes: "surgery",
  anesthesia: "surgery", anesthesiology: "surgery",
  em: "emergency", emergency: "emergency", trauma: "emergency", criticalcare: "emergency",
  rad: "radiology", radiology: "radiology", imaging: "radiology",
  micro: "microbiology", microbio: "microbiology", microbiology: "microbiology",
  id: "infectious", infectious: "infectious", infectiousdisease: "infectious",
  immuno: "immunology", immune: "immunology", immunology: "immunology",
  path: "pathology", patho: "pathology", pathology: "pathology",
  pharm: "pharmacology", pharma: "pharmacology", pharmacology: "pharmacology",
  biochem: "biochemistry", biochemistry: "biochemistry",
  physio: "physiology", physiology: "physiology",
  anat: "anatomy", anatomy: "anatomy",
  histo: "histology", histology: "histology",
  embryo: "embryology", embryology: "embryology",
  genetics: "genetics", genetic: "genetics",
  biostat: "biostats", biostats: "biostats", biostatistics: "biostats",
  statistics: "biostats", epi: "biostats", epidemiology: "biostats",
  ethics: "publichealth", publichealth: "publichealth",
  cna: "nursing", nursing: "nursing",
};

/* ---------------------------------------------------------------
   Publisher names. Matched against a whole token after camelCase
   splitting is undone, so "SketchyMicro" arrives here as "sketchymicro"
   and yields brand "sketchy" + remainder "micro".

   `aka` entries are alternate spellings that normalise to the same id.
   Order matters: longer ids are tried first so "sketchymicro" is not
   claimed by a shorter brand that happens to be a prefix of it.
   --------------------------------------------------------------- */
export const BRANDS = [
  { id: "boards-and-beyond", label: "Boards & Beyond", aka: ["boardsandbeyond", "bnb", "bandb", "bb"] },
  { id: "online-med-ed", label: "OnlineMedEd", aka: ["onlinemeded", "ome"] },
  { id: "dirty-medicine", label: "Dirty Medicine", aka: ["dirtymedicine", "dirtymed"] },
  { id: "ninja-nerd", label: "Ninja Nerd", aka: ["ninjanerd", "ninjanerdscience"] },
  { id: "divine-intervention", label: "Divine Intervention", aka: ["divineintervention", "divine"] },
  { id: "usmle-rx", label: "USMLE-Rx", aka: ["usmlerx", "usmlerxexpress", "rx"] },
  { id: "first-aid", label: "First Aid", aka: ["firstaid", "fa"] },
  { id: "sketchy", label: "Sketchy", aka: ["sketchymedical", "sketchymed"] },
  { id: "pathoma", label: "Pathoma", aka: ["pathoma"] },
  { id: "osmosis", label: "Osmosis", aka: ["osmosis"] },
  { id: "amboss", label: "AMBOSS", aka: ["amboss"] },
  { id: "kaplan", label: "Kaplan", aka: ["kaplan"] },
  { id: "lecturio", label: "Lecturio", aka: ["lecturio"] },
  { id: "physeo", label: "Physeo", aka: ["physeo"] },
  { id: "mehlman", label: "Mehlman", aka: ["mehlman", "mehlmanmedical"] },
  { id: "goljan", label: "Goljan", aka: ["goljan"] },
  { id: "bootcamp", label: "Bootcamp", aka: ["bootcamp", "medschoolbootcamp"] },
  { id: "randy-neil", label: "Randy Neil", aka: ["randyneil"] },
  { id: "kenhub", label: "Kenhub", aka: ["kenhub"] },
  { id: "acland", label: "Acland", aka: ["acland", "aclands"] },
];

/* alias -> brand, longest alias first so prefix collisions resolve to the
   more specific name ("boardsandbeyond" before "bb"). */
const BRAND_ALIASES = BRANDS.flatMap((b) => [b.id.replace(/-/g, ""), ...b.aka].map((a) => [a, b]))
  .sort((a, b) => b[0].length - a[0].length);

/* ---------------------------------------------------------------
   Publisher section labels from "### - Section - Topic" titles. The middle
   field is the publisher's own section name, so it beats keyword guessing.
   --------------------------------------------------------------- */
const SECTION_MAP = {
  "pathology": "pathology",
  "obstetrics": "obgyn",
  "gynecology": "obgyn",
  "breast": "obgyn",
  "red cells": "heme",
  "white cells": "heme",
  "coagulation": "heme",
  "pulmonary disease": "pulmonology",
  "other pulmonary topics": "pulmonology",
  "anatomy and orthopedics": "musculoskeletal",
  "trauma": "emergency",
  "emergencies": "emergency",
  "critical care": "emergency",
  "liver": "gastro",
  "biliary tree and pancreas": "gastro",
  "esophagus and stomach": "gastro",
  "intestines": "gastro",
  "general pediatrics": "pediatrics",
  "newborns": "pediatrics",
  "psychiatric disorders": "psychiatry",
  "abnormal psychology": "psychiatry",
  "psychopharmacology": "psychiatry",
  "substance abuse": "psychiatry",
  "diabetes": "endocrine",
  "thyroid gland": "endocrine",
  "adrenal glands": "endocrine",
  "acid base": "renal",
  "fluids and electrolytes": "renal",
  "glomerular disease": "renal",
  "renal failure": "renal",
  "arrhythmias": "cardiology",
  "heart failure": "cardiology",
  "cardiac auscultation": "cardiology",
  "ischemic heart disease": "cardiology",
  "antibiotics": "infectious",
  "hiv": "infectious",
  "fungi and parasites": "microbiology",
  "stroke and hemorrhage": "neurology",
  "demyelinating disorders": "neurology",
  "movement disorders": "neurology",
  "seizures": "neurology",
  "anesthesia": "surgery",
  "surgery": "surgery",
  "pharmacology": "pharmacology",
  "general topics": "publichealth",
  "embryology, anatomy and physiology": "embryology",
  "cell biology": "biochemistry",
  "immunology": "immunology",
  "dermatology": "dermatology",
  "ophthalmology": "ophthalmology",
  "rheumatology": "rheumatology",
  "genetics": "genetics",
  "biochemistry": "biochemistry",
  "microbiology": "microbiology",
  "neurology": "neurology",
  "cardiology": "cardiology",
  "endocrinology": "endocrine",
  "nephrology": "renal",
  "hematology": "heme",
  "oncology": "oncology",
  "gastroenterology": "gastro",
  "infectious disease": "infectious",
  "psychiatry": "psychiatry",
  "pediatrics": "pediatrics",
  "radiology": "radiology",
};

/* ---------------------------------------------------------------
   Tier 6 — weighted keywords. Multi-word phrases outscore bare words so
   "cardiac muscle histology" lands in histology instead of being fought
   over by cardiology and musculoskeletal. Weights are copied from
   scripts/categorize.js; keep them in sync.
   --------------------------------------------------------------- */
const KEYWORD_RULES = [
  ["nursing", [["nursing assistant", 12], ["nurse aide", 10], ["nursing", 5], ["patient transfer", 5], ["bed bath", 6], ["vital signs measurement", 5]]],
  ["biostats", [["biostatistic", 12], ["basic statistics", 12], ["statistics", 8], ["study design", 9], ["hypothesis testing", 10], ["sensitivity", 5], ["specificity", 5], ["predictive value", 9], ["confidence interval", 10], ["bias", 8], ["epidemiolog", 9], ["incidence", 6], ["prevalence", 6], ["risk quantification", 12], ["dose-response", 11], ["tests of significance", 12], ["correlation", 9], ["diagnostic test", 10], ["clinical trial", 11], ["p-value", 11], ["odds ratio", 11], ["relative risk", 11], ["number needed to treat", 12], ["screening", 7], ["roc curve", 12]]],
  ["publichealth", [["ethics", 10], ["informed consent", 10], ["confidentiality", 10], ["decision-making capacity", 10], ["delivering bad news", 10], ["public health", 10], ["quality", 5], ["safety", 5], ["healthcare system", 8], ["malpractice", 8], ["end of life", 7], ["physician-patient", 7]]],

  ["histology", [["histology", 12], ["histo", 8], ["stratum", 7], ["epithelium", 7], ["epithelial cell", 9], ["connective tissue", 7], ["nervous tissue", 8], ["microscopic anatomy", 9], ["cytoskeleton", 9], ["cell structure", 8], ["organelle", 9]]],
  ["embryology", [["embryology", 12], ["embryo", 8], ["fetal development", 9], ["pharyngeal arch", 9], ["neural crest", 8], ["gastrulation", 9], ["organogenesis", 9], ["branchial", 9]]],
  ["genetics", [["genetic", 10], ["chromosom", 8], ["down syndrome", 9], ["trisom", 10], ["inheritance", 9], ["mendelian", 9], ["mutation", 6], ["karyotype", 9], ["fish", 6], ["imprinting", 8], ["pedigree", 11], ["hardy-weinberg", 12], ["gene mapping", 11], ["deletion syndrome", 11], ["trinucleotide repeat", 12], ["turner", 9], ["klinefelter", 11], ["meiosis", 10], ["mitosis", 8], ["microarray", 10], ["achondroplasia", 10], ["muscular dystrophy", 10], ["fragile x", 11], ["cystic fibrosis", 10], ["marfan", 10]]],
  ["biochemistry", [["amino acid", 10], ["dna replication", 11], ["dna structure", 11], ["dna repair", 11], ["transcription", 8], ["translation", 7], ["enzyme", 8], ["glycolysis", 11], ["gluconeogenesis", 12], ["krebs", 10], ["tca cycle", 12], ["citric acid cycle", 11], ["electron transport", 12], ["metabolism", 7], ["b vitamins", 9], ["vitamin", 6], ["glucose", 6], ["lipid", 6], ["fatty acid", 10], ["ketone body", 11], ["glycogen", 11], ["protein synthesis", 9], ["cell cycle", 8], ["molecular", 6], ["purine", 8], ["pyrimidine", 8], ["porphyria", 12], ["lysosomal storage", 12], ["hmp shunt", 12], ["pentose phosphate", 12], ["ammonia", 9], ["urea cycle", 12], ["phenylalanine", 11], ["tyrosine", 10], ["fructose", 10], ["galactose", 10], ["pyruvate", 11], ["pcr", 10], ["blotting", 11], ["elisa", 11], ["flow cytometry", 11], ["starvation", 8], ["homocystein", 10]]],
  ["immunology", [["immunolog", 12], ["immunity", 10], ["hypersensitivity", 10], ["antibody", 8], ["antigen", 8], ["complement", 7], ["t cell", 7], ["b cell", 6], ["b-cell", 8], ["t-cell", 8], ["mhc", 8], ["autoimmun", 8], ["vaccine", 7], ["vaccination", 8], ["immunodeficiency", 10], ["immune deficiency", 11], ["transplant", 9], ["lymph node", 9], ["spleen", 8], ["thymus", 9], ["cytokine", 9], ["interleukin", 10], ["amyloidosis", 9]]],
  ["microbiology", [["bacteria", 9], ["bacteri", 7], ["virus", 8], ["viral", 7], ["fungal", 9], ["fungi", 9], ["parasit", 9], ["protozoa", 11], ["protoza", 11], ["malaria", 11], ["gram stain", 10], ["gram positive", 10], ["gram negative", 10], ["staphylo", 10], ["strepto", 10], ["clostrid", 10], ["mycobacter", 10], ["e. coli", 9], ["corynebacterium", 11], ["salmonella", 10], ["candida", 9], ["helminth", 10], ["spirochete", 11], ["actinomyc", 11], ["virulence", 10], ["shapes and stains", 11], ["growth requirement", 10], ["neisseria", 11], ["pseudomonas", 11], ["chlamydia", 10], ["rickettsia", 11], ["prion", 10], ["mrsa", 11], ["vre", 9], ["esbl", 10]]],
  ["infectious", [["antibiotic", 10], ["antimicrobial", 10], ["antiviral", 10], ["antifungal", 10], ["antimalarial", 11], ["hiv", 10], ["aids", 8], ["tuberculosis", 11], ["sepsis", 9], ["infection", 6], ["infectious", 9], ["beta lactam", 10], ["penicillin", 10], ["cephalosporin", 10], ["vancomycin", 10], ["meningitis", 8]]],

  ["cardiology", [["cardiac", 9], ["heart", 8], ["ekg", 11], ["ecg", 11], ["arrhythmia", 11], ["myocardial", 10], ["coronary", 10], ["heart failure", 12], ["hypertension", 9], ["murmur", 10], ["valve", 7], ["atrial", 9], ["ventricular", 8], ["aortic", 8], ["angina", 10], ["pericard", 10], ["endocarditis", 10], ["cardiomyopathy", 11], ["stroke volume", 9], ["ejection fraction", 10], ["blood pressure", 7], ["pacemaker", 9], ["tachycardia", 10], ["bradycardia", 10], ["lipid-lowering", 8], ["statin", 9], ["stemi", 12], ["nstemi", 12], ["bundle branch", 12], ["avnrt", 12], ["avrt", 12], ["wpw", 12], ["wolff-parkinson", 12], ["coarctation", 12], ["pv loop", 12], ["pressure-volume loop", 12], ["wiggers", 12], ["venous pressure", 10], ["starling curve", 12], ["shunt", 7], ["cv response", 10], ["cardiovascular", 10], ["atherosclerosis", 10], ["aneurysm", 9], ["peripheral vascular", 10], ["syncope", 9], ["preload", 10], ["afterload", 10], ["defibrillat", 10]]],
  ["pulmonology", [["pulmonary", 10], ["lung", 9], ["respiratory", 9], ["asthma", 11], ["copd", 11], ["pneumonia", 10], ["pneumothorax", 11], ["ventilation", 7], ["spirometry", 11], ["bronch", 8], ["pleural", 9], ["hypoxia", 7], ["oxygen", 5], ["tidal volume", 9], ["pulmonary embolism", 12]]],
  ["neurology", [["neurolog", 10], ["cranial nerve", 12], ["cerebral", 10], ["brain", 8], ["spinal cord", 10], ["stroke", 10], ["seizure", 11], ["epilep", 11], ["dementia", 11], ["alzheimer", 11], ["parkinson", 11], ["multiple sclerosis", 12], ["demyelinat", 11], ["neuron", 8], ["nervous system", 9], ["cortex", 9], ["thalamus", 10], ["cerebellum", 10], ["cerebellar", 10], ["basal ganglia", 11], ["meninges", 9], ["csf", 8], ["myasthenia", 11], ["neuropathy", 10], ["bell's palsy", 12], ["reflex", 7], ["motor neuron", 10], ["tracts", 7], ["cns", 8], ["pns", 8], ["migraine", 10], ["neurotransmitter", 11], ["acetylcholine", 10], ["dopamine", 9], ["serotonin", 9], ["gaba", 9], ["norepinephrine", 9], ["ventricles and sinuses", 11], ["altered mental status", 11], ["headache", 10], ["nerve damage", 10], ["encephal", 10], ["myelin", 9], ["huntington", 11], ["neuromuscular disease", 11], ["intracranial", 10], ["hydrocephalus", 11], ["aphasia", 11], ["apraxia", 11], ["als", 5]]],
  ["gastro", [["gastrointestinal", 11], ["esophag", 10], ["stomach", 9], ["intestin", 9], ["bowel", 9], ["liver", 10], ["hepat", 9], ["biliary", 10], ["pancrea", 8], ["colon", 9], ["gallbladder", 11], ["gallstone", 12], ["cholecystitis", 12], ["cholangitis", 12], ["cirrhosis", 11], ["jaundice", 10], ["bile", 9], ["bilirubin", 11], ["gastric", 9], ["peptic ulcer", 12], ["celiac", 10], ["crohn", 11], ["ulcerative colitis", 12], ["diarrhea", 8], ["digestion", 8], ["hernia", 10], ["salivary gland", 11], ["wilson's disease", 12], ["hemochromatosis", 12], ["appendicitis", 11], ["diverticul", 11], ["malabsorption", 11], ["ascites", 10], ["anorectal", 11]]],
  ["renal", [["renal", 10], ["kidney", 10], ["nephro", 10], ["glomerul", 11], ["urinary", 9], ["urolog", 10], ["bladder", 8], ["ureter", 9], ["acid base", 10], ["acid-base", 10], ["electrolyte", 9], ["diuretic", 10], ["dialysis", 11], ["creatinine", 10], ["gfr", 11], ["tubular", 8], ["tubulointerstitial", 12], ["sodium", 6], ["potassium", 6], ["acidosis", 9], ["alkalosis", 9], ["hematuria", 11], ["rhabdomyolysis", 11], ["cystitis", 10], ["pyelonephritis", 12], ["nephrotic", 12], ["nephritic", 12], ["incontinence", 9], ["nephrolithiasis", 12]]],
  ["endocrine", [["endocrine", 11], ["thyroid", 11], ["adrenal", 11], ["pituitary", 11], ["diabetes", 11], ["insulin", 10], ["hormone", 8], ["cortisol", 10], ["glucocorticoid", 10], ["cushing", 11], ["addison", 11], ["hypothyroid", 12], ["hyperthyroid", 12], ["parathyroid", 11], ["calcium", 6], ["growth hormone", 11], ["prolactin", 10], ["acromegaly", 12], ["men syndrome", 12], ["5-alpha-reductase", 12], ["pheochromocytoma", 12], ["aldosterone", 10], ["thyroiditis", 12], ["goiter", 11]]],
  ["heme", [["hematolog", 12], ["anemia", 11], ["coagulation", 10], ["coagulopath", 12], ["blood", 6], ["platelet", 10], ["hemoglobin", 10], ["thalassemia", 12], ["sickle cell", 12], ["hemolysis", 11], ["hemolytic", 11], ["clotting", 9], ["thrombo", 8], ["bleeding", 7], ["red cell", 10], ["white cell", 10], ["neutrophil", 9], ["transfusion", 10], ["heparin", 10], ["warfarin", 10], ["anticoagulant", 11], ["iron deficiency", 11], ["b12 and folate", 12], ["folate", 9], ["hypercoagulable", 12], ["plasma cell disorder", 12], ["myeloproliferative", 12], ["polycythemia", 12], ["pancytopenia", 11], ["marrow", 9]]],
  ["oncology", [["oncolog", 12], ["cancer", 10], ["carcinoma", 10], ["tumor", 9], ["neoplas", 10], ["lymphoma", 11], ["leukemia", 11], ["myeloma", 11], ["metasta", 10], ["chemotherap", 11], ["antimetabolite", 10], ["alkylating agent", 12], ["sarcoma", 10], ["malignan", 8], ["benign", 5], ["paraneoplastic", 12], ["oncogene", 11], ["tumor suppressor", 12], ["tumor lysis", 12]]],
  ["musculoskeletal", [["musculoskeletal", 12], ["orthoped", 11], ["bone", 8], ["joint", 8], ["muscle", 7], ["fracture", 10], ["osteo", 8], ["tendon", 9], ["ligament", 9], ["cartilage", 9], ["skeletal", 7], ["clavicle", 10], ["femur", 10], ["knee", 9], ["shoulder", 9], ["lower back pain", 11], ["intervertebral disc", 11], ["disc herniation", 11], ["curvatures of the spine", 11], ["scoliosis", 11], ["kyphosis", 11], ["myopathy", 9], ["sarcomere", 10], ["rotator cuff", 11], ["bursitis", 11], ["achondroplasia", 9]]],
  ["rheumatology", [["rheumat", 12], ["arthritis", 11], ["lupus", 11], ["scleroderma", 12], ["sjogren", 12], ["vasculitis", 12], ["gout", 11], ["spondyl", 10], ["fibromyalgia", 12], ["polymyalgia", 12], ["dermatomyositis", 12], ["polymyositis", 12], ["ankylosing", 12], ["connective tissue disease", 11], ["autoantibod", 9]]],
  ["dermatology", [["dermatolog", 12], ["skin", 9], ["epidermis", 11], ["dermis", 10], ["melanoma", 11], ["psoriasis", 11], ["eczema", 11], ["acne", 10], ["rash", 8], ["cutaneous", 9], ["burn", 7], ["pigment disorder", 11], ["blistering", 11], ["bullous", 11], ["pemphig", 12], ["urticaria", 11], ["cellulitis", 10], ["vascular lesion", 9], ["wound healing", 9], ["alopecia", 11]]],
  ["ophthalmology", [["ophthalmolog", 12], ["retina", 11], ["retinal", 11], ["glaucoma", 12], ["cataract", 12], ["cornea", 11], ["pupil", 11], ["lens", 9], ["visual field", 11], ["eye movement", 11], ["gaze palsy", 12], ["gaze palsies", 12], ["strabismus", 12], ["uveitis", 12], ["macular", 11], ["conjunctiv", 11], ["intro to the eye", 12], ["structural eye", 12], ["vision", 8], ["optic nerve", 10]]],
  ["ent", [["auditory", 11], ["hearing", 10], ["vertigo", 11], ["vestibular", 10], ["cochlea", 11], ["tinnitus", 11], ["otitis", 12], ["sinusitis", 11], ["pharyngitis", 11], ["laryng", 10], ["tonsil", 10], ["nasal", 9], ["olfact", 10], ["meniere", 12], ["deafness", 11]]],
  ["reproductive", [["reproductive", 10], ["testes", 9], ["testic", 9], ["scrotum", 10], ["ovarian", 8], ["ovary", 8], ["uterus", 8], ["prostate", 10], ["penis", 9], ["spermato", 10], ["menstrual", 9], ["puberty", 8]]],
  ["obgyn", [["obstetric", 12], ["gynecolog", 12], ["pregnan", 10], ["labor", 8], ["delivery", 7], ["placenta", 10], ["preeclampsia", 12], ["contracept", 10], ["breast", 8], ["cervical", 7], ["postpartum", 11], ["prenatal", 10]]],
  ["pediatrics", [["pediatric", 12], ["newborn", 11], ["neonat", 11], ["infant", 9], ["child", 8], ["congenital", 7], ["vaccination schedule", 10], ["milestone", 8], ["kawasaki", 11]]],
  ["psychiatry", [["psychiatr", 12], ["psycholog", 9], ["depress", 10], ["anxiety", 10], ["schizophren", 12], ["bipolar", 11], ["substance abuse", 11], ["addiction", 10], ["antidepressant", 11], ["antipsychotic", 11], ["personality disorder", 12], ["ptsd", 11], ["ocd", 10], ["eating disorder", 11], ["mood", 7], ["adhd", 12], ["autism", 12], ["cognitive disorder", 11], ["psychosis", 12], ["psychotic", 11], ["sleep disorder", 11], ["insomnia", 11], ["conditioning", 9], ["transference", 10], ["defense mechanism", 11], ["delirium", 10], ["somatic symptom", 11], ["benzodiazepine", 10], ["lithium", 10], ["zolpidem", 11], ["zaleplon", 11], ["eszopiclone", 11]]],
  ["surgery", [["surgery", 11], ["surgical", 10], ["anesthes", 11], ["operative", 9], ["incision", 8], ["suture", 9], ["laparoscop", 10], ["general anesthesia", 12], ["local anesthetic", 11], ["neuromuscular blocker", 11]]],
  ["emergency", [["emergency", 11], ["critical care", 12], ["trauma", 10], ["acls", 12], ["resuscitat", 11], ["shock", 9], ["icu", 10], ["triage", 10], ["code blue", 11], ["intubat", 10]]],
  ["radiology", [["radiolog", 12], ["x-ray", 11], ["xray", 11], ["ct scan", 11], ["mri", 11], ["ultrasound", 11], ["imaging", 10], ["chest film", 11], ["radiograph", 11]]],

  ["pharmacology", [["pharmacolog", 12], ["medication", 9], ["drug", 8], ["beta blocker", 11], ["inhibitor", 7], ["agonist", 9], ["antagonist", 9], ["pharmacokinetic", 12], ["pharmacodynamic", 12], ["dosing", 8], ["side effect", 7], ["toxicity", 7], ["nsaid", 10], ["opioid", 10], ["drug-receptor", 12], ["methyldopa", 10]]],
  ["pathology", [["pathology", 11], ["patholog", 10], ["inflammation", 8], ["inflammatory response", 10], ["necrosis", 9], ["apoptosis", 9], ["cellular injury", 10], ["cell injury", 11], ["cellular adaptation", 12], ["free radical", 11], ["edema", 7], ["thrombosis", 8], ["infarct", 8], ["fibrosis", 8], ["granuloma", 10], ["abscess", 9], ["scar", 8], ["hyperplasia", 10], ["metaplasia", 11], ["dysplasia", 10], ["atrophy", 9], ["calcification", 9]]],
  ["anatomy", [["anatomy", 10], ["anatomic", 9], ["innervation", 10], ["blood supply", 9], ["lymphatics", 9], ["arteries", 8], ["veins", 8], ["nerves", 7], ["plexus", 9], ["viscera", 9], ["abdominal wall", 10], ["fascia", 9], ["compartment", 7], ["triangle", 7], ["foramen", 9], ["limb", 7]]],
  ["physiology", [["physiolog", 11], ["action potential", 10], ["homeostasis", 10], ["membrane potential", 10], ["cardiac output", 9], ["autoregulation", 9], ["compliance", 7], ["gradient", 6], ["secretion", 6], ["absorption", 6], ["filtration", 7], ["conduction velocity", 9]]],
];

/* ---------------------------------------------------------------
   Tier 6b — morphology. A third of this library is titled with nothing but
   a drug name or an organism name ("1.3 - Cladribine cytarabine
   gemcitabine", "1.4 - Strep agalactiae"), which the phrase table above
   cannot reach without listing every molecule in the pharmacopoeia. Stems
   and genus names generalise instead.

   Scored into the same map as KEYWORD_RULES, so a title carrying both a
   phrase and a stem accumulates both. These rules do NOT exist in
   scripts/categorize.js or config/buckets.yaml — they are additive here.
   --------------------------------------------------------------- */
const MORPHOLOGY_RULES = [
  /* Antimicrobial stems. Their table files antibiotics under infectious
     rather than pharmacology, so these follow it. */
  /* Chemotherapeutics first: bleomycin and dactinomycin end in an
     antibiotic stem but belong to oncology, and the higher weight settles
     it when both rules fire. */
  [/\b\w{3,}(?:rubicin|platin|taxel|tabine|mustine|trexate)\b|\b(?:bleomycin|dactinomycin|vincristine|vinblastine|etoposide|hydroxyurea|leucovorin|fluorouracil|cyclophosphamide|tamoxifen|imatinib|rituximab)\w*/, "oncology", 12],

  [/\b\w{3,}(?:cillins?|mycins?|cyclines?|floxacins?|oxacins?|penems?|conazoles?|fungins?|micins?|navirs?|ovirs?)\b/, "infectious", 11],
  [/\b(?:sulfonamide|sulfamethoxazole|trimethoprim|metronidazole|rifamp|isoniazid|ethambutol|pyrazinamide|dapsone|linezolid|daptomycin)\w*/, "infectious", 11],

  /* General drug stems. */
  [/\b\w{3,}(?:olols?|prils?|sartans?|dipines?|statins?|prazoles?|tidines?|triptans?|azepams?|barbitals?|barbiturates?|caines?|curiums?|zosins?|terols?|parins?|glitazones?|gliptins?|glinides?|fibrates?)\b/, "pharmacology", 10],
  [/\banti(?:emetic|histamine|coagulant|platelet|hypertensive|convulsant|epileptic|metabolite|tussive|diarrheal|diabetic|cholinergic)\w*/, "pharmacology", 10],
  [/\b(?:cholinomimetic|adrenergic|sympathomimetic|sympatholytic|muscarinic|nicotinic|immunosuppress|corticosteroid)\w*/, "pharmacology", 10],
  [/\b(?:agonists?|antagonists?|blockers?|inhibitors?)\b/, "pharmacology", 6],

  /* Bacteria, fungi, protozoa and helminths by genus. */
  [/\b(?:staph|strep|listeria|bacillus|klebsiella|proteus|serratia|enterococc|haemophilus|bordetella|legionella|vibrio|campylobacter|shigella|yersinia|brucella|francisella|treponem|borrelia|leptospir|mycoplasm|ureaplasm|bartonella|nocardia|gardnerella)\w*/, "microbiology", 11],
  [/\b(?:blastomyc|coccidioid|paracoccidioid|histoplasm|cryptococc|aspergill|mucor|sporothrix|pneumocystis)\w*/, "microbiology", 11],
  [/\b(?:giardia|entamoeba|cryptosporid|toxoplasm|trypanosom|leishman|babesia|plasmodium|naegleria|acanthamoeba|trichomon)\w*/, "microbiology", 11],
  [/\b(?:schistosom|taenia|ascaris|enterobius|onchocerc|wuchereria|strongyloid|necator|ancylostom|trichinella|echinococc|diphyllobothrium|hymenolepis|clonorchis|paragonimus)\w*/, "microbiology", 11],
  [/\b(?:herpes|cmv|ebv|hsv|vzv|hpv|influenza|rotavirus|norovirus|adenovirus|rhinovirus|coronavirus|paramyxo|picorna|hepadna|flavivirus|togavirus|arbovirus|rabies|measles|mumps|rubella|parvovirus|poxvirus|polyoma)\w*/, "microbiology", 10],

  /* Immunoglobulin isotypes — "1.1 IgA-converted" and friends. */
  [/\big[agmed]\b/, "immunology", 11],

  /* Cardiac drug classes that carry no shared stem. */
  [/\b(?:digoxin|milrinone|nesiritide|dobutamine|amiodarone|nitrates?|nitroglycerin|hydralazine|minoxidil|clopidogrel)\w*/, "cardiology", 10],

  /* Endocrine and renal word-forms the phrase table just misses:
     "Hyperpituitarism", "Tubulointersititial Nephritis". */
  [/\b(?:hyper|hypo)(?:pituitar|thyroid|parathyroid|adrenal|glycem|calcem|natrem|kalem)\w*/, "endocrine", 11],
  [/\bnephr(?:itis|itic|opathy|olith|osclerosis)\w*/, "renal", 10],

  /* Female reproductive anatomy and lesions. */
  [/\b(?:vulva|vulvar|vagina|vaginal|cervix|endometri|myometri|fallopian)\w*/, "obgyn", 10],

  /* Pathoma's own chapter language. */
  [/\bcell death\b|\bgrowth adaptations?\b/, "pathology", 11],

  /* Vitamins, minerals and deficiency states. */
  [/\b(?:kwashiorkor|kwashiokor|marasmus|scurvy|pellagra|beriberi|rickets|thiamine|riboflavin|niacin|pyridoxine|cobalamin|biotin)\w*/, "biochemistry", 10],
  [/\b(?:zinc|selenium|copper|magnesium)\b/, "biochemistry", 8],
  [/\bketone bod(?:y|ies)\b/, "biochemistry", 11],
];

const MIN_KEYWORD_SCORE = 6;
const HIGH_KEYWORD_SCORE = 10;

/* Content-format tags layered on top of the subject. */
const TAG_RULES = [
  [/board-?style question|question breakdown/i, "board-style-question"],
  [/practice question/i, "practice-questions"],
  [/clinical reasoning/i, "clinical-reasoning"],
  [/clinician'?s? corner/i, "clinicians-corner"],
  [/clinical correlate/i, "clinical-correlates"],
  [/\bhisto(logy)?\b/i, "histology"],
  [/\bsummary\b|\boverview\b/i, "overview"],
  /* No atf rule. It appears in over half the filenames as an upload marker,
     so as a tag it separated nothing. Folder names that genuinely contain
     it ("Anatomy ATF") still become tags via the folder path. */
  [/\bcommentary\b/i, "commentary"],
];

export const LEVELS = ["Preclinical", "Clinical", "Board Review", "Advanced", "Uncategorized"];

/* Words that identify nothing on their own. A title made only of these —
   "Commentary", "Commentary_SelfReview_01", "Lecture 3" — has to take its
   subject from a folder or a prefix; scoring its own words would file every
   one of them under the same wrong bucket. */
const GENERIC_WORD = new RegExp(
  "^(?:" +
    [
      "commentary", "self", "selfreview", "review", "lecture", "lec", "video", "clip",
      "part", "pt", "section", "sec", "chapter", "ch", "intro", "introduction",
      "overview", "notes?", "recording", "untitled", "new", "final", "full",
      "episode", "ep", "module", "unit", "class", "session", "misc", "temp", "tmp",
      "test", "output", "export", "render", "screen", "screenrecording", "zoom",
      "movie", "gmt", "converted", "copy", "final2",
      "\\d+", "[a-z]\\d+", "\\d+[a-z]", "v\\d+",
    ].join("|") +
    ")$",
  "i"
);

/** Index/ordering tokens that carry no subject: "Ch1", "Part2", "03". */
const INDEX_TOKEN = /^(?:ch|chapter|part|pt|sec|section|ep|episode|vol|disc|lecture|lec|no|num)?\d{1,4}$/i;

function titleWords(text) {
  return splitCamelCase(stripExtension(text)).split(/[\s_.\-–—]+/).filter(Boolean);
}

/** True when every word of a title is filler. */
export function isGenericTitle(text) {
  const words = titleWords(text);
  if (!words.length) return true;
  return words.every((w) => GENERIC_WORD.test(w.replace(/[^a-z0-9]/gi, "")));
}

/**
 * Strip the leading publisher name, subject prefix and index tokens, so
 * "SketchyMicro_MRSA.mov" reads as "MRSA" and
 * "Pathoma_Ch1_General_Pathology.mp4" as "General Pathology".
 *
 * Only the first few words are eligible — a subject word deeper in the title
 * is the topic, not a prefix, and dropping it would leave a title that says
 * less than the filename did.
 */
export function buildDisplayTitle(rawTitle) {
  const base = stripExtension(String(rawTitle || "")).trim();
  if (!base) return String(rawTitle || "");

  /* Separator-split with offsets, case and punctuation preserved. Splitting
     camelCase here would break "BnB" into "Bn B" and hide the brand. */
  const words = [...base.matchAll(/[A-Za-z0-9]+/g)];
  const LEAD = 4;

  let cut = 0;
  for (let i = 0; i < words.length && i < LEAD; i++) {
    const w = words[i][0].toLowerCase();
    if (!(matchBrand(w) || SUBJECT_ALIASES[w] || INDEX_TOKEN.test(w))) break;
    cut = i + 1;
  }

  // Everything was prefix ("Pathoma_Micro.mp4") — keep the original rather
  // than hand the UI an empty string.
  if (cut >= words.length) return splitCamelCase(base);

  /* Slice the original from the first kept word, so the remainder keeps its
     own punctuation: "007 - General Topics - Informed Consent" loses only
     the index. */
  const kept = base
    .slice(words[cut].index)
    .replace(/^[\s._#\-–—/\\]+/, "")
    .replace(/_+/g, " "); // an underscore is a separator, not punctuation
  return splitCamelCase(kept).replace(/\s+/g, " ").trim() || splitCamelCase(base);
}

const MEDIA_EXT = /\.(?:mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|m2ts|mpg|mpeg|m3u8|mp3|m4a|aac|wav)$/i;

/* ---------------------------------------------------------------
   Text helpers
   --------------------------------------------------------------- */

/** Strip a trailing media extension. Only known extensions, so a title
 *  ending in ".5" or "Dr. Smith" keeps its tail. */
export function stripExtension(name) {
  return String(name || "").replace(MEDIA_EXT, "");
}

/** Insert spaces at camelCase boundaries: "SketchyMicro" -> "Sketchy Micro",
 *  "BetaBlockers" -> "Beta Blockers". Runs of capitals are left intact so
 *  "MRSA" and "COPDExacerbation" survive as "MRSA" / "COPD Exacerbation".
 *
 *  Both halves of a split must look like real words: the capital has to be
 *  followed by lowercase, and enough of it. Without that, "IgA" splits to
 *  "Ig A" and "EKGs" to "EK Gs", which loses the term in both the display
 *  title and the keyword tables. */
export function splitCamelCase(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, "$1 $2");
}

/** Lowercased, punctuation-flattened form used for keyword scoring. */
export function normalizeText(text) {
  return splitCamelCase(stripExtension(text))
    .toLowerCase()
    .replace(/[^a-z0-9\s'.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The same, without the camelCase split.
 *
 *  Both forms are needed: splitting rescues "BetaBlockers" -> "beta blockers",
 *  but it also shreds an acronym that ends in a capitalised suffix — "EKGs"
 *  becomes "EK Gs" and "IgA" becomes "Ig A", hiding both from the tables.
 *  keywordScore looks in either string and counts each hit once. */
export function normalizeRaw(text) {
  return stripExtension(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a title into lookup tokens: extension gone, camelCase split,
 *  separators collapsed. "Osmosis_Pharm_BetaBlockers.mp4" ->
 *  ["osmosis","pharm","beta","blockers"] */
export function tokenize(text) {
  return splitCamelCase(stripExtension(text))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Tokens split on separators only, camelCase left welded together:
 *  "SketchyMicro_MRSA.mov" -> ["sketchymicro","mrsa"].
 *
 *  The brand and alias tiers read these rather than tokenize()'s output.
 *  Splitting camelCase first would break "SketchyMicro" into two tokens the
 *  brand table cannot match as one, and would shred an acronym brand
 *  ("BnB" -> "bn","b") into nothing either table recognises. */
export function separatorTokens(text) {
  return stripExtension(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Folder names for the path tier, deepest last. Both slash flavours, so
 *  Windows paths from the sync script work unchanged.
 *
 *  `filePath` ends in a filename and loses its last segment; `folder` is
 *  already a directory and keeps all of its own. Conflating the two would
 *  silently discard `{ folder: "Cardiology" }`. */
function folderSegments(filePath, folder) {
  const split = (v) => (v ? String(v).split(/[\\/]+/).filter(Boolean) : []);
  return [...split(filePath).slice(0, -1), ...split(folder)];
}

/* ---------------------------------------------------------------
   Tier implementations. Each returns a bucket id or null.
   --------------------------------------------------------------- */

/** Tier 1 — "007 - General Topics - Informed Consent". */
function sectionLabelOf(title) {
  const m = stripExtension(title).match(/^\s*\d+\s*[-–]\s*([^-–]+?)\s*[-–]\s*.+$/);
  if (!m) return null;
  const key = m[1].trim().toLowerCase().replace(/\s+/g, " ");
  // "Other Topics" / "Misc" carry no subject signal. Returning the sentinel
  // marks the title as structured-but-unmapped so the caller can skip the
  // prefix tier — the leading number there is a section index, not a code.
  if (/^(other|misc)/.test(key)) return { bucket: null, structured: true };
  const bucket = SECTION_MAP[key];
  return bucket ? { bucket, structured: true } : { bucket: null, structured: true };
}

/** Tier 2 — "Cardio/014 - Preload", "Neuro__03 - Stroke". */
function qualifiedSubjectOf(title) {
  const m = stripExtension(title).match(/^\s*([A-Za-z]{2,16})\s*(?:\/|__|::)\s*\S/);
  if (!m) return null;
  return SUBJECT_ALIASES[m[1].toLowerCase()] || null;
}

/**
 * Tier 3 — publisher name with a subject welded on.
 * Returns { brand, bucket, rest } where `bucket` may be null for a bare
 * brand ("Pathoma_Ch1_..."), in which case only the name is consumed.
 */
export function matchBrand(token) {
  const t = String(token || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return null;
  for (const [alias, brand] of BRAND_ALIASES) {
    if (t === alias) return { brand, bucket: null, rest: "" };
    if (t.startsWith(alias)) {
      const rest = t.slice(alias.length);
      // A one-character tail is noise ("bb1"), not a subject.
      const bucket = rest.length > 1 ? SUBJECT_ALIASES[rest] || null : null;
      return { brand, bucket, rest };
    }
  }
  return null;
}

/** Scan the leading tokens of a title for a publisher name. Only the first
 *  few are considered — a brand mentioned mid-title is content, not a prefix. */
function brandScan(tokens) {
  const limit = Math.min(tokens.length, 3);
  for (let i = 0; i < limit; i++) {
    const hit = matchBrand(tokens[i]);
    if (hit) return { ...hit, index: i };
  }
  return null;
}

/** Tiers 4/5 — first token that is a known subject alias. */
function aliasScan(tokens, { limit = 3 } = {}) {
  const stop = Math.min(tokens.length, limit);
  for (let i = 0; i < stop; i++) {
    const bucket = SUBJECT_ALIASES[tokens[i]];
    if (bucket) return { bucket, index: i };
  }
  return null;
}

/**
 * Tier 6 — weighted substring scoring plus the morphology rules.
 *
 * @param {string} text     camelCase-split normalised title
 * @param {string} [rawText] same title without the camelCase split; a hit in
 *        either form counts once, never twice
 */
export function keywordScore(text, rawText = text) {
  const scores = new Map();
  const hits = new Map();
  const both = rawText !== text;

  const add = (bucket, weight, label) => {
    scores.set(bucket, (scores.get(bucket) || 0) + weight);
    if (!hits.has(bucket)) hits.set(bucket, []);
    hits.get(bucket).push(label);
  };

  for (const [bucket, keywords] of KEYWORD_RULES) {
    for (const [kw, weight] of keywords) {
      if (text.includes(kw) || (both && rawText.includes(kw))) add(bucket, weight, kw);
    }
  }

  for (const [re, bucket, weight] of MORPHOLOGY_RULES) {
    const m = text.match(re) || (both ? rawText.match(re) : null);
    if (m) add(bucket, weight, m[0]);
  }

  let best = null;
  let bestScore = 0;
  for (const [bucket, score] of scores) {
    // Ties go to whichever bucket scored first — insertion order, which
    // follows KEYWORD_RULES and then MORPHOLOGY_RULES. Deterministic, so a
    // reclassification run cannot shuffle titles between equal buckets.
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  return { bucket: best, score: bestScore, keywords: best ? hits.get(best) : [] };
}

/* ---------------------------------------------------------------
   Level and tags
   --------------------------------------------------------------- */

export function inferLevel(title) {
  const t = normalizeText(title);
  if (/board-?style question|practice question|question breakdown/.test(t)) return "Board Review";
  if (/clinical reasoning|clinician'?s? corner|clinical correlate|management|treatment/.test(t)) return "Clinical";
  if (/anatomy|embryolog|histolog|biochem|physiolog|genetic/.test(t)) return "Preclinical";
  return "Uncategorized";
}

export function inferTags(title, category, brand) {
  const tags = new Set();
  for (const [re, tag] of TAG_RULES) {
    if (re.test(String(title))) tags.add(tag);
  }
  if (category && category !== UNCATEGORIZED) tags.add(category);
  if (brand) tags.add(brand.id);
  return [...tags];
}

/* ---------------------------------------------------------------
   classifyVideo
   --------------------------------------------------------------- */

/**
 * @typedef {Object} Classification
 * @property {string}  category      bucket id, always one of BUCKETS
 * @property {string}  label         human label for that bucket
 * @property {string}  color         bucket colour, for the sidebar dot
 * @property {string}  source        which tier decided: explicit | section |
 *                                   qualified | brand-hint | prefix | path |
 *                                   keyword | default
 * @property {"high"|"medium"|"low"|"none"} confidence
 * @property {number}  score         keyword score, 0 when another tier won
 * @property {string|null} brand     publisher id, null when none recognised
 * @property {string}  displayTitle  title with brand/extension/index noise gone
 * @property {string[]} keywords     keyword hits behind a tier-6 decision
 * @property {boolean} isGeneric     title carries no subject of its own
 * @property {boolean} conflict      explicit category disagreed with the parse
 * @property {string}  level
 * @property {string[]} tags
 */

/**
 * Classify one library entry.
 *
 * @param {string|Object} input  a filename, or an object with any of
 *        { title, name, path, filename, category, folder }
 * @param {Object} [options]
 * @param {boolean} [options.preferFilename=false]  ignore an incoming
 *        `category` for the decision (it is still parsed and reported as a
 *        conflict). Use when auditing hand-entered metadata.
 * @param {boolean} [options.usePath=true]  allow folder names to supply the
 *        subject for titles that carry none.
 * @returns {Classification}
 */
export function classifyVideo(input, options = {}) {
  const { preferFilename = false, usePath = true } = options;

  const item = typeof input === "string" ? { title: input } : input || {};
  const rawTitle = String(item.title ?? item.name ?? item.filename ?? "");
  const filePath = item.path ?? item.filename ?? "";

  /* Two token streams: separator-only for the name tiers (a brand or subject
     is one token there), camelCase-split for keyword scoring. */
  const tokens = separatorTokens(rawTitle);
  const text = normalizeText(rawTitle);
  const rawText = normalizeRaw(rawTitle);

  const brandHit = brandScan(tokens);
  const brand = brandHit ? brandHit.brand : null;

  const displayTitle = buildDisplayTitle(rawTitle);
  const isGeneric = isGenericTitle(displayTitle);

  /* ---- the explicit metadata field ---- */
  const explicit = normalizeCategory(item.category);

  /* ---- run the filename tiers regardless, so an explicit value can be
     cross-checked instead of silently masking a bad parse ---- */
  const parsed = parseFromName({ rawTitle, tokens, text, rawText, brandHit, isGeneric });

  /* ---- folder fallback for titles with no signal of their own ---- */
  let fromPath = null;
  if (usePath && !parsed.bucket) {
    /* Deepest folder first — "Micro/Week 3/" is more specific than "Micro/". */
    for (const segment of folderSegments(filePath, item.folder).reverse()) {
      const segTokens = separatorTokens(segment);
      const hit =
        aliasScan(segTokens, { limit: segTokens.length }) ||
        (matchBrand(segTokens[0])?.bucket ? { bucket: matchBrand(segTokens[0]).bucket } : null);
      if (hit?.bucket) {
        fromPath = hit.bucket;
        break;
      }
      const scored = keywordScore(normalizeText(segment), normalizeRaw(segment));
      if (scored.score >= HIGH_KEYWORD_SCORE) {
        fromPath = scored.bucket;
        break;
      }
    }
  }

  /* ---- pick a winner ---- */
  let category = UNCATEGORIZED;
  let source = "default";
  let confidence = "none";
  let score = 0;
  let keywords = [];

  if (explicit && !preferFilename) {
    category = explicit;
    source = "explicit";
    confidence = "high";
  } else if (parsed.bucket) {
    category = parsed.bucket;
    source = parsed.source;
    confidence = parsed.confidence;
    score = parsed.score;
    keywords = parsed.keywords;
  } else if (fromPath) {
    category = fromPath;
    source = "path";
    confidence = "medium";
  } else if (explicit) {
    category = explicit;
    source = "explicit";
    confidence = "high";
  }

  const bucket = getBucket(category);
  const conflict = Boolean(explicit && parsed.bucket && explicit !== parsed.bucket);

  return {
    category: bucket.id,
    label: bucket.label,
    color: bucket.color,
    source,
    confidence,
    score,
    keywords,
    brand: brand ? brand.id : null,
    brandLabel: brand ? brand.label : null,
    displayTitle,
    isGeneric,
    conflict,
    parsedCategory: parsed.bucket || fromPath || null,
    level: inferLevel(rawTitle),
    tags: inferTags(rawTitle, bucket.id, brand),
  };
}

/** Tiers 1-4 and 6, over the filename only. */
function parseFromName({ rawTitle, tokens, text, rawText, brandHit, isGeneric }) {
  const none = { bucket: null, source: "default", confidence: "none", score: 0, keywords: [] };

  const section = sectionLabelOf(rawTitle);
  if (section?.bucket) {
    return { bucket: section.bucket, source: "section", confidence: "high", score: 0, keywords: [] };
  }

  const qualified = qualifiedSubjectOf(rawTitle);
  if (qualified) {
    return { bucket: qualified, source: "qualified", confidence: "high", score: 0, keywords: [] };
  }

  if (brandHit?.bucket) {
    return { bucket: brandHit.bucket, source: "brand-hint", confidence: "high", score: 0, keywords: [] };
  }

  /* A structured "### - Other Topics - X" title must not have its leading
     number read as a subject code, so the prefix tier is skipped for it. */
  if (!section?.structured) {
    const start = brandHit ? brandHit.index + 1 : 0;
    const alias = aliasScan(tokens.slice(start), { limit: 2 });
    if (alias) {
      // "BnB_Cardio_…" — a subject sitting directly behind a publisher name
      // is the same signal as "SketchyMicro", so it reports the same tier.
      const source = brandHit && alias.index === 0 ? "brand-hint" : "prefix";
      return { bucket: alias.bucket, source, confidence: "high", score: 0, keywords: [] };
    }
  }

  /* A generic title has nothing worth scoring — let the path tier answer. */
  if (isGeneric) return none;

  const scored = keywordScore(text, rawText);
  if (scored.bucket && scored.score >= MIN_KEYWORD_SCORE) {
    return {
      bucket: scored.bucket,
      source: "keyword",
      confidence: scored.score >= HIGH_KEYWORD_SCORE ? "high" : "low",
      score: scored.score,
      keywords: scored.keywords,
    };
  }

  return none;
}

/** Accept "Microbiology", "micro", "MICRO ", "Renal & Urology" -> bucket id. */
export function normalizeCategory(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (BUCKET_BY_ID.has(raw)) return raw;

  const byLabel = BUCKETS.find((b) => b.label.toLowerCase() === raw);
  if (byLabel) return byLabel.id;

  const key = raw.replace(/[^a-z0-9]/g, "");
  return SUBJECT_ALIASES[key] || SUBJECT_ALIASES[raw] || null;
}

/**
 * Classify a whole library. Returns the input objects with the
 * classification merged in, plus a `key` that is stable for de-duplicating
 * the many entries that share a generic title.
 */
export function classifyAll(items, options = {}) {
  return items.map((item, index) => {
    const result = classifyVideo(item, options);
    const base = typeof item === "string" ? { title: item } : item;
    return {
      ...base,
      ...result,
      key: base.id ?? base.guid ?? `${result.category}:${result.displayTitle}:${index}`,
    };
  });
}

/** Per-bucket totals, ordered like BUCKETS, empty buckets dropped. */
export function summarize(classified) {
  const counts = new Map();
  for (const v of classified) counts.set(v.category, (counts.get(v.category) || 0) + 1);
  return BUCKETS.filter((b) => counts.has(b.id)).map((b) => ({ ...b, count: counts.get(b.id) }));
}
