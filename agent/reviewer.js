// Deterministic tree reviewer / contradiction-detector.
//
// Pure function — reads individuals, families, and evidence_log; returns an
// array of findings. No LLM, no I/O. Safe to run on every page load.
//
// Each finding shape:
//   { severity: "error" | "warning" | "info",
//     kind: machine-readable category,
//     individual_id?, family_id?,
//     message: human-readable description,
//     evidence: { ...context },
//   }
//
// Categories implemented in v1:
//   age-gap:         mother_born_after_child, mother_too_young_at_birth,
//                    mother_too_old_at_birth, father_too_old_at_birth,
//                    father_born_after_child
//   chronology:      siblings_too_close, death_before_birth, lifespan_implausible
//   evidence:        high_band_no_evidence
//   data integrity:  famc_dangling, child_dangling

const MIN_MOTHER_AGE = 13;
const MAX_MOTHER_AGE = 50;
const MAX_FATHER_AGE = 70;
const MAX_LIFESPAN = 110;
const MIN_SIBLING_GAP = 1; // years; same-year same-mother flagged

const yearFromText = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 100 && y <= 2200 ? y : null;
};

const fmt = (id, byId) => {
  const p = byId.get(id);
  return p ? `${p.name} (b.${p.birth_year ?? "?"})` : `(${id})`;
};

export const reviewTree = ({ individuals = [], families = [], evidenceLog = {} } = {}) => {
  const findings = [];
  const byId = new Map(individuals.map((p) => [p.id, p]));
  const famById = new Map(families.map((f) => [f.id, f]));

  // 1. Age-gap checks: per family with children, compare each parent's
  //    birth_year against each child's birth_year.
  for (const fam of families) {
    for (const childId of fam.children ?? []) {
      const child = byId.get(childId);
      if (!child?.birth_year) continue;
      for (const role of ["husband", "wife"]) {
        const parentId = fam[role];
        if (!parentId) continue;
        const parent = byId.get(parentId);
        if (!parent?.birth_year) continue;
        const gap = child.birth_year - parent.birth_year;
        const isMother = role === "wife";

        if (gap < 0) {
          findings.push({
            severity: "error",
            kind: isMother ? "mother_born_after_child" : "father_born_after_child",
            individual_id: childId,
            family_id: fam.id,
            message: `${fmt(childId, byId)} listed as child of ${fmt(parentId, byId)} but the parent was born ${Math.abs(gap)} years AFTER the child.`,
            evidence: { parent_birth: parent.birth_year, child_birth: child.birth_year },
          });
        } else if (isMother && gap < MIN_MOTHER_AGE) {
          findings.push({
            severity: "warning",
            kind: "mother_too_young_at_birth",
            individual_id: childId,
            family_id: fam.id,
            message: `${fmt(parentId, byId)} would have been ${gap} at ${fmt(childId, byId)}'s birth — implausibly young.`,
            evidence: { mother_age: gap },
          });
        } else if (isMother && gap > MAX_MOTHER_AGE) {
          findings.push({
            severity: "warning",
            kind: "mother_too_old_at_birth",
            individual_id: childId,
            family_id: fam.id,
            message: `${fmt(parentId, byId)} would have been ${gap} at ${fmt(childId, byId)}'s birth — biologically implausible.`,
            evidence: { mother_age: gap },
          });
        } else if (!isMother && gap > MAX_FATHER_AGE) {
          findings.push({
            severity: "warning",
            kind: "father_too_old_at_birth",
            individual_id: childId,
            family_id: fam.id,
            message: `${fmt(parentId, byId)} would have been ${gap} at ${fmt(childId, byId)}'s birth — possible but worth checking.`,
            evidence: { father_age: gap },
          });
        }
      }
    }
  }

  // 2. Sibling chronology: same family, two children with same birth_year.
  //    v1 flags every same-year pair; user can dismiss twin cases manually.
  for (const fam of families) {
    const kids = (fam.children ?? [])
      .map((id) => byId.get(id))
      .filter((p) => p?.birth_year)
      .sort((a, b) => a.birth_year - b.birth_year);
    for (let i = 1; i < kids.length; i += 1) {
      const gap = kids[i].birth_year - kids[i - 1].birth_year;
      if (gap < MIN_SIBLING_GAP) {
        findings.push({
          severity: "warning",
          kind: "siblings_too_close",
          family_id: fam.id,
          individual_id: kids[i].id,
          message: `${fmt(kids[i].id, byId)} and ${fmt(kids[i - 1].id, byId)} are listed as siblings born the same year. Twins are possible — otherwise verify.`,
          evidence: { gap_years: gap, sibling_id: kids[i - 1].id },
        });
      }
    }
  }

  // 3. Death/lifespan checks
  for (const ind of individuals) {
    const deathYear = yearFromText(ind.death_date);
    if (deathYear == null || ind.birth_year == null) continue;
    if (deathYear < ind.birth_year) {
      findings.push({
        severity: "error",
        kind: "death_before_birth",
        individual_id: ind.id,
        message: `${ind.name} died (${deathYear}) before they were born (${ind.birth_year}).`,
        evidence: { birth_year: ind.birth_year, death_year: deathYear },
      });
    } else if (deathYear - ind.birth_year > MAX_LIFESPAN) {
      findings.push({
        severity: "warning",
        kind: "lifespan_implausible",
        individual_id: ind.id,
        message: `${ind.name} would have lived ${deathYear - ind.birth_year} years (b.${ind.birth_year} d.${deathYear}) — possible but check sources.`,
        evidence: { years: deathYear - ind.birth_year },
      });
    }
  }

  // 4. Confidence vs evidence: band A or B individuals with no evidence_log
  //    entry. Common when an early agent run was confident but the run was
  //    aborted before persistence — or when the band was hand-set.
  for (const ind of individuals) {
    if (ind.confidence !== "A" && ind.confidence !== "B") continue;
    const ev = evidenceLog[ind.id];
    if (ev?.runs?.length) continue;
    findings.push({
      severity: ind.confidence === "A" ? "warning" : "info",
      kind: "high_band_no_evidence",
      individual_id: ind.id,
      message: `${ind.name} is band ${ind.confidence} but has no recorded agent run. Consider running the agent to capture supporting evidence.`,
      evidence: { confidence: ind.confidence },
    });
  }

  // 5. Dangling references
  for (const ind of individuals) {
    if (ind.famc && !famById.has(ind.famc)) {
      findings.push({
        severity: "error",
        kind: "famc_dangling",
        individual_id: ind.id,
        message: `${ind.name}.famc points to ${ind.famc} which doesn't exist.`,
        evidence: { famc: ind.famc },
      });
    }
  }
  for (const fam of families) {
    for (const childId of fam.children ?? []) {
      if (!byId.has(childId)) {
        findings.push({
          severity: "error",
          kind: "child_dangling",
          family_id: fam.id,
          message: `Family ${fam.id}.children includes ${childId} but no such individual exists.`,
          evidence: { missing_id: childId },
        });
      }
    }
  }

  return findings;
};
