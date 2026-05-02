// Document and story ingestion pipeline.
//
// Phase 1: folder scanning (this file). No API calls.
// Phase 2: story extraction via Claude text API.
// Phase 3: document extraction via Claude vision API.
//
// Architecture: each file is identified by a content hash. The ingestion
// log (data/ingestion_log.json) records what's been processed, so re-scanning
// a folder reports per-file status (unprocessed / processed / changed /
// failed). Re-processing the same file is idempotent — confidence_evidence
// entries are keyed off the hash via evidence_group, so repeats collapse.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

// 16 hex chars = 64 bits of hash. Plenty for collision avoidance in a
// personal genealogy folder; short enough to render in a UI tooltip.
const HASH_LENGTH = 16;

const hashContent = (filePath) => {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, HASH_LENGTH);
};

const STORY_EXTENSIONS = [".md", ".txt"];
const DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

// List files in a folder with hash + size. Skips hidden files and
// subdirectories (flat-folder model in v1). Returns [] if the folder
// doesn't exist — the user may simply not have set up that side yet.
export const scanIngestFolder = ({ folderPath, kind, allowedExtensions } = {}) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const exts = allowedExtensions ?? (kind === "story" ? STORY_EXTENSIONS : DOCUMENT_EXTENSIONS);
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!exts.includes(ext)) continue;
    const fullPath = path.join(folderPath, entry.name);
    const stat = fs.statSync(fullPath);
    out.push({
      name: entry.name,
      hash: hashContent(fullPath),
      kind,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  return out;
};

// Build the prompt sent to Claude for one story. The story is plain text;
// the tree is summarised to one line per individual (id, name, year, place)
// to keep the input cheap. ~3–4K tokens for a 150-individual tree, which
// is well within the input budget for a single story extraction.
export const buildStoryExtractionPrompt = ({ storyText, ourTree = [] }) => {
  const treeLines = ourTree
    .map((p) => `${p.id}\t${p.name ?? ""}\tb.${p.birth_year ?? "?"}\t${p.birth_place ?? ""}`)
    .join("\n");
  return `You are reading a personal/family narrative. Identify which individuals from the family tree below are mentioned, and what claims the story makes about each. For each match, list any facts that *corroborate* what we already know (matching dates, places, occupations, relationships) and any that *contradict*.

Return JSON only, with this shape:
{
  "individuals_mentioned": [
    {
      "tree_id": "@I...@",
      "tree_name": "...",
      "match_confidence": "strong" | "medium" | "weak",
      "corroborating_facts": ["..."],
      "contradicting_facts": ["..."]
    }
  ],
  "summary": "1-2 sentence high-level description of what the story is about"
}

match_confidence guide:
  strong = name + at least one date/place explicitly match the tree entry
  medium = name + plausible context but ambiguous date/place
  weak   = name only; could be a different person with the same name

Tree (id\\tname\\tbirth_year\\tbirth_place):
${treeLines}

Story:
${storyText}`;
};

// Robust JSON extraction from Claude's response. Handles fenced ```json
// blocks and bare JSON objects. Returns null on malformed input rather
// than throwing — the caller logs it and marks the file failed.
export const parseStoryExtractionResponse = (text) => {
  if (!text || typeof text !== "string") return null;
  let candidate = null;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    candidate = fenceMatch[1];
  } else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) candidate = text.slice(start, end + 1);
  }
  if (!candidate) return null;
  let parsed;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  // Normalise missing arrays so downstream code doesn't have to defend.
  parsed.individuals_mentioned = (parsed.individuals_mentioned ?? []).map((m) => ({
    tree_id: m.tree_id,
    tree_name: m.tree_name ?? "",
    match_confidence: m.match_confidence ?? "weak",
    corroborating_facts: Array.isArray(m.corroborating_facts) ? m.corroborating_facts : [],
    contradicting_facts: Array.isArray(m.contradicting_facts) ? m.contradicting_facts : [],
  }));
  parsed.summary = parsed.summary ?? "";
  return parsed;
};

