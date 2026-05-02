// Research Knowledge Base — read, build per-individual context, write.
// All operations work on a kb object that's read from disk by the caller and
// written back via writeJsonAtomic. This module is pure (no IO) so it's easy
// to test and reason about.

import { lookupLr, loadLrTable } from "./confidence.js";

// Extract a per-person surname from a "Forename Forename Surname" string. The
// GEDCOM parser stripped the // markers so we use the last whitespace-delimited
// token. Handles "Smith-Jones" and similar.
const surnameOf = (name) => {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
};

// Extract a one-line summary of a prior run for the KB context block.
// Looks for the structured Recommendation fields; falls back to a generic
// description if the agent's output didn't conform.
const summariseRun = (run) => {
  const text = run?.agent_result ?? "";
  const date = (run?.searched_at ?? "").slice(0, 10) || "unknown date";
  const searches = run?.search_count ?? 0;
  const stopReason = run?.stop_reason ?? "";
  const stopFlag = stopReason === "search_cap_reached" ? " [hit search cap]" : "";

  const recSplit = text.split(/^##\s+Recommendation\s*$/m);
  const recBlock = recSplit.length > 1 ? recSplit[1] : "";
  const stripBold = (s) => s?.replace(/\*\*/g, "").trim();
  const bandMatch = recBlock.match(
    /Recommended confidence band[:*\s]+\*?\*?\s*(A|B|C|Unchanged)/i,
  );
  const tierMatch = recBlock.match(
    /Source tier[:*\s]+\*?\*?\s*(Tier\s*[12]|N\/?A)/i,
  );
  const citationMatch = recBlock.match(
    /Citation for GEDCOM write-back[:*\s]+\*?\*?\s*([^\n]+)/i,
  );

  const band = bandMatch?.[1] ?? "?";
  const tier = stripBold(tierMatch?.[1]) ?? "";
  const citation = stripBold(citationMatch?.[1]) ?? "";
  const noMatch = !citation || /^none\b/i.test(citation) || /no match/i.test(citation);

  let summary = `${date} — ${searches} searches${stopFlag}, recommended ${band}`;
  if (band !== "?" && band !== "Unchanged" && tier) summary += ` (${tier})`;
  if (!noMatch && citation) summary += `; citation: ${citation.slice(0, 100)}${citation.length > 100 ? "…" : ""}`;
  if (noMatch) summary += "; no Tier 1/2 source retrieved";
  return summary;
};

// Build a YAML-ish KB context block for a target individual. The agent
// reads this from inside <<RESEARCH_KB_CONTEXT>>...<</RESEARCH_KB_CONTEXT>>.
//
// `evidenceLog` is the multi-run evidence_log indexed by individual id; if
// supplied, prior-run summaries are folded in so the agent can build on its
// own history.
export const buildKbContextBody = (
  kb,
  individual,
  families = [],
  individuals = [],
  evidenceLog = {},
) => {
  if (!individual) return EMPTY_KB_BODY;

  const sn = surnameOf(individual.name);
  const parishes = sn ? kb.known_parishes?.[sn] ?? [] : [];

  const naming = (kb.naming_pattern_warnings ?? [])
    .filter((w) => individual.name?.toLowerCase().split(/\s+/).includes(w.name.toLowerCase()));

  // Deduplicate negative searches by source||query (KB may contain
  // duplicates from older builds), then cap to the most recent N to
  // keep prompt input tokens bounded. Persisted KB stays untouched.
  const NEG_SEARCH_PROMPT_CAP = 20;
  const negRaw = (kb.negative_searches ?? []).filter((n) => n.individual_id === individual.id);
  const negSeen = new Set();
  const negDedup = [];
  for (const n of negRaw.slice().reverse()) { // reverse → newest first
    const key = `${n.source}||${n.query}`;
    if (negSeen.has(key)) continue;
    negSeen.add(key);
    negDedup.push(n);
    if (negDedup.length >= NEG_SEARCH_PROMPT_CAP) break;
  }
  const neg = negDedup.reverse(); // back to chronological for display

  // Confirmed relatives: derive from BOTH the FAMC family (parents + siblings)
  // AND any FAMS family (spouse + children). Filtering by confidence A or B
  // keeps the context tight; a weak relative isn't a useful anchor.
  const fromKb = kb.confirmed_relatives?.[individual.id] ?? [];
  const derived = [];

  const pushIfStrong = (id, relationship) => {
    if (!id || id === individual.id) return;
    const other = individuals.find((p) => p.id === id);
    if (!other) return;
    if (other.confidence !== "A" && other.confidence !== "B") return;
    derived.push({
      relative_id: other.id,
      relationship,
      name: other.name,
      birth_year: other.birth_year,
      birth_place: other.birth_place,
      confidence: other.confidence,
    });
  };

  // FAMC: parents + siblings (the +1 direction — older generation)
  if (individual.famc) {
    const fam = families.find((f) => f.id === individual.famc);
    if (fam) {
      pushIfStrong(fam.husband, "father");
      pushIfStrong(fam.wife, "mother");
      for (const sibId of fam.children ?? []) {
        if (sibId !== individual.id) pushIfStrong(sibId, "sibling");
      }
    }
  }

  // FAMS: spouse + children (the -1 direction — younger generation, used for
  // triangulation). A baptism record naming the child is direct evidence
  // for this individual; same with census records showing co-residence.
  for (const fsId of individual.fams ?? []) {
    const fs = families.find((f) => f.id === fsId);
    if (!fs) continue;
    const spouseId = fs.husband === individual.id ? fs.wife : fs.husband;
    pushIfStrong(spouseId, "spouse");
    for (const childId of fs.children ?? []) {
      pushIfStrong(childId, "child");
    }
  }

  // Cap confirmed_relatives at 8 most relevant. Sort: A-band first, then
  // B-band, then unranked; preserve the order within each band as found.
  const RELATIVES_PROMPT_CAP = 8;
  const seen = new Set();
  const allRelatives = [...fromKb, ...derived].filter((r) => {
    if (seen.has(r.relative_id)) return false;
    seen.add(r.relative_id);
    return true;
  });
  const bandRank = (r) =>
    r.confidence === "A" ? 0 : r.confidence === "B" ? 1 : 2;
  const relatives = allRelatives
    .map((r, i) => ({ r, idx: i }))
    .sort((a, b) => {
      const d = bandRank(a.r) - bandRank(b.r);
      return d !== 0 ? d : a.idx - b.idx;
    })
    .map(({ r }) => r)
    .slice(0, RELATIVES_PROMPT_CAP);

  const aliases = kb.alias_registry ?? {};
  const migrations = kb.migration_routes ?? [];

  const yamlEsc = (s) => String(s ?? "").replace(/"/g, '\\"');

  let body = "";

  // Prior runs + prior paid lookups on this individual — first so the agent
  // reads context about what's already been tried before formulating new
  // searches and before suggesting paywalled databases.
  const evEntry = evidenceLog?.[individual.id];
  const priorRuns = Array.isArray(evEntry?.runs) ? evEntry.runs : [];
  const paidLookups = Array.isArray(evEntry?.paid_lookups) ? evEntry.paid_lookups : [];
  body += `prior_runs:\n`;
  if (priorRuns.length > 0) {
    body += `  (${priorRuns.length} prior run${priorRuns.length === 1 ? "" : "s"} on this individual — DO NOT repeat queries listed in negative_searches)\n`;
    for (const run of priorRuns.slice(-5)) {
      // last 5 only, oldest at top
      body += `  - ${summariseRun(run)}\n`;
    }
    // Surface any next-time hypothesis from the most recent run that captured one
    const latest = priorRuns[priorRuns.length - 1];
    if (latest?.next_time_hypothesis) {
      body += `  last_run_hypothesis: "${yamlEsc(latest.next_time_hypothesis)}"\n`;
    }
  } else {
    body += `  (no prior runs on this individual — fresh start)\n`;
  }

  body += `\npaid_lookups_done:\n`;
  if (paidLookups.length > 0) {
    body += `  (the user has already consulted these paywalled sources for this individual — DO NOT suggest them again in <<EXTERNAL_LOOKUPS>>)\n`;
    for (const pl of paidLookups) {
      body += `  - ${yamlEsc(pl.service)} (${pl.outcome}, ${(pl.consulted_at ?? "").slice(0, 10)})${pl.query ? `: ${yamlEsc(pl.query)}` : ""}\n`;
    }
  } else {
    body += `  (no paywalled lookups recorded yet)\n`;
  }

  body += `\nknown_parishes:\n`;
  if (parishes.length) {
    body += `  ${sn}: [${parishes.map((p) => `"${yamlEsc(p)}"`).join(", ")}]\n`;
  } else {
    body += `  (none confirmed for surname "${sn}" yet)\n`;
  }

  body += `\nnaming_pattern_warnings:\n`;
  if (naming.length) {
    for (const w of naming) {
      body += `  - "${yamlEsc(w.name)}" appears ${w.count} times across this family — apply stricter convergence\n`;
    }
  } else {
    body += `  (none triggered for this individual)\n`;
  }

  body += `\nnegative_searches:\n`;
  if (neg.length) {
    for (const n of neg) body += `  - ${yamlEsc(n.source)}||${yamlEsc(n.query)}\n`;
  } else {
    body += `  (none recorded)\n`;
  }

  body += `\nconfirmed_relatives:\n`;
  if (relatives.length) {
    for (const r of relatives) {
      body += `  - gedcom_id: "${yamlEsc(r.relative_id)}"\n`;
      body += `    name: "${yamlEsc(r.name)}"\n`;
      body += `    relationship: ${r.relationship}\n`;
      if (r.birth_year) body += `    birth_year: ${r.birth_year}\n`;
      if (r.birth_place) body += `    birth_place: "${yamlEsc(r.birth_place)}"\n`;
      body += `    confidence: ${r.confidence}\n`;
      if (r.source) body += `    source: "${yamlEsc(r.source)}"\n`;
    }
  } else {
    body += `  (none recorded — this individual has no anchored relatives yet)\n`;
  }

  body += `\nmigration_routes:\n`;
  if (migrations.length) {
    for (const m of migrations) body += `  - "${yamlEsc(m)}"\n`;
  } else {
    body += `  (none recorded)\n`;
  }

  // Source efficacy: ranked summary of which repositories have produced
  // accepted matches across all prior research, plus which sources have
  // returned the most negative results. Helps the agent prioritise.
  body += `\nsource_efficacy:\n`;
  const eff = kb.source_efficacy ?? {};
  const negBySource = {};
  for (const n of kb.negative_searches ?? []) {
    const s = normaliseSource(n.source) ?? n.source;
    if (!s) continue;
    negBySource[s] = (negBySource[s] ?? 0) + 1;
  }
  const allSources = new Set([
    ...Object.keys(eff),
    ...Object.keys(negBySource),
  ]);
  if (allSources.size > 0) {
    const ranked = [...allSources]
      .map((s) => ({
        source: s,
        accepted: eff[s]?.accepted_count ?? 0,
        negatives: negBySource[s] ?? 0,
      }))
      .sort((a, b) => b.accepted - a.accepted || a.negatives - b.negatives);
    for (const r of ranked.slice(0, 12)) {
      body += `  - ${r.source}: ${r.accepted} accepted match${r.accepted === 1 ? "" : "es"}, ${r.negatives} negative result${r.negatives === 1 ? "" : "s"}\n`;
    }
    body += `  (Prioritise sources with high accepted counts. Deprioritise sources with many negatives and zero accepts.)\n`;
  } else {
    body += `  (no efficacy data yet — first runs)\n`;
  }

  // External suggestions for THIS individual — Tier 3 only, explicitly
  // flagged as leads to verify, never authoritative. Sources include
  // imported GEDCOM(s) and live API queries (FamilySearch, WikiTree, TNA
  // Discovery). Each entry is tagged with `source_kind`.
  const extSugg = kb.external_suggestions?.by_individual?.[individual.id] ?? [];
  if (extSugg.length > 0) {
    body += `\nexternal_suggestions:\n`;
    body += `  (Tier 3 — imported from external GEDCOM(s) and queried from external APIs (FamilySearch, WikiTree, TNA Discovery). These are LEADS to verify, not primary evidence. Never raises a band on its own. Use them as hypotheses to investigate via free or paywalled sources. Surface any TNA catalogue refs in <<EXTERNAL_LOOKUPS>>.)\n`;
    for (const m of extSugg) {
      const kind = m.source_kind ?? "gedcom";
      body += `  - source_kind: ${kind}\n`;
      body += `    external_id: "${yamlEsc(m.external_id)}"\n`;

      if (kind === "tna") {
        if (m.catalogue_ref) body += `    catalogue_ref: "${yamlEsc(m.catalogue_ref)}"\n`;
        if (m.title) body += `    title: "${yamlEsc(m.title)}"\n`;
        if (m.held_by) body += `    held_by: "${yamlEsc(m.held_by)}"\n`;
        if (m.covering_dates) body += `    covering_dates: "${yamlEsc(m.covering_dates)}"\n`;
        if (m.catalogue_url) body += `    catalogue_url: "${yamlEsc(m.catalogue_url)}"\n`;
        continue;
      }

      if (kind === "gedcom" && m.external_source_file) {
        body += `    source_file: "${yamlEsc(m.external_source_file)}"\n`;
      }
      if (m.confidence) body += `    match_confidence: ${m.confidence}\n`;
      if (m.reasons?.length) {
        body += `    match_reasons: [${m.reasons.map((r) => `"${yamlEsc(r)}"`).join(", ")}]\n`;
      }
      const d = m.external_data ?? {};
      body += `    external_data:\n`;
      if (d.name) body += `      name: "${yamlEsc(d.name)}"\n`;
      if (d.birth_year) body += `      birth_year: ${d.birth_year}\n`;
      if (d.birth_place) body += `      birth_place: "${yamlEsc(d.birth_place)}"\n`;
      if (d.death_date) body += `      death_date: "${yamlEsc(d.death_date)}"\n`;
      if (d.death_place) body += `      death_place: "${yamlEsc(d.death_place)}"\n`;
      if (d.famc) body += `      famc: "${yamlEsc(d.famc)}"\n`;
      if (d.profile_url) body += `      profile_url: "${yamlEsc(d.profile_url)}"\n`;
      if (d.citations?.length) {
        body += `      citations:\n`;
        for (const c of d.citations.slice(0, 5)) {
          body += `        - source_id: "${yamlEsc(c.source_id)}"`;
          if (c.page) body += `, page: "${yamlEsc(c.page)}"`;
          body += `\n`;
        }
      }
    }
  }

  body += `\nalias_registry:\n`;
  const aliasKeys = Object.keys(aliases);
  const ALIASES_PER_KEY_CAP = 6;
  if (aliasKeys.length) {
    for (const k of aliasKeys) {
      const variants = aliases[k];
      if (variants?.length) {
        const trimmed = variants.slice(0, ALIASES_PER_KEY_CAP);
        body += `  ${yamlEsc(k)}: [${trimmed.map((v) => `"${yamlEsc(v)}"`).join(", ")}]\n`;
      }
    }
  } else {
    body += `  (none recorded)\n`;
  }

  return body.trimEnd();
};

const EMPTY_KB_BODY = `known_parishes: {}
naming_pattern_warnings: []
negative_searches: []
confirmed_relatives: []
migration_routes: []
alias_registry: {}`;

// Parse the agent's <<NEGATIVE_SEARCHES>> trailing block.
export const parseNegativeSearchesBlock = (text) => {
  const m = text?.match(/<<NEGATIVE_SEARCHES>>\s*([\s\S]*?)\s*<<\/NEGATIVE_SEARCHES>>/);
  if (!m) return [];
  return m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l))
    .map((l) => {
      const [source, ...rest] = l.split("||");
      return { source: source?.trim(), query: rest.join("||").trim() };
    })
    .filter((r) => r.source && r.query);
};

