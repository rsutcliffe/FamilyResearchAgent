import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performImport } from "../../agent/externalImport.js";

const ourTree = [
  {
    id: "@OUR_ANN@",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire",
    confidence: "D",
  },
];

const gedcomA = `0 @I1@ INDI
1 NAME Ann /Sweeting/
1 SEX F
1 BIRT
2 DATE 14 MAR 1802
2 PLAC Monk Fryston, Yorkshire, England
0 @I2@ INDI
1 NAME Joseph /Sweeting/
1 SEX M
1 BIRT
2 DATE 1798
2 PLAC Monk Fryston
0 TRLR`;

describe("performImport", () => {
  test("matches Ann to our Ann Sweeting and adds source/timestamp metadata", () => {
    const { suggestions, summary } = performImport({
      gedcomText: gedcomA,
      filename: "ancestry.ged",
      ourTree,
      currentSuggestions: null,
    });

    assert.equal(summary.filename, "ancestry.ged");
    assert.equal(summary.individual_count, 2);
    assert.equal(summary.matched_count, 1);
    assert.equal(summary.unmatched_count, 1);

    const annMatches = suggestions.by_individual["@OUR_ANN@"];
    assert.ok(annMatches, "Ann should have matches");
    assert.equal(annMatches.length, 1);
    assert.equal(annMatches[0].external_source_file, "ancestry.ged");
    assert.ok(annMatches[0].imported_at, "imported_at timestamp present");

    const joseph = suggestions.unmatched.find((u) => u.name === "Joseph Sweeting");
    assert.ok(joseph, "Joseph should be in unmatched (no matching individual in our tree)");
    assert.equal(joseph.external_source_file, "ancestry.ged");
  });

  test("incremental imports preserve previous data", () => {
    const first = performImport({
      gedcomText: gedcomA,
      filename: "first.ged",
      ourTree,
      currentSuggestions: null,
    });

    const gedcomB = `0 @I1@ INDI
1 NAME Anne /Sweeting/
1 SEX F
1 BIRT
2 DATE 1803
2 PLAC Monks Frystone
0 TRLR`;

    const second = performImport({
      gedcomText: gedcomB,
      filename: "second.ged",
      ourTree,
      currentSuggestions: first.suggestions,
    });

    // Both imports' Ann matches are now stored
    const matches = second.suggestions.by_individual["@OUR_ANN@"];
    assert.equal(matches.length, 2, "both imports' Ann matches preserved");
    assert.ok(matches.some((m) => m.external_source_file === "first.ged"));
    assert.ok(matches.some((m) => m.external_source_file === "second.ged"));

    // Imports list has both entries
    assert.equal(second.suggestions.imports.length, 2);
  });

  test("returns the summary the endpoint will surface to the user", () => {
    const { summary } = performImport({
      gedcomText: gedcomA,
      filename: "x.ged",
      ourTree,
      currentSuggestions: null,
    });
    assert.ok(summary.imported_at);
    assert.equal(typeof summary.matched_count, "number");
    assert.equal(typeof summary.unmatched_count, "number");
    assert.equal(typeof summary.individual_count, "number");
  });

  test("handles empty GEDCOM gracefully", () => {
    const { suggestions, summary } = performImport({
      gedcomText: "",
      filename: "empty.ged",
      ourTree,
      currentSuggestions: null,
    });
    assert.equal(summary.individual_count, 0);
    assert.equal(summary.matched_count, 0);
    assert.equal(summary.unmatched_count, 0);
    assert.deepEqual(suggestions.by_individual, {});
  });
});
