import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildKbContextBody } from "../../agent/researchKb.js";

const ourIndividual = {
  id: "@OUR_ANN@",
  name: "Ann Sweeting",
  sex: "F",
  birth_year: 1802,
  birth_place: "Monks Frystone, Yorkshire",
  confidence: "D",
  famc: null,
  fams: [],
};

const baseKb = () => ({
  known_parishes: {},
  naming_pattern_warnings: [],
  negative_searches: [],
  confirmed_relatives: {},
  migration_routes: [],
  alias_registry: {},
  reresearch_recommended: {},
  external_suggestions: { by_individual: {}, unmatched: [], imports: [] },
});

describe("buildKbContextBody — external_suggestions section", () => {
  test("section is omitted when no external suggestions exist", () => {
    const kb = baseKb();
    const body = buildKbContextBody(kb, ourIndividual, [], [], {});
    // Should not contain the section header
    assert.ok(
      !body.includes("external_suggestions"),
      "external_suggestions section should not appear when KB has none",
    );
  });

  test("includes per-individual suggestions when present", () => {
    const kb = baseKb();
    kb.external_suggestions.by_individual["@OUR_ANN@"] = [
      {
        external_id: "@EXT_ANN@",
        external_source_file: "Sutcliffe_Ancestry_export.ged",
        imported_at: "2026-05-01T10:00:00Z",
        confidence: "strong",
        reasons: ["Surname match: Sweeting", "Given name match: Ann", "Birth year close: 1802 vs 1802"],
        external_data: {
          name: "Ann Sweeting",
          birth_year: 1802,
          birth_place: "Monk Fryston, Yorkshire, England",
          death_date: "1865",
          famc: "@EXT_F1@",
          citations: [
            { source_id: "@S1@", page: "WDP149/1/1/3 p.47" },
          ],
        },
      },
    ];

    const body = buildKbContextBody(kb, ourIndividual, [], [], {});
    assert.ok(body.includes("external_suggestions"), "section header present");
    // Must clearly mark Tier 3 / not authoritative
    assert.match(body, /tier\s*3|leads only|not authoritative/i);
    // Includes the external data
    assert.ok(body.includes("Sutcliffe_Ancestry_export.ged"), "source filename surfaced");
    assert.ok(body.includes("strong"), "confidence surfaced");
    assert.ok(body.includes("Monk Fryston"), "external birth place surfaced");
    assert.ok(body.includes("WDP149/1/1/3 p.47"), "external citation surfaced");
  });

  test("multiple matches all listed", () => {
    const kb = baseKb();
    kb.external_suggestions.by_individual["@OUR_ANN@"] = [
      {
        external_id: "@EXT_A@",
        external_source_file: "fileA.ged",
        confidence: "strong",
        reasons: ["a"],
        external_data: { name: "Ann Sweeting", birth_year: 1802, birth_place: "Monk Fryston" },
      },
      {
        external_id: "@EXT_B@",
        external_source_file: "fileB.ged",
        confidence: "medium",
        reasons: ["b"],
        external_data: { name: "Anne Sweeting", birth_year: 1803, birth_place: "Monks Frystone" },
      },
    ];
    const body = buildKbContextBody(kb, ourIndividual, [], [], {});
    assert.ok(body.includes("@EXT_A@"));
    assert.ok(body.includes("@EXT_B@"));
  });

  test("indicates that section is leads-only and never raises a band on its own", () => {
    const kb = baseKb();
    kb.external_suggestions.by_individual["@OUR_ANN@"] = [
      {
        external_id: "@EXT@",
        external_source_file: "x.ged",
        confidence: "strong",
        reasons: ["x"],
        external_data: { name: "Ann Sweeting", birth_year: 1802 },
      },
    ];
    const body = buildKbContextBody(kb, ourIndividual, [], [], {});
    // The agent must understand these are NOT primary evidence
    assert.match(body, /verify|hypothes|never.*primary|tier\s*3/i);
  });
});
