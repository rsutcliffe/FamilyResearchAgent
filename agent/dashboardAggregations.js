// Pure aggregations for the Dashboard view. No file I/O — server.js reads
// the JSON files and passes them in so these functions can be unit tested
// in isolation.

// LR lookup helper — keeps aggregators pure (lrTable passed in, never imported).
const lookupLr = (lrTable, kind, claim_kind = "identity") => {
  if (!lrTable || !kind) return null;
  const bucket = claim_kind === "relationship" ? lrTable.sources_relationship : lrTable.sources_identity;
  const entry = bucket?.[kind];
  return entry?.lr_match ?? null;
};

export const buildDistribution = (individuals = []) => {
  const bands = { A: 0, B: 0, C: 0, D: 0 };
  for (const ind of individuals) {
    const b = ind.confidence;
    if (b in bands) bands[b]++;
  }
  return { bands, total: individuals.length };
};

// Recent evidence ingested across the whole tree. Three sources merged:
//   1. kb.confidence_evidence[*].identity[] entries with added_at
//      (Phase 2 stored evidence from accepted citations & ingestion runs)
//   2. evidenceLog[*].searched_at (each agent run = an "evidence ingested"
//      event — the agent extracted research narrative)
//   3. externalSuggestions imported_at (GEDCOM imports populate the tree)
//
// Each entry carries a `category` so the UI can colour/section sensibly:
//   "accepted" | "agent_run" | "gedcom_import"
export const buildRecentEvidence = ({
  kb,
  evidenceLog = {},
  externalSuggestions = {},
  individuals,
  lrTable = null,
  limit = 20,
} = {}) => {
  const nameById = new Map((individuals ?? []).map((p) => [p.id, p.name]));
  const all = [];

  // 1. Phase 2 stored evidence (accepted decisions, ingestion runs).
  //    Walks both identity[] and relationship[] so each row carries its own
  //    claim_kind + per-instance note + LR contribution from the LR table.
  for (const [id, entry] of Object.entries(kb?.confidence_evidence ?? {})) {
    for (const claim_kind of ["identity", "relationship"]) {
      for (const ev of entry?.[claim_kind] ?? []) {
        if (!ev.added_at) continue;
        all.push({
          category: "accepted",
          individual_id: id,
          individual_name: nameById.get(id) ?? id,
          kind: ev.kind ?? "evidence",
          source: ev.source ?? null,
          source_tier: ev.source_tier ?? null,
          note: ev.note ?? null,
          claim_kind,
          lr_match: lookupLr(lrTable, ev.kind, claim_kind),
          added_at: ev.added_at,
        });
      }
    }
  }

  // 2. Agent runs
  for (const [id, e] of Object.entries(evidenceLog ?? {})) {
    if (!e?.searched_at) continue;
    all.push({
      category: "agent_run",
      individual_id: id,
      individual_name: nameById.get(id) ?? id,
      kind: "agent_run",
      source: e.model ?? "agent",
      source_tier: null,
      added_at: e.searched_at,
      search_count: e.search_count ?? (e.searches?.length ?? null),
    });
  }

  // 3. GEDCOM imports — earliest only (one event per individual import)
  const seenImports = new Set();
  for (const [id, sugs] of Object.entries(externalSuggestions?.by_individual ?? {})) {
    for (const sug of sugs ?? []) {
      const when = sug?.imported_at;
      if (!when) continue;
      const key = `${id}::${sug.external_source_file ?? ""}`;
      if (seenImports.has(key)) continue;
      seenImports.add(key);
      all.push({
        category: "gedcom_import",
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: "gedcom_import",
        source: sug.external_source_file ?? "GEDCOM",
        source_tier: 3,
        added_at: when,
      });
      break;
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

// Evidence Queue: triage worklist. Merges four signal sources, normalises
// the reviewer's severity vocabulary (`warning`/`info`/`error`) onto a
// shared scale, and collapses repeated reviewer findings of the same
// `kind` into one grouped row so the queue isn't flooded.
//
// Item shape:
//   {
//     individual_id, individual_name, kind, severity,
//     summary, group?: { count, sample_ids, sample_names }
//   }
//
// Severity scale (high → medium → low) — used for sorting + UI pill colour:
//   - error / chronology_violation / contradiction → "high" (red)
//   - warning / flagged decision                   → "medium" (amber)
//   - info / reresearch / housekeeping             → "low" (grey)
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const normaliseSeverity = (raw, kind = "") => {
  const s = String(raw ?? "").toLowerCase();
  if (s === "error" || s === "high") return "high";
  if (/violation|conflict|too_young|too_old|before_birth|impossible|implausible/.test(kind)) return "high";
  if (s === "warning" || s === "medium") return "medium";
  if (s === "info" || s === "low") return "low";
  return "medium";
};

// Reviewer findings whose `kind` we always want to collapse rather than
// emit one row per individual. Currently just high_band_no_evidence
// (which fires on every A/B individual without an agent run — typical
// is dozens to hundreds in a freshly-imported tree).
const COLLAPSIBLE_KINDS = new Set(["high_band_no_evidence"]);

export const buildEvidenceQueue = ({ individuals, kb, reviewerFindings, decisions } = {}) => {
  const nameById = new Map((individuals ?? []).map((p) => [p.id, p.name]));
  const out = [];

  // 1. Flagged decisions
  for (const [id, dec] of Object.entries(decisions ?? {})) {
    if (dec?.decision === "flagged") {
      out.push({
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: "flagged",
        severity: "medium",
        summary: dec.note ?? "Flagged for investigation",
      });
    }
  }

  // 2. Reviewer findings — split into "collapsible" vs "individual"
  const collapsible = new Map(); // kind → { items, severity }
  for (const f of reviewerFindings ?? []) {
    const sev = normaliseSeverity(f.severity, f.kind);
    if (COLLAPSIBLE_KINDS.has(f.kind)) {
      if (!collapsible.has(f.kind)) collapsible.set(f.kind, { severity: sev, items: [] });
      collapsible.get(f.kind).items.push({
        individual_id: f.individual_id,
        individual_name: nameById.get(f.individual_id) ?? f.individual_id,
        message: f.message,
      });
    } else {
      out.push({
        individual_id: f.individual_id,
        individual_name: nameById.get(f.individual_id) ?? f.individual_id,
        kind: f.kind,
        severity: sev,
        summary: f.message ?? f.kind,
      });
    }
  }
  // Emit one grouped row per collapsible kind
  for (const [kind, group] of collapsible.entries()) {
    out.push({
      individual_id: null,
      individual_name: `${group.items.length} individual${group.items.length === 1 ? "" : "s"}`,
      kind,
      severity: group.severity,
      summary:
        kind === "high_band_no_evidence"
          ? `${group.items.length} individuals at band A/B with no agent run yet — research these to lock in a Bayesian-grade band.`
          : `${group.items.length} occurrences of ${kind.replace(/_/g, " ")}.`,
      group: {
        count: group.items.length,
        sample_ids: group.items.slice(0, 5).map((i) => i.individual_id),
        sample_names: group.items.slice(0, 5).map((i) => i.individual_name),
      },
    });
  }

  // 3. Re-research recommended
  for (const [id, info] of Object.entries(kb?.reresearch_recommended ?? {})) {
    out.push({
      individual_id: id,
      individual_name: nameById.get(id) ?? id,
      kind: "reresearch_recommended",
      severity: "low",
      summary: info?.reason ?? "Re-research recommended",
    });
  }

  // 4. Stored-evidence contradictions. Surface the most-recent contradicting
  //    entry as triggered_by so the queue row tells the user *which* source
  //    raised the alarm, not just that something contradicts.
  for (const [id, entry] of Object.entries(kb?.confidence_evidence ?? {})) {
    const contradicting = [];
    for (const ev of entry?.identity ?? []) {
      if (ev.lr != null && ev.lr < 1) contradicting.push(ev);
    }
    if (contradicting.length > 0) {
      const latest = contradicting.slice().sort(
        (a, b) => (a.added_at < b.added_at ? 1 : -1),
      )[0];
      out.push({
        individual_id: id,
        individual_name: nameById.get(id) ?? id,
        kind: "evidence_contradiction",
        severity: "high",
        summary: `${contradicting.length} contradicting evidence entr${contradicting.length === 1 ? "y" : "ies"}`,
        triggered_by: {
          source: latest.source ?? null,
          source_tier: latest.source_tier ?? null,
          kind: latest.kind ?? null,
          note: latest.note ?? null,
        },
      });
    }
  }

  out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  return out;
};

// Sources catalogue (Slice 3, rev 2). Replaces the earlier "everything is
// a source" aggregator with three honestly-labeled categories:
//
//   archive_citations  — structured GEDCOM citations from imported trees.
//     These reference real archives (TNA, GRO, parish offices, etc.).
//     Grouped by the citation's `page` text (repository + reference).
//
//   accepted_citations — citations the user has accepted via the Accept
//     Match flow (Phase 2 evidence in kb.confidence_evidence). Currently
//     empty in most installs but the wiring is here.
//
//   search_trail       — search queries the agent ran. NOT sources; we
//     surface them so the user can see what's already been tried, but
//     under a clearly-labeled section so they aren't mistaken for cited
//     evidence.
//
// Each item: { source, source_id?, tier, citation_count, individuals: [{id, name}],
//              last_cited, sample?, contexts: [{ individual_id, individual_name, note,
//                                                 claim_kind, lr_match, added_at }] }
const accumulator = (nameById) => {
  const map = new Map();
  return {
    touch: ({ key, source, sourceId, tier, individualId, when, sample, note, claim_kind, lr_match }) => {
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          source,
          source_id: sourceId ?? null,
          tier: tier ?? null,
          citation_count: 0,
          individuals: new Map(),
          last_cited: when ?? null,
          sample: sample ?? null,
          contexts: [],
        });
      }
      const s = map.get(key);
      s.citation_count++;
      if (tier && !s.tier) s.tier = tier;
      if (individualId && !s.individuals.has(individualId)) {
        s.individuals.set(individualId, nameById.get(individualId) ?? individualId);
      }
      if (when && (!s.last_cited || s.last_cited < when)) s.last_cited = when;
      if (sample && !s.sample) s.sample = sample;
      // Per-touch context — one row per cite occurrence so the UI can show
      // which individual + what note + what claim + what LR each cite carries.
      s.contexts.push({
        individual_id: individualId ?? null,
        individual_name: individualId ? (nameById.get(individualId) ?? individualId) : null,
        note: note ?? null,
        claim_kind: claim_kind ?? null,
        lr_match: lr_match ?? null,
        added_at: when ?? null,
      });
    },
    finalize: () =>
      [...map.values()]
        .map((s) => ({
          ...s,
          individuals: [...s.individuals.entries()].map(([id, name]) => ({ id, name })),
        }))
        .sort((a, b) => b.citation_count - a.citation_count),
  };
};

