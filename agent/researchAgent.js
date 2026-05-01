import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { ANCESTOR_SYSTEM_PROMPT } from "./ancestorPrompt.js";

const MODEL = process.env.MODEL || "claude-sonnet-4-6";
// Hard cap on web_search tool calls per run. The model is forced to write up
// once the cap is reached. Tunable via env so power users can experiment.
const WEB_SEARCH_MAX_USES = Number(process.env.WEB_SEARCH_MAX_USES ?? 10);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 3000);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const buildUserMessage = (profile, kbBody) => {
  const sexLabel =
    profile.sex === "M" ? "Male" : profile.sex === "F" ? "Female" : "Unknown";
  return `Please research this individual from the Sutcliffe family tree:

Name: ${profile.name}
GEDCOM ID: ${profile.id}
Sex: ${sexLabel}
Approximate birth year: ${profile.birth_year ?? "Unknown"}
Birth place: ${profile.birth_place || "Unknown"}
Generation from root (Richard David Sutcliffe b.1972): ${profile.generation}
Current confidence band: ${profile.confidence}
Current evidence score: ${profile.score}/20
Known warnings: ${(profile.warnings ?? []).join("; ") || "None"}
Known alerts: ${(profile.alerts ?? []).join("; ") || "None"}

<<RESEARCH_KB_CONTEXT>>
${kbBody}
<</RESEARCH_KB_CONTEXT>>

Please search public records to find primary source evidence for this individual. If you find a match, provide the source citation in full and recommend a new confidence band. If you cannot find a match, explain what you searched and why it returned no results.`;
};

const EMPTY_KB = `known_parishes: {}
naming_pattern_warnings: []
negative_searches: []
confirmed_relatives: []
migration_routes: []
alias_registry: {}`;

// Build the user message for an Ancestor Discovery run. Given a child and
// optional other-parent profile, ask the agent to propose the missing parent
// and the link evidence binding them to the child.
const buildAncestorMessage = ({ child, role, otherParent, siblings, kbBody }) => {
  const childPart = `Child:
  Name: ${child.name}
  GEDCOM ID: ${child.id}
  Sex: ${child.sex || "Unknown"}
  Birth: ${child.birth_year ?? "Unknown"} (${child.birth_date || "no exact date"})
  Birth place: ${child.birth_place || "Unknown"}
  Confidence: ${child.confidence}
  Generation: ${child.generation ?? "Unknown"}
  Warnings: ${(child.warnings ?? []).join("; ") || "None"}
  Alerts: ${(child.alerts ?? []).join("; ") || "None"}`;

  const otherParentPart = otherParent
    ? `Known other parent (${otherParent.sex === "M" ? "father" : otherParent.sex === "F" ? "mother" : "spouse"}):
  Name: ${otherParent.name}
  GEDCOM ID: ${otherParent.id}
  Birth: ${otherParent.birth_year ?? "Unknown"} (${otherParent.birth_date || "no exact date"})
  Birth place: ${otherParent.birth_place || "Unknown"}
  Confidence: ${otherParent.confidence}`
    : `Known other parent: NONE — the other parent is also unknown.`;

  const siblingsPart =
    siblings?.length > 0
      ? `Known siblings:\n${siblings
          .map(
            (s) =>
              `  - ${s.name} (b.${s.birth_year ?? "?"}, ${s.birth_place || "?"}, ${s.confidence})`,
          )
          .join("\n")}`
      : `Known siblings: NONE in the tree.`;

  return `Find the unknown ${role} of ${child.name}.

${childPart}

${otherParentPart}

${siblingsPart}

<<RESEARCH_KB_CONTEXT>>
${kbBody ?? EMPTY_KB}
<</RESEARCH_KB_CONTEXT>>

Propose candidate ${role}s for ${child.name}, with the LINK evidence binding each candidate to ${child.name}. Surface ALL plausible candidates if more than one exists — do not pick one prematurely. If no candidate has at least CIRCUMSTANTIAL link evidence, recommend none.`;
};

