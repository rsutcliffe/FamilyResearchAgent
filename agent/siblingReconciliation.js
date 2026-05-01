// Sibling reconciliation — count independent corroborations of a family's
// parental link by counting siblings whose record-discovery agent runs
// reached an "accepted" decision.
//
// Logic: every accepted decision means the user confirmed the agent's
// match for that sibling against a primary or indexed source. That source
// typically names the parents (baptism record: "John, son of William and
// Mary"; birth certificate: father's + mother's full name). So each
// accepted sibling is one independent corroboration of the parental link.
//
// v1 doesn't parse the source tier from the run text — that's a v2
// refinement. v1 just counts accepted siblings:
//   0 accepted    → "none"     (no corroboration yet)
//   1 accepted    → "weak"     (one source naming the parents)
//   2+ accepted   → "strong"   (independent multi-source corroboration)
//
// Pure function. Returns null if familyId not found.

export const reconcileSiblings = ({
  familyId,
  individuals = [],
  families = [],
  evidenceLog = {},
  decisions = {},
}) => {
  const fam = families.find((f) => f.id === familyId);
  if (!fam) return null;

  const byId = new Map(individuals.map((p) => [p.id, p]));
  const childIds = fam.children ?? [];

  const siblings = childIds.map((id) => {
    const p = byId.get(id);
    const ev = evidenceLog[id];
    const dec = decisions[id];
    return {
      id,
      name: p?.name ?? "(unknown)",
      birth_year: p?.birth_year ?? null,
      researched: !!ev?.runs?.length,
      run_count: ev?.runs?.length ?? 0,
      decision: dec?.action ?? null,
    };
  });

  const researched = siblings.filter((s) => s.researched).map((s) => s.id);
  const unresearched = siblings.filter((s) => !s.researched).map((s) => s.id);
  const acceptedCount = siblings.filter((s) => s.decision === "accepted").length;

  let strength = "none";
  if (acceptedCount === 1) strength = "weak";
  else if (acceptedCount >= 2) strength = "strong";

  return {
    family_id: familyId,
    total_siblings: siblings.length,
    researched,
    unresearched,
    accepted_count: acceptedCount,
    corroboration_strength: strength,
    siblings,
  };
};
