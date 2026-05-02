import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDistribution,
  buildRecentEvidence,
  buildRecentRuns,
  buildEvidenceQueue,
  buildSourcesCatalog,
} from "../../agent/dashboardAggregations.js";

const fixtureIndividuals = [
  { id: "@1@", name: "Alice", confidence: "A" },
  { id: "@2@", name: "Bob", confidence: "B" },
  { id: "@3@", name: "Carol", confidence: "B" },
  { id: "@4@", name: "Dan", confidence: "C" },
  { id: "@5@", name: "Eve", confidence: "D" },
];

test("buildDistribution counts bands and total", () => {
  const r = buildDistribution(fixtureIndividuals);
  assert.deepEqual(r.bands, { A: 1, B: 2, C: 1, D: 1 });
  assert.equal(r.total, 5);
});

test("buildDistribution handles empty list", () => {
  const r = buildDistribution([]);
  assert.deepEqual(r.bands, { A: 0, B: 0, C: 0, D: 0 });
  assert.equal(r.total, 0);
});

test("buildRecentEvidence merges accepted + agent runs + GEDCOM imports", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "parish_baptism", source: "St Wilfrid", source_tier: 1, added_at: "2026-04-01T00:00:00Z" },
        ],
      },
    },
  };
  const evidenceLog = {
    "@2@": { searched_at: "2026-05-02T00:00:00Z", search_count: 7, model: "claude-sonnet-4-6" },
  };
  const externalSuggestions = {
    by_individual: {
      "@3@": [
        { imported_at: "2026-04-15T00:00:00Z", external_source_file: "Sutcliffe.ged" },
      ],
    },
  };
  const r = buildRecentEvidence({
    kb,
    evidenceLog,
    externalSuggestions,
    individuals: fixtureIndividuals,
    limit: 10,
  });
  assert.equal(r.length, 3);
  // Newest first → agent run on @2@
  assert.equal(r[0].category, "agent_run");
  assert.equal(r[0].individual_name, "Bob");
  assert.equal(r[0].search_count, 7);
  // Then GEDCOM import for @3@
  assert.equal(r[1].category, "gedcom_import");
  // Then accepted citation for @1@
  assert.equal(r[2].category, "accepted");
});

test("buildRecentEvidence honours limit", () => {
  const evidenceLog = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      `@R${i}@`,
      { searched_at: `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`, search_count: 5 },
    ]),
  );
  const r = buildRecentEvidence({ kb: {}, evidenceLog, externalSuggestions: {}, individuals: [], limit: 5 });
  assert.equal(r.length, 5);
});

test("buildRecentRuns sorts by searched_at and resolves names", () => {
  const evidenceLog = {
    "@1@": { searched_at: "2026-04-01T00:00:00Z", search_count: 5, model: "claude-sonnet-4-6" },
    "@2@": { searched_at: "2026-05-01T12:00:00Z", searches: ["a", "b"] },
    "@3@": { /* no searched_at */ },
  };
  const r = buildRecentRuns({ evidenceLog, individuals: fixtureIndividuals, limit: 5 });
  assert.equal(r.length, 2);
  assert.equal(r[0].individual_name, "Bob");
  assert.equal(r[0].search_count, 2);
});

test("buildEvidenceQueue merges 4 sources, normalises severity, sorts by rank", () => {
  const kb = {
    reresearch_recommended: {
      "@2@": { reason: "marriage record found, re-run for confirmation" },
    },
    confidence_evidence: {
      "@4@": {
        identity: [
          { kind: "parish_baptism", lr: 50 },
          { kind: "story_contradiction", lr: 0.4 },
        ],
      },
    },
  };
  const decisions = {
    "@5@": { decision: "flagged", note: "1880 census needs verification" },
  };
  const reviewerFindings = [
    // reviewer emits severity:"warning" but kind contains "violation" so this
    // should normalise to "high"
    { individual_id: "@4@", kind: "chronology_violation", severity: "warning", message: "death predates birth" },
  ];
  const queue = buildEvidenceQueue({
    individuals: fixtureIndividuals,
    kb,
    reviewerFindings,
    decisions,
  });
  assert.equal(queue.length, 4);
  // First two items must be high-severity (chronology_violation + evidence_contradiction)
  assert.equal(queue[0].severity, "high");
  assert.equal(queue[1].severity, "high");
  // Reresearch + flagged are mid/low
  const sevs = queue.map((q) => q.severity);
  assert.ok(sevs.includes("medium"), "flagged decision is medium");
  assert.ok(sevs.includes("low"), "reresearch is low");
});