export const buildSourcesCatalog = ({
  kb,
  evidenceLog = {},
  externalSuggestions = {},
  individuals = [],
  lrTable = null,
} = {}) => {
  const nameById = new Map(individuals.map((p) => [p.id, p.name]));

  // 1. Archive citations from GEDCOM imports — group by `page` (the
  //    human-readable repository + reference).
  const arch = accumulator(nameById);
  const bi = externalSuggestions?.by_individual ?? {};
  for (const [individualId, suggestions] of Object.entries(bi)) {
    for (const sug of suggestions ?? []) {
      const cits = sug?.external_data?.citations ?? [];
      for (const c of cits) {
        const page = (c?.page ?? "").trim();
        if (!page) continue;
        arch.touch({
          key: page,
          source: page,
          sourceId: c?.source_id ?? null,
          tier: 2, // database extract / archive index — Tier 2 baseline
          individualId,
          when: sug.imported_at ?? null,
          note: c?.note ?? null,
          claim_kind: "archive_citation",
          lr_match: null, // archive citations aren't yet decision-accepted, so no LR contribution
        });
      }
    }
  }

  // 2. Accepted citations — Phase 2 evidence with source_kind=decision_accept.
  const acc = accumulator(nameById);
  for (const [individualId, entry] of Object.entries(kb?.confidence_evidence ?? {})) {
    for (const claim_kind of ["identity", "relationship"]) {
      for (const ev of entry?.[claim_kind] ?? []) {
        if (ev?.source_kind !== "decision_accept") continue;
        const key = ev.source ?? ev.note ?? ev.kind;
        acc.touch({
          key,
          source: ev.source ?? ev.note ?? ev.kind,
          tier: ev.source_tier ?? 1,
          individualId,
          when: ev.added_at ?? null,
          sample: ev.note ?? null,
          note: ev.note ?? null,
          claim_kind,
          lr_match: lookupLr(lrTable, ev.kind, claim_kind),
        });
      }
    }
  }

  // 3. Search trail — clearly labeled queries, not sources.
  const trail = accumulator(nameById);
  for (const [individualId, entry] of Object.entries(evidenceLog ?? {})) {
    for (const s of entry?.searches ?? []) {
      const q = typeof s === "string" ? s : (s?.query ?? s?.source ?? s?.url ?? "");
      if (!q) continue;
      trail.touch({
        key: q,
        source: q,
        tier: null,
        individualId,
        when: entry.searched_at ?? null,
        note: typeof s === "string" ? null : (s?.note ?? null),
        claim_kind: "search_query",
        lr_match: null,
      });
    }
  }

  return {
    archive_citations: arch.finalize(),
    accepted_citations: acc.finalize(),
    search_trail: trail.finalize(),
  };
};

// Back-compat shim — keep the old `buildSources` shape so any existing
// callers (server.js, tests) that import it keep working until they're
// migrated. Returns just the archive_citations as the canonical sources
// list. New callers should use buildSourcesCatalog directly.
export const buildSources = (args) => {
  const cat = buildSourcesCatalog(args);
  return cat.archive_citations;
};
