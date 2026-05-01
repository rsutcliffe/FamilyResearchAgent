// TNA Discovery API client — UK National Archives catalogue search.
//
// Free, no auth, but the API requires `Accept: application/json` or it
// returns an HTML error page (learned by probing the live endpoint).
//
// Returns *catalogue pointers* (e.g. "PROB 11/1234 — will of X"), not
// document content. The agent surfaces these via <<EXTERNAL_LOOKUPS>> for
// the user to follow up with a paid certificate request or visit.

const ENDPOINT = "https://discovery.nationalarchives.gov.uk/API/search/v1/records";

export const parseTnaSearchResponse = (raw) => {
  if (!raw || typeof raw !== "object") return [];
  const records = Array.isArray(raw.records) ? raw.records : [];
  return records
    .filter((r) => r.id)
    .map((r) => ({
      id: r.id,
      reference: r.reference || "",
      title: r.title || "",
      description: r.description || "",
      covering_dates: r.coveringDates || "",
      held_by: Array.isArray(r.heldBy) ? r.heldBy.join("; ") : (r.heldBy || ""),
      places: Array.isArray(r.places) ? r.places : [],
      score: r.score ?? null,
      catalogue_url: `https://discovery.nationalarchives.gov.uk/details/r/${r.id}`,
    }));
};

export const searchTnaDiscovery = async ({
  query,
  yearFrom,
  yearTo,
  pageSize = 5,
  fetchImpl = fetch,
} = {}) => {
  if (!query || !query.trim()) return [];
  const params = new URLSearchParams();
  params.set("sps.searchQuery", query.trim());
  params.set("sps.resultsPageSize", String(pageSize));
  // NB: param names are sps.dateRangeFrom / sps.dateRangeTo. The shorter
  // sps.dateFrom / sps.dateTo (mentioned in some third-party docs) trigger
  // a 500 from the live API — verified by probing.
  if (yearFrom) params.set("sps.dateRangeFrom", String(yearFrom));
  if (yearTo) params.set("sps.dateRangeTo", String(yearTo));

  const url = `${ENDPOINT}?${params.toString()}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`TNA Discovery API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return parseTnaSearchResponse(await res.json());
};

export const isTnaDisabled = () => process.env.TNA_DISCOVERY_DISABLE === "1";
