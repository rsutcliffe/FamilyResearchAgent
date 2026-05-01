import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runAncestorAgent } from "./agent/researchAgent.js";
import { exportGedcom } from "./gedcom/writer.js";
import {
  buildKbContextBody,
  applyAgentRunToKb,
  applyAcceptedMatchToKb,
  applyAcceptedCandidateToKb,
  computeNamingPatterns,
  clearReresearchFlag,
  parseNextTimeBlock,
} from "./agent/researchKb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const INDIVIDUALS_FILE = path.join(DATA_DIR, "individuals.json");
const FAMILIES_FILE = path.join(DATA_DIR, "families.json");
const RELATIONSHIPS_FILE = path.join(DATA_DIR, "relationships.json");
const EVIDENCE_LOG_FILE = path.join(DATA_DIR, "evidence_log.json");
const DECISIONS_FILE = path.join(DATA_DIR, "decisions.json");
const ANCESTOR_LOG_FILE = path.join(DATA_DIR, "ancestor_discovery_log.json");
const RESEARCH_KB_FILE = path.join(DATA_DIR, "research_kb.json");
const SOURCE_GEDCOM = path.join(__dirname, "research", "Sutcliffe_CleanTree_v1.ged");
const OUTPUTS_DIR = path.join(__dirname, "outputs");
const PORT = Number(process.env.PORT) || 3000;

// Pricing (USD per million tokens) for cost-visibility display. Defaults are
// claude-sonnet-4-6 list rates as of 2026; override via env vars in .env.
const PRICE_INPUT_PER_M = Number(process.env.PRICE_INPUT_PER_M ?? 3);
const PRICE_OUTPUT_PER_M = Number(process.env.PRICE_OUTPUT_PER_M ?? 15);
const PRICE_CACHE_READ_PER_M = Number(process.env.PRICE_CACHE_READ_PER_M ?? 0.3);
const PRICE_CACHE_WRITE_PER_M = Number(process.env.PRICE_CACHE_WRITE_PER_M ?? 3.75);
const SESSION_CAP_USD = Number(process.env.SESSION_CAP_USD ?? 0); // 0 = no cap

const sessionStartedAt = new Date().toISOString();
let sessionTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
let sessionCost = 0;

const computeCost = (usage = {}) => {
  // input_tokens already includes cache reads + cache writes per Anthropic's
  // billing semantics; subtract them out so we don't double-count.
  const cr = usage.cache_read_input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const baseInput = Math.max(0, (usage.input_tokens ?? 0) - cr - cw);
  const o = usage.output_tokens ?? 0;
  return (
    (baseInput * PRICE_INPUT_PER_M +
      o * PRICE_OUTPUT_PER_M +
      cr * PRICE_CACHE_READ_PER_M +
      cw * PRICE_CACHE_WRITE_PER_M) /
    1_000_000
  );
};

const recordSessionSpend = (usage = {}) => {
  sessionTokens.input += usage.input_tokens ?? 0;
  sessionTokens.output += usage.output_tokens ?? 0;
  sessionTokens.cache_read += usage.cache_read_input_tokens ?? 0;
  sessionTokens.cache_write += usage.cache_creation_input_tokens ?? 0;
  sessionCost += computeCost(usage);
};

const sessionCapHit = () => SESSION_CAP_USD > 0 && sessionCost >= SESSION_CAP_USD;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env, paste your key, and restart.",
  );
  process.exit(2);
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

// Migrate the old single-run-per-individual evidence_log to the new multi-run
// shape. Old: { "@I@": { agent_result, searches, ... } }
// New: { "@I@": { id, name, runs: [{ agent_result, searches, ... }] } }
// Migration is lazy — entries are upgraded on first write that touches them.
const ensureMultiRunShape = (entry) => {
  if (!entry) return null;
  if (Array.isArray(entry.runs)) return entry;
  // Old shape: hoist the run-specific fields into a single-element runs array
  const { id, name, confidence_original, ...runFields } = entry;
  return {
    id,
    name,
    confidence_original,
    runs: [runFields],
  };
};

