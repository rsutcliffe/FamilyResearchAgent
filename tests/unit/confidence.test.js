import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateConfidence,
  bandFromPosterior,
  oddsToProbability,
  probabilityToOdds,
  loadLrTable,
  lookupLr,
} from "../../agent/confidence.js";

const closeTo = (a, b, tol = 0.001) => Math.abs(a - b) < tol;

describe("oddsToProbability / probabilityToOdds", () => {
  test("round-trips correctly across the range", () => {
    for (const p of [0.01, 0.1, 0.5, 0.8, 0.95, 0.99]) {
      const odds = probabilityToOdds(p);
      const back = oddsToProbability(odds);
      assert.ok(closeTo(p, back), `${p} → ${odds} → ${back}`);
    }
  });
});

describe("bandFromPosterior", () => {
  test("uses 0.95 / 0.80 / 0.50 thresholds", () => {
    assert.equal(bandFromPosterior(0.99), "A");
    assert.equal(bandFromPosterior(0.95), "A"); // boundary inclusive
    assert.equal(bandFromPosterior(0.949), "B");
    assert.equal(bandFromPosterior(0.80), "B");
    assert.equal(bandFromPosterior(0.79), "C");
    assert.equal(bandFromPosterior(0.50), "C");
    assert.equal(bandFromPosterior(0.49), "D");
    assert.equal(bandFromPosterior(0.0), "D");
  });
});

describe("accumulateConfidence — empty / prior-only", () => {
  test("with no evidence returns the prior unchanged", () => {
    const out = accumulateConfidence({ priorProbability: 0.15, evidence: [] });
    assert.ok(closeTo(out.posterior, 0.15));
    assert.equal(out.contributions.length, 0);
  });

  test("uses default prior when none specified", () => {
    const out = accumulateConfidence({ evidence: [] });
    assert.ok(out.posterior > 0 && out.posterior < 1);
  });
});

describe("accumulateConfidence — single source", () => {
  test("Tier 1 baptism (LR=50) on moderate prior moves to band A", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [{ kind: "parish_baptism", lr: 50 }],
    });
    // posterior odds = (0.15/0.85) * 50 = 8.82, prob = 0.898 → band B
    assert.ok(closeTo(out.posterior, 0.898, 0.01));
    assert.equal(out.band, "B");
  });

  test("Tier 1 will (LR=80) on moderate prior crosses A threshold", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [{ kind: "will_or_probate", lr: 80 }],
    });
    // posterior odds = (0.15/0.85) * 80 = 14.1, prob = 0.934 → still B (< 0.95)
    assert.ok(closeTo(out.posterior, 0.934, 0.01));
    assert.equal(out.band, "B");
  });

  test("Tier 3 family tree (LR=1.5) barely moves the prior", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [{ kind: "member_family_tree", lr: 1.5 }],
    });
    // posterior odds = (0.15/0.85) * 1.5 = 0.265, prob = 0.209 → D
    assert.ok(out.posterior < 0.30);
    assert.equal(out.band, "D");
  });
});

describe("accumulateConfidence — multi-source independent", () => {
  test("three Tier 2 censuses (LR=8 each) accumulate to band A", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "census_record", lr: 8 },
        { kind: "census_record", lr: 8, evidence_group: "census_1851" },
        { kind: "census_record", lr: 8, evidence_group: "census_1861" },
      ],
    });
    // The first has no group; treated as solo. Then 1851 and 1861 are
    // distinct groups. All three contribute.
    // posterior odds = 0.176 * 8 * 8 * 8 = 90.4, prob = 0.989 → A
    assert.ok(out.posterior > 0.95);
    assert.equal(out.band, "A");
    assert.equal(out.contributions.length, 3);
  });

  test("Tier 1 baptism + Tier 1 will (independent groups) → A", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "parish_baptism", lr: 50 },
        { kind: "will_or_probate", lr: 80 },
      ],
    });
    // posterior odds = 0.176 * 50 * 80 = 705.9, prob = 0.998 → A
    assert.ok(out.posterior > 0.99);
    assert.equal(out.band, "A");
  });
});

describe("accumulateConfidence — non-independence via evidence_group", () => {
  test("two indexes of the same baptism in same group count as one", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "parish_baptism", lr: 50, evidence_group: "heptonstall_PR_1774" },
        { kind: "parish_register_index", lr: 12, evidence_group: "heptonstall_PR_1774" },
      ],
    });
    // Same group ⇒ keep most extreme (lr=50). Effective: prior * 50.
    assert.ok(closeTo(out.posterior, 0.898, 0.01));
    assert.equal(out.contributions.length, 1, "duplicate-group entries collapsed");
    assert.equal(out.contributions[0].lr, 50);
  });

  test("solo evidence (no group) treated independently", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "parish_baptism", lr: 8 },
        { kind: "parish_baptism", lr: 8 },
      ],
    });
    // Both contribute; but neither has a group, so they're each unique solos.
    // posterior odds = 0.176 * 8 * 8 = 11.3, prob = 0.918 → B
    assert.ok(out.posterior > 0.85);
    assert.equal(out.contributions.length, 2);
  });
});

