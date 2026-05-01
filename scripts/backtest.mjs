#!/usr/bin/env node
// Backtest the Bayesian confidence accumulator against a curated set of
// synthetic scenarios in data/confidence_backtest_cases.json. Each case
// declares the expected band and a posterior probability range; the
// harness reports pass / fail / drift so you can sanity-check LR
// adjustments before they touch real data.
//
// Run: `node scripts/backtest.mjs` (no args)
// Exit code: 0 if all cases pass, 1 otherwise.

import { accumulateConfidence, loadLrTable } from "../agent/confidence.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(__dirname, "..", "data", "confidence_backtest_cases.json");

const fmtPct = (p) => (p * 100).toFixed(1) + "%";

const main = () => {
  const { cases } = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const lrTable = loadLrTable();
  const priors = lrTable.name_rarity_prior_probabilities;

  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(`\nBacktest: ${cases.length} cases\n${"-".repeat(60)}`);

  for (const c of cases) {
    const priorProbability = priors[c.prior_kind];
    if (priorProbability == null) {
      console.log(`✗ ${c.name}\n    invalid prior_kind: ${c.prior_kind}`);
      failed += 1;
      failures.push(c.name);
      continue;
    }

    const out = accumulateConfidence({ priorProbability, evidence: c.evidence });

    const bandOk = out.band === c.expected_band;
    const minOk = c.expected_posterior_min == null || out.posterior >= c.expected_posterior_min;
    const maxOk = c.expected_posterior_max == null || out.posterior <= c.expected_posterior_max;

    const ok = bandOk && minOk && maxOk;
    if (ok) {
      passed += 1;
      console.log(`✓ ${c.name}`);
      console.log(`    posterior=${fmtPct(out.posterior)} band=${out.band} (prior ${c.prior_kind}=${fmtPct(priorProbability)}, ${out.contributions.length} contribution${out.contributions.length === 1 ? "" : "s"})`);
    } else {
      failed += 1;
      failures.push(c.name);
      console.log(`✗ ${c.name}`);
      console.log(`    posterior=${fmtPct(out.posterior)} band=${out.band}`);
      if (!bandOk) console.log(`    expected band=${c.expected_band}, got ${out.band}`);
      if (!minOk) console.log(`    posterior below expected_min ${fmtPct(c.expected_posterior_min)}`);
      if (!maxOk) console.log(`    posterior above expected_max ${fmtPct(c.expected_posterior_max)}`);
    }
  }

  console.log(`${"-".repeat(60)}\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailing cases:\n  ${failures.join("\n  ")}`);
    console.log("\nIf these failures are persistent, adjust the LR table in data/confidence_lrs.json.");
    console.log("Do NOT loosen the test cases to mask a misbehaving table.\n");
    process.exit(1);
  }
};

main();
