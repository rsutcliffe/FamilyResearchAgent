import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseFamilySearchResponse,
  searchFamilySearchTree,
  __resetFamilySearchTokenCacheForTests,
} from "../../agent/apiClients/familySearchClient.js";

// Fixture mirrors the GEDCOM-X Atom JSON shape returned by
// /platform/tree/search. Each entry has score + a gedcomx envelope with
// persons[] holding names, facts (birth/death), and gender.

const FIXTURE = {
  entries: [
    {
      id: "https://api.familysearch.org/platform/tree/persons/L1AB-CDE",
      title: "Ann Sweeting",
      score: 92.4,
      content: {
        gedcomx: {
          persons: [
            {
              id: "L1AB-CDE",
              names: [{ nameForms: [{ fullText: "Ann Sweeting" }] }],
              gender: { type: "http://gedcomx.org/Female" },
              facts: [
                {
                  type: "http://gedcomx.org/Birth",
                  date: { original: "14 March 1802" },
                  place: { original: "Monks Frystone, Yorkshire, England" },
                },
                {
                  type: "http://gedcomx.org/Death",
                  date: { original: "1875" },
                  place: { original: "Leeds, Yorkshire" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      id: "https://api.familysearch.org/platform/tree/persons/L2XY-ZZZ",
      title: "Anne Sweeting",
      score: 80.1,
      content: {
        gedcomx: {
          persons: [
            {
              id: "L2XY-ZZZ",
              names: [{ nameForms: [{ fullText: "Anne Sweeting" }] }],
              gender: { type: "http://gedcomx.org/Female" },
              facts: [
                {
                  type: "http://gedcomx.org/Birth",
                  date: { original: "abt 1803" },
                  place: { original: "Yorkshire" },
                },
              ],
            },
          ],
        },
      },
    },
  ],
};

describe("parseFamilySearchResponse", () => {
  test("returns [] for malformed input", () => {
    assert.deepEqual(parseFamilySearchResponse(null), []);
    assert.deepEqual(parseFamilySearchResponse({}), []);
    assert.deepEqual(parseFamilySearchResponse({ entries: [] }), []);
  });

  test("normalises GEDCOM-X persons into our lead shape", () => {
    const out = parseFamilySearchResponse(FIXTURE);
    assert.equal(out.length, 2);
    const ann = out[0];
    assert.equal(ann.id, "L1AB-CDE");
    assert.equal(ann.name, "Ann Sweeting");
    assert.equal(ann.sex, "F");
    assert.equal(ann.birth_year, 1802);
    assert.equal(ann.birth_date, "14 March 1802");
    assert.equal(ann.birth_place, "Monks Frystone, Yorkshire, England");
    assert.equal(ann.death_date, "1875");
    assert.equal(ann.death_place, "Leeds, Yorkshire");
    assert.match(ann.profile_url, /familysearch\.org\/tree\/person\/details\/L1AB-CDE/);
  });

  test("handles 'abt 1803' fuzzy years", () => {
    const out = parseFamilySearchResponse(FIXTURE);
    assert.equal(out[1].birth_year, 1803);
  });

  test("'http://gedcomx.org/Male' gender → 'M'", () => {
    const r = {
      entries: [
        {
          id: "x",
          score: 1,
          content: {
            gedcomx: {
              persons: [
                {
                  id: "X1",
                  names: [{ nameForms: [{ fullText: "John X" }] }],
                  gender: { type: "http://gedcomx.org/Male" },
                  facts: [],
                },
              ],
            },
          },
        },
      ],
    };
    assert.equal(parseFamilySearchResponse(r)[0].sex, "M");
  });

  test("skips entries with no person data", () => {
    const r = { entries: [{ id: "x", score: 1, content: { gedcomx: { persons: [] } } }] };
    assert.deepEqual(parseFamilySearchResponse(r), []);
  });
});

describe("searchFamilySearchTree", () => {
  test("returns [] without HTTP call when surname is missing", async () => {
    __resetFamilySearchTokenCacheForTests();
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    };
    const out = await searchFamilySearchTree({
      givenName: "Ann",
      clientId: "TEST-CLIENT",
      fetchImpl: fakeFetch,
    });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });

  test("fetches a token then calls Person Search with Bearer auth", async () => {
    __resetFamilySearchTokenCacheForTests();
    const calls = [];
    const fakeFetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes("/cis-web/oauth2/v3/token")) {
        return { ok: true, json: async () => ({ access_token: "TOKEN-123", token_type: "family_search" }) };
      }
      return { ok: true, json: async () => FIXTURE };
    };
    const out = await searchFamilySearchTree({
      givenName: "Ann",
      surname: "Sweeting",
      birthYear: 1802,
      birthPlace: "Yorkshire",
      clientId: "TEST-CLIENT",
      fetchImpl: fakeFetch,
    });
    assert.equal(out.length, 2);
    // Two HTTP calls: token, then search
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/cis-web\/oauth2\/v3\/token$/);
    assert.match(calls[0].opts.body, /grant_type=unauthenticated_session/);
    assert.match(calls[0].opts.body, /client_id=TEST-CLIENT/);
    assert.match(calls[1].url, /\/platform\/tree\/search/);
    assert.match(calls[1].url, /q\.surname=Sweeting/);
    assert.match(calls[1].url, /q\.givenName=Ann/);
    assert.match(calls[1].url, /q\.birthLikeDate=1802/);
    assert.equal(calls[1].opts.headers.Authorization, "Bearer TOKEN-123");
    assert.equal(calls[1].opts.headers.Accept, "application/x-gedcomx-atom+json");
  });

  test("caches tokens across calls within the cache window", async () => {
    __resetFamilySearchTokenCacheForTests();
    let tokenCalls = 0;
    let searchCalls = 0;
    const fakeFetch = async (url) => {
      if (url.includes("/cis-web/oauth2/v3/token")) {
        tokenCalls += 1;
        return { ok: true, json: async () => ({ access_token: "T", token_type: "family_search" }) };
      }
      searchCalls += 1;
      return { ok: true, json: async () => ({ entries: [] }) };
    };
    await searchFamilySearchTree({ surname: "X", clientId: "C", fetchImpl: fakeFetch });
    await searchFamilySearchTree({ surname: "Y", clientId: "C", fetchImpl: fakeFetch });
    assert.equal(tokenCalls, 1, "token reused across calls");
    assert.equal(searchCalls, 2);
  });

  test("throws on non-ok token response", async () => {
    __resetFamilySearchTokenCacheForTests();
    const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "no" });
    await assert.rejects(
      () => searchFamilySearchTree({ surname: "X", clientId: "C", fetchImpl: fakeFetch }),
      /FamilySearch token 401/,
    );
  });
});
