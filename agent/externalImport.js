// External GEDCOM import — parses an Ancestry.com (or similar) GEDCOM export
// and matches it against the local tree to surface additional sources and
// candidate ancestors as Tier 3 leads. External data is NEVER promoted to
// primary evidence on import; the agent treats it as a hypothesis to verify.

// ---------- GEDCOM line parser (shared shape with scripts/parse-gedcom.mjs) ----------

const parseLine = (line) => {
  const m = line.match(/^(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return {
    level: Number(m[1]),
    xref: m[2] ?? null,
    tag: m[3],
    value: m[4] ?? "",
    children: [],
  };
};

const parseRecords = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const records = [];
  let current = null;
  const stack = [];
  for (const raw of lines) {
    const node = parseLine(raw);
    if (!node) continue;
    if (node.level === 0) {
      if (current) records.push(current);
      current = node;
      stack[0] = current;
      stack.length = 1;
    } else if (current) {
      const parent = stack[node.level - 1];
      if (!parent) continue;
      parent.children.push(node);
      stack[node.level] = node;
      stack.length = node.level + 1;
    }
  }
  if (current) records.push(current);
  return records;
};

const findChild = (rec, tag) => rec.children.find((c) => c.tag === tag);
const findChildren = (rec, tag) => rec.children.filter((c) => c.tag === tag);

const parseEvent = (rec) => {
  if (!rec) return { date: "", place: "" };
  return {
    date: findChild(rec, "DATE")?.value ?? "",
    place: findChild(rec, "PLAC")?.value ?? "",
  };
};

// Pull a 4-digit year (1500–2099) out of a GEDCOM date string, regardless of
// whether it's prefixed with "Abt.", "Bef.", "Aft.", or any qualifier.
const extractYear = (dateStr) => {
  if (!dateStr) return null;
  const m = dateStr.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
};

// Citations attached to an INDI: both top-level (1 SOUR @S@) and nested
// inside event blocks (1 BIRT / 2 SOUR @S@). All collected per individual.
const collectCitations = (rec) => {
  const citations = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.tag === "SOUR" && child.value?.startsWith("@")) {
        citations.push({
          source_id: child.value,
          page: findChild(child, "PAGE")?.value ?? null,
          quay: findChild(child, "QUAY")?.value ?? null,
        });
      }
      walk(child);
    }
  };
  walk(rec);
  return citations;
};

