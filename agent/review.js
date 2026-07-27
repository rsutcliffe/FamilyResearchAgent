// Pure review functions — no I/O, no LLM calls.
import { reviewTree } from "./reviewer.js";

// Reviewer finding kinds that implicate a specific parent-child relationship,
// and which role in the family (husband|wife) is the parent.
const KIND_TO_PARENT_ROLE = {
  mother_born_after_child: "wife",
  mother_too_young_at_birth: "wife",
  mother_too_old_at_birth: "wife",
  father_born_after_child: "husband",
  father_too_old_at_birth: "husband",
};

const severityRank = (entry) => {
  if (entry.findings.some((f) => f.severity === "error")) return 0;
  if (entry.findings.some((f) => f.severity === "warning")) return 1;
  return 2;
};

export function getUnconfirmedHighConfidence({ individuals, decisions }) {
  return individuals
    .filter(
      (p) =>
        (p.confidence === "A" || p.confidence === "B") &&
        decisions[p.id]?.decision !== "accepted",
    )
    .sort((a, b) => {
      if (a.confidence !== b.confidence)
        return a.confidence === "A" ? -1 : 1;
      return (a.generation ?? 9999) - (b.generation ?? 9999);
    });
}

export function getWeakLinks({ individuals, families, relationships, evidenceLog }) {
  const byId = new Map(individuals.map((p) => [p.id, p]));
  const famById = new Map(families.map((f) => [f.id, f]));
  const relById = new Map(relationships.map((r) => [r.id, r]));

  // keyed by relationship ID
  const result = new Map();

  const upsert = (relId, patch) => {
    if (!result.has(relId)) result.set(relId, { ...patch, findings: [] });
    else Object.assign(result.get(relId), patch);
  };

  // 1. Reviewer findings that point to a specific parent-child link
  const findings = reviewTree({ individuals, families, evidenceLog });
  for (const f of findings) {
    const parentRole = KIND_TO_PARENT_ROLE[f.kind];
    if (!parentRole || !f.family_id || !f.individual_id) continue;

    const fam = famById.get(f.family_id);
    if (!fam) continue;
    const parentId = fam[parentRole];
    if (!parentId) continue;

    const relId = `${f.family_id}-${parentId}-${f.individual_id}`;
    const rel = relById.get(relId);

    upsert(relId, {
      relationship_id: relId,
      family_id: f.family_id,
      parent_id: parentId,
      parent_name: byId.get(parentId)?.name ?? parentId,
      child_id: f.individual_id,
      child_name: byId.get(f.individual_id)?.name ?? f.individual_id,
      kind: parentRole === "wife" ? "mother" : "father",
      confidence: rel?.confidence ?? null,
      is_disputed: rel?.disputed ?? false,
      dispute_reason: rel?.dispute_reason ?? null,
    });
    result.get(relId).findings.push({ severity: f.severity, message: f.message });
  }

  // 2. D-band relationships not already captured above
  for (const rel of relationships) {
    if (rel.confidence !== "D") continue;
    if (result.has(rel.id)) {
      result.get(rel.id).confidence = rel.confidence;
      result.get(rel.id).is_disputed = rel.disputed ?? false;
      result.get(rel.id).dispute_reason = rel.dispute_reason ?? null;
      continue;
    }
    upsert(rel.id, {
      relationship_id: rel.id,
      family_id: rel.family_id,
      parent_id: rel.parent_id,
      parent_name: byId.get(rel.parent_id)?.name ?? rel.parent_id,
      child_id: rel.child_id,
      child_name: byId.get(rel.child_id)?.name ?? rel.child_id,
      kind: rel.kind,
      confidence: rel.confidence,
      is_disputed: rel.disputed ?? false,
      dispute_reason: rel.dispute_reason ?? null,
    });
  }

  return [...result.values()].sort((a, b) => severityRank(a) - severityRank(b));
}