// Apply a story extraction to the KB: write a story_corroboration evidence
// entry for each strong+corroborated match. Pure function — caller persists.
//
// LR contributions are written into kb.confidence_evidence[id].identity.
// evidence_group is keyed off the file hash so re-processing the same
// story (after editing) groups correctly with the prior evidence — the
// accumulator's collapse-by-group logic prevents over-counting.
//
// Contradictions are NOT auto-applied as negative LR (would surprise the
// user). They surface in the summary for review; the user can manually
// decide whether to flag the individual or refine the source.
export const applyStoryEvidence = ({ kb, extraction, filename, fileHash, lrTable }) => {
  // Inline default LR so the function stays pure (no imports of confidence.js).
  const STORY_LR = lrTable?.sources_identity?.story_corroboration?.lr_match ?? 3.0;
  const next = JSON.parse(JSON.stringify(kb));
  next.confidence_evidence = next.confidence_evidence ?? {};

  const summary = {
    individuals_matched: 0,
    evidence_written: 0,
    contradictions_flagged: 0,
    contradictions: [],
  };

  for (const m of extraction?.individuals_mentioned ?? []) {
    if (!m.tree_id) continue;
    summary.individuals_matched += 1;
    if (m.contradicting_facts.length > 0) {
      summary.contradictions_flagged += 1;
      summary.contradictions.push(`${m.tree_name || m.tree_id}: ${m.contradicting_facts.join("; ")}`);
    }
    if (m.match_confidence !== "strong") continue;
    if (m.corroborating_facts.length === 0) continue;

    next.confidence_evidence[m.tree_id] = next.confidence_evidence[m.tree_id] ?? { identity: [], relationship: [] };
    next.confidence_evidence[m.tree_id].identity.push({
      kind: "story_corroboration",
      lr: STORY_LR,
      source_tier: 3,
      source_kind: "story",
      source: filename,
      // Hash-based grouping → same file always produces same group → re-
      // ingestion of an edited file replaces in-place via accumulator logic.
      evidence_group: `story_${fileHash}_${m.tree_id}`,
      note: m.corroborating_facts.join("; "),
      added_at: new Date().toISOString(),
    });
    summary.evidence_written += 1;
  }

  return { kb: next, summary };
};

// Document extraction prompt. Image/PDF is attached separately as a
// content block; this prompt asks Claude to identify the document type
// (drives the LR), transcribe key facts, and match to tree individuals.
const DOCUMENT_KINDS = [
  "civil_bmd_certificate", "civil_bmd_index",
  "parish_baptism", "parish_marriage", "parish_burial", "parish_register_index",
  "will_or_probate",
  "census_record",
  "memorial_inscription",
  "newspaper_obituary", "newspaper_announcement",
  "unknown_document",
];

export const buildDocumentExtractionPrompt = ({ ourTree = [] }) => {
  const treeLines = ourTree
    .map((p) => `${p.id}\t${p.name ?? ""}\tb.${p.birth_year ?? "?"}\t${p.birth_place ?? ""}`)
    .join("\n");
  return `You are reading a genealogy document (image or PDF — civil record, parish register, census, will, etc.). Identify the document type, transcribe the key facts, and match named individuals to the family tree below.

Return JSON only, with this shape:
{
  "document_kind": "${DOCUMENT_KINDS.join("\" | \"")}",
  "transcript_summary": "1-2 sentence plain-English summary of what the document records",
  "individuals_mentioned": [
    {
      "tree_id": "@I...@",
      "tree_name": "...",
      "match_confidence": "strong" | "medium" | "weak",
      "corroborating_facts": ["..."],
      "contradicting_facts": ["..."]
    }
  ]
}

document_kind guide:
  civil_bmd_certificate — UK GRO birth/marriage/death certificate (1837+).
  civil_bmd_index       — index entry only (e.g. FreeBMD); reference but no certificate text.
  parish_baptism / _marriage / _burial — original parish register entry naming the individual.
  parish_register_index — transcribed/indexed parish entry (FamilySearch IGI etc.).
  will_or_probate       — probate document, will, or letters of administration.
  census_record         — UK census 1841–1911 page or transcript.
  memorial_inscription  — gravestone / memorial photo with transcription.
  newspaper_obituary / _announcement — news clipping (death notice, marriage notice, BMD column).
  unknown_document      — anything else, or unidentifiable.

match_confidence guide:
  strong = name + at least one date/place explicitly match the tree entry
  medium = name + plausible context but ambiguous date/place
  weak   = name only; could be a different person with the same name

Tree (id\\tname\\tbirth_year\\tbirth_place):
${treeLines}`;
};

export const parseDocumentExtractionResponse = (text) => {
  const parsed = parseStoryExtractionResponse(text); // shape is the same family
  if (!parsed) return null;
  parsed.document_kind = DOCUMENT_KINDS.includes(parsed.document_kind)
    ? parsed.document_kind
    : "unknown_document";
  parsed.transcript_summary = parsed.transcript_summary ?? "";
  return parsed;
};

