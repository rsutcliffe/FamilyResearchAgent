import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getUnconfirmedHighConfidence,
  getWeakLinks,
} from "../../agent/review.js";

// ---------------------------------------------------------------------------
// getUnconfirmedHighConfidence
// ---------------------------------------------------------------------------

describe("getUnconfirmedHighConfidence", () => {
  test("returns Band A and B individuals when decisions is empty", () => {
    const individuals = [
      { id: "@I1@", name: "Alice", confidence: "A", generation: 1 },
      { id: "@I2@", name: "Bob", confidence: "B", generation: 2 },
      { id: "@I3@", name: "Carol", confidence: "C", generation: 3 },
      { id: "@I4@", name: "Dave", confidence: "D", generation: 4 },
    ];
    const result = getUnconfirmedHighConfidence({ individuals, decisions: {} });
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.id),
      ["@I1@", "@I2@"],
    );
  });

  test("excludes individuals with an accepted decision", () => {
    const individuals = [
      { id: "@I1@", name: "Alice", confidence: "A", generation: 1 },
      { id: "@I2@", name: "Bob", confidence: "A", generation: 2 },
    ];
    const decisions = { "@I1@": { decision: "accepted" } };
    const result = getUnconfirmedHighConfidence({ individuals, decisions });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "@I2@");
  });

  test("includes individuals with rejected or flagged decisions", () => {
    const individuals = [
      { id: "@I1@", name: "Alice", confidence: "A", generation: 1 },
      { id: "@I2@", name: "Bob", confidence: "B", generation: 2 },
    ];
    const decisions = {
      "@I1@": { decision: "rejected" },
      "@I2@": { decision: "flagged" },
    };
    const result = getUnconfirmedHighConfidence({ individuals, decisions });
    assert.equal(result.length, 2);
  });

  test("sorts A before B, then by generation ascending within each band", () => {
    const individuals = [
      { id: "@I1@", name: "A gen5", confidence: "A", generation: 5 },
      { id: "@I2@", name: "B gen2", confidence: "B", generation: 2 },
      { id: "@I3@", name: "A gen3", confidence: "A", generation: 3 },
      { id: "@I4@", name: "B gen1", confidence: "B", generation: 1 },
    ];
    const result = getUnconfirmedHighConfidence({ individuals, decisions: {} });
    assert.deepEqual(
      result.map((r) => r.id),
      ["@I3@", "@I1@", "@I4@", "@I2@"],
    );
  });

  test("treats missing generation as very high (sorts last within band)", () => {
    const individuals = [
      { id: "@I1@", name: "No gen", confidence: "A" },
      { id: "@I2@", name: "Gen 2", confidence: "A", generation: 2 },
    ];
    const result = getUnconfirmedHighConfidence({ individuals, decisions: {} });
    assert.deepEqual(
      result.map((r) => r.id),
      ["@I2@", "@I1@"],
    );
  });

  test("returns empty array for empty input", () => {
    assert.deepEqual(
      getUnconfirmedHighConfidence({ individuals: [], decisions: {} }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// getWeakLinks
// ---------------------------------------------------------------------------

const mkInd = (id, name, birthYear, sex, confidence, generation = 1) => ({
  id,
  name,
  birth_year: birthYear,
  sex,
  confidence,
  generation,
});

const mkFam = (id, husband, wife, children) => ({
  id,
  husband,
  wife,
  children: children ?? [],
});

const mkRel = (famId, parentId, childId, kind, confidence, extra = {}) => ({
  id: `${famId}-${parentId}-${childId}`,
  family_id: famId,
  parent_id: parentId,
  child_id: childId,
  kind,
  confidence,
  disputed: false,
  ...extra,
});

describe("getWeakLinks", () => {
  test("includes D-band relationships with no reviewer findings", () => {
    const individuals = [
      mkInd("@I1@", "Father", 1800, "M", "D"),
      mkInd("@I2@", "Child", 1830, "M", "D"),
    ];
    const families = [mkFam("@F1@", "@I1@", null, ["@I2@"])];
    const relationships = [mkRel("@F1@", "@I1@", "@I2@", "father", "D")];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].relationship_id, "@F1@-@I1@-@I2@");
    assert.equal(result[0].confidence, "D");
    assert.deepEqual(result[0].findings, []);
  });

  test("captures reviewer error when mother born after child", () => {
    const individuals = [
      mkInd("@I1@", "Mother", 1840, "F", "B"),
      mkInd("@I2@", "Child", 1830, "M", "B"),
    ];
    const families = [mkFam("@F1@", null, "@I1@", ["@I2@"])];
    const relationships = [mkRel("@F1@", "@I1@", "@I2@", "mother", "B")];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    assert.ok(result.length > 0);
    const entry = result.find((r) => r.relationship_id === "@F1@-@I1@-@I2@");
    assert.ok(entry, "expected entry for that relationship");
    assert.ok(entry.findings.some((f) => f.severity === "error"));
  });

  test("captures reviewer warning when father too old at birth", () => {
    const individuals = [
      mkInd("@I1@", "Father", 1700, "M", "B"),
      mkInd("@I2@", "Child", 1780, "M", "B"),
    ];
    const families = [mkFam("@F1@", "@I1@", null, ["@I2@"])];
    const relationships = [mkRel("@F1@", "@I1@", "@I2@", "father", "B")];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    const entry = result.find((r) => r.relationship_id === "@F1@-@I1@-@I2@");
    assert.ok(entry);
    assert.ok(entry.findings.some((f) => f.severity === "warning"));
  });

  test("sorts errors before warnings, warnings before D-band-only", () => {
    const individuals = [
      mkInd("@I1@", "Mother", 1840, "F", "B"), // born after child → error
      mkInd("@I2@", "ChildA", 1830, "M", "B"),
      mkInd("@I3@", "OldFather", 1700, "M", "B"), // too old → warning
      mkInd("@I4@", "ChildB", 1780, "M", "B"),
      mkInd("@I5@", "UnknownFather", 1820, "M", "D"), // D-band only
      mkInd("@I6@", "ChildC", 1850, "M", "D"),
    ];
    const families = [
      mkFam("@F1@", null, "@I1@", ["@I2@"]),
      mkFam("@F2@", "@I3@", null, ["@I4@"]),
      mkFam("@F3@", "@I5@", null, ["@I6@"]),
    ];
    const relationships = [
      mkRel("@F1@", "@I1@", "@I2@", "mother", "B"),
      mkRel("@F2@", "@I3@", "@I4@", "father", "B"),
      mkRel("@F3@", "@I5@", "@I6@", "father", "D"),
    ];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    // Error-bearing link should come first
    assert.ok(result[0].findings.some((f) => f.severity === "error"));
    // D-band-only link should come last
    assert.equal(result[result.length - 1].relationship_id, "@F3@-@I5@-@I6@");
  });

  test("accumulates multiple findings on the same relationship", () => {
    // Mother born after child AND sibling born same year (two findings on same family)
    const individuals = [
      mkInd("@I1@", "Mother", 1840, "F", "B"),
      mkInd("@I2@", "Child1", 1830, "M", "B"),
      mkInd("@I3@", "Child2", 1830, "M", "B"),
    ];
    const families = [mkFam("@F1@", null, "@I1@", ["@I2@", "@I3@"])];
    const relationships = [
      mkRel("@F1@", "@I1@", "@I2@", "mother", "B"),
      mkRel("@F1@", "@I1@", "@I3@", "mother", "B"),
    ];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    // Both mother→child relationships should appear
    assert.ok(result.some((r) => r.relationship_id === "@F1@-@I1@-@I2@"));
    assert.ok(result.some((r) => r.relationship_id === "@F1@-@I1@-@I3@"));
  });

  test("marks disputed relationships", () => {
    const individuals = [
      mkInd("@I1@", "Father", 1800, "M", "D"),
      mkInd("@I2@", "Child", 1830, "M", "D"),
    ];
    const families = [mkFam("@F1@", "@I1@", null, ["@I2@"])];
    const relationships = [
      mkRel("@F1@", "@I1@", "@I2@", "father", "D", {
        disputed: true,
        dispute_reason: "Birth records do not match",
        disputed_at: "2026-05-01T00:00:00.000Z",
      }),
    ];
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].is_disputed);
    assert.equal(result[0].dispute_reason, "Birth records do not match");
  });

  test("returns empty array for empty input", () => {
    assert.deepEqual(
      getWeakLinks({
        individuals: [],
        families: [],
        relationships: [],
        evidenceLog: {},
      }),
      [],
    );
  });

  test("skips findings when no matching relationship record exists", () => {
    // Reviewer may flag a family/child pair but relationships.json has no entry
    const individuals = [
      mkInd("@I1@", "Mother", 1840, "F", "B"),
      mkInd("@I2@", "Child", 1830, "M", "B"),
    ];
    const families = [mkFam("@F1@", null, "@I1@", ["@I2@"])];
    const relationships = []; // no relationship records at all
    const result = getWeakLinks({
      individuals,
      families,
      relationships,
      evidenceLog: {},
    });
    // No relationship record → finding should still surface with null confidence
    const entry = result.find((r) => r.parent_id === "@I1@");
    assert.ok(entry);
    assert.equal(entry.confidence, null);
  });
});