// Run the agent against a single individual, streaming events to the supplied
// emit function. Each event is { type, ... } where type is one of:
//   "search"    — { type, query }      a web search has started
//   "text"      — { type, text }       a chunk of assistant text
//   "done"      — { type, result }     final aggregated result
//   "error"     — { type, message }
export const runAgent = async ({ profile, kbBody, emit, signal }) => {
  const userMessage = buildUserMessage(profile, kbBody ?? EMPTY_KB);

  let fullText = "";
  let searchCount = 0;
  const searches = [];

  try {
    const stream = anthropic.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: WEB_SEARCH_MAX_USES,
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      },
      { signal },
    );

    // The for-await loop blocks waiting for events from the SDK. If the
    // external signal aborts (user clicks Stop, connection drops), we have
    // to explicitly abort the stream's controller — otherwise the loop sits
    // asleep until the next event arrives, which can be many seconds.
    if (signal) {
      signal.addEventListener("abort", () => stream.controller.abort(), { once: true });
    }

    let capAborted = false;
    for await (const event of stream) {
      if (signal?.aborted || capAborted) break;

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "server_tool_use" && block?.name === "web_search") {
          // Hard server-side cap, regardless of whether the SDK's max_uses
          // is being honoured by the upstream service. Belt and suspenders.
          if (searchCount >= WEB_SEARCH_MAX_USES) {
            console.warn(
              `[agent] Search cap ${WEB_SEARCH_MAX_USES} hit. Aborting stream to prevent runaway cost.`,
            );
            emit({
              type: "search",
              query: `[search cap ${WEB_SEARCH_MAX_USES} reached — aborting]`,
            });
            stream.controller.abort();
            capAborted = true;
            break;
          }
          searchCount += 1;
          searches.push({ index: event.index, query: null });
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d?.type === "text_delta" && d.text) {
          fullText += d.text;
          emit({ type: "text", text: d.text });
        } else if (d?.type === "input_json_delta" && d.partial_json) {
          const cur = searches[searches.length - 1];
          if (cur && cur.index === event.index) {
            cur._buf = (cur._buf ?? "") + d.partial_json;
          }
        }
      } else if (event.type === "content_block_stop") {
        const cur = searches.find((s) => s.index === event.index);
        if (cur && cur._buf) {
          try {
            const parsed = JSON.parse(cur._buf);
            cur.query = parsed.query ?? null;
            delete cur._buf;
            if (cur.query) emit({ type: "search", query: cur.query });
          } catch {
            // Ignore — partial JSON occasionally fails to round-trip
          }
        }
      }
    }

    let usage = {};
    let stop_reason = null;
    if (!capAborted) {
      const final = await stream.finalMessage();
      usage = final.usage ?? {};
      stop_reason = final.stop_reason;
    } else {
      // The stream was aborted server-side after the search cap. The model
      // never got to write its closing summary; surface a partial result so
      // the user can still see what was gathered.
      stop_reason = "search_cap_reached";
      fullText +=
        `\n\n---\n\n**[Server-side stop: search cap of ${WEB_SEARCH_MAX_USES} reached.]** ` +
        `The agent attempted further searches than the configured budget allows. ` +
        `Output above is partial. Raise WEB_SEARCH_MAX_USES in .env if a hard case really needs more searches.`;
    }

    emit({
      type: "done",
      result: {
        text: fullText,
        stop_reason,
        searches: searches.map((s) => s.query).filter(Boolean),
        search_count: searchCount,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
        model: MODEL,
        completed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: "error", message: "cancelled" });
      return;
    }
    emit({ type: "error", message: err?.message ?? String(err) });
  }
};

// Run the Ancestor Discovery agent for an unknown parent.
// `child` is the known individual; `role` is "father" | "mother";
// `otherParent` is the known other parent (or null); `siblings` is an array
// of known siblings (may be empty).
export const runAncestorAgent = async ({
  child,
  role,
  otherParent,
  siblings,
  kbBody,
  emit,
  signal,
}) => {
  const userMessage = buildAncestorMessage({ child, role, otherParent, siblings, kbBody });

  let fullText = "";
  let searchCount = 0;
  const searches = [];

  try {
    const stream = anthropic.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: ANCESTOR_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: WEB_SEARCH_MAX_USES,
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      },
      { signal },
    );

    if (signal) {
      signal.addEventListener("abort", () => stream.controller.abort(), { once: true });
    }

    let capAborted = false;
    for await (const event of stream) {
      if (signal?.aborted || capAborted) break;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "server_tool_use" && block?.name === "web_search") {
          if (searchCount >= WEB_SEARCH_MAX_USES) {
            console.warn(
              `[ancestor agent] Search cap ${WEB_SEARCH_MAX_USES} hit. Aborting stream.`,
            );
            emit({
              type: "search",
              query: `[search cap ${WEB_SEARCH_MAX_USES} reached — aborting]`,
            });
            stream.controller.abort();
            capAborted = true;
            break;
          }
          searchCount += 1;
          searches.push({ index: event.index, query: null });
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d?.type === "text_delta" && d.text) {
          fullText += d.text;
          emit({ type: "text", text: d.text });
        } else if (d?.type === "input_json_delta" && d.partial_json) {
          const cur = searches[searches.length - 1];
          if (cur && cur.index === event.index) {
            cur._buf = (cur._buf ?? "") + d.partial_json;
          }
        }
      } else if (event.type === "content_block_stop") {
        const cur = searches.find((s) => s.index === event.index);
        if (cur && cur._buf) {
          try {
            const parsed = JSON.parse(cur._buf);
            cur.query = parsed.query ?? null;
            delete cur._buf;
            if (cur.query) emit({ type: "search", query: cur.query });
          } catch {
            // ignore partial JSON
          }
        }
      }
    }

    let usage = {};
    let stop_reason = null;
    if (!capAborted) {
      const final = await stream.finalMessage();
      usage = final.usage ?? {};
      stop_reason = final.stop_reason;
    } else {
      // The stream was aborted server-side after the search cap. The model
      // never got to write its closing summary; surface a partial result so
      // the user can still see what was gathered.
      stop_reason = "search_cap_reached";
      fullText +=
        `\n\n---\n\n**[Server-side stop: search cap of ${WEB_SEARCH_MAX_USES} reached.]** ` +
        `The agent attempted further searches than the configured budget allows. ` +
        `Output above is partial. Raise WEB_SEARCH_MAX_USES in .env if a hard case really needs more searches.`;
    }

    emit({
      type: "done",
      result: {
        text: fullText,
        stop_reason,
        searches: searches.map((s) => s.query).filter(Boolean),
        search_count: searchCount,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
        model: MODEL,
        completed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: "error", message: "cancelled" });
      return;
    }
    emit({ type: "error", message: err?.message ?? String(err) });
  }
};