// Parse the agent's <<EXTERNAL_LOOKUPS>> trailing block. Returns an array
// of { service, url, reason } objects.
export const parseExternalLookups = (text) => {
  const m = text?.match(/<<EXTERNAL_LOOKUPS>>\s*([\s\S]*?)\s*<<\/EXTERNAL_LOOKUPS>>/);
  if (!m) return [];
  return m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l))
    .map((l) => {
      const parts = l.split("||").map((p) => p.trim());
      if (parts.length < 3) return null;
      const [service, url, reason] = parts;
      if (!service || !url) return null;
      return { service, url, reason };
    })
    .filter(Boolean);
};

// Parse the agent's <<NEXT_TIME>> trailing block — a free-text hypothesis
// for the next run on this individual.
export const parseNextTimeBlock = (text) => {
  const m = text?.match(/<<NEXT_TIME>>\s*([\s\S]*?)\s*<<\/NEXT_TIME>>/);
  if (!m) return null;
  const body = m[1].trim();
  if (!body || /^NONE\s*$/i.test(body)) return null;
  return body;
};

// Parse the agent's <<ALIAS_OBSERVATIONS>> trailing block.
export const parseAliasObservationsBlock = (text) => {
  const m = text?.match(/<<ALIAS_OBSERVATIONS>>\s*([\s\S]*?)\s*<<\/ALIAS_OBSERVATIONS>>/);
  if (!m) return [];
  return m[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !/^NONE$/i.test(l))
    .map((l) => {
      const parts = l.split("||").map((p) => p.trim());
      if (parts.length < 2) return null;
      const [standard, variant, source] = parts;
      return { standard, variant, source: source ?? "" };
    })
    .filter(Boolean);
};

