import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveConfidenceEvidence } from "../../agent/confidenceEvidence.js";

const baseKb = () => ({ confidence_evidence: {} });

describe("deriveConfidenceEvidence — empty inputs", () => {
  test("returns empty arrays when nothing is stored or derivable", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@", kb: baseKb(), reviewerFindings: [], externalSuggestions: { by_individual: {} },
    });
    assert.deepEqual(out.identity, []);
    assert.deepEqual(out.relationship, []);
  });

  test("missing kb is handled gracefully", () => {
    const out = deriveConfidenceEvidence({ id: "@X@" });
    assert.deepEqual(out.identity, []);
    assert.deepEqual(out.relationship, []);
  });
});

describe("deriveConfidenceEvidence — stored evidence", () => {
  test("surfaces stored identity entries unchanged", () => {
    const kb = {
      confidence_evidence: {
        "@X@": {
          identity: [
            { kind: "parish_baptism", lr: 50, source_tier: 1, evidence_group: "g1", source_kind: "decision_accept" },
          ],
        },
      },
    };
    const out = deriveConfidenceEvidence({ id: "@X@", kb });
    assert.equal(out.identity.length, 1);
    assert.equal(out.identity[0].kind, "parish_baptism");
    assert.equal(out.identity[0].source_kind, "decision_accept");
  });

  test("returns empty arrays for an individual not in confidence_evidence", () => {
    const kb = { confidence_evidence: { "@OTHER@": { identity: [{ kind: "parish_baptism", lr: 50 }] } } };
    const out = deriveConfidenceEvidence({ id: "@X@", kb });
    assert.deepEqual(out.identity, []);
  });
});

describe("deriveConfidenceEvidence — reviewer findings", () => {
  test("translates a finding into a negative-LR identity entry", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@",
      kb: baseKb(),
      reviewerFindings: [
        { individual_id: "@X@", kind: "death_before_birth", severity: "error", message: "..." },
      ],
    });
    assert.equal(out.identity.length, 1);
    assert.equal(out.identity[0].source_kind, "reviewer");
    assert.ok(out.identity[0].lr < 1, "negative LR");
  });

  test("relationship-domain finding goes into relationship array", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@",
      kb: baseKb(),
      reviewerFindings: [
        { individual_id: "@X@", kind: "mother_too_young_at_birth", severity: "warning", message: "..." },
      ],
    });
    assert.equal(out.relationship.length, 1);
    assert.equal(out.identity.length, 0);
    assert.ok(out.relationship[0].lr < 1);
  });

  test("ignores findings for other individuals", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@",
      kb: baseKb(),
      reviewerFindings: [
        { individual_id: "@OTHER@", kind: "death_before_birth", severity: "error", message: "..." },
      ],
    });
    assert.equal(out.identity.length, 0);
  });

  test("unknown finding kind is skipped (not in lr table)", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@",
      kb: baseKb(),
      reviewerFindings: [
        { individual_id: "@X@", kind: "made_up_finding", severity: "info", message: "..." },
      ],
    });
    assert.equal(out.identity.length, 0);
    assert.equal(out.relationship.length, 0);
  });
});

describe("deriveConfidenceEvidence — external suggestions", () => {
  test("Tier 3 GEDCOM/WikiTree/FamilySearch suggestions become identity evidence", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@", kb: baseKb(),
      externalSuggestions: {
        by_individual: {
          "@X@": [
            { source_kind: "wikitree", external_id: "Foo-1" },
            { source_kind: "familysearch", external_id: "ABC-XYZ" },
            { source_kind: "gedcom", external_id: "@G1@" },
          ],
        },
      },
    });
    assert.equal(out.identity.length, 3);
    assert.equal(out.identity[0].source_tier, 3);
    assert.ok(out.identity[0].lr > 1 && out.identity[0].lr < 2, "Tier 3 LRs are mild");
  });

  test("TNA catalogue refs are NOT identity evidence (they're catalogue pointers)", () => {
    const out = deriveConfidenceEvidence({
      id: "@X@", kb: baseKb(),
      externalSuggestions: {
        by_individual: {
          "@X@": [{ source_kind: "tna", catalogue_ref: "PROB 11/123" }],
        },
      },
    });
    assert.equal(out.identity.length, 0);
  });
});

describe("deriveConfidenceEvidence — mixed", () => {
  test("combines stored + reviewer + external into single arrays", () => {
    const kb = {
      confidence_evidence: {
        "@X@": {
          identity: [{ kind: "parish_baptism", lr: 50, source_tier: 1, source_kind: "decision_accept" }],
        },
      },
    };
    const out = deriveConfidenceEvidence({
      id: "@X@", kb,
      reviewerFindings: [
        { individual_id: "@X@", kind: "lifespan_implausible", severity: "warning", message: "..." },
      ],
      externalSuggestions: {
        by_individual: { "@X@": [{ source_kind: "wikitree", external_id: "F-1" }] },
      },
    });
    // 1 stored + 1 reviewer + 1 external = 3 identity entries
    assert.equal(out.identity.length, 3);
    const sources = out.identity.map((e) => e.source_kind).sort();
    assert.deepEqual(sources, ["decision_accept", "external_suggestion", "reviewer"]);
  });
});