// Strip the // markers from a GEDCOM NAME field. "Mary Ann /Smith-Jones/" → "Mary Ann Smith-Jones".
const cleanName = (rawName) =>
  String(rawName ?? "")
    .replace(/\//g, "")
    .replace(/\s+/g, " ")
    .trim();

export const parseExternalGedcom = (text) => {
  if (!text) return { individuals: [], families: [], sources: [] };
  const records = parseRecords(text);

  const individuals = [];
  const families = [];
  const sources = [];

  for (const rec of records) {
    if (rec.tag === "INDI" && rec.xref) {
      const nameRec = findChild(rec, "NAME");
      const name = cleanName(nameRec?.value);
      const sex = findChild(rec, "SEX")?.value ?? "";
      const birth = parseEvent(findChild(rec, "BIRT"));
      const death = parseEvent(findChild(rec, "DEAT"));
      const baptism = parseEvent(findChild(rec, "BAPM"));
      const famc = findChild(rec, "FAMC")?.value ?? null;
      const fams = findChildren(rec, "FAMS").map((f) => f.value);

      individuals.push({
        id: rec.xref,
        name,
        sex,
        birth_year: extractYear(birth.date),
        birth_date: birth.date,
        birth_place: birth.place,
        death_date: death.date,
        death_place: death.place,
        baptism_date: baptism.date,
        baptism_place: baptism.place,
        famc,
        fams,
        citations: collectCitations(rec),
      });
    } else if (rec.tag === "FAM" && rec.xref) {
      const husb = findChild(rec, "HUSB")?.value ?? null;
      const wife = findChild(rec, "WIFE")?.value ?? null;
      const children = findChildren(rec, "CHIL").map((c) => c.value);
      const marr = parseEvent(findChild(rec, "MARR"));
      families.push({
        id: rec.xref,
        husband: husb,
        wife,
        children,
        marriage_date: marr.date,
        marriage_place: marr.place,
      });
    } else if (rec.tag === "SOUR" && rec.xref) {
      sources.push({
        id: rec.xref,
        title: findChild(rec, "TITL")?.value ?? "",
        author: findChild(rec, "AUTH")?.value ?? "",
        publisher: findChild(rec, "PUBL")?.value ?? "",
        repo: findChild(rec, "REPO")?.value ?? "",
      });
    }
  }

  return { individuals, families, sources };
};

// ---------- Match algorithm ----------
//
// Score each pair (ours, external) on three axes and return matches ranked by
// overall confidence:
//
//   surname:     exact (or alias) match required — otherwise discard
//   given name:  exact / variant / abbreviation
//   birth year:  same > ±2 > ±5 > out
//   birth place: identical > overlapping tokens > different
//
// Buckets: strong (high agreement on all four) / medium (most agree, some
// flex) / weak (only surname + rough year). Below "medium" is currently
// dropped — too noisy.

const NAME_VARIANTS = {
  ann: ["ann", "anne", "hannah", "annie"],
  hannah: ["hannah", "ann", "anne", "annie"],
  anne: ["anne", "ann", "hannah", "annie"],
  elizabeth: ["elizabeth", "eliza", "bess", "betty", "lizzie", "beth"],
  eliza: ["eliza", "elizabeth", "bess", "betty"],
  bess: ["bess", "elizabeth", "eliza"],
  betty: ["betty", "elizabeth", "eliza"],
  william: ["william", "wm", "will", "bill"],
  wm: ["wm", "william"],
  john: ["john", "jno", "jonathon", "johnny"],
  jno: ["jno", "john"],
  joseph: ["joseph", "jos", "joe"],
  jos: ["jos", "joseph"],
  mary: ["mary", "margt", "polly"],
  margt: ["margt", "margaret", "mary"],
  margaret: ["margaret", "margt", "peggy", "maggie"],
  peggy: ["peggy", "margaret"],
  thomas: ["thomas", "tom", "tommy"],
  richard: ["richard", "dick", "rich"],
  catherine: ["catherine", "kate", "katy", "kitty"],
  sutcliffe: ["sutcliffe", "sutclyffe", "sutcliff", "sootcliffe"],
};

const namesAreVariants = (a, b) => {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  return NAME_VARIANTS[la]?.includes(lb) || NAME_VARIANTS[lb]?.includes(la) || false;
};

const surnameOf = (name) => {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
};

const givenOf = (name) => {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[0] : null;
};

// Token-set similarity for places: "Monks Frystone, Yorkshire" vs
// "Monk Fryston, Yorkshire, England" → high overlap.
const placeOverlap = (a, b) => {
  if (!a || !b) return 0;
  const tok = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[,.]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  // Allow soft matching for parish-name variants (Frystone ≈ Fryston)
  let overlap = 0;
  for (const ta of A) {
    if (B.has(ta)) {
      overlap += 1;
      continue;
    }
    // Levenshtein-1 fuzzy match for parish names
    for (const tb of B) {
      if (Math.abs(ta.length - tb.length) <= 2 && (ta.startsWith(tb.slice(0, 5)) || tb.startsWith(ta.slice(0, 5)))) {
        overlap += 0.5;
        break;
      }
    }
  }
  return overlap / Math.max(A.size, B.size);
};

const yearWithinTolerance = (a, b, tolerance) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tolerance;
};

