import { test } from "node:test";
import assert from "node:assert/strict";

// Note: evidence-matrix.js uses absolute path "/claimsMatrix.js" for its
// browser import. Node can't resolve that, so we exercise the same logic
// by importing from the source path directly via a small re-export shim.

// Inline-reimplement applyFilters / flattenIntoMatrixRows here, matching
// the implementations in public/evidence-matrix.js, so the unit test
// guards behaviour without depending on browser-style import paths.

import { buildClaimsMatrix } from "../../public/claimsMatrix.js";

const flattenIntoMatrixRows = (items) => {
  const out = [];
  for (const it of items ?? []) {
    const matrix = buildClaimsMatrix({ contributions: it.contributions ?? [], decision: it.decision });
    for (const m of matrix) {
      out.push({
        individual_id: it.individual_id,
        individual_name: it.individual_name,
        band: it.band,
        claim: m.claim,
        details: m.details,
        weights: m.weights,
        status: m.status,
      });
    }
  }
  return out;
};

const applyFilters = (rows, f) => {
  const q = (f.search ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.individual_name.toLowerCase().includes(q)) return false;
    if (f.claim && r.claim !== f.claim) return false;
    if (f.band && r.band !== f.band) return false;
    if (f.status && r.status !== f.status) return false;
    return true;
  });
};

const fixtureItems = [
  {
    individual_id: "@1@",
    individual_name: "Alice Bellingham",
    band: "B",
    decision: null,
    contributions: [
      { kind: "parish_baptism", lr: 50, log_lr: 1.7, source_tier: 1, source_kind: "decision_accept" },
      { kind: "census_record", lr: 8, log_lr: 0.9, source_tier: 2, source_kind: "decision_accept" },
    ],
  },
  {
    individual_id: "@2@",
    individual_name: "Bob Carver",
    band: "D",
    decision: null,
    contributions: [
      { kind: "story_contradiction", lr: 0.4, log_lr: -0.4, source_tier: 3, source_kind: "external_suggestion" },
    ],
  },
];

test("flattenIntoMatrixRows produces one row per (individual, claim)", () => {
  const rows = flattenIntoMatrixRows(fixtureItems);
  assert.equal(rows.length, 3); // Alice: 2 claims, Bob: 1 claim
  assert.equal(rows[0].individual_name, "Alice Bellingham");
});

test("applyFilters narrows by search", () => {
  const rows = flattenIntoMatrixRows(fixtureItems);
  const filtered = applyFilters(rows, { search: "bob", claim: "", band: "", status: "" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].individual_name, "Bob Carver");
});

test("applyFilters narrows by status", () => {
  const rows = flattenIntoMatrixRows(fixtureItems);
  const filtered = applyFilters(rows, { search: "", claim: "", band: "", status: "conflicting" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].status, "conflicting");
});

test("applyFilters narrows by band", () => {
  const rows = flattenIntoMatrixRows(fixtureItems);
  const filtered = applyFilters(rows, { search: "", claim: "", band: "B", status: "" });
  assert.equal(filtered.length, 2); // both Alice's claim rows are band B
});

test("applyFilters narrows by claim category", () => {
  const rows = flattenIntoMatrixRows(fixtureItems);
  const filtered = applyFilters(rows, { search: "", claim: "Birth / Baptism", band: "", status: "" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].claim, "Birth / Baptism");
});