// Apply the negative searches and alias observations from one agent run to
// the KB. Returns an updated kb object (does not mutate input).
//
// Persistent caps (different from prompt-display caps in buildKbContextBody):
//   - negative_searches per individual: keep last 50, dedup by source||query
//   - alias variants per standard name: keep last 12
// These are large enough that no signal is lost, small enough that the file
// can't grow unboundedly across thousands of runs.
const NEG_SEARCH_PERSIST_CAP = 50;
const ALIAS_PERSIST_CAP = 12;

export const applyAgentRunToKb = (kb, individualId, agentResultText) => {
  const next = JSON.parse(JSON.stringify(kb));
  const negs = parseNegativeSearchesBlock(agentResultText);
  next.negative_searches = next.negative_searches ?? [];
  for (const n of negs) {
    const exists = next.negative_searches.some(
      (x) =>
        x.individual_id === individualId &&
        x.source === n.source &&
        x.query === n.query,
    );
    if (!exists) {
      next.negative_searches.push({ individual_id: individualId, ...n, recorded_at: new Date().toISOString() });
    }
  }
  // Trim to the most recent NEG_SEARCH_PERSIST_CAP per individual.
  const byIndividual = new Map();
  for (const ns of next.negative_searches) {
    const arr = byIndividual.get(ns.individual_id) ?? [];
    arr.push(ns);
    byIndividual.set(ns.individual_id, arr);
  }
  const trimmed = [];
  for (const [, arr] of byIndividual) {
    trimmed.push(...arr.slice(-NEG_SEARCH_PERSIST_CAP));
  }
  next.negative_searches = trimmed;

  const aliases = parseAliasObservationsBlock(agentResultText);
  next.alias_registry = next.alias_registry ?? {};
  for (const a of aliases) {
    next.alias_registry[a.standard] = next.alias_registry[a.standard] ?? [];
    if (!next.alias_registry[a.standard].includes(a.variant)) {
      next.alias_registry[a.standard].push(a.variant);
    }
    if (next.alias_registry[a.standard].length > ALIAS_PERSIST_CAP) {
      next.alias_registry[a.standard] = next.alias_registry[a.standard].slice(-ALIAS_PERSIST_CAP);
    }
  }
  next.last_changed_at = new Date().toISOString();
  return next;
};

