// FamilySearch API client — Tree Person Search via unauthenticated session.
//
// Docs:
//   https://developers.familysearch.org/main/docs/authentication
//   https://www.familysearch.org/developers/docs/api/tree/Tree_Person_Search_resource
//
// Auth model: FamilySearch's `client_credentials` grant requires special
// permission ("not available for general use"). For our needs (read-only
// tree search) the public `unauthenticated_session` grant is sufficient and
// is documented as supporting Person Search. Only a registered app's
// client_id is required (no client_secret).

const TOKEN_URL = "https://api.familysearch.org/cis-web/oauth2/v3/token";
const SEARCH_URL = "https://api.familysearch.org/platform/tree/search";
const TOKEN_TTL_MS = 55 * 60 * 1000; // tokens live ~1h; refresh a bit early

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export const __resetFamilySearchTokenCacheForTests = () => {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
};

const yearFromDate = (s) => {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 100 || y > 2100) return null;
  return y;
};

const sexFromGedcomxType = (t) => {
  if (t === "http://gedcomx.org/Male") return "M";
  if (t === "http://gedcomx.org/Female") return "F";
  return "";
};

const factOfType = (facts, suffix) => {
  if (!Array.isArray(facts)) return null;
  return facts.find((f) => f?.type?.endsWith(suffix)) || null;
};

const personFromEntry = (entry) => {
  const p = entry?.content?.gedcomx?.persons?.[0];
  if (!p) return null;
  const name = p.names?.[0]?.nameForms?.[0]?.fullText || entry.title || "";
  const birth = factOfType(p.facts, "/Birth");
  const death = factOfType(p.facts, "/Death");
  return {
    id: p.id,
    name,
    sex: sexFromGedcomxType(p.gender?.type),
    birth_year: yearFromDate(birth?.date?.original),
    birth_date: birth?.date?.original || "",
    birth_place: birth?.place?.original || "",
    death_date: death?.date?.original || "",
    death_place: death?.place?.original || "",
    score: entry.score ?? null,
    profile_url: `https://www.familysearch.org/tree/person/details/${p.id}`,
  };
};

export const parseFamilySearchResponse = (raw) => {
  if (!raw || typeof raw !== "object") return [];
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return entries.map(personFromEntry).filter(Boolean);
};

const fetchToken = async ({ clientId, fetchImpl, now = Date.now }) => {
  if (cachedToken && cachedTokenExpiresAt > now()) return cachedToken;
  const body = new URLSearchParams({
    grant_type: "unauthenticated_session",
    client_id: clientId,
    ip_address: "127.0.0.1",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`FamilySearch token ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("FamilySearch token response missing access_token");
  cachedToken = json.access_token;
  cachedTokenExpiresAt = now() + TOKEN_TTL_MS;
  return cachedToken;
};

export const searchFamilySearchTree = async ({
  givenName,
  surname,
  birthYear,
  birthPlace,
  clientId,
  fetchImpl = fetch,
  now,
} = {}) => {
  if (!surname) return [];
  if (!clientId) throw new Error("FamilySearch clientId is required");

  const token = await fetchToken({ clientId, fetchImpl, now });

  const params = new URLSearchParams();
  params.set("q.surname", surname);
  if (givenName) params.set("q.givenName", givenName);
  if (birthYear) params.set("q.birthLikeDate", String(birthYear));
  if (birthPlace) params.set("q.birthLikePlace", birthPlace);
  params.set("count", "10");

  const url = `${SEARCH_URL}?${params.toString()}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/x-gedcomx-atom+json",
    },
  });
  if (!res.ok) {
    throw new Error(`FamilySearch search ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return parseFamilySearchResponse(await res.json());
};

export const isFamilySearchDisabled = () => process.env.FAMILYSEARCH_DISABLE === "1";
