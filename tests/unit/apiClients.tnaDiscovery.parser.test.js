import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseTnaSearchResponse,
  searchTnaDiscovery,
} from "../../agent/apiClients/tnaDiscoveryClient.js";

// Fixture is a real (trimmed) response from the live TNA Discovery API at
// /API/search/v1/records. Top level is { records: [...] }; per-record fields
// include id, reference, title, description, coveringDates, heldBy, etc.

const FIXTURE = {
  records: [
    {
      id: "N14005683",
      reference: "SU",
      title:
        "Edmund Whitaker & Son, sizers, cotton spinners and manufacturers, balance sheets etc",
      description: "balance sheets etc",
      coveringDates: "1858-63",
      startDate: "01/01/1858",
      endDate: "31/12/1863",
      numStartDate: 18580101,
      numEndDate: 18631231,
      heldBy: ["West Yorkshire Archive Service, Calderdale"],
      places: [],
      score: 722.8024,
      catalogueLevel: 0,
    },
    {
      id: "C12345",
      reference: "PROB 11/1234/56",
      title: "Will of John Sutcliffe of Halifax, Yorkshire",
      description: "",
      coveringDates: "1789",
      startDate: "01/01/1789",
      endDate: "31/12/1789",
      numStartDate: 17890101,
      numEndDate: 17891231,
      heldBy: ["The National Archives, Kew"],
      places: ["Halifax"],
      score: 510.2,
    },
  ],
};

describe("parseTnaSearchResponse", () => {
  test("returns [] for empty / malformed input", () => {
    assert.deepEqual(parseTnaSearchResponse(null), []);
    assert.deepEqual(parseTnaSearchResponse(undefined), []);
    assert.deepEqual(parseTnaSearchResponse({}), []);
    assert.deepEqual(parseTnaSearchResponse({ records: [] }), []);
  });

  test("normalises records into our lead shape", () => {
    const out = parseTnaSearchResponse(FIXTURE);
    assert.equal(out.length, 2);
    const will = out.find((r) => r.reference === "PROB 11/1234/56");
    assert.ok(will, "Halifax will should be in results");
    assert.equal(will.id, "C12345");
    assert.equal(will.title, "Will of John Sutcliffe of Halifax, Yorkshire");
    assert.equal(will.covering_dates, "1789");
    assert.equal(will.held_by, "The National Archives, Kew");
    assert.match(will.catalogue_url, /discovery\.nationalarchives\.gov\.uk.*C12345/);
  });

  test("collapses multiple heldBy entries into a single string", () => {
    const out = parseTnaSearchResponse({
      records: [
        {
          id: "X1",
          reference: "REF/1",
          title: "Test",
          heldBy: ["TNA", "WYAS Halifax"],
        },
      ],
    });
    assert.equal(out[0].held_by, "TNA; WYAS Halifax");
  });

  test("skips records without an id (defensive)", () => {
    const out = parseTnaSearchResponse({
      records: [
        { reference: "X", title: "no id" },
        { id: "Y1", reference: "Y", title: "has id" },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "Y1");
  });
});

describe("searchTnaDiscovery", () => {
  test("returns [] without HTTP call when query is empty", async () => {
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return { ok: true, json: async () => ({ records: [] }) };
    };
    const out = await searchTnaDiscovery({ query: "", fetchImpl: fakeFetch });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });

  test("sends Accept: application/json and the documented sps.* params", async () => {
    let captured = null;
    const fakeFetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({ records: [] }) };
    };
    await searchTnaDiscovery({
      query: "Sutcliffe Halifax",
      yearFrom: 1800,
      yearTo: 1850,
      fetchImpl: fakeFetch,
    });
    assert.match(captured.url, /API\/search\/v1\/records/);
    assert.match(captured.url, /sps\.searchQuery=Sutcliffe\+Halifax/);
    assert.match(captured.url, /sps\.dateRangeFrom=1800/);
    assert.match(captured.url, /sps\.dateRangeTo=1850/);
    assert.equal(captured.opts.headers.Accept, "application/json");
  });

  test("throws on non-ok HTTP response", async () => {
    const fakeFetch = async () => ({ ok: false, status: 503, text: async () => "down" });
    await assert.rejects(
      () => searchTnaDiscovery({ query: "x", fetchImpl: fakeFetch }),
      /TNA Discovery API 503/,
    );
  });

  test("returns parsed records on a successful response", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => FIXTURE });
    const out = await searchTnaDiscovery({ query: "Sutcliffe", fetchImpl: fakeFetch });
    assert.equal(out.length, 2);
  });
});
