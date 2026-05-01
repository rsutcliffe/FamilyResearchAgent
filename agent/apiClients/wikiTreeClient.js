// WikiTree API client — public-profile reads, no auth.
//
// Docs: https://github.com/wikitree/wikitree-api
// Endpoint: https://api.wikitree.com/api.php (POST or GET, form-encoded)
//
// Read-only access to public profiles is unauthenticated. Private profiles
// (Trusted-List-only data, living people) need a session — out of scope here.

const ENDPOINT = "https://api.wikitree.com/api.php";

// Fields we ask the API to return per match. Keep this list small — every
// extra field bloats the response, and we only need enough to drive the
// matcher and display the lead.
const FIELDS = [
  "Id",
  "Name",
  "FirstName",
  "MiddleName",
  "LastNameAtBirth",
  "LastNameCurrent",
  "BirthDate",
  "BirthLocation",
  "DeathDate",
  "DeathLocation",
  "Gender",
].join(",");

const yearFromWikiTreeDate = (s) => {
  if (!s || typeof s !== "string") return null;
  // WikiTree dates: "YYYY-MM-DD", "YYYY-00-00", or sometimes just "YYYY".
  const m = s.match(/^(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 100 || y > 2100) return null;
  return y;
};

const sexFromGender = (g) => {
  if (g === "Male") return "M";
  if (g === "Female") return "F";
  return "";
};

const composeName = (m) => {
  const surname = m.LastNameAtBirth || m.LastNameCurrent || "";
  return [m.FirstName, m.MiddleName, surname].filter(Boolean).join(" ").trim();
};

// Pure parser: API response → normalised lead records.
// Exported for unit testing without HTTP.
export const parseWikiTreeSearchResponse = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const top = raw[0];
  if (!top || top.status !== 0) return [];
  const matches = Array.isArray(top.matches) ? top.matches : [];
  return matches.map((m) => ({
    id: m.Name, // WikiTree ID is the human-readable Name field e.g. "Sweeting-12"
    name: composeName(m),
    sex: sexFromGender(m.Gender),
    birth_year: yearFromWikiTreeDate(m.BirthDate),
    birth_date: m.BirthDate || "",
    birth_place: m.BirthLocation || "",
    death_date: m.DeathDate || "",
    death_place: m.DeathLocation || "",
    profile_url: `https://www.wikitree.com/wiki/${m.Name}`,
  }));
};

// HTTP wrapper. fetchImpl is injectable for tests.
export const searchWikiTreePersons = async ({
  givenName,
  surname,
  birthYear,
  birthPlace,
  fetchImpl = fetch,
} = {}) => {
  if (!surname) return [];
  const params = new URLSearchParams({
    action: "searchPerson",
    LastName: surname,
    fields: FIELDS,
    format: "json",
    limit: "10",
  });
  if (givenName) params.set("FirstName", givenName);
  if (birthYear) {
    // Accept ±5 years to forgive minor date drift in our tree.
    params.set("BirthDate", `${birthYear}-00-00`);
    params.set("BirthDateDecade", "5");
  }
  if (birthPlace) params.set("BirthLocation", birthPlace);

  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`WikiTree API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return parseWikiTreeSearchResponse(json);
};

// Disabled-state helper used by the orchestrator.
export const isWikiTreeDisabled = () => process.env.WIKITREE_DISABLE === "1";
