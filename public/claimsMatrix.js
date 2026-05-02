// Pure helpers for the Claims & Evidence Matrix and Confidence Donut.
// Imported both from the browser (tree.js detail panel) and from
// Node tests (tests/unit/claimsMatrix.test.js). No DOM access.

// Map a confidence-LR `kind` to a human-facing claim category. Civil BMD
// certificates can back birth/marriage/death — we surface them under
// "Vital records" rather than guess. The Claims Matrix shows one row
// per non-empty category, in this order:
const CLAIM_ORDER = [
  "Birth / Baptism",
  "Marriage",
  "Census / Residence",
  "Death / Burial",
  "Vital records",
  "Tree corroboration",
  "Other",
];

const KIND_TO_CLAIM = {
  parish_baptism: "Birth / Baptism",
  baptism_naming_parents: "Birth / Baptism",
  parish_marriage: "Marriage",
  marriage_naming_father: "Marriage",
  parish_burial: "Death / Burial",
  burial_naming_relative: "Death / Burial",
  will_or_probate: "Death / Burial",
  memorial_inscription: "Death / Burial",
  newspaper_obituary: "Death / Burial",
  census_record: "Census / Residence",
  census_household_relationship: "Census / Residence",
  civil_bmd_certificate: "Vital records",
  civil_bmd_index: "Vital records",
  civil_bmd_certificate_naming: "Vital records",
  parish_register_index: "Vital records",
  newspaper_announcement: "Vital records",
  wikitree_profile: "Tree corroboration",
  wikitree_profile_naming: "Tree corroboration",
  familysearch_tree_match: "Tree corroboration",
  member_family_tree: "Tree corroboration",
  member_family_tree_naming: "Tree corroboration",
  sibling_baptism_naming_same: "Birth / Baptism",
  story_corroboration: "Tree corroboration",
  story_contradiction: "Tree corroboration",
  tna_catalogue_ref: "Other",
};

export const categorizeKind = (kind) => KIND_TO_CLAIM[kind] ?? "Other";

// Status pill rules:
// - confirmed   = the user has accepted a decision for this individual
// - corroborated = ≥2 independent contributions in the row, all supporting (lr>1)
// - verified    = exactly 1 supporting contribution and it's Tier 1
// - conflicting = any contribution with lr<1 OR a reviewer finding lands
//                 in this category
// - (none)      = otherwise — a single non-Tier-1 supporting contribution
const computeStatus = ({ rows, decision }) => {
  const conflicting = rows.some((c) => c.lr < 1 || c.source_kind === "reviewer");
  if (conflicting) return "conflicting";
  if (decision === "accepted") return "confirmed";
  const supports = rows.filter((c) => c.lr > 1);
  if (supports.length >= 2) return "corroborated";
  if (supports.length === 1 && supports[0].source_tier === 1) return "verified";
  return null;
};

// Source-weight bar: each row has a stack of tier-coloured segments whose
// widths reflect the share of |log_lr| from each tier within the row.
// Empty (lr=1) contributions don't appear; a row of all reviewer findings
// (no tier) shows a flat conflicting bar.
const computeWeights = (rows) => {
  const totals = { 1: 0, 2: 0, 3: 0, x: 0 };
  for (const r of rows) {
    const w = Math.abs(r.log_lr ?? Math.log10(r.lr ?? 1));
    if (!w) continue;
    if (r.source_tier === 1) totals[1] += w;
    else if (r.source_tier === 2) totals[2] += w;
    else if (r.source_tier === 3) totals[3] += w;
    else totals.x += w;
  }
  const sum = totals[1] + totals[2] + totals[3] + totals.x;
  if (!sum) return [];
  return [
    { tier: 1, fraction: totals[1] / sum },
    { tier: 2, fraction: totals[2] / sum },
    { tier: 3, fraction: totals[3] / sum },
  ].filter((s) => s.fraction > 0);
};

