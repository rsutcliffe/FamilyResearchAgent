// Bayesian confidence accumulator. Phase 1 of the Bayesian-network
// confidence model: a pure function that takes a prior + a list of
// evidence entries and returns the posterior, band, and per-contribution
// audit trail. No integration with read/write sites yet — that's Phase 2.
//
// Architecture (borrowed from NHS PDS-MPI matching, with adaptations for
// genealogy):
//   - Each evidence entry carries a likelihood ratio (LR). Default LRs
//     come from data/confidence_lrs.json, but callers can override per-
//     entry.
//   - Multiplicative accumulation in LOG-ODDS space for numerical safety
//     (a stack of strong evidence would otherwise overflow odds quickly).
//   - Non-independence handled via `evidence_group`: entries sharing a
//     group are collapsed to the most extreme LR (correlated sources
//     can't be multiplied; the strongest captures the joint signal).
//   - Bands derived from posterior probability via configurable
//     thresholds (defaults: A ≥ 0.95, B ≥ 0.80, C ≥ 0.50, else D).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LR_TABLE_PATH = path.join(__dirname, "..", "data", "confidence_lrs.json");

let cachedTable = null;
export const loadLrTable = () => {
  if (cachedTable) return cachedTable;
  cachedTable = JSON.parse(fs.readFileSync(LR_TABLE_PATH, "utf8"));
  return cachedTable;
};

export const __resetLrTableCacheForTests = () => {
  cachedTable = null;
};

// Look up the default LR for a (kind, direction, domain) triple.
//   direction: "match" | "no_match"
//   domain:    "identity" | "relationship"
// Returns null if the kind isn't in the table — callers must decide a
// default rather than getting a silent surprise value.
export const lookupLr = ({ kind, direction = "match", domain = "identity" } = {}) => {
  const table = loadLrTable();
  const bucket = domain === "relationship" ? table.sources_relationship : table.sources_identity;
  const entry = bucket?.[kind];
  if (!entry) return null;
  return direction === "no_match" ? entry.lr_no_match : entry.lr_match;
};

// Probability ↔ odds helpers. Defined on (0, 1) and (0, ∞).
export const probabilityToOdds = (p) => {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return p / (1 - p);
};

export const oddsToProbability = (odds) => {
  if (!Number.isFinite(odds)) return 1;
  if (odds <= 0) return 0;
  return odds / (1 + odds);
};

const DEFAULT_THRESHOLDS = { A: 0.95, B: 0.80, C: 0.50 };

export const bandFromPosterior = (p, thresholds = DEFAULT_THRESHOLDS) => {
  if (p >= thresholds.A) return "A";
  if (p >= thresholds.B) return "B";
  if (p >= thresholds.C) return "C";
  return "D";
};

// Deduplicate by evidence_group: within each group, keep the entry whose
// LR is most informative — i.e. the one with the largest |log(lr)|.
// Solo entries (no group) all survive as independent contributions.
// Preserves input order so callers see the audit trail in the same order
// they supplied it.
const collapseByGroup = (evidence) => {
  // First pass: pick the winner for each group.
  const winners = new Map();
  for (const e of evidence) {
    if (!e.evidence_group) continue;
    const lr = e.lr ?? 1.0;
    const score = Math.abs(Math.log(lr || 1e-9));
    const prev = winners.get(e.evidence_group);
    if (!prev || score > prev.score) {
      winners.set(e.evidence_group, { entry: e, score });
    }
  }
  // Second pass: walk in original order, emit solos and group-winners only.
  const seen = new Set();
  const out = [];
  for (const e of evidence) {
    if (!e.evidence_group) {
      out.push(e);
      continue;
    }
    if (seen.has(e.evidence_group)) continue;
    if (winners.get(e.evidence_group)?.entry !== e) continue;
    seen.add(e.evidence_group);
    out.push(e);
  }
  return out;
};

export const accumulateConfidence = ({
  priorOdds,
  priorProbability,
  evidence = [],
  thresholds = DEFAULT_THRESHOLDS,
} = {}) => {
  const table = (() => {
    try {
      return loadLrTable();
    } catch {
      return { default_prior_probability: 0.15 };
    }
  })();

  const startProb = priorOdds != null
    ? oddsToProbability(priorOdds)
    : priorProbability ?? table.default_prior_probability ?? 0.15;
  const startOdds = priorOdds ?? probabilityToOdds(startProb);

  const collapsed = collapseByGroup(evidence);

  // Accumulate in log-space so a chain of strong evidence doesn't overflow.
  let logOdds = startOdds === 0 ? -Infinity : Math.log(startOdds);
  const contributions = [];
  for (const e of collapsed) {
    const lr = e.lr ?? 1.0;
    if (lr <= 0) {
      logOdds = -Infinity;
      contributions.push({ ...stripped(e), log_lr: -Infinity });
      continue;
    }
    const dl = Math.log(lr);
    logOdds += dl;
    contributions.push({ ...stripped(e), log_lr: dl });
  }

  const posteriorOdds = Number.isFinite(logOdds) ? Math.exp(logOdds) : (logOdds < 0 ? 0 : Infinity);
  const posterior = oddsToProbability(posteriorOdds);

  return {
    prior: startProb,
    prior_odds: startOdds,
    posterior,
    posterior_odds: posteriorOdds,
    posterior_log_odds: logOdds,
    band: bandFromPosterior(posterior, thresholds),
    contributions,
    thresholds,
  };
};

const stripped = (e) => ({
  kind: e.kind,
  source_tier: e.source_tier,
  lr: e.lr,
  evidence_group: e.evidence_group,
  ...(e.note ? { note: e.note } : {}),
  ...(e.source ? { source: e.source } : {}),
});
