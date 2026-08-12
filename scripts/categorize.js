/* ============================================================
   Auto-categorize synced videos into subject areas.

   Usage:  node scripts/categorize.js
           node scripts/categorize.js --dry-run    (report only, write nothing)
           node scripts/categorize.js --recategorize  (also redo previous auto picks)

   Reads titles out of js/videos.generated.js, assigns a category /
   level / tags to each, and writes the result into js/overrides.json.

   SAFETY: entries you have edited by hand are never touched. The script
   only writes entries it owns, marked with "_auto": true. Remove that
   flag from an entry (or just edit the entry) and it becomes yours —
   subsequent runs will leave it alone.

   After running this, re-run `node scripts/sync-bunny.js` to fold the
   new metadata into js/videos.generated.js.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GENERATED_PATH = path.join(ROOT, "js", "videos.generated.js");
const OVERRIDES_PATH = path.join(ROOT, "js", "overrides.json");

const DRY_RUN = process.argv.includes("--dry-run");
const RECATEGORIZE = process.argv.includes("--recategorize");
const LIST_UNMATCHED = process.argv.includes("--list-uncategorized");

/* ---------------------------------------------------------------
   Authoritative section labels — these come from titles formatted as
   "### - Section - Topic", where the middle field is the publisher's
   own section name. Trusted over keyword guessing.
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
  "cell biology": "biochemistry",
  "arrhythmias": "cardiology",
  "heart failure": "cardiology",
  "cardiac auscultation": "cardiology",
  "ischemic heart disease": "cardiology",
  "antibiotics": "infectious",
  "fungi and parasites": "microbiology",
  "hiv": "infectious",
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
   Weighted keyword rules. Multi-word phrases score higher than bare
   words so "cardiac muscle histology" resolves to histology rather
   than fighting between cardiology and musculoskeletal.
   --------------------------------------------------------------- */