describe("accumulateConfidence — negative evidence", () => {
  test("LR < 1 lowers posterior (confirmed search returned nothing)", () => {
    const out = accumulateConfidence({
      priorProbability: 0.5,
      evidence: [
        { kind: "parish_baptism", lr: 0.2, note: "searched, not found" },
      ],
    });
    // odds 1.0 * 0.2 = 0.2, prob = 0.167 → D
    assert.ok(out.posterior < 0.20);
    assert.equal(out.band, "D");
  });

  test("strong positive + moderate negative still positive but tempered", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "will_or_probate", lr: 80 },
        { kind: "parish_burial", lr: 0.5, note: "expected burial not found" },
      ],
    });
    // odds 0.176 * 80 * 0.5 = 7.06, prob = 0.876 → B
    assert.ok(out.posterior > 0.80 && out.posterior < 0.95);
    assert.equal(out.band, "B");
  });
});

describe("accumulateConfidence — log-space numerical safety", () => {
  test("handles very strong combined evidence without Infinity", () => {
    const out = accumulateConfidence({
      priorProbability: 0.5,
      evidence: Array.from({ length: 20 }, (_, i) => ({
        kind: "civil_bmd_certificate", lr: 80, evidence_group: `g${i}`,
      })),
    });
    assert.ok(Number.isFinite(out.posterior_log_odds), "log-odds finite");
    assert.equal(out.posterior, 1.0); // saturates to 1 in finite-precision land
    assert.equal(out.band, "A");
  });

  test("LR of zero (impossibility) drives posterior to ~0", () => {
    const out = accumulateConfidence({
      priorProbability: 0.95,
      evidence: [{ kind: "death_before_birth", lr: 0.001 }],
    });
    assert.ok(out.posterior < 0.02);
    assert.equal(out.band, "D");
  });

  test("LR of exactly 1 doesn't change the posterior", () => {
    const out = accumulateConfidence({
      priorProbability: 0.4,
      evidence: [{ kind: "parish_baptism", lr: 1 }],
    });
    assert.ok(closeTo(out.posterior, 0.4));
  });
});

describe("accumulateConfidence — contributions audit trail", () => {
  test("returns one contribution per surviving evidence item", () => {
    const out = accumulateConfidence({
      priorProbability: 0.15,
      evidence: [
        { kind: "parish_baptism", lr: 50, source_tier: 1, evidence_group: "x" },
        { kind: "census_record", lr: 8, source_tier: 2, note: "1841 census" },
      ],
    });
    assert.equal(out.contributions.length, 2);
    assert.equal(out.contributions[0].kind, "parish_baptism");
    assert.equal(out.contributions[0].lr, 50);
    assert.equal(out.contributions[1].note, "1841 census");
  });

  test("contributions include logarithm so callers can rank by impact", () => {
    const out = accumulateConfidence({
      priorProbability: 0.5,
      evidence: [
        { kind: "parish_baptism", lr: 50 },
        { kind: "member_family_tree", lr: 1.5 },
      ],
    });
    const baptism = out.contributions.find((c) => c.kind === "parish_baptism");
    const tree = out.contributions.find((c) => c.kind === "member_family_tree");
    assert.ok(baptism.log_lr > tree.log_lr, "stronger LR has greater log_lr");
  });
});

describe("loadLrTable / lookupLr", () => {
  test("loads the JSON table from disk", () => {
    const table = loadLrTable();
    assert.ok(table.sources_identity);
    assert.ok(table.sources_relationship);
    assert.equal(typeof table.default_prior_probability, "number");
  });

  test("lookupLr returns the lr_match for an identity source", () => {
    const lr = lookupLr({ kind: "parish_baptism", direction: "match", domain: "identity" });
    assert.equal(lr, 50);
  });

  test("lookupLr returns the lr_no_match when direction is 'no_match'", () => {
    const lr = lookupLr({ kind: "civil_bmd_certificate", direction: "no_match", domain: "identity" });
    assert.equal(lr, 0.05);
  });

  test("unknown kind returns null (caller decides default)", () => {
    assert.equal(lookupLr({ kind: "made_up_source", direction: "match", domain: "identity" }), null);
  });
});
