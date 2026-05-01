// Orchestrator: queries WikiTree, FamilySearch, and TNA Discovery in
// parallel for a target individual, scores person-shaped results via the
// existing GEDCOM matcher, and merges leads into the shared
// external_suggestions store with per-source `source_kind` tags.
//
// Design: clients are passed in (DI) so tests can stub HTTP. In production
// server.js binds them to the real fetchers + env-var-driven disable flags.

import { matchExternalIndividuals } from "./externalImport.js";

const splitName = (full) => {
  if (!full) return { givenName: "", surname: "" };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: "", surname: parts[0] };
  return { givenName: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
};

export const isCacheFresh = (apiCache, individualId, cacheDays) => {
  if (!cacheDays || cacheDays <= 0) return false;
  const entry = apiCache?.[individualId];
  if (!entry?.fetched_at) return false;
  const ageMs = Date.now() - new Date(entry.fetched_at).getTime();
  return ageMs < cacheDays * 86400_000;
};

// Person-shaped leads (WikiTree, FamilySearch) → run through existing
// matcher so they get the same confidence + reasons as GEDCOM leads.
const matchPersonLeads = (sourceKind, externalIndividuals, individual, ourTree) => {
  if (externalIndividuals.length === 0) return [];
  const { by_individual } = matchExternalIndividuals(ourTree, externalIndividuals);
  const matches = by_individual[individual.id] ?? [];
  return matches.map((m) => ({ source_kind: sourceKind, ...m }));
};

// TNA leads are catalogue references, not person matches. Stored with a
// distinct shape so the KB renderer can surface them in <<EXTERNAL_LOOKUPS>>.
const tnaLeadsFor = (tnaResults) =>
  tnaResults.map((r) => ({
    source_kind: "tna",
    external_id: r.id,
    catalogue_ref: r.reference,
    title: r.title,
    held_by: r.held_by,
    covering_dates: r.covering_dates,
    catalogue_url: r.catalogue_url,
    score: r.score,
  }));

export const gatherApiLeads = async ({
  individual,
  ourTree,
  currentSuggestions,
  clients,
}) => {
  const next = JSON.parse(
    JSON.stringify(
      currentSuggestions ?? {
        by_individual: {},
        unmatched: [],
        imports: [],
        api_cache: {},
      },
    ),
  );
  next.by_individual = next.by_individual ?? {};
  next.api_cache = next.api_cache ?? {};

  const { givenName, surname } = splitName(individual.name);
  const query = {
    givenName,
    surname,
    birthYear: individual.birth_year,
    birthPlace: individual.birth_place,
  };

  const errors = [];
  const settle = async (label, enabled, fn) => {
    if (!enabled) return [];
    try {
      return await fn();
    } catch (err) {
      errors.push({ source: label, message: err.message });
      console.warn(`[externalApi] ${label} failed: ${err.message}`);
      return [];
    }
  };

  const [wikiTreeRes, familySearchRes, tnaRes] = await Promise.all([
    settle("wikitree", !clients.isWikiTreeDisabled(), () => clients.searchWikiTree(query)),
    settle("familysearch", !clients.isFamilySearchDisabled(), () =>
      clients.searchFamilySearch({ ...query, clientId: clients.familySearchClientId }),
    ),
    settle("tna", !clients.isTnaDisabled(), () =>
      // TNA queries use AND across whitespace tokens, so a long phrase
      // ("Ann Sweeting Monks Frystone") almost never matches. Use just the
      // person's name as the query — the date range narrows the rest.
      clients.searchTna({
        query: individual.name || surname,
        yearFrom: individual.birth_year ? individual.birth_year - 5 : undefined,
        yearTo: individual.birth_year ? individual.birth_year + 90 : undefined,
      }),
    ),
  ]);

  const wikiTreeMatches = matchPersonLeads("wikitree", wikiTreeRes, individual, ourTree);
  const familySearchMatches = matchPersonLeads("familysearch", familySearchRes, individual, ourTree);
  const tnaMatches = tnaLeadsFor(tnaRes);

  // Strip prior API-derived leads for this individual (idempotent re-run);
  // GEDCOM-imported entries (source_kind="gedcom" or absent) are preserved.
  const existing = next.by_individual[individual.id] ?? [];
  const preserved = existing.filter(
    (m) => !["wikitree", "familysearch", "tna"].includes(m.source_kind),
  );
  next.by_individual[individual.id] = [
    ...preserved,
    ...wikiTreeMatches,
    ...familySearchMatches,
    ...tnaMatches,
  ];
  if (next.by_individual[individual.id].length === 0) delete next.by_individual[individual.id];

  next.api_cache[individual.id] = { fetched_at: new Date().toISOString() };

  const summary = {
    wikitree_count: wikiTreeMatches.length,
    familysearch_count: familySearchMatches.length,
    tna_count: tnaMatches.length,
    errors,
  };

  return { suggestions: next, summary };
};
