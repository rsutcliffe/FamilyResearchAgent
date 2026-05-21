import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimsMatrix,
  categorizeKind,
  interpretBand,
  renderDonut,
  renderBandScale,
} from "../../public/claimsMatrix.js";

test("categorizeKind maps known kinds and falls back to Other", () => {
  assert.equal(categorizeKind("parish_baptism"), "Birth / Baptism");
  assert.equal(categorizeKind("census_record"), "Census / Residence");
  assert.equal(categorizeKind("will_or_probate"), "Death / Burial");
  assert.equal(categorizeKind("wikitree_profile"), "Tree corroboration");
  assert.equal(categorizeKind("nonsense_kind"), "Other");
});

test("buildClaimsMatrix groups contributions by claim and orders rows", () => {
  const matrix = buildClaimsMatrix({
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept", note: "St Wilfrid's, 1842" },
      { kind: "census_record", lr: 8, log_lr: 0.9, source_tier: 2, source_kind: "decision_accept", note: "1851 census, Brooklyn" },
      { kind: "wikitree_profile", lr: 1.8, log_lr: 0.26, source_tier: 3, source_kind: "external_suggestion", note: "from wikitree" },
    ],
  });
  assert.equal(matrix.length, 3);
  assert.deepEqual(
    matrix.map((r) => r.claim),
    ["Birth / Baptism", "Census / Residence", "Tree corroboration"],
  );
  assert.equal(matrix[0].details, "St Wilfrid's, 1842");
});

test("buildClaimsMatrix marks status corroborated when 2+ supports in a row", () => {
  const matrix = buildClaimsMatrix({
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
      { kind: "baptism_naming_parents", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
    ],
  });
  assert.equal(matrix[0].status, "corroborated");
});

test("buildClaimsMatrix marks status verified for single Tier 1 row", () => {
  const matrix = buildClaimsMatrix({
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
    ],
  });
  assert.equal(matrix[0].status, "verified");
});

test("buildClaimsMatrix marks status confirmed when decision is accepted", () => {
  const matrix = buildClaimsMatrix({
    contributions: [
      { kind: "census_record", lr: 8, log_lr: 0.9, source_tier: 2, source_kind: "decision_accept" },
    ],
    decision: "accepted",
  });
  assert.equal(matrix[0].status, "confirmed");
});

test("buildClaimsMatrix marks status conflicting on reviewer findings or lr<1", () => {
  const matrixA = buildClaimsMatrix({
    contributions: [
      { kind: "story_contradiction", lr: 0.4, log_lr: -0.4, source_tier: 3, source_kind: "external_suggestion" },
    ],
  });
  assert.equal(matrixA[0].status, "conflicting");

  const matrixB = buildClaimsMatrix({
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
      { kind: "chronology_violation", lr: 0.01, log_lr: -2.0, source_tier: null, source_kind: "reviewer", note: "death predates birth" },
    ],
  });
  // Same claim category? No — chronology_violation maps to Other. Expect 2 rows.
  assert.equal(matrixB.length, 2);
  const otherRow = matrixB.find((r) => r.claim === "Other");
  assert.equal(otherRow.status, "conflicting");
});

test("buildClaimsMatrix weights split contributions by tier", () => {
  const matrix = buildClaimsMatrix({
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
      { kind: "wikitree_profile", lr: 1.8, log_lr: 0.26, source_tier: 3, source_kind: "external_suggestion" },
    ],
  });
  // Two different claims here (Birth and Tree). Each has 1 contribution.
  const birth = matrix.find((r) => r.claim === "Birth / Baptism");
  assert.deepEqual(birth.weights, [{ tier: 1, fraction: 1 }]);
  const tree = matrix.find((r) => r.claim === "Tree corroboration");
  assert.deepEqual(tree.weights, [{ tier: 3, fraction: 1 }]);
});

test("interpretBand produces a one-liner whose lead matches the band", () => {
  assert.match(interpretBand({ band: "A", posterior: 0.95, contributions: [{ lr: 50 }] }), /High-probability match/);
  assert.match(interpretBand({ band: "C", posterior: 0.4, contributions: [] }), /Uncertain/);
  assert.match(
    interpretBand({ band: "B", posterior: 0.85, contributions: [{ lr: 50 }, { lr: 0.1, source_kind: "reviewer" }] }),
    /1 conflict flagged/,
  );
});

test("renderDonut emits an SVG with band letter and percent", () => {
  const html = renderDonut({ band: "B", posterior: 0.854 });
  assert.match(html, /<svg /);
  assert.match(html, />B</);
  assert.match(html, /85\.4%/);
});

test("renderBandScale highlights the active band", () => {
  const html = renderBandScale({ band: "B" });
  assert.match(html, /wb-band-scale-cell active">B</);
  assert.match(html, /wb-band-scale-cell ">A</);
});