const latestRun = (entry) => {
  const m = ensureMultiRunShape(entry);
  return m?.runs?.[m.runs.length - 1] ?? null;
};

// Atomic write — temp file then rename — per PRD §8.1.
const writeJsonAtomic = async (file, data) => {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/individuals", async (_req, res) => {
  try {
    const [individuals, evidence, decisions] = await Promise.all([
      readJson(INDIVIDUALS_FILE),
      readJson(EVIDENCE_LOG_FILE),
      readJson(DECISIONS_FILE),
    ]);
    const enriched = individuals.map((p) => {
      const ev = ensureMultiRunShape(evidence[p.id]);
      return {
        ...p,
        researched: Boolean(ev?.runs?.length),
        run_count: ev?.runs?.length ?? 0,
        decision: decisions[p.id]?.decision ?? null,
      };
    });
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/families", async (_req, res) => {
  try {
    res.json(await readJson(FAMILIES_FILE));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/relationships", async (_req, res) => {
  try {
    res.json(await readJson(RELATIONSHIPS_FILE));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update the link-level confidence for a single parent-child relationship.
// This is independent of either individual's own confidence band — it
// describes how well-evidenced THIS LINK is.
app.patch("/api/relationship/:id", async (req, res) => {
  const { confidence, evidence_type, citation } = req.body ?? {};
  if (!["A", "B", "C", "D"].includes(confidence)) {
    res.status(400).json({ error: "confidence must be A|B|C|D" });
    return;
  }
  try {
    const relationships = await readJson(RELATIONSHIPS_FILE);
    const idx = relationships.findIndex((r) => r.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: "relationship not found" });
      return;
    }
    const previous = relationships[idx];
    relationships[idx] = {
      ...previous,
      confidence,
      evidence_type: evidence_type ?? previous.evidence_type ?? null,
      source: citation || previous.source,
      verified_at: new Date().toISOString(),
      override_log: [
        ...(previous.override_log ?? []),
        {
          confidence: previous.confidence,
          source: previous.source,
          verified_at: previous.verified_at,
          changed_at: new Date().toISOString(),
        },
      ],
    };
    await writeJsonAtomic(RELATIONSHIPS_FILE, relationships);
    res.json({ ok: true, relationship: relationships[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GEDCOM export — Stage 4. Produces outputs/Sutcliffe_CleanTree_vN.ged with
// confidence band updates, SOUR records for accepted decisions, and any
// agent-proposed individuals + families appended.
app.post("/api/gedcom/export", async (_req, res) => {
  try {
    const [individuals, families, decisions] = await Promise.all([
      readJson(INDIVIDUALS_FILE),
      readJson(FAMILIES_FILE),
      readJson(DECISIONS_FILE),
    ]);
    const result = exportGedcom({
      sourceGedcomPath: SOURCE_GEDCOM,
      outputDir: OUTPUTS_DIR,
      individuals,
      families,
      decisions,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gedcom/download/:filename", (req, res) => {
  const safe = path.basename(req.params.filename); // prevent path traversal
  const file = path.join(OUTPUTS_DIR, safe);
  res.download(file);
});

app.get("/api/kb", async (_req, res) => {
  try {
    res.json(await readJson(RESEARCH_KB_FILE));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/spend", async (_req, res) => {
  try {
    const [evidence, ancestor] = await Promise.all([
      readJson(EVIDENCE_LOG_FILE),
      readJson(ANCESTOR_LOG_FILE),
    ]);
    let lifetimeTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let lifetimeCost = 0;
    const byIndividual = {};
    const tally = (entries, idKey) => {
      for (const entry of Object.values(entries)) {
        if (!entry?.usage) continue;
        const u = entry.usage;
        lifetimeTokens.input += u.input_tokens ?? 0;
        lifetimeTokens.output += u.output_tokens ?? 0;
        lifetimeTokens.cache_read += u.cache_read_input_tokens ?? 0;
        lifetimeTokens.cache_write += u.cache_creation_input_tokens ?? 0;
        const cost = computeCost(u);
        lifetimeCost += cost;
        const id = entry[idKey];
        if (id) {
          byIndividual[id] = byIndividual[id] ?? {
            input_tokens: 0,
            output_tokens: 0,
            cost: 0,
            runs: 0,
          };
          byIndividual[id].input_tokens += u.input_tokens ?? 0;
          byIndividual[id].output_tokens += u.output_tokens ?? 0;
          byIndividual[id].cost += cost;
          byIndividual[id].runs += 1;
        }
      }
    };
    tally(evidence, "id");
    tally(ancestor, "child_id");
    res.json({
      session: {
        started_at: sessionStartedAt,
        tokens: sessionTokens,
        cost: sessionCost,
        cap: SESSION_CAP_USD,
        cap_hit: sessionCapHit(),
      },
      lifetime: { tokens: lifetimeTokens, cost: lifetimeCost },
      by_individual: byIndividual,
      pricing: {
        input_per_million: PRICE_INPUT_PER_M,
        output_per_million: PRICE_OUTPUT_PER_M,
        cache_read_per_million: PRICE_CACHE_READ_PER_M,
        cache_write_per_million: PRICE_CACHE_WRITE_PER_M,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Latest run only — the UI's default view. Backwards-compatible with older
// callers expecting a flat object: returns { id, name, ...latestRunFields }.
app.get("/api/evidence/:id", async (req, res) => {
  try {
    const evidence = await readJson(EVIDENCE_LOG_FILE);
    const entry = ensureMultiRunShape(evidence[req.params.id]);
    if (!entry) {
      res.json(null);
      return;
    }
    const latest = entry.runs[entry.runs.length - 1] ?? {};
    res.json({
      id: entry.id,
      name: entry.name,
      confidence_original: entry.confidence_original,
      run_count: entry.runs.length,
      paid_lookups: entry.paid_lookups ?? [],
      ...latest,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full run history for an individual — every prior run with its metadata.
app.get("/api/evidence/:id/runs", async (req, res) => {
  try {
    const evidence = await readJson(EVIDENCE_LOG_FILE);
    const entry = ensureMultiRunShape(evidence[req.params.id]);
    res.json(entry?.runs ?? []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE streaming agent endpoint.
app.get("/api/agent/run/:id", async (req, res) => {
  if (sessionCapHit()) {
    res.status(429).json({
      error: `Session spend cap of $${SESSION_CAP_USD.toFixed(2)} reached ($${sessionCost.toFixed(2)} spent). Restart the server to reset, or raise SESSION_CAP_USD in .env.`,
    });
    return;
  }
  const id = req.params.id;
  const individuals = await readJson(INDIVIDUALS_FILE);
  const profile = individuals.find((p) => p.id === id);
  if (!profile) {
    res.status(404).json({ error: "Individual not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  // Build KB context body for this individual using current KB state and
  // any prior runs so the agent can build on its own history.
  const [kb, families, allIndividuals, evidenceLog] = await Promise.all([
    readJson(RESEARCH_KB_FILE),
    readJson(FAMILIES_FILE),
    readJson(INDIVIDUALS_FILE),
    readJson(EVIDENCE_LOG_FILE),
  ]);
  const kbBody = buildKbContextBody(
    kb,
    profile,
    families,
    allIndividuals,
    evidenceLog,
  );

  send({ type: "start", profile });

  await runAgent({
    profile,
    kbBody,
    signal: ac.signal,
    emit: async (event) => {
      send(event);
      if (event.type === "done") {
        recordSessionSpend(event.result.usage);
        try {
          const evidence = await readJson(EVIDENCE_LOG_FILE);
          const existing = ensureMultiRunShape(evidence[id]);
          const runRecord = {
            agent_result: event.result.text,
            searches: event.result.searches,
            search_count: event.result.search_count,
            usage: event.result.usage,
            model: event.result.model,
            stop_reason: event.result.stop_reason,
            searched_at: event.result.completed_at,
            next_time_hypothesis: parseNextTimeBlock(event.result.text),
          };
          evidence[id] = existing
            ? { ...existing, runs: [...existing.runs, runRecord] }
            : {
                id,
                name: profile.name,
                confidence_original: profile.confidence,
                runs: [runRecord],
              };
          await writeJsonAtomic(EVIDENCE_LOG_FILE, evidence);

          // KB: capture negative searches & alias observations from every run;
          // clear re-research flag since this person was just re-researched.
          let kbNext = await readJson(RESEARCH_KB_FILE);
          kbNext = applyAgentRunToKb(kbNext, id, event.result.text);
          kbNext = clearReresearchFlag(kbNext, id);
          await writeJsonAtomic(RESEARCH_KB_FILE, kbNext);

          send({ type: "saved" });
        } catch (e) {
          send({ type: "error", message: `persist failed: ${e.message}` });
        }
      }
    },
  });

  res.end();
});

// Ancestor Discovery — find an unknown parent for a known child.
// /api/ancestor/run/:childId/:role  where role is "father" or "mother".
app.get("/api/ancestor/run/:childId/:role", async (req, res) => {
  if (sessionCapHit()) {
    res.status(429).json({
      error: `Session spend cap of $${SESSION_CAP_USD.toFixed(2)} reached ($${sessionCost.toFixed(2)} spent). Restart the server to reset, or raise SESSION_CAP_USD in .env.`,
    });
    return;
  }
  const { childId, role } = req.params;
  if (!["father", "mother"].includes(role)) {
    res.status(400).json({ error: "role must be father or mother" });
    return;
  }
  const [individuals, families] = await Promise.all([
    readJson(INDIVIDUALS_FILE),
    readJson(FAMILIES_FILE),
  ]);
  const child = individuals.find((p) => p.id === childId);
  if (!child) {
    res.status(404).json({ error: "child not found" });
    return;
  }
  // The other parent (if any), and any siblings, come from the child's FAMC.
  const fam = child.famc ? families.find((f) => f.id === child.famc) : null;
  const otherParentId = fam ? (role === "father" ? fam.wife : fam.husband) : null;
  const otherParent = otherParentId ? individuals.find((p) => p.id === otherParentId) : null;
  const siblings = fam
    ? individuals.filter((p) => fam.children.includes(p.id) && p.id !== childId)
    : [];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  // Build KB context for the ancestor search anchored on the child.
  const [kb, evidenceLog] = await Promise.all([
    readJson(RESEARCH_KB_FILE),
    readJson(EVIDENCE_LOG_FILE),
  ]);
  const kbBody = buildKbContextBody(kb, child, families, individuals, evidenceLog);

  send({ type: "start", child, role, otherParent, siblings });

  await runAncestorAgent({
    child,
    role,
    otherParent,
    siblings,
    kbBody,
    signal: ac.signal,
    emit: async (event) => {
      send(event);
      if (event.type === "done") {
        recordSessionSpend(event.result.usage);
        try {
          const log = await readJson(ANCESTOR_LOG_FILE);
          const key = `${childId}:${role}`;
          log[key] = {
            child_id: childId,
            child_name: child.name,
            role,
            other_parent_id: otherParentId,
            agent_result: event.result.text,
            searches: event.result.searches,
            search_count: event.result.search_count,
            usage: event.result.usage,
            model: event.result.model,
            stop_reason: event.result.stop_reason,
            searched_at: event.result.completed_at,
            next_time_hypothesis: parseNextTimeBlock(event.result.text),
          };
          await writeJsonAtomic(ANCESTOR_LOG_FILE, log);

          // KB: ancestor discovery contributes negative searches + alias
          // observations the same way Record Discovery does.
          let kbNext = await readJson(RESEARCH_KB_FILE);
          kbNext = applyAgentRunToKb(kbNext, childId, event.result.text);
          await writeJsonAtomic(RESEARCH_KB_FILE, kbNext);

          send({ type: "saved" });
        } catch (e) {
          send({ type: "error", message: `persist failed: ${e.message}` });
        }
      }
    },
  });

  res.end();
});

// Accept an Ancestor Discovery candidate. Creates a new individual, ensures
// a family record exists with this individual as the named parent of the
// child, and creates a parent-child relationship record at the chosen link
// confidence. All writes are atomic; the new individual gets an ID with a
// distinguishing prefix so agent-proposed people are easy to spot.
app.post("/api/ancestor/accept/:childId/:role", async (req, res) => {
  const { childId, role } = req.params;
  if (!["father", "mother"].includes(role)) {
    res.status(400).json({ error: "role must be father or mother" });
    return;
  }
  const {
    name,
    birth_year,
    birth_place,
    link_confidence,
    link_evidence_type,
    link_citation,
  } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "candidate name is required" });
    return;
  }
  if (!["A", "B", "C"].includes(link_confidence)) {
    res.status(400).json({ error: "link_confidence must be A|B|C" });
    return;
  }
  if (!link_citation?.trim()) {
    res.status(400).json({ error: "link_citation is required (the document binding parent and child)" });
    return;
  }

  try {
    const [individuals, families, relationships] = await Promise.all([
      readJson(INDIVIDUALS_FILE),
      readJson(FAMILIES_FILE),
      readJson(RELATIONSHIPS_FILE),
    ]);
    const child = individuals.find((p) => p.id === childId);
    if (!child) {
      res.status(404).json({ error: "child not found" });
      return;
    }

    const ts = Date.now();
    const newIndividualId = `@AGENT_${ts}@`;
    const newIndividual = {
      id: newIndividualId,
      name: name.trim(),
      sex: role === "father" ? "M" : "F",
      birth_year: Number(birth_year) || null,
      birth_date: birth_year ? String(birth_year) : "",
      birth_place: birth_place ?? "",
      death_date: "",
      death_place: "",
      baptism_date: "",
      baptism_place: "",
      famc: null,
      fams: [],
      // Individual confidence starts at C — Ancestor Discovery establishes
      // the LINK; the new person still needs their own Record Discovery run
      // before getting B or A on their own merits.
      confidence: "C",
      score: 0,
      warnings: [
        "Proposed by Ancestor Discovery agent — individual record not yet primary-verified",
      ],
      alerts: [],
      generation: child.generation != null ? child.generation + 1 : null,
      provenance: "agent_proposed",
      proposed_at: new Date().toISOString(),
    };

    // Find or create the child's FAMC family, then attach the new parent.
    let fam = child.famc ? families.find((f) => f.id === child.famc) : null;
    if (!fam) {
      const newFamId = `@AGENT_F_${ts}@`;
      fam = {
        id: newFamId,
        husband: null,
        wife: null,
        children: [childId],
        marriage_date: "",
        marriage_place: "",
      };
      families.push(fam);
      child.famc = newFamId;
    }

    if (role === "father") {
      if (fam.husband && fam.husband !== newIndividualId) {
        res.status(409).json({
          error: `child already has a recorded father (${fam.husband}). Remove the existing assignment before accepting a new one.`,
        });
        return;
      }
      fam.husband = newIndividualId;
    } else {
      if (fam.wife && fam.wife !== newIndividualId) {
        res.status(409).json({
          error: `child already has a recorded mother (${fam.wife}). Remove the existing assignment before accepting a new one.`,
        });
        return;
      }
      fam.wife = newIndividualId;
    }
    newIndividual.fams = [fam.id];

    individuals.push(newIndividual);

    relationships.push({
      id: `${fam.id}-${newIndividualId}-${childId}`,
      family_id: fam.id,
      parent_id: newIndividualId,
      child_id: childId,
      kind: role,
      confidence: link_confidence,
      evidence_type: link_evidence_type ?? null,
      source: link_citation.trim(),
      verified_at: new Date().toISOString(),
      evidence_id: null,
      provenance: "agent_proposed",
    });

    await Promise.all([
      writeJsonAtomic(INDIVIDUALS_FILE, individuals),
      writeJsonAtomic(FAMILIES_FILE, families),
      writeJsonAtomic(RELATIONSHIPS_FILE, relationships),
    ]);

    // KB write: new individual is a confirmed relative of the child; the
    // child's siblings + other parent (if any) get re-research flags.
    try {
      const [evidenceLog, kbCurrent] = await Promise.all([
        readJson(EVIDENCE_LOG_FILE),
        readJson(RESEARCH_KB_FILE),
      ]);
      const kbNext = applyAcceptedCandidateToKb(kbCurrent, {
        newIndividual,
        child,
        role,
        linkCitation: link_citation.trim(),
        families,
        individuals,
        evidenceLog,
      });
      await writeJsonAtomic(RESEARCH_KB_FILE, kbNext);
    } catch (kbErr) {
      console.error("KB update failed on candidate accept:", kbErr);
    }

    res.json({ ok: true, newIndividualId, familyId: fam.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ancestor/log/:childId/:role", async (req, res) => {
  try {
    const log = await readJson(ANCESTOR_LOG_FILE);
    const key = `${req.params.childId}:${req.params.role}`;
    res.json(log[key] ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record a manual / paid lookup the user performed externally (Ancestry,
// Findmypast, etc.). Persists the lookup metadata under the individual's
// paid_lookups array so future runs and the UI know which services have
// already been consulted — preventing duplicate manual work and duplicate
// subscription cost. If outcome === "found", also writes an accepted
// decision, updates the individual's confidence band, and applies the
// usual KB writes (parish, confirmed_relatives, source_efficacy, etc.).
app.post("/api/manual-evidence/:id", async (req, res) => {
  const id = req.params.id;
  const { service, url, query, outcome, citation, new_confidence, note } =
    req.body ?? {};

  if (!["found", "not_found"].includes(outcome)) {
    res.status(400).json({ error: "outcome must be 'found' or 'not_found'" });
    return;
  }
  if (outcome === "found") {
    if (!citation?.title || !citation?.repository || !citation?.reference) {
      res.status(400).json({
        error: "found evidence requires citation.title, citation.repository, citation.reference",
      });
      return;
    }
    if (!["A", "B", "C"].includes(new_confidence)) {
      res.status(400).json({ error: "found evidence requires new_confidence A|B|C" });
      return;
    }
  }

  try {
    const [individuals, evidence] = await Promise.all([
      readJson(INDIVIDUALS_FILE),
      readJson(EVIDENCE_LOG_FILE),
    ]);
    const profile = individuals.find((p) => p.id === id);
    if (!profile) {
      res.status(404).json({ error: "Individual not found" });
      return;
    }

    // 1. Append the lookup record (always, regardless of outcome)
    const existing = ensureMultiRunShape(evidence[id]);
    const entry = existing ?? {
      id,
      name: profile.name,
      confidence_original: profile.confidence,
      runs: [],
    };
    entry.paid_lookups = entry.paid_lookups ?? [];
    entry.paid_lookups.push({
      service: service ?? "manual",
      url: url ?? null,
      query: query ?? null,
      outcome,
      consulted_at: new Date().toISOString(),
      citation: outcome === "found" ? citation : null,
      new_confidence: outcome === "found" ? new_confidence : null,
      note: note ?? null,
    });
    evidence[id] = entry;
    await writeJsonAtomic(EVIDENCE_LOG_FILE, evidence);

    if (outcome !== "found") {
      res.json({ ok: true, recorded: "lookup_only" });
      return;
    }

    // 2. Found: write decision + update band + KB writes (mirrors /api/decision)
    const decisions = await readJson(DECISIONS_FILE);
    const previous = decisions[id];
    decisions[id] = {
      individual_id: id,
      decision: "accepted",
      citation,
      note: note || `Manual evidence from ${service ?? "external lookup"}`,
      previous_confidence: profile.confidence,
      new_confidence,
      decided_at: new Date().toISOString(),
      provenance: "user_manual",
      override_log: previous ? [...(previous.override_log ?? []), previous] : [],
    };
    await writeJsonAtomic(DECISIONS_FILE, decisions);

    const idx = individuals.findIndex((p) => p.id === id);
    if (idx !== -1) {
      individuals[idx] = { ...individuals[idx], confidence: new_confidence };
      await writeJsonAtomic(INDIVIDUALS_FILE, individuals);
    }

    try {
      const [families, kbCurrent, evRefreshed] = await Promise.all([
        readJson(FAMILIES_FILE),
        readJson(RESEARCH_KB_FILE),
        readJson(EVIDENCE_LOG_FILE),
      ]);
      const target = individuals.find((p) => p.id === id);
      const kbNext = applyAcceptedMatchToKb(kbCurrent, {
        individual: target,
        citation,
        newConfidence: new_confidence,
        families,
        individuals,
        evidenceLog: evRefreshed,
      });
      await writeJsonAtomic(RESEARCH_KB_FILE, kbNext);
    } catch (kbErr) {
      console.error("KB update failed on manual evidence:", kbErr);
    }

    res.json({ ok: true, recorded: "lookup_and_decision" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/decision/:id", async (req, res) => {
  const id = req.params.id;
  const { decision, citation, note, new_confidence } = req.body ?? {};
  if (!["accepted", "rejected", "flagged"].includes(decision)) {
    res.status(400).json({ error: "decision must be accepted|rejected|flagged" });
    return;
  }
  if (decision === "accepted") {
    if (!citation?.title || !citation?.repository || !citation?.reference) {
      res.status(400).json({
        error:
          "Accept requires citation.title, citation.repository, citation.reference",
      });
      return;
    }
    if (!["A", "B", "C"].includes(new_confidence)) {
      res.status(400).json({ error: "Accept requires new_confidence in A|B|C" });
      return;
    }
  }
  if (decision === "flagged" && !note?.trim()) {
    res.status(400).json({ error: "Flag requires a note" });
    return;
  }

  try {
    const [decisions, individuals] = await Promise.all([
      readJson(DECISIONS_FILE),
      readJson(INDIVIDUALS_FILE),
    ]);
    const previous = decisions[id];
    decisions[id] = {
      individual_id: id,
      decision,
      citation: decision === "accepted" ? citation : null,
      note: note ?? null,
      previous_confidence: individuals.find((p) => p.id === id)?.confidence ?? null,
      new_confidence: decision === "accepted" ? new_confidence : null,
      decided_at: new Date().toISOString(),
      override_log: previous ? [...(previous.override_log ?? []), previous] : [],
    };
    await writeJsonAtomic(DECISIONS_FILE, decisions);

    if (decision === "accepted") {
      const idx = individuals.findIndex((p) => p.id === id);
      if (idx !== -1) {
        individuals[idx] = { ...individuals[idx], confidence: new_confidence };
        await writeJsonAtomic(INDIVIDUALS_FILE, individuals);
      }

      // KB write: this individual is now a confirmed relative for their
      // family; their parish becomes a known anchor; siblings/parents/
      // children/spouse who've been researched get a re-research flag.
      try {
        const [families, evidenceLog, kbCurrent] = await Promise.all([
          readJson(FAMILIES_FILE),
          readJson(EVIDENCE_LOG_FILE),
          readJson(RESEARCH_KB_FILE),
        ]);
        const target = individuals.find((p) => p.id === id);
        const kbNext = applyAcceptedMatchToKb(kbCurrent, {
          individual: target,
          citation,
          newConfidence: new_confidence,
          families,
          individuals,
          evidenceLog,
        });
        await writeJsonAtomic(RESEARCH_KB_FILE, kbNext);
      } catch (kbErr) {
        // KB update failure is non-fatal — the decision is already saved.
        console.error("KB update failed on accept:", kbErr);
      }
    }
    res.json({ ok: true, decision: decisions[id] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bootstrap KB: if naming_pattern_warnings is empty, derive from individuals.
// One-time on startup; user can re-run by deleting the field in research_kb.json.
(async () => {
  try {
    const kb = await readJson(RESEARCH_KB_FILE);
    if (!kb.naming_pattern_warnings || kb.naming_pattern_warnings.length === 0) {
      const individuals = await readJson(INDIVIDUALS_FILE);
      kb.naming_pattern_warnings = computeNamingPatterns(individuals);
      kb.last_changed_at = new Date().toISOString();
      await writeJsonAtomic(RESEARCH_KB_FILE, kb);
      console.log(
        `KB: bootstrapped naming_pattern_warnings (${kb.naming_pattern_warnings.length} given names appear 3+ times in this tree)`,
      );
    }
  } catch (e) {
    console.error("KB bootstrap failed:", e.message);
  }
})();

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `\nSutcliffe Family Research Agent\n  → http://localhost:${PORT}\n  Press Ctrl+C to stop.\n`,
  );
});
