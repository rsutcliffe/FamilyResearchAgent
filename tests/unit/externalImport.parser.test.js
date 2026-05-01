import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseExternalGedcom } from "../../agent/externalImport.js";

const sampleGedcom = `0 HEAD
1 SOUR Ancestry.com
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ann /Sweeting/
1 SEX F
1 BIRT
2 DATE 14 MAR 1802
2 PLAC Monk Fryston, Yorkshire, England
2 SOUR @S1@
3 PAGE WDP149/1/1/3 p.47
1 DEAT
2 DATE 1865
2 PLAC Pontefract, Yorkshire
1 FAMC @F1@
1 SOUR @S1@
2 PAGE WDP149/1/1/3 p.47
0 @I2@ INDI
1 NAME Richard /Sweeting/
1 SEX M
1 BIRT
2 DATE Abt. 1759
2 PLAC Brayton, Yorkshire
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ann /Wainwright/
1 SEX F
1 BIRT
2 DATE 1766
2 PLAC Hillam, Yorkshire
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 MARR
2 DATE 1798
2 PLAC Brayton, Yorkshire
0 @S1@ SOUR
1 TITL West Yorkshire, England, Church of England Baptisms 1813-1910
1 AUTH West Yorkshire Archive Service
1 PUBL Ancestry.com
0 TRLR`;

describe("parseExternalGedcom", () => {
  test("returns empty arrays for empty input", () => {
    const result = parseExternalGedcom("");
    assert.deepEqual(result.individuals, []);
    assert.deepEqual(result.families, []);
    assert.deepEqual(result.sources, []);
  });

  test("parses INDI records with name, sex, birth, death, family pointers", () => {
    const result = parseExternalGedcom(sampleGedcom);
    assert.equal(result.individuals.length, 3);
    const ann = result.individuals.find((i) => i.id === "@I1@");
    assert.equal(ann.name, "Ann Sweeting");
    assert.equal(ann.sex, "F");
    assert.equal(ann.birth_year, 1802);
    assert.equal(ann.birth_date, "14 MAR 1802");
    assert.equal(ann.birth_place, "Monk Fryston, Yorkshire, England");
    assert.equal(ann.death_date, "1865");
    assert.equal(ann.death_place, "Pontefract, Yorkshire");
    assert.equal(ann.famc, "@F1@");
  });

  test("extracts FAM records with husband, wife, children", () => {
    const result = parseExternalGedcom(sampleGedcom);
    assert.equal(result.families.length, 1);
    const fam = result.families[0];
    assert.equal(fam.id, "@F1@");
    assert.equal(fam.husband, "@I2@");
    assert.equal(fam.wife, "@I3@");
    assert.deepEqual(fam.children, ["@I1@"]);
    assert.equal(fam.marriage_date, "1798");
  });

  test("extracts top-level SOUR records", () => {
    const result = parseExternalGedcom(sampleGedcom);
    assert.equal(result.sources.length, 1);
    const src = result.sources[0];
    assert.equal(src.id, "@S1@");
    assert.equal(src.title, "West Yorkshire, England, Church of England Baptisms 1813-1910");
    assert.equal(src.author, "West Yorkshire Archive Service");
    assert.equal(src.publisher, "Ancestry.com");
  });

  test("collects per-individual citations linking to top-level sources", () => {
    const result = parseExternalGedcom(sampleGedcom);
    const ann = result.individuals.find((i) => i.id === "@I1@");
    assert.ok(Array.isArray(ann.citations), "citations should be an array");
    // Ann has SOUR refs both inside BIRT and at the INDI level — both should appear
    assert.ok(ann.citations.length >= 1);
    const cit = ann.citations[0];
    assert.equal(cit.source_id, "@S1@");
    assert.equal(cit.page, "WDP149/1/1/3 p.47");
  });

  test("extracts birth_year from a variety of date formats", () => {
    const variants = `0 @I1@ INDI
1 NAME A /B/
1 BIRT
2 DATE 14 MAR 1802
0 @I2@ INDI
1 NAME C /D/
1 BIRT
2 DATE Abt. 1759
0 @I3@ INDI
1 NAME E /F/
1 BIRT
2 DATE 1845
0 @I4@ INDI
1 NAME G /H/
1 BIRT
2 DATE Bef. 1900
0 @I5@ INDI
1 NAME I /J/
1 BIRT
2 DATE January 1859`;
    const result = parseExternalGedcom(variants);
    const years = result.individuals.map((i) => i.birth_year);
    assert.deepEqual(years, [1802, 1759, 1845, 1900, 1859]);
  });

  test("handles individuals with missing birth data without crashing", () => {
    const minimal = `0 @I1@ INDI
1 NAME Joe /Bloggs/
1 SEX M`;
    const result = parseExternalGedcom(minimal);
    assert.equal(result.individuals.length, 1);
    const joe = result.individuals[0];
    assert.equal(joe.birth_year, null);
    assert.equal(joe.birth_place, "");
  });

  test("strips // markers from the NAME field", () => {
    const text = `0 @I1@ INDI
1 NAME Mary Ann /Smith-Jones/`;
    const result = parseExternalGedcom(text);
    assert.equal(result.individuals[0].name, "Mary Ann Smith-Jones");
  });
});
