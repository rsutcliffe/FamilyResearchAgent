import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcileSiblings } from "../../agent/siblingReconciliation.js";

const baseInd = (overrides) => ({
  warnings: [], alerts: [], fams: [], famc: null, confidence: "C", ...overrides,
});

const familyOf = (kids) => [
  { id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: kids },
];

const individualsFor = (kids) => [
  baseInd({ id: "@DAD@", name: "Dad", sex: "M", birth_year: 1750, fams: ["@F1@"] }),
  baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1755, fams: ["@F1@"] }),
  ...kids.map((id, i) => baseInd({ id, name: `Kid ${i + 1}`, birth_year: 1780 + i, famc: "@F1@" })),
];

describe("reconcileSiblings", () => {
  test("returns null when family doesn't exist", () => {
    assert.equal(reconcileSiblings({ familyId: "@NOPE@", individuals: [], families: [], evidenceLog: {}, decisions: {} }), null);
  });

  test("returns 0 corroboration when no siblings have been researched", () => {
    const kids = ["@K1@", "@K2@", "@K3@"];
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor(kids),
      families: familyOf(kids),
      evidenceLog: {},
      decisions: {},
    });
    assert.equal(r.total_siblings, 3);
    assert.deepEqual(r.unresearched.sort(), kids);
    assert.equal(r.accepted_count, 0);
    assert.equal(r.corroboration_strength, "none");
  });

  test("counts siblings with accepted decisions as corroborators", () => {
    const kids = ["@K1@", "@K2@", "@K3@"];
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor(kids),
      families: familyOf(kids),
      evidenceLog: {
        "@K1@": { runs: [{ agent_result: "..." }] },
        "@K2@": { runs: [{ agent_result: "..." }] },
        "@K3@": { runs: [{ agent_result: "..." }] },
      },
      decisions: {
        "@K1@": { action: "accepted" },
        "@K2@": { action: "accepted" },
        // K3 researched but not yet decided
      },
    });
    assert.equal(r.researched.length, 3);
    assert.equal(r.accepted_count, 2);
    assert.equal(r.corroboration_strength, "strong"); // 2+ accepted = strong
  });

  test("single accepted sibling = weak corroboration (one source)", () => {
    const kids = ["@K1@", "@K2@"];
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor(kids),
      families: familyOf(kids),
      evidenceLog: { "@K1@": { runs: [{ agent_result: "" }] } },
      decisions: { "@K1@": { action: "accepted" } },
    });
    assert.equal(r.accepted_count, 1);
    assert.equal(r.corroboration_strength, "weak");
  });

  test("rejected and flagged decisions don't count toward corroboration", () => {
    const kids = ["@K1@", "@K2@", "@K3@"];
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor(kids),
      families: familyOf(kids),
      evidenceLog: {
        "@K1@": { runs: [{}] }, "@K2@": { runs: [{}] }, "@K3@": { runs: [{}] },
      },
      decisions: {
        "@K1@": { action: "rejected" },
        "@K2@": { action: "flagged" },
        "@K3@": { action: "accepted" },
      },
    });
    assert.equal(r.accepted_count, 1);
    assert.equal(r.corroboration_strength, "weak");
  });

  test("includes per-sibling status for the UI to render", () => {
    const kids = ["@K1@", "@K2@"];
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor(kids),
      families: familyOf(kids),
      evidenceLog: { "@K1@": { runs: [{}] } },
      decisions: { "@K1@": { action: "accepted" } },
    });
    assert.equal(r.siblings.length, 2);
    const k1 = r.siblings.find((s) => s.id === "@K1@");
    assert.equal(k1.researched, true);
    assert.equal(k1.decision, "accepted");
    const k2 = r.siblings.find((s) => s.id === "@K2@");
    assert.equal(k2.researched, false);
    assert.equal(k2.decision, null);
  });

  test("ignores siblings with no birth_year — only count those for whom research is meaningful", () => {
    // v1 keeps all listed children in the report. Filtering by birth_year
    // is a v2 concern; document the v1 behaviour explicitly.
    const kids = ["@K1@", "@K2@"];
    const inds = individualsFor(kids);
    inds.find((i) => i.id === "@K2@").birth_year = null;
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: inds,
      families: familyOf(kids),
      evidenceLog: {},
      decisions: {},
    });
    assert.equal(r.total_siblings, 2);
  });

  test("an empty children array reports zero siblings", () => {
    const r = reconcileSiblings({
      familyId: "@F1@",
      individuals: individualsFor([]),
      families: familyOf([]),
      evidenceLog: {},
      decisions: {},
    });
    assert.equal(r.total_siblings, 0);
    assert.equal(r.corroboration_strength, "none");
  });
});