test("buildEvidenceQueue collapses repeated high_band_no_evidence into one grouped row", () => {
  const reviewerFindings = Array.from({ length: 30 }, (_, i) => ({
    individual_id: `@H${i}@`,
    kind: "high_band_no_evidence",
    severity: "warning",
    message: `Person ${i} band A but no agent run.`,
  }));
  // Plus one real chronology violation that should NOT be collapsed
  reviewerFindings.push({
    individual_id: "@X@",
    kind: "chronology_violation",
    severity: "warning",
    message: "death before birth",
  });
  const queue = buildEvidenceQueue({
    individuals: [{ id: "@X@", name: "Real Bob" }],
    kb: {},
    reviewerFindings,
    decisions: {},
  });
  // 1 chronology row + 1 collapsed group row = 2 entries
  assert.equal(queue.length, 2);
  const grouped = queue.find((q) => q.kind === "high_band_no_evidence");
  assert.ok(grouped.group, "grouped row carries .group metadata");
  assert.equal(grouped.group.count, 30);
  assert.equal(grouped.individual_id, null, "grouped rows have no single individual_id");
});

test("buildSourcesCatalog separates archive/accepted/trail correctly", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "parish_baptism", source: "St Wilfrid baptism register 1842", source_tier: 1, source_kind: "decision_accept", added_at: "2026-04-01T00:00:00Z", note: "fol. 23" },
        ],
      },
    },
  };
  const externalSuggestions = {
    by_individual: {
      "@1@": [
        {
          imported_at: "2026-03-01T00:00:00Z",
          external_data: {
            citations: [
              { source_id: "@S1@", page: "TNA RG 15/22309, 1921 Census, Hunslet" },
              { source_id: "@S2@", page: "GRO Birth Index 1842 Q2 Pontefract" },
            ],
          },
        },
      ],
      "@2@": [
        {
          imported_at: "2026-03-02T00:00:00Z",
          external_data: {
            citations: [
              { source_id: "@S1@", page: "TNA RG 15/22309, 1921 Census, Hunslet" },
            ],
          },
        },
      ],
    },
  };
  const evidenceLog = {
    "@1@": {
      searched_at: "2026-04-15T00:00:00Z",
      searches: [
        { source: "FreeBMD", query: "John Sutcliffe 1842" },
        "FamilySearch Yorkshire baptisms",
      ],
    },
  };

  const cat = buildSourcesCatalog({
    kb,
    evidenceLog,
    externalSuggestions,
    individuals: fixtureIndividuals,
  });

  // Archive: 2 unique pages, TNA cited twice (one per individual)
  assert.equal(cat.archive_citations.length, 2);
  const tna = cat.archive_citations.find((s) => s.source.includes("TNA"));
  assert.equal(tna.citation_count, 2);
  assert.equal(tna.individuals.length, 2);

  // Accepted: 1 entry (the decision_accept identity entry)
  assert.equal(cat.accepted_citations.length, 1);
  assert.equal(cat.accepted_citations[0].sample, "fol. 23");

  // Search trail: 2 queries
  assert.equal(cat.search_trail.length, 2);
  assert.equal(cat.search_trail[0].tier, null);
});

test("buildSourcesCatalog ignores non-decision_accept evidence in accepted bucket", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "wikitree_profile", source_kind: "external_suggestion", added_at: "2026-04-01T00:00:00Z" },
        ],
      },
    },
  };
  const cat = buildSourcesCatalog({
    kb,
    evidenceLog: {},
    externalSuggestions: {},
    individuals: fixtureIndividuals,
  });
  assert.equal(cat.accepted_citations.length, 0);
});

test("buildEvidenceQueue skips when there's nothing to triage", () => {
  const queue = buildEvidenceQueue({
    individuals: fixtureIndividuals,
    kb: {},
    reviewerFindings: [],
    decisions: {},
  });
  assert.equal(queue.length, 0);
});

// --- Per-source context surfacing (context-over-aggregation rule) ---
//
// These tests exercise the new fields the workbench feeds need so list/feed
// rows show citation note + claim backed + LR contribution, not just
// source name + count. The LR table is passed in (keeps aggregators pure).

const fixtureLrTable = {
  sources_identity: {
    parish_baptism: { tier: 1, lr_match: 50, lr_no_match: 0.2 },
    civil_bmd_certificate: { tier: 1, lr_match: 80, lr_no_match: 0.05 },
    census_record: { tier: 2, lr_match: 8, lr_no_match: 0.4 },
  },
  sources_relationship: {
    baptism_naming_parents: { tier: 1, lr_match: 50, lr_no_match: 0.3 },
  },
};