const RULES = [
  ["nursing",        [["nursing assistant", 12], ["nurse aide", 10], ["nursing", 5], ["patient transfer", 5], ["bed bath", 6], ["vital signs measurement", 5]]],
  ["biostats",       [["biostatistic", 12], ["basic statistics", 12], ["statistics", 8], ["study design", 9], ["hypothesis testing", 10], ["sensitivity", 5], ["specificity", 5], ["predictive value", 9], ["confidence interval", 10], ["bias", 8], ["epidemiolog", 9], ["incidence", 6], ["prevalence", 6], ["risk quantification", 12], ["dose-response", 11], ["tests of significance", 12], ["correlation", 9], ["diagnostic test", 10], ["clinical trial", 11], ["p-value", 11], ["odds ratio", 11], ["relative risk", 11], ["number needed to treat", 12], ["screening", 7], ["roc curve", 12]]],
  ["publichealth",   [["ethics", 10], ["informed consent", 10], ["confidentiality", 10], ["decision-making capacity", 10], ["delivering bad news", 10], ["public health", 10], ["quality", 5], ["safety", 5], ["healthcare system", 8], ["malpractice", 8], ["end of life", 7], ["physician-patient", 7]]],

  ["histology",      [["histology", 12], ["histo", 8], ["stratum", 7], ["epithelium", 7], ["epithelial cell", 9], ["connective tissue", 7], ["nervous tissue", 8], ["microscopic anatomy", 9], ["cytoskeleton", 9], ["cell structure", 8], ["organelle", 9]]],
  ["embryology",     [["embryology", 12], ["embryo", 8], ["fetal development", 9], ["pharyngeal arch", 9], ["neural crest", 8], ["gastrulation", 9], ["organogenesis", 9], ["branchial", 9]]],
  ["genetics",       [["genetic", 10], ["chromosom", 8], ["down syndrome", 9], ["trisom", 10], ["inheritance", 9], ["mendelian", 9], ["mutation", 6], ["karyotype", 9], ["imprinting", 8], ["pedigree", 11], ["hardy-weinberg", 12], ["gene mapping", 11], ["deletion syndrome", 11], ["trinucleotide repeat", 12], ["turner", 9], ["klinefelter", 11], ["meiosis", 10], ["mitosis", 8], ["microarray", 10], ["fish", 6], ["achondroplasia", 10], ["muscular dystrophy", 10], ["fragile x", 11], ["cystic fibrosis", 10], ["marfan", 10]]],
  ["biochemistry",   [["amino acid", 10], ["dna replication", 11], ["dna structure", 11], ["dna repair", 11], ["transcription", 8], ["translation", 7], ["enzyme", 8], ["glycolysis", 11], ["gluconeogenesis", 12], ["krebs", 10], ["tca cycle", 12], ["citric acid cycle", 11], ["electron transport", 12], ["metabolism", 7], ["b vitamins", 9], ["vitamin", 6], ["glucose", 6], ["lipid", 6], ["fatty acid", 10], ["ketone body", 11], ["glycogen", 11], ["protein synthesis", 9], ["cell cycle", 8], ["molecular", 6], ["purine", 8], ["pyrimidine", 8], ["porphyria", 12], ["lysosomal storage", 12], ["hmp shunt", 12], ["pentose phosphate", 12], ["ammonia", 9], ["urea cycle", 12], ["phenylalanine", 11], ["tyrosine", 10], ["fructose", 10], ["galactose", 10], ["pyruvate", 11], ["pcr", 10], ["blotting", 11], ["elisa", 11], ["flow cytometry", 11], ["starvation", 8], ["homocystein", 10]]],
  ["immunology",     [["immunolog", 12], ["immunity", 10], ["hypersensitivity", 10], ["antibody", 8], ["antigen", 8], ["complement", 7], ["t cell", 7], ["b cell", 6], ["b-cell", 8], ["t-cell", 8], ["mhc", 8], ["autoimmun", 8], ["vaccine", 7], ["vaccination", 8], ["immunodeficiency", 10], ["immune deficiency", 11], ["transplant", 9], ["lymph node", 9], ["spleen", 8], ["thymus", 9], ["cytokine", 9], ["interleukin", 10], ["amyloidosis", 9]]],
  ["microbiology",   [["bacteria", 9], ["bacteri", 7], ["virus", 8], ["viral", 7], ["fungal", 9], ["fungi", 9], ["parasit", 9], ["protozoa", 11], ["protoza", 11], ["malaria", 11], ["gram stain", 10], ["gram positive", 10], ["gram negative", 10], ["staphylo", 10], ["strepto", 10], ["clostrid", 10], ["mycobacter", 10], ["e. coli", 9], ["corynebacterium", 11], ["salmonella", 10], ["candida", 9], ["helminth", 10], ["spirochete", 11], ["actinomyc", 11], ["virulence", 10], ["shapes and stains", 11], ["growth requirement", 10], ["neisseria", 11], ["pseudomonas", 11], ["chlamydia", 10], ["rickettsia", 11], ["prion", 10]]],
  ["infectious",     [["antibiotic", 10], ["antimicrobial", 10], ["antiviral", 10], ["antifungal", 10], ["antimalarial", 11], ["hiv", 10], ["aids", 8], ["tuberculosis", 11], ["sepsis", 9], ["infection", 6], ["infectious", 9], ["beta lactam", 10], ["penicillin", 10], ["cephalosporin", 10], ["vancomycin", 10], ["meningitis", 8]]],

  ["cardiology",     [["cardiac", 9], ["heart", 8], ["ekg", 11], ["ecg", 11], ["arrhythmia", 11], ["myocardial", 10], ["coronary", 10], ["heart failure", 12], ["hypertension", 9], ["murmur", 10], ["valve", 7], ["atrial", 9], ["ventricular", 8], ["aortic", 8], ["angina", 10], ["pericard", 10], ["endocarditis", 10], ["cardiomyopathy", 11], ["stroke volume", 9], ["ejection fraction", 10], ["blood pressure", 7], ["pacemaker", 9], ["tachycardia", 10], ["bradycardia", 10], ["lipid-lowering", 8], ["statin", 9], ["stemi", 12], ["nstemi", 12], ["bundle branch", 12], ["avnrt", 12], ["avrt", 12], ["wpw", 12], ["wolff-parkinson", 12], ["coarctation", 12], ["pv loop", 12], ["pressure-volume loop", 12], ["wiggers", 12], ["venous pressure", 10], ["starling curve", 12], ["shunt", 7], ["cv response", 10], ["cardiovascular", 10], ["atherosclerosis", 10], ["aneurysm", 9], ["peripheral vascular", 10], ["syncope", 9], ["preload", 10], ["afterload", 10], ["defibrillat", 10]]],
  ["pulmonology",    [["pulmonary", 10], ["lung", 9], ["respiratory", 9], ["asthma", 11], ["copd", 11], ["pneumonia", 10], ["pneumothorax", 11], ["ventilation", 7], ["spirometry", 11], ["bronch", 8], ["pleural", 9], ["hypoxia", 7], ["oxygen", 5], ["tidal volume", 9], ["pulmonary embolism", 12]]],
  ["neurology",      [["neurolog", 10], ["cranial nerve", 12], ["cerebral", 10], ["brain", 8], ["spinal cord", 10], ["stroke", 10], ["seizure", 11], ["epilep", 11], ["dementia", 11], ["alzheimer", 11], ["parkinson", 11], ["multiple sclerosis", 12], ["demyelinat", 11], ["neuron", 8], ["nervous system", 9], ["cortex", 9], ["thalamus", 10], ["cerebellum", 10], ["cerebellar", 10], ["basal ganglia", 11], ["meninges", 9], ["csf", 8], ["myasthenia", 11], ["neuropathy", 10], ["bell's palsy", 12], ["reflex", 7], ["motor neuron", 10], ["tracts", 7], ["cns", 8], ["pns", 8], ["migraine", 10], ["neurotransmitter", 11], ["acetylcholine", 10], ["dopamine", 9], ["serotonin", 9], ["gaba", 9], ["norepinephrine", 9], ["ventricles and sinuses", 11], ["altered mental status", 11], ["headache", 10], ["nerve damage", 10], ["encephal", 10], ["myelin", 9], ["huntington", 11], ["als", 5], ["neuromuscular disease", 11], ["intracranial", 10], ["hydrocephalus", 11], ["aphasia", 11], ["apraxia", 11]]],
  ["gastro",         [["gastrointestinal", 11], ["esophag", 10], ["stomach", 9], ["intestin", 9], ["bowel", 9], ["liver", 10], ["hepat", 9], ["biliary", 10], ["pancrea", 8], ["colon", 9], ["gallbladder", 11], ["gallstone", 12], ["cholecystitis", 12], ["cholangitis", 12], ["cirrhosis", 11], ["jaundice", 10], ["bile", 9], ["bilirubin", 11], ["gastric", 9], ["peptic ulcer", 12], ["celiac", 10], ["crohn", 11], ["ulcerative colitis", 12], ["diarrhea", 8], ["digestion", 8], ["hernia", 10], ["salivary gland", 11], ["wilson's disease", 12], ["hemochromatosis", 12], ["appendicitis", 11], ["diverticul", 11], ["malabsorption", 11], ["ascites", 10]]],
  ["renal",          [["renal", 10], ["kidney", 10], ["nephro", 10], ["glomerul", 11], ["urinary", 9], ["urolog", 10], ["bladder", 8], ["ureter", 9], ["acid base", 10], ["acid-base", 10], ["electrolyte", 9], ["diuretic", 10], ["dialysis", 11], ["creatinine", 10], ["gfr", 11], ["tubular", 8], ["tubulointerstitial", 12], ["sodium", 6], ["potassium", 6], ["acidosis", 9], ["alkalosis", 9], ["hematuria", 11], ["rhabdomyolysis", 11], ["cystitis", 10], ["pyelonephritis", 12], ["nephrotic", 12], ["nephritic", 12], ["incontinence", 9]]],
  ["endocrine",      [["endocrine", 11], ["thyroid", 11], ["adrenal", 11], ["pituitary", 11], ["diabetes", 11], ["insulin", 10], ["hormone", 8], ["cortisol", 10], ["glucocorticoid", 10], ["cushing", 11], ["addison", 11], ["hypothyroid", 12], ["hyperthyroid", 12], ["parathyroid", 11], ["calcium", 6], ["growth hormone", 11], ["prolactin", 10], ["acromegaly", 12], ["men syndrome", 12], ["5-alpha-reductase", 12], ["pheochromocytoma", 12], ["aldosterone", 10], ["thyroiditis", 12], ["goiter", 11]]],
  ["heme",           [["hematolog", 12], ["anemia", 11], ["coagulation", 10], ["coagulopath", 12], ["blood", 6], ["platelet", 10], ["hemoglobin", 10], ["thalassemia", 12], ["sickle cell", 12], ["hemolysis", 11], ["hemolytic", 11], ["clotting", 9], ["thrombo", 8], ["bleeding", 7], ["red cell", 10], ["white cell", 10], ["neutrophil", 9], ["transfusion", 10], ["heparin", 10], ["warfarin", 10], ["anticoagulant", 11], ["iron deficiency", 11], ["b12 and folate", 12], ["folate", 9], ["hypercoagulable", 12], ["plasma cell disorder", 12], ["myeloproliferative", 12], ["polycythemia", 12], ["pancytopenia", 11], ["marrow", 9]]],
  ["oncology",       [["oncolog", 12], ["cancer", 10], ["carcinoma", 10], ["tumor", 9], ["neoplas", 10], ["lymphoma", 11], ["leukemia", 11], ["myeloma", 11], ["metasta", 10], ["chemotherap", 11], ["antimetabolite", 10], ["alkylating agent", 12], ["sarcoma", 10], ["malignan", 8], ["benign", 5], ["paraneoplastic", 12], ["oncogene", 11], ["tumor suppressor", 12]]],
  ["musculoskeletal", [["musculoskeletal", 12], ["orthoped", 11], ["bone", 8], ["joint", 8], ["muscle", 7], ["fracture", 10], ["osteo", 8], ["tendon", 9], ["ligament", 9], ["cartilage", 9], ["skeletal", 7], ["clavicle", 10], ["femur", 10], ["knee", 9], ["shoulder", 9], ["achondroplasia", 9], ["lower back pain", 11], ["intervertebral disc", 11], ["disc herniation", 11], ["curvatures of the spine", 11], ["scoliosis", 11], ["kyphosis", 11], ["myopathy", 9], ["sarcomere", 10], ["rotator cuff", 11]]],
  ["rheumatology",   [["rheumat", 12], ["arthritis", 11], ["lupus", 11], ["scleroderma", 12], ["sjogren", 12], ["vasculitis", 12], ["gout", 11], ["spondyl", 10], ["fibromyalgia", 12], ["polymyalgia", 12], ["dermatomyositis", 12], ["polymyositis", 12], ["ankylosing", 12], ["connective tissue disease", 11], ["autoantibod", 9]]],
  ["dermatology",    [["dermatolog", 12], ["skin", 9], ["epidermis", 11], ["dermis", 10], ["melanoma", 11], ["psoriasis", 11], ["eczema", 11], ["acne", 10], ["rash", 8], ["cutaneous", 9], ["burn", 7], ["pigment disorder", 11], ["blistering", 11], ["bullous", 11], ["pemphig", 12], ["urticaria", 11], ["cellulitis", 10], ["vascular lesion", 9], ["wound healing", 9], ["alopecia", 11]]],
  ["ophthalmology",  [["ophthalmolog", 12], ["retina", 11], ["retinal", 11], ["glaucoma", 12], ["cataract", 12], ["cornea", 11], ["pupil", 11], ["lens", 9], ["visual field", 11], ["eye movement", 11], ["gaze palsy", 12], ["gaze palsies", 12], ["strabismus", 12], ["uveitis", 12], ["macular", 11], ["conjunctiv", 11], ["intro to the eye", 12], ["structural eye", 12], ["vision", 8], ["optic nerve", 10]]],
  ["ent",            [["auditory", 11], ["hearing", 10], ["vertigo", 11], ["vestibular", 10], ["cochlea", 11], ["tinnitus", 11], ["otitis", 12], ["sinusitis", 11], ["pharyngitis", 11], ["laryng", 10], ["tonsil", 10], ["nasal", 9], ["olfact", 10], ["meniere", 12], ["deafness", 11]]],
  ["reproductive",   [["reproductive", 10], ["testes", 9], ["testic", 9], ["scrotum", 10], ["ovarian", 8], ["ovary", 8], ["uterus", 8], ["prostate", 10], ["penis", 9], ["spermato", 10], ["menstrual", 9], ["puberty", 8]]],
  ["obgyn",          [["obstetric", 12], ["gynecolog", 12], ["pregnan", 10], ["labor", 8], ["delivery", 7], ["fetal", 8], ["placenta", 10], ["preeclampsia", 12], ["contracept", 10], ["breast", 8], ["cervical", 7], ["postpartum", 11], ["prenatal", 10]]],
  ["pediatrics",     [["pediatric", 12], ["newborn", 11], ["neonat", 11], ["infant", 9], ["child", 8], ["congenital", 7], ["vaccination schedule", 10], ["milestone", 8], ["kawasaki", 11]]],
  ["psychiatry",     [["psychiatr", 12], ["psycholog", 9], ["depress", 10], ["anxiety", 10], ["schizophren", 12], ["bipolar", 11], ["substance abuse", 11], ["addiction", 10], ["antidepressant", 11], ["antipsychotic", 11], ["personality disorder", 12], ["ptsd", 11], ["ocd", 10], ["eating disorder", 11], ["mood", 7], ["adhd", 12], ["autism", 12], ["cognitive disorder", 11], ["psychosis", 12], ["psychotic", 11], ["sleep disorder", 11], ["insomnia", 11], ["conditioning", 9], ["transference", 10], ["defense mechanism", 11], ["delirium", 10], ["somatic symptom", 11], ["benzodiazepine", 10], ["lithium", 10]]],
  ["surgery",        [["surgery", 11], ["surgical", 10], ["anesthes", 11], ["operative", 9], ["incision", 8], ["suture", 9], ["laparoscop", 10], ["general anesthesia", 12], ["local anesthetic", 11], ["neuromuscular blocker", 11]]],
  ["emergency",      [["emergency", 11], ["critical care", 12], ["trauma", 10], ["acls", 12], ["resuscitat", 11], ["shock", 9], ["icu", 10], ["triage", 10], ["code blue", 11], ["intubat", 10]]],
  ["radiology",      [["radiolog", 12], ["x-ray", 11], ["xray", 11], ["ct scan", 11], ["mri", 11], ["ultrasound", 11], ["imaging", 10], ["chest film", 11], ["radiograph", 11]]],

  ["pharmacology",   [["pharmacolog", 12], ["medication", 9], ["drug", 8], ["inhibitor", 7], ["agonist", 9], ["antagonist", 9], ["pharmacokinetic", 12], ["pharmacodynamic", 12], ["dosing", 8], ["side effect", 7], ["toxicity", 7], ["nsaid", 10], ["opioid", 10], ["beta blocker", 11]]],
  ["pathology",      [["pathology", 11], ["patholog", 10], ["inflammation", 8], ["inflammatory response", 10], ["necrosis", 9], ["apoptosis", 9], ["cellular injury", 10], ["cell injury", 11], ["cellular adaptation", 12], ["free radical", 11], ["edema", 7], ["thrombosis", 8], ["infarct", 8], ["fibrosis", 8], ["granuloma", 10], ["abscess", 9], ["scar", 8], ["hyperplasia", 10], ["metaplasia", 11], ["dysplasia", 10], ["atrophy", 9], ["calcification", 9]]],
  ["anatomy",        [["anatomy", 10], ["anatomic", 9], ["innervation", 10], ["blood supply", 9], ["lymphatics", 9], ["arteries", 8], ["veins", 8], ["nerves", 7], ["plexus", 9], ["viscera", 9], ["abdominal wall", 10], ["fascia", 9], ["compartment", 7], ["triangle", 7], ["foramen", 9], ["limb", 7]]],
  ["physiology",     [["physiolog", 11], ["action potential", 10], ["homeostasis", 10], ["membrane potential", 10], ["cardiac output", 9], ["autoregulation", 9], ["compliance", 7], ["gradient", 6], ["secretion", 6], ["absorption", 6], ["filtration", 7], ["conduction velocity", 9]]],
];

