import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchExternalIndividuals } from "../../agent/externalImport.js";

const ourTree = [
  {
    id: "@OUR_ANN@",
    name: "Ann Sweeting",
    sex: "F",
    birth_year: 1802,
    birth_place: "Monks Frystone, Yorkshire",
    confidence: "D",
  },
  {
    id: "@OUR_RICHARD@",
    name: "Richard Sweeting",
    sex: "M",
    birth_year: 1759,
    birth_place: "Brayton, Yorkshire",
    confidence: "C",
  },
  {
    id: "@OUR_HANNAH@",
    name: "Hannah Pickersgill",
    sex: "F",
    birth_year: 1825,
    birth_place: "Kippax, Yorkshire",
    confidence: "B",
  },
];

describe("matchExternalIndividuals", () => {
  test("strong match: same surname + given name + similar year + place", () => {
    const external = [
      {
        id: "@EXT1@",
        name: "Ann Sweeting",
        sex: "F",
        birth_year: 1802,
        birth_place: "Monk Fryston, Yorkshire, England",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    assert.ok(result.by_individual["@OUR_ANN@"]);
    assert.equal(result.by_individual["@OUR_ANN@"].length, 1);
    const m = result.by_individual["@OUR_ANN@"][0];
    assert.equal(m.confidence, "strong");
    assert.equal(m.external_id, "@EXT1@");
  });

  test("medium match: name variant (Ann ↔ Anne) plus close year", () => {
    const external = [
      {
        id: "@EXT2@",
        name: "Anne Sweeting",
        sex: "F",
        birth_year: 1803,
        birth_place: "Monks Frystone",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    const matches = result.by_individual["@OUR_ANN@"];
    assert.ok(matches?.length, "Anne should match Ann");
    assert.equal(matches[0].confidence, "medium");
    assert.match(matches[0].reasons.join(" "), /variant/i);
  });

  test("rejects matches with different surname", () => {
    const external = [
      {
        id: "@EXT3@",
        name: "Ann Smith",
        sex: "F",
        birth_year: 1802,
        birth_place: "Monks Frystone",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    assert.equal(result.by_individual["@OUR_ANN@"], undefined);
    assert.ok(result.unmatched.find((u) => u.id === "@EXT3@"));
  });

  test("rejects matches with birth year out of tolerance", () => {
    // Pre-1837 tolerance is ±5 years; 1820 vs 1802 is 18 years out
    const external = [
      {
        id: "@EXT4@",
        name: "Ann Sweeting",
        sex: "F",
        birth_year: 1820,
        birth_place: "Monks Frystone",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    assert.equal(result.by_individual["@OUR_ANN@"], undefined);
  });

  test("returns multiple candidates when more than one external could match", () => {
    const external = [
      {
        id: "@EXT_A@",
        name: "Ann Sweeting",
        sex: "F",
        birth_year: 1802,
        birth_place: "Monk Fryston",
      },
      {
        id: "@EXT_B@",
        name: "Ann Sweeting",
        sex: "F",
        birth_year: 1804,
        birth_place: "Monks Frystone",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    assert.equal(result.by_individual["@OUR_ANN@"].length, 2);
  });

  test("returns unmatched externals as candidate ancestors", () => {
    const external = [
      {
        id: "@EXT_NEW1@",
        name: "John Sweeting",
        sex: "M",
        birth_year: 1730,
        birth_place: "Brayton, Yorkshire",
      },
      {
        id: "@EXT_NEW2@",
        name: "Mary Sweeting",
        sex: "F",
        birth_year: 1735,
        birth_place: "Brayton, Yorkshire",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    assert.equal(result.unmatched.length, 2);
    assert.ok(result.unmatched.find((u) => u.name === "John Sweeting"));
    assert.ok(result.unmatched.find((u) => u.name === "Mary Sweeting"));
  });

  test("each match includes structured reasons explaining why it matched", () => {
    const external = [
      {
        id: "@EXT@",
        name: "Hannah Pickersgill",
        sex: "F",
        birth_year: 1825,
        birth_place: "Kippax",
      },
    ];
    const result = matchExternalIndividuals(ourTree, external);
    const m = result.by_individual["@OUR_HANNAH@"][0];
    assert.ok(Array.isArray(m.reasons));
    assert.ok(m.reasons.length > 0);
    // Reasons should mention name, year, place (some subset)
    const text = m.reasons.join(" ").toLowerCase();
    assert.ok(/name/.test(text) || /surname/.test(text), `reasons should reference name match: ${text}`);
  });

  test("works with empty external list", () => {
    const result = matchExternalIndividuals(ourTree, []);
    assert.deepEqual(result.by_individual, {});
    assert.deepEqual(result.unmatched, []);
  });

  test("works with empty our tree", () => {
    const external = [{ id: "@E@", name: "X Y", birth_year: 1800, birth_place: "Z" }];
    const result = matchExternalIndividuals([], external);
    assert.deepEqual(result.by_individual, {});
    assert.equal(result.unmatched.length, 1);
  });
});