test("buildRecentEvidence surfaces note + claim_kind + lr_match for accepted entries", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "parish_baptism", source: "St Wilfrid", source_tier: 1, added_at: "2026-04-01T00:00:00Z", note: "fol. 23, born 1842 to John & Mary" },
        ],
        relationship: [
          { kind: "baptism_naming_parents", source: "St Wilfrid", source_tier: 1, added_at: "2026-04-02T00:00:00Z", note: "parents named on baptism" },
        ],
      },
    },
  };
  const r = buildRecentEvidence({
    kb,
    evidenceLog: {},
    externalSuggestions: {},
    individuals: fixtureIndividuals,
    lrTable: fixtureLrTable,
    limit: 10,
  });
  assert.equal(r.length, 2);
  // Newest first: the relationship entry
  assert.equal(r[0].claim_kind, "relationship");
  assert.equal(r[0].note, "parents named on baptism");
  assert.equal(r[0].lr_match, 50);
  // Then the identity entry
  assert.equal(r[1].claim_kind, "identity");
  assert.equal(r[1].note, "fol. 23, born 1842 to John & Mary");
  assert.equal(r[1].lr_match, 50);
});

test("buildRecentEvidence sets lr_match=null for unknown kinds and missing note tolerated", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "made_up_kind", source: "Mystery", added_at: "2026-04-01T00:00:00Z" },
        ],
      },
    },
  };
  const r = buildRecentEvidence({
    kb,
    evidenceLog: {},
    externalSuggestions: {},
    individuals: fixtureIndividuals,
    lrTable: fixtureLrTable,
    limit: 10,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].lr_match, null);
  assert.equal(r[0].note, null);
  assert.equal(r[0].claim_kind, "identity");
});

test("buildSourcesCatalog attaches per-citation contexts[] with note + claim_kind + lr_match", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          {
            kind: "parish_baptism",
            source: "St Wilfrid baptism register",
            source_tier: 1,
            source_kind: "decision_accept",
            added_at: "2026-04-01T00:00:00Z",
            note: "fol. 23",
          },
        ],
      },
    },
  };
  const externalSuggestions = {
    by_individual: {
      "@1@": [
        {
          imported_at: "2026-03-01T00:00:00Z",
          external_data: {
            citations: [
              { source_id: "@S1@", page: "TNA RG 15/22309, 1921 Census, Hunslet", note: "household 5, family 12" },
            ],
          },
        },
      ],
      "@2@": [
        {
          imported_at: "2026-03-02T00:00:00Z",
          external_data: {
            citations: [
              { source_id: "@S1@", page: "TNA RG 15/22309, 1921 Census, Hunslet", note: "household 6" },
            ],
          },
        },
      ],
    },
  };
  const cat = buildSourcesCatalog({
    kb,
    evidenceLog: {},
    externalSuggestions,
    individuals: fixtureIndividuals,
    lrTable: fixtureLrTable,
  });
  // Archive: TNA cited twice — contexts[] holds per-individual context
  const tna = cat.archive_citations.find((s) => s.source.includes("TNA"));
  assert.ok(tna.contexts, "archive citation has contexts[]");
  assert.equal(tna.contexts.length, 2);
  assert.equal(tna.contexts[0].note, "household 5, family 12");
  assert.equal(tna.contexts[0].individual_name, "Alice");
  assert.equal(tna.contexts[0].claim_kind, "archive_citation");
  // Accepted: contexts[] holds the per-acceptance note + claim + LR
  assert.equal(cat.accepted_citations.length, 1);
  const accCtx = cat.accepted_citations[0].contexts;
  assert.equal(accCtx.length, 1);
  assert.equal(accCtx[0].note, "fol. 23");
  assert.equal(accCtx[0].claim_kind, "identity");
  assert.equal(accCtx[0].lr_match, 50);
});

test("buildEvidenceQueue attaches triggered_by source for evidence_contradiction rows", () => {
  const kb = {
    confidence_evidence: {
      "@4@": {
        identity: [
          { kind: "parish_baptism", source: "St Wilfrid", source_tier: 1, lr: 50, added_at: "2026-04-01T00:00:00Z" },
          { kind: "story_contradiction", source: "Family bible note", source_tier: 3, lr: 0.4, added_at: "2026-04-15T00:00:00Z", note: "born in Lancs, not Yorks" },
        ],
      },
    },
  };
  const queue = buildEvidenceQueue({
    individuals: fixtureIndividuals,
    kb,
    reviewerFindings: [],
    decisions: {},
  });
  const contradiction = queue.find((q) => q.kind === "evidence_contradiction");
  assert.ok(contradiction, "evidence_contradiction row exists");
  assert.ok(contradiction.triggered_by, "triggered_by populated");
  // Most-recent contradicting entry is the story_contradiction (later added_at)
  assert.equal(contradiction.triggered_by.source, "Family bible note");
  assert.equal(contradiction.triggered_by.source_tier, 3);
  assert.equal(contradiction.triggered_by.kind, "story_contradiction");
  assert.equal(contradiction.triggered_by.note, "born in Lancs, not Yorks");
});