/* Content-format tags applied on top of the subject category. */
const TAG_RULES = [
  [/board-?style question|question breakdown/i, "board-style-question"],
  [/practice question/i, "practice-questions"],
  [/clinical reasoning/i, "clinical-reasoning"],
  [/clinician'?s? corner/i, "clinicians-corner"],
  [/clinical correlate/i, "clinical-correlates"],
  [/\bhisto(logy)?\b/i, "histology"],
  [/summary|overview/i, "overview"],
  [/\batf\b/i, "atf-series"],
  [/osmosis/i, "osmosis"],
];

/* Level inference from content format. */
function inferLevel(title) {
  const t = title.toLowerCase();
  if (/board-?style question|practice question|question breakdown/.test(t)) return "Board Review";
  if (/clinical reasoning|clinician'?s? corner|clinical correlate|management|treatment/.test(t)) return "Clinical";
  if (/anatomy|embryolog|histolog|biochem|physiolog|genetic/.test(t)) return "Preclinical";
  return "Uncategorized";
}

function normalize(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionLabelOf(title) {
  const m = title.match(/^\s*\d+\s*-\s*([^-]+?)\s*-\s*.+$/);
  if (!m) return null;
  const key = m[1].trim().toLowerCase().replace(/\s+/g, " ");
  // "OtherTopics" / "Other Topics" carry no subject signal — fall through to keywords.
  if (key.startsWith("other")) return null;
  return SECTION_MAP[key] || null;
}

function categorize(title) {
  const fromSection = sectionLabelOf(title);
  if (fromSection) return { category: fromSection, confidence: "section-label" };

  const text = normalize(title);
  let best = null;
  let bestScore = 0;

  for (const [category, keywords] of RULES) {
    let score = 0;
    for (const [kw, weight] of keywords) {
      if (text.includes(kw)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  if (!best || bestScore < 6) return { category: "uncategorized", confidence: "none" };
  return { category: best, confidence: bestScore >= 10 ? "high" : "low" };
}

function tagsFor(title, category) {
  const tags = new Set();
  for (const [re, tag] of TAG_RULES) {
    if (re.test(title)) tags.add(tag);
  }
  if (category !== "uncategorized") tags.add(category);
  return [...tags];
}

/* --------------------------------------------------------------- */

function main() {
  if (!fs.existsSync(GENERATED_PATH)) {
    console.error("js/videos.generated.js not found — run scripts/sync-bunny.js first.");
    process.exit(1);
  }

  const src = fs.readFileSync(GENERATED_PATH, "utf8");
  const entries = [];
  const blockRe = /\{\s*id: ("(?:[^"\\]|\\.)*"),[\s\S]*?title: ("(?:[^"\\]|\\.)*"),[\s\S]*?\}/g;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    entries.push({ guid: JSON.parse(m[1]), title: JSON.parse(m[2]) });
  }

  if (!entries.length) {
    console.error("Could not parse any videos out of js/videos.generated.js.");
    process.exit(1);
  }

  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"))
    : {};
  const comment = overrides._comment;
  delete overrides._comment;

  const stats = { assigned: 0, uncategorized: 0, skippedManual: 0, byCategory: {}, byConfidence: {} };
  const unmatchedTitles = [];

  for (const { guid, title } of entries) {
    const existing = overrides[guid];
    if (existing && !existing._auto) {
      stats.skippedManual++;
      continue;
    }
    if (existing && existing._auto && !RECATEGORIZE) {
      // Already auto-assigned; keep it stable unless asked to redo.
      stats.byCategory[existing.category] = (stats.byCategory[existing.category] || 0) + 1;
      if (existing.category === "uncategorized") stats.uncategorized++;
      else stats.assigned++;
      continue;
    }

    const { category, confidence } = categorize(title);
    stats.byConfidence[confidence] = (stats.byConfidence[confidence] || 0) + 1;

    if (category === "uncategorized") {
      stats.uncategorized++;
      unmatchedTitles.push(title);
    } else {
      stats.assigned++;
    }
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;

    overrides[guid] = {
      _auto: true,
      _title: title, // for human reference when hand-editing
      category,
      level: inferLevel(title),
      tags: tagsFor(title, category),
    };
  }

  const total = entries.length;
  console.log(`Parsed ${total} video(s).`);
  console.log(`  auto-assigned a subject : ${stats.assigned}`);
  console.log(`  left uncategorized      : ${stats.uncategorized}`);
  console.log(`  preserved manual entries: ${stats.skippedManual}`);
  console.log(`\nMatch confidence: ${JSON.stringify(stats.byConfidence)}`);
  console.log("\nBy category:");
  Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k}`));

  if (LIST_UNMATCHED) {
    console.log(`\n=== ${unmatchedTitles.length} UNCATEGORIZED TITLES ===`);
    unmatchedTitles.forEach((t) => console.log(t));
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const out = { _comment: comment, ...overrides };
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote js/overrides.json. Now re-run: node scripts/sync-bunny.js`);
}

main();
