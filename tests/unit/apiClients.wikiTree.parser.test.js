import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseWikiTreeSearchResponse,
  searchWikiTreePersons,
} from "../../agent/apiClients/wikiTreeClient.js";

// Fixtures shaped after the documented WikiTree searchPerson response.
// https://github.com/wikitree/wikitree-api/blob/main/searchPerson.md

describe("parseWikiTreeSearchResponse", () => {
  test("returns empty array when status indicates failure", () => {
    const out = parseWikiTreeSearchResponse([{ status: 1, matches: [] }]);
    assert.deepEqual(out, []);
  });

  test("returns empty array when matches is missing or empty", () => {
    assert.deepEqual(parseWikiTreeSearchResponse([{ status: 0 }]), []);
    assert.deepEqual(parseWikiTreeSearchResponse([{ status: 0, matches: [] }]), []);
  });

  test("normalises a single match into our external_suggestions shape", () => {
    const raw = [
      {
        status: 0,
        matches: [
          {
            Id: 5185,
            Name: "Sweeting-12",
            FirstName: "Ann",
            LastNameAtBirth: "Sweeting",
            BirthDate: "1802-03-14",
            BirthLocation: "Monks Frystone, Yorkshire, England",
            DeathDate: "1875-00-00",
            DeathLocation: "Leeds, Yorkshire",
            Gender: "Female",
          },
        ],
        total: 1,
      },
    ];
    const [m] = parseWikiTreeSearchResponse(raw);
    assert.equal(m.id, "Sweeting-12");
    assert.equal(m.name, "Ann Sweeting");
    assert.equal(m.birth_year, 1802);
    assert.equal(m.birth_place, "Monks Frystone, Yorkshire, England");
    assert.equal(m.death_date, "1875-00-00");
    assert.equal(m.death_place, "Leeds, Yorkshire");
    assert.equal(m.sex, "F");
    assert.equal(m.profile_url, "https://www.wikitree.com/wiki/Sweeting-12");
  });

  test("handles partial dates (year only) and missing death", () => {
    const raw = [
      {
        status: 0,
        matches: [
          { Id: 1, Name: "Sutcliffe-99", FirstName: "John", LastNameAtBirth: "Sutcliffe", BirthDate: "1750-00-00" },
        ],
      },
    ];
    const [m] = parseWikiTreeSearchResponse(raw);
    assert.equal(m.birth_year, 1750);
    assert.equal(m.death_date, "");
    assert.equal(m.death_place, "");
  });

  test("returns multiple matches in order", () => {
    const raw = [
      {
        status: 0,
        matches: [
          { Id: 1, Name: "Sweeting-1", FirstName: "Ann", LastNameAtBirth: "Sweeting", BirthDate: "1800-00-00" },
          { Id: 2, Name: "Sweeting-2", FirstName: "Anne", LastNameAtBirth: "Sweeting", BirthDate: "1803-00-00" },
        ],
      },
    ];
    const out = parseWikiTreeSearchResponse(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "Sweeting-1");
    assert.equal(out[1].id, "Sweeting-2");
  });

  test("infers Gender 'Male'/'Female' to 'M'/'F'; defaults to empty when missing", () => {
    const raw = [
      {
        status: 0,
        matches: [
          { Id: 1, Name: "X-1", FirstName: "Joe", LastNameAtBirth: "X", BirthDate: "1800-00-00", Gender: "Male" },
          { Id: 2, Name: "X-2", FirstName: "Jane", LastNameAtBirth: "X", BirthDate: "1800-00-00" },
        ],
      },
    ];
    const out = parseWikiTreeSearchResponse(raw);
    assert.equal(out[0].sex, "M");
    assert.equal(out[1].sex, "");
  });

  test("handles null/undefined input gracefully", () => {
    assert.deepEqual(parseWikiTreeSearchResponse(null), []);
    assert.deepEqual(parseWikiTreeSearchResponse(undefined), []);
    assert.deepEqual(parseWikiTreeSearchResponse([]), []);
  });

  test("returns [] without HTTP call when surname is missing", async () => {
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return { ok: true, json: async () => [] };
    };
    const out = await searchWikiTreePersons({ givenName: "Ann", fetchImpl: fakeFetch });
    assert.deepEqual(out, []);
    assert.equal(called, false, "should short-circuit without surname");
  });

  test("posts form-encoded body with searchPerson action and surname", async () => {
    let captured = null;
    const fakeFetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => [
          { status: 0, matches: [{ Id: 1, Name: "Sweeting-12", FirstName: "Ann", LastNameAtBirth: "Sweeting", BirthDate: "1802-03-14" }] },
        ],
      };
    };
    const out = await searchWikiTreePersons({
      givenName: "Ann",
      surname: "Sweeting",
      birthYear: 1802,
      birthPlace: "Yorkshire",
      fetchImpl: fakeFetch,
    });
    assert.equal(out.length, 1);
    assert.equal(captured.url, "https://api.wikitree.com/api.php");
    assert.equal(captured.opts.method, "POST");
    assert.match(captured.opts.body, /action=searchPerson/);
    assert.match(captured.opts.body, /LastName=Sweeting/);
    assert.match(captured.opts.body, /FirstName=Ann/);
    assert.match(captured.opts.body, /BirthDate=1802-00-00/);
  });

  test("throws on non-ok HTTP response", async () => {
    const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(
      () => searchWikiTreePersons({ surname: "X", fetchImpl: fakeFetch }),
      /WikiTree API 500/,
    );
  });

  test("trims trailing zeros from BirthDate when computing year", () => {
    const raw = [
      {
        status: 0,
        matches: [{ Id: 1, Name: "X-1", FirstName: "A", LastNameAtBirth: "X", BirthDate: "1799" }],
      },
    ];
    const [m] = parseWikiTreeSearchResponse(raw);
    assert.equal(m.birth_year, 1799);
  });
});