// Auto-derive migration routes by comparing this individual's birth_place
// to the birth places of confirmed family members. A different parish for
// a child or spouse implies a route worth recording.
const deriveMigrationRoutes = (kb, individual, families, individuals) => {
  if (!individual.birth_place) return;
  const indPlace = individual.birth_place;
  kb.migration_routes = kb.migration_routes ?? [];

  const candidates = [];
  // Children — born somewhere different to the parent
  for (const fsId of individual.fams ?? []) {
    const fam = families.find((f) => f.id === fsId);
    if (!fam) continue;
    for (const childId of fam.children ?? []) {
      const child = individuals.find((p) => p.id === childId);
      if (!child?.birth_place || child.birth_place === indPlace) continue;
      // Only derive when both individuals have non-D evidence (we want
      // confirmed places, not GEDCOM-asserted guesses)
      if (child.confidence !== "A" && child.confidence !== "B") continue;
      candidates.push(`${indPlace} → ${child.birth_place}`);
    }
  }
  // Parents — different parish than this individual
  if (individual.famc) {
    const fam = families.find((f) => f.id === individual.famc);
    if (fam) {
      for (const pId of [fam.husband, fam.wife]) {
        const parent = individuals.find((p) => p.id === pId);
        if (!parent?.birth_place || parent.birth_place === indPlace) continue;
        if (parent.confidence !== "A" && parent.confidence !== "B") continue;
        candidates.push(`${parent.birth_place} → ${indPlace}`);
      }
    }
  }

  for (const route of candidates) {
    if (!kb.migration_routes.includes(route)) {
      kb.migration_routes.push(route);
    }
  }
};

