// Phase 2 — derive the merged evidence list for an individual at read time.
//
// Three sources, blended into one identity array and one relationship array:
//   1. Stored evidence in kb.confidence_evidence[id] — populated when the
//      user accepts a match (Phase 2 wiring on applyAcceptedMatchToKb).
//   2. Reviewer findings affecting this individual — translated to negative
//      LR entries via the reviewer_findings block in confidence_lrs.json.
//      Re-derived every read so dismissed findings disappear automatically.
//   3. External suggestions (WikiTree/FamilySearch/GEDCOM matches) — Tier 3
//      identity contributions. TNA catalogue refs deliberately excluded
//      (they're pointers, not person matches).
//
// Pure function. No I/O.

import { loadLrTable } from "./confidence.js";

const reviewerFindingToEvidence = (finding, lrTable) => {
  const def = lrTable.reviewer_findings?.[finding.kind];
  if (!def) return null;
  return {
    kind: finding.kind,
    lr: def.lr_against,
    source_tier: null,
    source_kind: "reviewer",
    note: finding.message,
    domain: def.applies_to,
  };
};

const externalSuggestionToEvidence = (sugg, lrTable) => {
  const map = {
    wikitree: "wikitree_profile",
    familysearch: "familysearch_tree_match",
    gedcom: "member_family_tree",
  };
  // Pre-Phase-1 entries don't carry source_kind. Default to "gedcom" since
  // they all came from the original GEDCOM imports.
  const sourceKind = sugg.source_kind ?? "gedcom";
  const kind = map[sourceKind];
  if (!kind) return null; // TNA / unknown — not identity evidence
  const def = lrTable.sources_identity?.[kind];
  if (!def) return null;
  return {
    kind,
    lr: def.lr_match,
    source_tier: def.tier,
    source_kind: "external_suggestion",
    note: sugg.external_id ? `from ${sourceKind}: ${sugg.external_id}` : `from ${sourceKind}`,
    evidence_group: sugg.external_id ? `ext_${sourceKind}_${sugg.external_id}` : undefined,
  };
};

export const deriveConfidenceEvidence = ({
  id,
  kb,
  reviewerFindings = [],
  externalSuggestions,
} = {}) => {
  const lrTable = loadLrTable();
  const identity = [];
  const relationship = [];

  // 1. Stored evidence
  const stored = kb?.confidence_evidence?.[id];
  if (stored?.identity) identity.push(...stored.identity);
  if (stored?.relationship) relationship.push(...stored.relationship);

  // 2. Reviewer findings affecting this individual
  for (const f of reviewerFindings) {
    if (f.individual_id !== id) continue;
    const ev = reviewerFindingToEvidence(f, lrTable);
    if (!ev) continue;
    if (ev.domain === "relationship") relationship.push(ev);
    else identity.push(ev);
  }

  // 3. External suggestions
  const externals = externalSuggestions?.by_individual?.[id] ?? [];
  for (const sugg of externals) {
    const ev = externalSuggestionToEvidence(sugg, lrTable);
    if (ev) identity.push(ev);
  }

  return { identity, relationship };
};
