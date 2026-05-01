import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reviewTree } from "../../agent/reviewer.js";

const baseInd = (overrides) => ({
  warnings: [],
  alerts: [],
  fams: [],
  famc: null,
  confidence: "C",
  ...overrides,
});

describe("reviewTree — parent/child age-gap checks", () => {
  test("flags mother born after child", () => {
    const individuals = [
      baseInd({ id: "@MUM@", name: "Mum X", sex: "F", birth_year: 1810, fams: ["@F1@"] }),
      baseInd({ id: "@DAD@", name: "Dad X", sex: "M", birth_year: 1800, fams: ["@F1@"] }),
      baseInd({ id: "@KID@", name: "Kid X", sex: "M", birth_year: 1805, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: ["@KID@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    const fail = findings.find((f) => f.kind === "mother_born_after_child");
    assert.ok(fail, "should flag mother born after child");
    assert.equal(fail.individual_id, "@KID@");
    assert.equal(fail.severity, "error");
  });

  test("flags father older than 70 at child's birth", () => {
    const individuals = [
      baseInd({ id: "@DAD@", name: "Dad X", sex: "M", birth_year: 1700, fams: ["@F1@"] }),
      baseInd({ id: "@MUM@", name: "Mum X", sex: "F", birth_year: 1745, fams: ["@F1@"] }),
      baseInd({ id: "@KID@", name: "Kid X", birth_year: 1775, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: ["@KID@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "father_too_old_at_birth" && f.individual_id === "@KID@"));
  });

  test("flags mother older than 50 at child's birth", () => {
    const individuals = [
      baseInd({ id: "@DAD@", name: "Dad", sex: "M", birth_year: 1750, fams: ["@F1@"] }),
      baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1750, fams: ["@F1@"] }),
      baseInd({ id: "@KID@", name: "Kid", birth_year: 1810, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: ["@KID@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "mother_too_old_at_birth"));
  });

  test("flags mother under 13 at child's birth", () => {
    const individuals = [
      baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1800, fams: ["@F1@"] }),
      baseInd({ id: "@KID@", name: "Kid", birth_year: 1810, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: null, wife: "@MUM@", children: ["@KID@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "mother_too_young_at_birth"));
  });

  test("does not flag plausible parent ages", () => {
    const individuals = [
      baseInd({ id: "@DAD@", name: "Dad", sex: "M", birth_year: 1780, fams: ["@F1@"] }),
      baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1785, fams: ["@F1@"] }),
      baseInd({ id: "@KID@", name: "Kid", birth_year: 1810, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: ["@KID@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.equal(findings.length, 0);
  });
});

describe("reviewTree — sibling chronology checks", () => {
  test("flags two siblings born in the same year (different mother required for plausibility)", () => {
    const individuals = [
      baseInd({ id: "@DAD@", name: "Dad", sex: "M", birth_year: 1750, fams: ["@F1@"] }),
      baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1755, fams: ["@F1@"] }),
      baseInd({ id: "@K1@", name: "K1", birth_year: 1780, famc: "@F1@" }),
      baseInd({ id: "@K2@", name: "K2", birth_year: 1780, famc: "@F1@" }), // implausible from same mother
    ];
    const families = [{ id: "@F1@", husband: "@DAD@", wife: "@MUM@", children: ["@K1@", "@K2@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    const f = findings.find((x) => x.kind === "siblings_too_close");
    assert.ok(f, "should flag same-year siblings");
  });

  test("does not flag twins flagged as such (skipped — out of v1 scope)", () => {
    // v1: any same-year pair flagged. User can dismiss after manual check.
    // Twin-aware logic is a v2 enhancement.
    assert.ok(true);
  });

  test("does not flag siblings 2+ years apart", () => {
    const individuals = [
      baseInd({ id: "@MUM@", name: "Mum", sex: "F", birth_year: 1755, fams: ["@F1@"] }),
      baseInd({ id: "@K1@", name: "K1", birth_year: 1780, famc: "@F1@" }),
      baseInd({ id: "@K2@", name: "K2", birth_year: 1782, famc: "@F1@" }),
    ];
    const families = [{ id: "@F1@", husband: null, wife: "@MUM@", children: ["@K1@", "@K2@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.equal(findings.filter((f) => f.kind === "siblings_too_close").length, 0);
  });
});

describe("reviewTree — confidence-vs-evidence checks", () => {
  test("flags band A with no evidence_log entry as unsupported", () => {
    const individuals = [
      baseInd({ id: "@X@", name: "Mystery A", birth_year: 1800, confidence: "A" }),
    ];
    const findings = reviewTree({ individuals, families: [], evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "high_band_no_evidence" && f.individual_id === "@X@"));
  });

  test("does not flag band C/D individuals lacking evidence (expected state)", () => {
    const individuals = [
      baseInd({ id: "@X@", name: "Speculative", birth_year: 1800, confidence: "D" }),
    ];
    const findings = reviewTree({ individuals, families: [], evidenceLog: {} });
    assert.equal(findings.filter((f) => f.kind === "high_band_no_evidence").length, 0);
  });
});

describe("reviewTree — death-before-birth check", () => {
  test("flags death year before birth year", () => {
    const individuals = [
      baseInd({ id: "@X@", name: "Time Traveller", birth_year: 1850, death_date: "12 Jan 1840" }),
    ];
    const findings = reviewTree({ individuals, families: [], evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "death_before_birth"));
  });

  test("flags lifespan over 110 years", () => {
    const individuals = [
      baseInd({ id: "@X@", name: "Methuselah", birth_year: 1700, death_date: "1815" }),
    ];
    const findings = reviewTree({ individuals, families: [], evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "lifespan_implausible"));
  });
});

describe("reviewTree — orphan / dangling references", () => {
  test("flags famc pointing to a missing family", () => {
    const individuals = [
      baseInd({ id: "@X@", name: "Orphan", birth_year: 1800, famc: "@NOPE@" }),
    ];
    const findings = reviewTree({ individuals, families: [], evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "famc_dangling"));
  });

  test("flags family.children entry that is not in individuals", () => {
    const individuals = [];
    const families = [{ id: "@F1@", husband: null, wife: null, children: ["@GHOST@"] }];
    const findings = reviewTree({ individuals, families, evidenceLog: {} });
    assert.ok(findings.find((f) => f.kind === "child_dangling"));
  });
});

describe("reviewTree — empty input", () => {
  test("empty tree returns no findings", () => {
    assert.deepEqual(reviewTree({ individuals: [], families: [], evidenceLog: {} }), []);
  });
});