// Normalise a source name from a citation. We want stable counts so
// "FamilySearch.org", "FamilySearch", and "Family Search" all collapse to
// one bucket. The strategy: pull the first recognisable repository token.
const SOURCE_PATTERNS = [
  [/\bfamilysearch\b/i, "FamilySearch"],
  [/\bfreebmd\b/i, "FreeBMD"],
  [/\bborthwick\b/i, "Borthwick Institute"],
  [/\bwest yorkshire archive\b/i, "West Yorkshire Archive Service"],
  [/\blancashire archives?\b/i, "Lancashire Archives"],
  [/\bgenuki\b/i, "Genuki"],
  [/\bnational archives?\b/i, "National Archives"],
  [/\bgro\b/i, "GRO"],
  [/\bancestry\b/i, "Ancestry"],
  [/\bfindmypast\b/i, "Findmypast"],
  [/\bbritish newspaper\b/i, "British Newspaper Archive"],
  [/\bwikitree\b/i, "WikiTree"],
  [/\bfreereg\b/i, "FreeREG"],
];

const normaliseSource = (str) => {
  const text = String(str ?? "");
  if (!text) return null;
  for (const [pattern, label] of SOURCE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  // Fallback: first capitalised phrase
  const m = text.match(/^[^,.;]+/);
  return m ? m[0].trim().slice(0, 40) : null;
};

const recordSourceAccept = (kb, citation) => {
  const candidates = [
    citation?.repository,
    citation?.title,
  ].filter(Boolean);
  for (const c of candidates) {
    const src = normaliseSource(c);
    if (!src) continue;
    kb.source_efficacy = kb.source_efficacy ?? {};
    kb.source_efficacy[src] = kb.source_efficacy[src] ?? {
      accepted_count: 0,
      first_seen: new Date().toISOString(),
    };
    kb.source_efficacy[src].accepted_count += 1;
    kb.source_efficacy[src].last_seen = new Date().toISOString();
    break; // one source bucket per accept
  }
};

// Apply an accepted Record Discovery match: the accepted citation's place
// becomes a confirmed parish for this individual's surname; related family
// members get this person added as a confirmed relative; and any related
// people who've been researched before get tagged for re-research.
export const applyAcceptedMatchToKb = (kb, {
  individual,
  citation,
  newConfidence,
  families,
  individuals,
  evidenceLog,
}) => {
  const next = JSON.parse(JSON.stringify(kb));
  const sn = surnameOf(individual.name);

  // Heuristic: parish derives from the citation repository or title — use the
  // birth_place as the canonical parish, and add the repository as a hint.
  if (sn && individual.birth_place) {
    next.known_parishes = next.known_parishes ?? {};
    next.known_parishes[sn] = next.known_parishes[sn] ?? [];
    if (!next.known_parishes[sn].includes(individual.birth_place)) {
      next.known_parishes[sn].push(individual.birth_place);
    }
  }

  // Migration routes from accepted-individual's family
  deriveMigrationRoutes(next, individual, families, individuals);

  // Source efficacy — which repositories produce accepted matches
  recordSourceAccept(next, citation);

  // Mark this individual as a confirmed relative for everyone in their family
  // (parents and siblings via FAMC, children via FAMS).
  next.confirmed_relatives = next.confirmed_relatives ?? {};
  const addRelative = (forId, rec) => {
    next.confirmed_relatives[forId] = next.confirmed_relatives[forId] ?? [];
    const exists = next.confirmed_relatives[forId].some(
      (r) => r.relative_id === rec.relative_id,
    );
    if (!exists) next.confirmed_relatives[forId].push(rec);
  };

  const indRec = {
    relative_id: individual.id,
    name: individual.name,
    relationship: "self", // overridden per target
    birth_year: individual.birth_year,
    birth_place: individual.birth_place,
    confidence: newConfidence,
    citation: citation
      ? `${citation.title}. ${citation.repository}. ${citation.reference}`
      : null,
  };

  const relatedIds = new Set();
  if (individual.famc) {
    const fam = families.find((f) => f.id === individual.famc);
    if (fam) {
      for (const otherId of [fam.husband, fam.wife]) {
        if (otherId && otherId !== individual.id) {
          addRelative(otherId, { ...indRec, relationship: "child" });
          relatedIds.add(otherId);
        }
      }
      for (const sibId of fam.children ?? []) {
        if (sibId !== individual.id) {
          addRelative(sibId, { ...indRec, relationship: "sibling" });
          relatedIds.add(sibId);
        }
      }
    }
  }
  for (const fsId of individual.fams ?? []) {
    const fam = families.find((f) => f.id === fsId);
    if (!fam) continue;
    for (const childId of fam.children ?? []) {
      addRelative(childId, { ...indRec, relationship: "parent" });
      relatedIds.add(childId);
    }
    const spouseId = fam.husband === individual.id ? fam.wife : fam.husband;
    if (spouseId) {
      addRelative(spouseId, { ...indRec, relationship: "spouse" });
      relatedIds.add(spouseId);
    }
  }

  // Re-research recommended for any related person who's been researched.
  next.reresearch_recommended = next.reresearch_recommended ?? {};
  for (const rid of relatedIds) {
    if (evidenceLog?.[rid]) {
      next.reresearch_recommended[rid] = {
        reason: `${individual.name} accepted at confidence ${newConfidence} on ${new Date().toISOString().slice(0, 10)} — new context available`,
        triggered_by: individual.id,
        triggered_at: new Date().toISOString(),
      };
    }
  }

  // Phase 2: record this accept as a Bayesian identity-evidence entry so the
  // confidence breakdown panel reflects it. Source-kind inference is rough —
  // we look at the citation title for hints; otherwise default to a generic
  // "parish_baptism" Tier 1. The user can refine in a later phase.
  next.confidence_evidence = next.confidence_evidence ?? {};
  next.confidence_evidence[individual.id] = next.confidence_evidence[individual.id] ?? { identity: [], relationship: [] };
  const inferKind = (cit) => {
    const t = `${cit?.title ?? ""} ${cit?.reference ?? ""}`.toLowerCase();
    if (/baptism|baptis|baptized/.test(t)) return "parish_baptism";
    if (/marriage|wed/.test(t)) return "parish_marriage";
    if (/burial|buried/.test(t)) return "parish_burial";
    if (/will|probate/.test(t)) return "will_or_probate";
    if (/census/.test(t)) return "census_record";
    if (/birth.*certificate|gro|general register/.test(t)) return "civil_bmd_certificate";
    if (/freebmd|bmd index/.test(t)) return "civil_bmd_index";
    return "parish_baptism"; // safe default for the era this tree mostly covers
  };
  const kind = inferKind(citation);
  const lr = lookupLr({ kind, direction: "match", domain: "identity" }) ?? 50;
  const tier = (() => {
    try { return loadLrTable().sources_identity?.[kind]?.tier ?? 1; } catch { return 1; }
  })();
  next.confidence_evidence[individual.id].identity.push({
    kind,
    lr,
    source_tier: tier,
    source_kind: "decision_accept",
    source: citation ? `${citation.title}. ${citation.repository}. ${citation.reference}` : null,
    evidence_group: citation?.reference ? `accept_${citation.reference}` : undefined,
    added_at: new Date().toISOString(),
  });

  next.last_changed_at = new Date().toISOString();
  return next;
};

// Apply an accepted Ancestor Discovery candidate: the new agent-proposed
// individual becomes a confirmed relative of the child, and the link
// citation contributes to the family's parish anchors.
export const applyAcceptedCandidateToKb = (kb, { newIndividual, child, role, linkCitation, families, individuals, evidenceLog }) => {
  const next = JSON.parse(JSON.stringify(kb));
  const childSurname = surnameOf(child.name);

  // The new individual's parish (if known) is now a confirmed parish for
  // their surname AND for the child's surname (since they shared a parish).
  if (newIndividual.birth_place) {
    next.known_parishes = next.known_parishes ?? {};
    const newSn = surnameOf(newIndividual.name);
    for (const sn of [newSn, childSurname].filter(Boolean)) {
      next.known_parishes[sn] = next.known_parishes[sn] ?? [];
      if (!next.known_parishes[sn].includes(newIndividual.birth_place)) {
        next.known_parishes[sn].push(newIndividual.birth_place);
      }
    }
  }

  // Migration routes — the new ancestor's birth place differs from the child's
  deriveMigrationRoutes(next, newIndividual, families, individuals);

  // Source efficacy — the link citation establishes which repository produced
  // this accepted relationship. Ancestor accepts contribute to the same
  // efficacy table as Record Discovery accepts.
  recordSourceAccept(next, { title: linkCitation });

  next.confirmed_relatives = next.confirmed_relatives ?? {};
  next.confirmed_relatives[child.id] = next.confirmed_relatives[child.id] ?? [];
  const exists = next.confirmed_relatives[child.id].some(
    (r) => r.relative_id === newIndividual.id,
  );
  if (!exists) {
    next.confirmed_relatives[child.id].push({
      relative_id: newIndividual.id,
      name: newIndividual.name,
      relationship: role,
      birth_year: newIndividual.birth_year,
      birth_place: newIndividual.birth_place,
      confidence: newIndividual.confidence,
      citation: linkCitation,
    });
  }

  // Re-research recommended for the child's siblings + other parent who've
  // been researched (they now have a new anchor).
  next.reresearch_recommended = next.reresearch_recommended ?? {};
  if (child.famc) {
    const fam = families.find((f) => f.id === child.famc);
    if (fam) {
      const related = [fam.husband, fam.wife, ...(fam.children ?? [])].filter(
        (id) => id && id !== child.id && id !== newIndividual.id,
      );
      for (const rid of related) {
        if (evidenceLog?.[rid]) {
          next.reresearch_recommended[rid] = {
            reason: `New ${role} ${newIndividual.name} added for ${child.name} — new context available`,
            triggered_by: newIndividual.id,
            triggered_at: new Date().toISOString(),
          };
        }
      }
    }
  }

  next.last_changed_at = new Date().toISOString();
  return next;
};

// Compute naming-pattern warnings from the full individuals list. A given
// name appearing 3+ times across generations is flagged.
//
// Filters out:
//   - Surnames-used-as-middle-names (e.g. "Bentley" in "John Bentley Smith"
//     when "Bentley" is also a surname elsewhere in the tree)
//   - Annotations or non-name tokens (e.g. "ggf", lowercase abbreviations)
export const computeNamingPatterns = (individuals) => {
  const surnames = new Set();
  for (const ind of individuals) {
    if (!ind.name) continue;
    const parts = ind.name.split(/\s+/);
    if (parts.length > 0) surnames.add(parts[parts.length - 1]);
  }

  const counts = new Map();
  for (const ind of individuals) {
    if (!ind.name) continue;
    const givens = ind.name.split(/\s+/).slice(0, -1);
    for (const g of givens) {
      if (g.length < 2) continue;
      // Must look like a proper given name: starts with capital, rest lowercase
      if (!/^[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?$/.test(g)) continue;
      // Exclude surnames-as-middle-names
      if (surnames.has(g)) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  const warnings = [];
  for (const [name, count] of counts) {
    if (count >= 3) warnings.push({ name, count });
  }
  warnings.sort((a, b) => b.count - a.count);
  return warnings;
};

// Clear a person's reresearch_recommended flag — called after they've been
// re-researched.
export const clearReresearchFlag = (kb, individualId) => {
  const next = JSON.parse(JSON.stringify(kb));
  if (next.reresearch_recommended?.[individualId]) {
    delete next.reresearch_recommended[individualId];
  }
  return next;
};
