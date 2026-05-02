import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDistribution,
  buildRecentEvidence,
  buildRecentRuns,
  buildEvidenceQueue,
  buildSources,
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

test("buildRecentEvidence flattens, sorts desc, limits", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "parish_baptism", source: "St Wilfrid", source_tier: 1, added_at: "2026-04-01T00:00:00Z" },
          { kind: "story_corroboration", source: "uncle.txt", source_tier: 3, added_at: "2026-05-01T00:00:00Z" },
        ],
      },
      "@2@": {
        identity: [
          { kind: "civil_bmd_certificate", source: "GRO 1842/Q2", source_tier: 1, added_at: "2026-04-15T00:00:00Z" },
        ],
      },
    },
  };
  const r = buildRecentEvidence({ kb, individuals: fixtureIndividuals, limit: 2 });
  assert.equal(r.length, 2);
  assert.equal(r[0].source, "uncle.txt");
  assert.equal(r[0].individual_name, "Alice");
  assert.equal(r[1].source, "GRO 1842/Q2");
});

test("buildRecentEvidence skips entries without added_at", () => {
  const kb = {
    confidence_evidence: {
      "@1@": { identity: [{ kind: "x", source: "y" }] },
    },
  };
  const r = buildRecentEvidence({ kb, individuals: [] });
  assert.equal(r.length, 0);
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

test("buildEvidenceQueue merges 4 sources, dedupes, sorts by severity", () => {
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
    { individual_id: "@4@", kind: "chronology_violation", message: "death predates birth" },
  ];
  const queue = buildEvidenceQueue({
    individuals: fixtureIndividuals,
    kb,
    reviewerFindings,
    decisions,
  });
  assert.equal(queue.length, 4);
  // First should be a high-severity item (flagged or chronology_violation)
  assert.equal(queue[0].severity, "high");
  // All include resolved names
  for (const item of queue) {
    assert.ok(item.individual_name, "must have a name");
  }
});

test("buildSources groups by source string with tier/individual/count", () => {
  const kb = {
    confidence_evidence: {
      "@1@": {
        identity: [
          { kind: "parish_baptism", source: "https://archive/parish/wilfrid", source_tier: 1, added_at: "2026-04-01T00:00:00Z" },
          { kind: "wikitree_profile", source: "https://wikitree/X-1", source_tier: 3, added_at: "2026-03-01T00:00:00Z" },
        ],
      },
      "@2@": {
        identity: [
          { kind: "parish_baptism", source: "https://archive/parish/wilfrid", source_tier: 1, added_at: "2026-05-01T00:00:00Z" },
        ],
      },
    },
  };
  const sources = buildSources({ kb, evidenceLog: {}, individuals: fixtureIndividuals });
  assert.equal(sources.length, 2);
  const wilfrid = sources.find((s) => s.source.includes("wilfrid"));
  assert.equal(wilfrid.citation_count, 2);
  assert.equal(wilfrid.tier, 1);
  assert.equal(wilfrid.individuals.length, 2);
  assert.equal(wilfrid.last_cited, "2026-05-01T00:00:00Z");
  assert.equal(sources[0], wilfrid, "highest count first");
});

test("buildSources walks evidenceLog searches as Tier 3 leads", () => {
  const evidenceLog = {
    "@1@": {
      searched_at: "2026-04-15T00:00:00Z",
      searches: [
        { source: "familysearch.org", query: "John Sutcliffe 1812" },
        "ancestry.com",
      ],
    },
  };
  const sources = buildSources({ kb: {}, evidenceLog, individuals: fixtureIndividuals });
  assert.equal(sources.length, 2);
  assert.equal(sources.every((s) => s.tier === 3), true);
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