// One-line summary of the strongest contribution, used as the "Details"
// column in the matrix.
const summarise = (rows) => {
  if (!rows.length) return "";
  const strongest = [...rows].sort(
    (a, b) => Math.abs(b.log_lr ?? 0) - Math.abs(a.log_lr ?? 0),
  )[0];
  if (strongest.note) return strongest.note;
  return strongest.kind.replace(/_/g, " ");
};

// Group contributions by claim category and produce one row per category.
// `contributions` shape: result.contributions[] from /api/confidence/:id
// `decision` is the individual's decision state ("accepted" | "flagged" | etc.)
export const buildClaimsMatrix = ({ contributions = [], decision = null } = {}) => {
  const byClaim = new Map();
  for (const c of contributions) {
    const claim = categorizeKind(c.kind);
    if (!byClaim.has(claim)) byClaim.set(claim, []);
    byClaim.get(claim).push(c);
  }
  const out = [];
  for (const claim of CLAIM_ORDER) {
    const rows = byClaim.get(claim);
    if (!rows?.length) continue;
    out.push({
      claim,
      details: summarise(rows),
      weights: computeWeights(rows),
      status: computeStatus({ rows, decision }),
      contribution_count: rows.length,
    });
  }
  return out;
};

// One-sentence interpretation under the donut. Heuristic, not LLM.
export const interpretBand = ({ band, posterior, contributions = [] } = {}) => {
  const conflicts = contributions.filter((c) => c.lr < 1 || c.source_kind === "reviewer").length;
  const supports = contributions.filter((c) => c.lr > 1).length;
  const pct = posterior != null ? `${(posterior * 100).toFixed(1)}%` : null;
  let lead;
  if (band === "A") lead = "High-probability match";
  else if (band === "B") lead = "Probable match";
  else if (band === "C") lead = "Uncertain — more evidence needed";
  else lead = "Unverified — primary records not yet found";
  const tail =
    conflicts > 0
      ? ` ${conflicts} conflict${conflicts === 1 ? "" : "s"} flagged.`
      : supports > 0
      ? ` ${supports} supporting source${supports === 1 ? "" : "s"}.`
      : "";
  return pct ? `${lead} (${pct}).${tail}` : `${lead}.${tail}`;
};

// SVG donut markup. r=44 in a 100-viewport gives a 4px stroke-equivalent
// at 16px font. Returns a string so callers can drop it into innerHTML.
export const renderDonut = ({ band, posterior } = {}) => {
  const pct = Math.max(0, Math.min(1, posterior ?? 0));
  const C = 2 * Math.PI * 44;
  const dash = pct * C;
  const colour =
    band === "A" ? "#2e7d32" :
    band === "B" ? "#1565c0" :
    band === "C" ? "#bf6f00" :
    band === "D" ? "#c00000" : "#6b7280";
  const pctLabel = posterior != null ? `${(pct * 100).toFixed(1)}%` : "";
  return `
    <svg class="wb-donut" viewBox="0 0 100 100" role="img" aria-label="Confidence ${band ?? "?"} ${pctLabel}">
      <circle cx="50" cy="50" r="44" fill="none" stroke="#ececf0" stroke-width="8" />
      <circle cx="50" cy="50" r="44" fill="none" stroke="${colour}" stroke-width="8"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${C / 4}"
        transform="rotate(-90 50 50)" stroke-linecap="round" />
      <text x="50" y="48" text-anchor="middle" font-size="22" font-weight="700" fill="#1a1f2c">${band ?? "?"}</text>
      <text x="50" y="66" text-anchor="middle" font-size="10" fill="#6b7280">${pctLabel}</text>
    </svg>
  `;
};

// Linear band scale E-D-C-B-A with the active band filled. Used under
// the donut.
export const renderBandScale = ({ band } = {}) => {
  const order = ["E", "D", "C", "B", "A"];
  return `
    <div class="wb-band-scale" aria-hidden="true">
      ${order
        .map(
          (b) =>
            `<div class="wb-band-scale-cell ${b === band ? "active" : ""}">${b}</div>`,
        )
        .join("")}
    </div>
  `;
};
