// Pure aggregations for the Dashboard view. No file I/O — server.js reads
// the JSON files and passes them in so these functions can be unit tested
// in isolation.

export const buildDistribution = (individuals = []) => {
  const bands = { A: 0, B: 0, C: 0, D: 0 };
  for (const ind of individuals) {
    const b = ind.confidence;
    if (b in bands) bands[b]++;
  }
  return { bands, total: individuals.length };
};

// Recent evidence ingested across the whole tree. Walks
// kb.confidence_evidence[id].identity[] flattening every entry that has
// an `added_at` timestamp, sorts desc, slices.
export const buildRecentEvidence = ({ kb, individuals, limit = 20 } = {}) => {
  const nameById = new Map((individuals ?? []).map((p) => [p.id, p.name]));
  const all = [];
  const map = kb?.confidence_evidence ?? {};
  for (const [id, entry] of Object.entries(map)) {
    for (const ev of entry?.identity ?? []) {
      if (!ev.added_at) continue;
      all.push({
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: ev.kind ?? "evidence",
        source: ev.source ?? null,
        source_tier: ev.source_tier ?? null,
        added_at: ev.added_at,
      });
    }
  }
  all.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
  return all.slice(0, limit);
};

// Recent finished agent runs from evidence_log. Each individual has at
// most one entry; we sort by searched_at and slice.
export const buildRecentRuns = ({ evidenceLog, individuals, limit = 5 } = {}) => {
  const nameById = new Map((individuals ?? []).map((p) => [p.id, p.name]));
  const entries = Object.entries(evidenceLog ?? {})
    .map(([id, e]) => ({
      individual_id: id,
      individual_name: nameById.get(id) ?? id,
      searched_at: e?.searched_at ?? null,
      search_count: e?.search_count ?? (e?.searches?.length ?? null),
      model: e?.model ?? null,
    }))
    .filter((e) => !!e.searched_at);
  entries.sort((a, b) => (a.searched_at < b.searched_at ? 1 : -1));
  return entries.slice(0, limit);
};

// Evidence Queue: triage worklist. Pulls four signal sources and merges.
//   - decision === "flagged"        (severity: high)
//   - reviewer findings             (severity: high or medium per finding kind)
//   - reresearch_recommended[id]    (severity: medium)
//   - contradictions in stored ev   (severity: medium) — entries with lr<1
export const buildEvidenceQueue = ({ individuals, kb, reviewerFindings, decisions } = {}) => {
  const nameById = new Map((individuals ?? []).map((p) => [p.id, p.name]));
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.individual_id}::${item.kind}::${item.summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const [id, dec] of Object.entries(decisions ?? {})) {
    if (dec?.decision === "flagged") {
      push({
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: "flagged",
        severity: "high",
        summary: dec.note ?? "Flagged for investigation",
      });
    }
  }

  for (const f of reviewerFindings ?? []) {
    const sev = f.severity ?? (/violation|conflict|missing/i.test(f.kind ?? "") ? "high" : "medium");
    push({
      individual_id: f.individual_id,
      individual_name: nameById.get(f.individual_id) ?? f.individual_id,
      kind: f.kind,
      severity: sev,
      summary: f.message ?? f.kind,
    });
  }

  for (const [id, info] of Object.entries(kb?.reresearch_recommended ?? {})) {
    push({
      individual_id: id,
      individual_name: nameById.get(id) ?? id,
      kind: "reresearch_recommended",
      severity: "medium",
      summary: info?.reason ?? "Re-research recommended",
    });
  }

  for (const [id, entry] of Object.entries(kb?.confidence_evidence ?? {})) {
    let conflicts = 0;
    for (const ev of entry?.identity ?? []) {
      if (ev.lr != null && ev.lr < 1) conflicts++;
    }
    if (conflicts > 0) {
      push({
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: "evidence_contradiction",
        severity: "medium",
        summary: `${conflicts} contradicting evidence entr${conflicts === 1 ? "y" : "ies"}`,
      });
    }
  }

  // Severity sort: high → medium → low; stable within tier.
  const order = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return out;
};

// Sources aggregator (Slice 3). Walks every `source` string in the KB's
// confidence_evidence[*].identity[] (and .relationship[]) entries plus the
// search trail of evidenceLog, grouping by URL/title.
//
// Returns:
//   [{ source, tier, citation_count, individuals: [{id, name}], last_cited }]
// grouped under sectionable tiers (1, 2, 3, null). Caller decides how to
// section them on screen.
export const buildSources = ({ kb, evidenceLog = {}, individuals = [] } = {}) => {
  const nameById = new Map(individuals.map((p) => [p.id, p.name]));
  const sources = new Map(); // key: source string

  const touch = ({ source, tier, individualId, when }) => {
    if (!source) return;
    if (!sources.has(source)) {
      sources.set(source, {
        source,
        tier: tier ?? null,
        citation_count: 0,
        individuals: new Map(),
        last_cited: when ?? null,
      });
    }
    const s = sources.get(source);
    s.citation_count++;
    if (tier && !s.tier) s.tier = tier;
    if (individualId && !s.individuals.has(individualId)) {
      s.individuals.set(individualId, nameById.get(individualId) ?? individualId);
    }
    if (when && (!s.last_cited || s.last_cited < when)) s.last_cited = when;
  };

  for (const [id, entry] of Object.entries(kb?.confidence_evidence ?? {})) {
    for (const ev of entry?.identity ?? []) {
      touch({ source: ev.source, tier: ev.source_tier, individualId: id, when: ev.added_at });
    }
    for (const ev of entry?.relationship ?? []) {
      touch({ source: ev.source, tier: ev.source_tier, individualId: id, when: ev.added_at });
    }
  }

  // Search trail: each entry in evidenceLog has searches[] with {source, query}
  for (const [id, entry] of Object.entries(evidenceLog ?? {})) {
    for (const s of entry?.searches ?? []) {
      const url = typeof s === "string" ? s : s?.source ?? s?.url;
      touch({ source: url, tier: 3, individualId: id, when: entry.searched_at });
    }
  }

  return [...sources.values()]
    .map((s) => ({
      ...s,
      individuals: [...s.individuals.entries()].map(([id, name]) => ({ id, name })),
    }))
    .sort((a, b) => b.citation_count - a.citation_count);
};
