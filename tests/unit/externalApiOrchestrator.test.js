import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gatherApiLeads, isCacheFresh } from "../../agent/externalApiOrchestrator.js";

const ourTree = [
  {
    id: "@OUR_ANN@",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire",
    confidence: "D",
  },
];

const annTarget = ourTree[0];

const wikiTreeHit = [
  {
    id: "Sweeting-12",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire, England",
    death_date: "1875",
    death_place: "Leeds, Yorkshire",
    profile_url: "https://www.wikitree.com/wiki/Sweeting-12",
  },
];

const familySearchHit = [
  {
    id: "L1AB-CDE",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire, England",
    death_date: "1875",
    death_place: "Leeds",
    profile_url: "https://www.familysearch.org/tree/person/details/L1AB-CDE",
  },
];

const tnaHit = [
  {
    id: "C12345",
    reference: "PROB 11/1234/56",
    title: "Will of Ann Sweeting of Monks Frystone",
    description: "",
    covering_dates: "1875",
    held_by: "The National Archives, Kew",
    places: [],
    score: 510.2,
    catalogue_url: "https://discovery.nationalarchives.gov.uk/details/r/C12345",
  },
];

const stubClients = ({ wikiTree = [], familySearch = [], tna = [] } = {}) => ({
  searchWikiTree: async () => wikiTree,
  searchFamilySearch: async () => familySearch,
  searchTna: async () => tna,
  isWikiTreeDisabled: () => false,
  isFamilySearchDisabled: () => false,
  isTnaDisabled: () => false,
  familySearchClientId: "TEST-CLIENT",
});

describe("isCacheFresh", () => {
  test("returns false when no cache entry exists", () => {
    assert.equal(isCacheFresh({}, "@OUR_ANN@", 30), false);
  });

  test("returns true when fetched_at is within cacheDays", () => {
    const cache = {
      "@OUR_ANN@": { fetched_at: new Date(Date.now() - 5 * 86400_000).toISOString() },
    };
    assert.equal(isCacheFresh(cache, "@OUR_ANN@", 30), true);
  });

  test("returns false when fetched_at is older than cacheDays", () => {
    const cache = {
      "@OUR_ANN@": { fetched_at: new Date(Date.now() - 31 * 86400_000).toISOString() },
    };
    assert.equal(isCacheFresh(cache, "@OUR_ANN@", 30), false);
  });

  test("cacheDays=0 always returns false (force refresh)", () => {
    const cache = { "@OUR_ANN@": { fetched_at: new Date().toISOString() } };
    assert.equal(isCacheFresh(cache, "@OUR_ANN@", 0), false);
  });
});

describe("gatherApiLeads", () => {
  test("merges WikiTree + FamilySearch + TNA into external_suggestions tagged by source_kind", async () => {
    const { suggestions, summary } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients: stubClients({
        wikiTree: wikiTreeHit,
        familySearch: familySearchHit,
        tna: tnaHit,
      }),
    });

    const matches = suggestions.by_individual["@OUR_ANN@"];
    assert.ok(matches, "Ann should have matches");
    const kinds = new Set(matches.map((m) => m.source_kind));
    assert.ok(kinds.has("wikitree"));
    assert.ok(kinds.has("familysearch"));
    assert.ok(kinds.has("tna"));

    assert.equal(summary.wikitree_count, 1);
    assert.equal(summary.familysearch_count, 1);
    assert.equal(summary.tna_count, 1);
  });

  test("WikiTree person matches scored via the existing matcher", async () => {
    const { suggestions } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients: stubClients({ wikiTree: wikiTreeHit }),
    });
    const wt = suggestions.by_individual["@OUR_ANN@"].find((m) => m.source_kind === "wikitree");
    assert.equal(wt.confidence, "strong");
    assert.ok(Array.isArray(wt.reasons) && wt.reasons.length > 0);
    assert.equal(wt.external_data.id, "Sweeting-12");
  });

  test("TNA leads stored with catalogue_ref + held_by, no confidence (catalogue not person)", async () => {
    const { suggestions } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients: stubClients({ tna: tnaHit }),
    });
    const tna = suggestions.by_individual["@OUR_ANN@"].find((m) => m.source_kind === "tna");
    assert.equal(tna.catalogue_ref, "PROB 11/1234/56");
    assert.equal(tna.held_by, "The National Archives, Kew");
    assert.equal(tna.catalogue_url, "https://discovery.nationalarchives.gov.uk/details/r/C12345");
  });

  test("respects per-source disable flags", async () => {
    const clients = {
      ...stubClients({ wikiTree: wikiTreeHit, familySearch: familySearchHit, tna: tnaHit }),
      isWikiTreeDisabled: () => true,
      isFamilySearchDisabled: () => true,
    };
    const { summary } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients,
    });
    assert.equal(summary.wikitree_count, 0);
    assert.equal(summary.familysearch_count, 0);
    assert.equal(summary.tna_count, 1);
  });

  test("one client failing does not block the others (Promise.allSettled)", async () => {
    const clients = {
      ...stubClients({ familySearch: familySearchHit, tna: tnaHit }),
      searchWikiTree: async () => {
        throw new Error("WikiTree down");
      },
    };
    const { suggestions, summary } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients,
    });
    assert.equal(summary.wikitree_count, 0);
    assert.equal(summary.familysearch_count, 1);
    assert.equal(summary.tna_count, 1);
    // Errors surface in summary for visibility
    assert.ok(summary.errors.some((e) => e.source === "wikitree"));
    // Other source's leads still merged
    assert.ok(suggestions.by_individual["@OUR_ANN@"].length >= 2);
  });

  test("re-running for the same individual replaces prior API leads (no duplicates)", async () => {
    const first = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients: stubClients({ wikiTree: wikiTreeHit, familySearch: familySearchHit }),
    });
    const second = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: first.suggestions,
      clients: stubClients({ wikiTree: wikiTreeHit, familySearch: familySearchHit }),
    });
    const apiLeads = second.suggestions.by_individual["@OUR_ANN@"].filter(
      (m) => m.source_kind === "wikitree" || m.source_kind === "familysearch",
    );
    assert.equal(apiLeads.length, 2, "should have 2 API leads, not 4");
  });

  test("preserves existing GEDCOM-imported entries when adding API leads", async () => {
    const seed = {
      by_individual: {
        "@OUR_ANN@": [
          {
            source_kind: "gedcom",
            external_id: "@I_FROM_ANCESTRY@",
            external_source_file: "ancestry.ged",
            confidence: "medium",
            reasons: ["from GEDCOM"],
            external_data: { name: "Ann Sweeting", birth_year: 1802 },
          },
        ],
      },
      unmatched: [],
      imports: [],
      api_cache: {},
    };
    const { suggestions } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: seed,
      clients: stubClients({ wikiTree: wikiTreeHit }),
    });
    const all = suggestions.by_individual["@OUR_ANN@"];
    assert.ok(all.some((m) => m.source_kind === "gedcom"), "GEDCOM entry preserved");
    assert.ok(all.some((m) => m.source_kind === "wikitree"), "WikiTree entry added");
  });

  test("updates api_cache.fetched_at for the individual", async () => {
    const { suggestions } = await gatherApiLeads({
      individual: annTarget,
      ourTree,
      currentSuggestions: null,
      clients: stubClients({ wikiTree: wikiTreeHit }),
    });
    assert.ok(suggestions.api_cache["@OUR_ANN@"]?.fetched_at, "fetched_at recorded");
  });
});