const scoreMatch = (ours, external) => {
  const reasons = [];
  const ourSurname = surnameOf(ours.name);
  const extSurname = surnameOf(external.name);
  if (!ourSurname || !extSurname) return null;

  const surnameMatch = namesAreVariants(ourSurname, extSurname);
  if (!surnameMatch) return null; // hard requirement
  reasons.push(
    ourSurname.toLowerCase() === extSurname.toLowerCase()
      ? `Surname match: ${ourSurname}`
      : `Surname variant: ${ourSurname} ≈ ${extSurname}`,
  );

  const ourGiven = givenOf(ours.name);
  const extGiven = givenOf(external.name);
  let givenMatch = "none";
  if (ourGiven && extGiven) {
    if (ourGiven.toLowerCase() === extGiven.toLowerCase()) {
      givenMatch = "exact";
      reasons.push(`Given name match: ${ourGiven}`);
    } else if (namesAreVariants(ourGiven, extGiven)) {
      givenMatch = "variant";
      reasons.push(`Given name variant: ${ourGiven} ≈ ${extGiven}`);
    } else {
      givenMatch = "different";
    }
  }

  // Year scoring
  let yearScore = 0;
  if (yearWithinTolerance(ours.birth_year, external.birth_year, 2)) {
    yearScore = 2;
    reasons.push(`Birth year close: ${ours.birth_year} vs ${external.birth_year}`);
  } else if (yearWithinTolerance(ours.birth_year, external.birth_year, 5)) {
    yearScore = 1;
    reasons.push(`Birth year within ±5: ${ours.birth_year} vs ${external.birth_year}`);
  } else if (ours.birth_year != null && external.birth_year != null) {
    return null; // out of tolerance — discard
  }

  const placeScore = placeOverlap(ours.birth_place, external.birth_place);
  if (placeScore >= 0.5) reasons.push(`Birth place overlaps: ${ours.birth_place} ≈ ${external.birth_place}`);

  // Bucket by combined signal
  let confidence = "weak";
  if (givenMatch === "exact" && yearScore === 2 && placeScore >= 0.5) {
    confidence = "strong";
  } else if ((givenMatch === "exact" && yearScore >= 1) || (givenMatch === "variant" && yearScore >= 1 && placeScore >= 0.3)) {
    confidence = "medium";
  } else if (givenMatch === "different") {
    return null; // surname-only is too weak
  }

  return {
    external_id: external.id,
    confidence,
    reasons,
    external_data: external,
  };
};

export const matchExternalIndividuals = (ourTree, externalIndividuals) => {
  const by_individual = {};
  const matchedExtIds = new Set();

  for (const ours of ourTree) {
    const matches = [];
    for (const ext of externalIndividuals) {
      const m = scoreMatch(ours, ext);
      if (m) {
        matches.push(m);
        matchedExtIds.add(ext.id);
      }
    }
    if (matches.length > 0) {
      // Sort: strong > medium > weak
      const rank = { strong: 3, medium: 2, weak: 1 };
      matches.sort((a, b) => rank[b.confidence] - rank[a.confidence]);
      by_individual[ours.id] = matches;
    }
  }

  const unmatched = externalIndividuals.filter((e) => !matchedExtIds.has(e.id));
  return { by_individual, unmatched };
};

// One-shot import: parse GEDCOM, match against our tree, merge into the
// current external_suggestions store. Returns the updated suggestions object
// (caller persists) plus a human-readable summary.
//
// Multiple imports stack: each match record is tagged with source_file +
// imported_at so the agent (and the user reviewing the merge) can see
// where each lead came from.
export const performImport = ({ gedcomText, filename, ourTree, currentSuggestions }) => {
  const parsed = parseExternalGedcom(gedcomText ?? "");
  const { by_individual, unmatched } = matchExternalIndividuals(
    ourTree ?? [],
    parsed.individuals,
  );
  const importedAt = new Date().toISOString();

  const stamp = (m) => ({
    ...m,
    external_source_file: filename,
    imported_at: importedAt,
  });

  const next = JSON.parse(
    JSON.stringify(
      currentSuggestions ?? { by_individual: {}, unmatched: [], imports: [] },
    ),
  );
  next.by_individual = next.by_individual ?? {};
  next.unmatched = next.unmatched ?? [];
  next.imports = next.imports ?? [];

  for (const [ourId, matches] of Object.entries(by_individual)) {
    next.by_individual[ourId] = [
      ...(next.by_individual[ourId] ?? []),
      ...matches.map(stamp),
    ];
  }
  for (const u of unmatched) {
    next.unmatched.push({ ...u, external_source_file: filename, imported_at: importedAt });
  }

  const summary = {
    filename,
    imported_at: importedAt,
    individual_count: parsed.individuals.length,
    matched_count: Object.keys(by_individual).length,
    unmatched_count: unmatched.length,
    family_count: parsed.families.length,
    source_count: parsed.sources.length,
  };
  next.imports.push(summary);

  return { suggestions: next, summary };
};

