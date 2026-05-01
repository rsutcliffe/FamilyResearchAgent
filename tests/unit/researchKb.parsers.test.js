import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseNegativeSearchesBlock,
  parseAliasObservationsBlock,
  parseExternalLookups,
  parseNextTimeBlock,
  computeNamingPatterns,
} from "../../agent/researchKb.js";

describe("parseNegativeSearchesBlock", () => {
  test("returns empty array when block is absent", () => {
    assert.deepEqual(parseNegativeSearchesBlock("no block here"), []);
  });

  test("returns empty array when body is NONE", () => {
    const text = `<<NEGATIVE_SEARCHES>>\nNONE\n<</NEGATIVE_SEARCHES>>`;
    assert.deepEqual(parseNegativeSearchesBlock(text), []);
  });

  test("parses one entry per line on the source||query format", () => {
    const text = `prelude\n<<NEGATIVE_SEARCHES>>
FreeBMD||Sweeting birth Monks Frystone 1800 1810
FamilySearch||Ann Sweeting baptism Fryston 1800
<</NEGATIVE_SEARCHES>>
postlude`;
    const result = parseNegativeSearchesBlock(text);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { source: "FreeBMD", query: "Sweeting birth Monks Frystone 1800 1810" });
    assert.deepEqual(result[1], { source: "FamilySearch", query: "Ann Sweeting baptism Fryston 1800" });
  });

  test("ignores empty lines and skips lines without separator", () => {
    const text = `<<NEGATIVE_SEARCHES>>

FreeBMD||a query

malformed line no separator

FamilySearch||another
<</NEGATIVE_SEARCHES>>`;
    const result = parseNegativeSearchesBlock(text);
    assert.equal(result.length, 2);
  });

  test("handles null/undefined input gracefully", () => {
    assert.deepEqual(parseNegativeSearchesBlock(null), []);
    assert.deepEqual(parseNegativeSearchesBlock(undefined), []);
    assert.deepEqual(parseNegativeSearchesBlock(""), []);
  });
});

describe("parseAliasObservationsBlock", () => {
  test("returns empty when NONE", () => {
    const text = `<<ALIAS_OBSERVATIONS>>\nNONE\n<</ALIAS_OBSERVATIONS>>`;
    assert.deepEqual(parseAliasObservationsBlock(text), []);
  });

  test("parses standard||variant||source triples", () => {
    const text = `<<ALIAS_OBSERVATIONS>>
Ann Sweeting || Anne Sweeting || FreeBMD birth index Q1 1803
Monk Fryston || Monks Frystone || Wikipedia
<</ALIAS_OBSERVATIONS>>`;
    const result = parseAliasObservationsBlock(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].standard, "Ann Sweeting");
    assert.equal(result[0].variant, "Anne Sweeting");
    assert.equal(result[0].source, "FreeBMD birth index Q1 1803");
  });

  test("source field is optional", () => {
    const text = `<<ALIAS_OBSERVATIONS>>
Ann || Anne
<</ALIAS_OBSERVATIONS>>`;
    const result = parseAliasObservationsBlock(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "");
  });
});

describe("parseExternalLookups", () => {
  test("returns empty when NONE", () => {
    const text = `<<EXTERNAL_LOOKUPS>>\nNONE\n<</EXTERNAL_LOOKUPS>>`;
    assert.deepEqual(parseExternalLookups(text), []);
  });

  test("parses service||url||reason triples", () => {
    const text = `<<EXTERNAL_LOOKUPS>>
Ancestry||https://ancestry.co.uk/search?surname=Sweeting||West Yorkshire baptisms
Findmypast||https://findmypast.co.uk/search/results?firstname=Ann||Yorkshire index
<</EXTERNAL_LOOKUPS>>`;
    const result = parseExternalLookups(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].service, "Ancestry");
    assert.equal(result[0].url, "https://ancestry.co.uk/search?surname=Sweeting");
    assert.equal(result[0].reason, "West Yorkshire baptisms");
  });

  test("skips entries missing service or url", () => {
    const text = `<<EXTERNAL_LOOKUPS>>
||https://example.com||no service
Ancestry||||no url
ValidService||https://valid.com||has both
<</EXTERNAL_LOOKUPS>>`;
    const result = parseExternalLookups(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].service, "ValidService");
  });
});

describe("parseNextTimeBlock", () => {
  test("returns null when NONE", () => {
    assert.equal(parseNextTimeBlock(`<<NEXT_TIME>>\nNONE\n<</NEXT_TIME>>`), null);
  });

  test("returns the body trimmed", () => {
    const text = `<<NEXT_TIME>>
  Try the bishop's transcripts at Borthwick next time.

<</NEXT_TIME>>`;
    assert.equal(
      parseNextTimeBlock(text),
      "Try the bishop's transcripts at Borthwick next time.",
    );
  });

  test("returns null when block absent", () => {
    assert.equal(parseNextTimeBlock("no block"), null);
  });
});

describe("computeNamingPatterns", () => {
  test("flags a given name appearing 3+ times", () => {
    const individuals = [
      { name: "John Smith" },
      { name: "John Jones" },
      { name: "John Brown" },
      { name: "Mary Smith" },
    ];
    const result = computeNamingPatterns(individuals);
    const johnEntry = result.find((w) => w.name === "John");
    assert.ok(johnEntry, "John should be flagged (3 occurrences)");
    assert.equal(johnEntry.count, 3);
    const maryEntry = result.find((w) => w.name === "Mary");
    assert.equal(maryEntry, undefined, "Mary appears only once");
  });

  test("filters out tokens that are also surnames in the dataset", () => {
    // Bentley appears as a middle name once and as a surname elsewhere
    const individuals = [
      { name: "Joseph Bentley" },         // surname
      { name: "Timothy Bentley" },        // surname
      { name: "Michael Bentley" },        // surname
      { name: "John Bentley Smith" },     // Bentley as middle name
      { name: "Mary Bentley Brown" },     // Bentley as middle name
      { name: "Sarah Bentley Jones" },    // Bentley as middle name
    ];
    const result = computeNamingPatterns(individuals);
    const bentleyEntry = result.find((w) => w.name === "Bentley");
    assert.equal(bentleyEntry, undefined, "Bentley is a surname; should not be flagged as a given name");
  });

  test("filters out lowercase and abbreviation tokens", () => {
    const individuals = [
      { name: "ggf John Smith" },
      { name: "ggf Mary Jones" },
      { name: "ggf Robert Brown" },
    ];
    const result = computeNamingPatterns(individuals);
    const ggf = result.find((w) => w.name === "ggf");
    assert.equal(ggf, undefined, "lowercase abbreviation should not be flagged");
  });

  test("handles missing names without crashing", () => {
    const individuals = [{ name: null }, { name: "" }, { name: "John Smith" }];
    const result = computeNamingPatterns(individuals);
    assert.ok(Array.isArray(result));
  });
});
