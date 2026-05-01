import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimUnmatchedAsDescendant } from "../../agent/externalImport.js";

const baseIndividuals = () => [
  {
    id: "@OUR_ROOT@",
    name: "Test Root",
    sex: "M",
    birth_year: 1972,
    birth_place: "Leeds",
    famc: "@FAM_PARENTS@",
    fams: ["@FAM_MARR@"],
    confidence: "A",
  },
  {
    id: "@OUR_SPOUSE@",
    name: "Test Spouse",
    sex: "F",
    birth_year: 1974,
    famc: null,
    fams: ["@FAM_MARR@"],
    confidence: "B",
  },
];

const baseFamilies = () => [
  { id: "@FAM_PARENTS@", husband: "@PARENT_DAD@", wife: "@PARENT_MUM@", children: ["@OUR_ROOT@"] },
  { id: "@FAM_MARR@", husband: "@OUR_ROOT@", wife: "@OUR_SPOUSE@", children: [] },
];

const baseSuggestions = () => ({
  imports: [],
  by_individual: {},
  unmatched: [
    {
      id: "@EXT_JESS@",
      name: "Jessica Amber Sutcliffe",
      sex: "F",
      birth_year: 1995,
      birth_place: "Leeds",
      external_source_file: "ancestry.ged",
    },
    {
      id: "@EXT_JACOB@",
      name: "Jacob Adam Sutcliffe",
      sex: "M",
      birth_year: 2003,
      external_source_file: "ancestry.ged",
    },
  ],
});

describe("claimUnmatchedAsDescendant", () => {
  test("appends claimed individual to data/individuals.json", () => {
    const out = claimUnmatchedAsDescendant({
      externalId: "@EXT_JESS@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@CLAIMED_JESS@",
      individuals: baseIndividuals(),
      families: baseFamilies(),
      suggestions: baseSuggestions(),
    });
    const jess = out.individuals.find((p) => p.id === "@CLAIMED_JESS@");
    assert.ok(jess, "claimed individual present");
    assert.equal(jess.name, "Jessica Amber Sutcliffe");
    assert.equal(jess.birth_year, 1995);
    assert.equal(jess.famc, "@FAM_MARR@");
    assert.equal(jess.confidence, "B");
    assert.equal(jess.claimed_from_external.external_id, "@EXT_JESS@");
  });

  test("adds claimed individual to target family's children", () => {
    const out = claimUnmatchedAsDescendant({
      externalId: "@EXT_JESS@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@CLAIMED_JESS@",
      individuals: baseIndividuals(),
      families: baseFamilies(),
      suggestions: baseSuggestions(),
    });
    const fam = out.families.find((f) => f.id === "@FAM_MARR@");
    assert.deepEqual(fam.children, ["@CLAIMED_JESS@"]);
  });

  test("removes claimed entry from suggestions.unmatched", () => {
    const out = claimUnmatchedAsDescendant({
      externalId: "@EXT_JESS@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@CLAIMED_JESS@",
      individuals: baseIndividuals(),
      families: baseFamilies(),
      suggestions: baseSuggestions(),
    });
    assert.equal(out.suggestions.unmatched.length, 1);
    assert.equal(out.suggestions.unmatched[0].id, "@EXT_JACOB@");
  });

  test("does NOT mutate the inputs (pure)", () => {
    const ind = baseIndividuals();
    const fam = baseFamilies();
    const sugg = baseSuggestions();
    claimUnmatchedAsDescendant({
      externalId: "@EXT_JESS@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@CLAIMED_JESS@",
      individuals: ind,
      families: fam,
      suggestions: sugg,
    });
    assert.equal(ind.length, 2);
    assert.equal(fam.find((f) => f.id === "@FAM_MARR@").children.length, 0);
    assert.equal(sugg.unmatched.length, 2);
  });

  test("throws when external id is not in unmatched", () => {
    assert.throws(
      () =>
        claimUnmatchedAsDescendant({
          externalId: "@EXT_NOPE@",
          targetFamilyId: "@FAM_MARR@",
          newId: "@C1@",
          individuals: baseIndividuals(),
          families: baseFamilies(),
          suggestions: baseSuggestions(),
        }),
      /Unmatched external id not found/,
    );
  });

  test("throws when target family does not exist", () => {
    assert.throws(
      () =>
        claimUnmatchedAsDescendant({
          externalId: "@EXT_JESS@",
          targetFamilyId: "@FAM_NOPE@",
          newId: "@C1@",
          individuals: baseIndividuals(),
          families: baseFamilies(),
          suggestions: baseSuggestions(),
        }),
      /Family not found/,
    );
  });

  test("throws when newId already exists", () => {
    assert.throws(
      () =>
        claimUnmatchedAsDescendant({
          externalId: "@EXT_JESS@",
          targetFamilyId: "@FAM_MARR@",
          newId: "@OUR_ROOT@",
          individuals: baseIndividuals(),
          families: baseFamilies(),
          suggestions: baseSuggestions(),
        }),
      /already in use/,
    );
  });

  test("can claim multiple from the same family by chaining", () => {
    const r1 = claimUnmatchedAsDescendant({
      externalId: "@EXT_JESS@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@C_JESS@",
      individuals: baseIndividuals(),
      families: baseFamilies(),
      suggestions: baseSuggestions(),
    });
    const r2 = claimUnmatchedAsDescendant({
      externalId: "@EXT_JACOB@",
      targetFamilyId: "@FAM_MARR@",
      newId: "@C_JACOB@",
      individuals: r1.individuals,
      families: r1.families,
      suggestions: r1.suggestions,
    });
    const fam = r2.families.find((f) => f.id === "@FAM_MARR@");
    assert.deepEqual(fam.children, ["@C_JESS@", "@C_JACOB@"]);
    assert.equal(r2.suggestions.unmatched.length, 0);
  });
});