// Apply a document extraction to the KB. LR is looked up from the
// confidence_lrs table by document_kind; falls back to a conservative
// 2.0 for unknown_document so the find is still recorded.
export const applyDocumentEvidence = ({ kb, extraction, filename, fileHash, lrTable }) => {
  // Inline LR table loader — same pattern as applyStoryEvidence to keep
  // the function pure-friendly when callers want to override.
  const table = lrTable ?? loadLrTableSafe();
  const kind = extraction?.document_kind ?? "unknown_document";
  const def = table?.sources_identity?.[kind];
  const lr = def?.lr_match ?? 2.0;
  const tier = def?.tier ?? 3;

  const next = JSON.parse(JSON.stringify(kb));
  next.confidence_evidence = next.confidence_evidence ?? {};

  const summary = {
    document_kind: kind,
    individuals_matched: 0,
    evidence_written: 0,
    contradictions_flagged: 0,
    contradictions: [],
  };

  for (const m of extraction?.individuals_mentioned ?? []) {
    if (!m.tree_id) continue;
    summary.individuals_matched += 1;
    if ((m.contradicting_facts ?? []).length > 0) {
      summary.contradictions_flagged += 1;
      summary.contradictions.push(`${m.tree_name || m.tree_id}: ${m.contradicting_facts.join("; ")}`);
    }
    if (m.match_confidence !== "strong") continue;
    if ((m.corroborating_facts ?? []).length === 0) continue;

    next.confidence_evidence[m.tree_id] = next.confidence_evidence[m.tree_id] ?? { identity: [], relationship: [] };
    next.confidence_evidence[m.tree_id].identity.push({
      kind,
      lr,
      source_tier: tier,
      source_kind: "document",
      source: filename,
      evidence_group: `doc_${fileHash}_${m.tree_id}`,
      note: m.corroborating_facts.join("; "),
      added_at: new Date().toISOString(),
    });
    summary.evidence_written += 1;
  }

  return { kb: next, summary };
};

// Fallback LR-table load that doesn't throw — used by applyDocumentEvidence
// to stay test-friendly when the table file isn't available.
const loadLrTableSafe = () => {
  try {
    const tablePath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "confidence_lrs.json");
    return JSON.parse(fs.readFileSync(tablePath, "utf8"));
  } catch {
    return null;
  }
};

// Conservative cost estimate: ~$0.05/document at typical census image
// resolution + the prompt overhead. Used by the UI cost-preview before
// processing. Upper-bound estimate; actuals usually lower.
const COST_PER_DOCUMENT_USD = 0.05;
export const estimateDocumentCost = ({ fileCount = 0 } = {}) => {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return 0;
  return fileCount * COST_PER_DOCUMENT_USD;
};

// Vision API extraction. PDFs and images are read off disk and attached
// as base64 content blocks alongside the text prompt.
export const extractDocument = async ({ filePath, ourTree, fetchImpl }) => {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = ext === ".pdf" ? "application/pdf"
    : ext === ".png" ? "image/png"
    : "image/jpeg";
  const buf = fs.readFileSync(filePath);
  const base64 = buf.toString("base64");
  const prompt = buildDocumentExtractionPrompt({ ourTree });

  if (fetchImpl) {
    const res = await fetchImpl({ prompt, mediaType, base64 });
    return parseDocumentExtractionResponse(res);
  }
  const blockType = mediaType === "application/pdf" ? "document" : "image";
  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: blockType, source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseDocumentExtractionResponse(text);
};

// One-shot extraction call to Claude (text). Returns the parsed extraction
// or throws on extraction/network failure. Callers wrap in try/catch and
// log a "failed" entry in the ingestion log.
const MODEL = process.env.MODEL ?? "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS_INGEST ?? 2000);
let _anthropic = null;
const anthropicClient = () => {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
};

export const extractStory = async ({ storyText, ourTree, fetchImpl }) => {
  const prompt = buildStoryExtractionPrompt({ storyText, ourTree });
  // fetchImpl is a test seam — production uses the SDK. The SDK call
  // is non-streaming because we want the whole JSON before parsing.
  if (fetchImpl) {
    const res = await fetchImpl({ prompt });
    return parseStoryExtractionResponse(res);
  }
  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseStoryExtractionResponse(text);
};

// Decorate scan results with processed-status from the ingestion log.
//   unprocessed: never seen this file
//   processed:   filename + hash both match a successful prior run
//   changed:     filename matches but content has changed since last run
//   failed:      last run errored — surfaces the error message for diagnosis
export const attachIngestionStatus = (files, log = { files: {} }) => {
  const logFiles = log?.files ?? {};
  return files.map((f) => {
    const prior = logFiles[f.name];
    if (!prior) {
      return { ...f, status: "unprocessed", last_processed_at: null };
    }
    if (prior.status === "failed") {
      return {
        ...f,
        status: "failed",
        last_processed_at: prior.last_processed_at ?? null,
        error: prior.error ?? null,
      };
    }
    if (prior.hash !== f.hash) {
      return { ...f, status: "changed", last_processed_at: prior.last_processed_at ?? null };
    }
    return {
      ...f,
      status: "processed",
      last_processed_at: prior.last_processed_at ?? null,
      individuals_matched: prior.individuals_matched ?? 0,
      evidence_written: prior.evidence_written ?? 0,
    };
  });
};
