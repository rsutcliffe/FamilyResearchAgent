# Spec Doc Changes — Outstanding

The runtime system prompt is now extracted to [agent/systemPrompt.js](agent/systemPrompt.js) and imported by [docs/agent_1.jsx](docs/agent_1.jsx:2). This is the canonical source.

[docs/20250419_Sutcliffe_ClaudeCode_PRD_Addendum_v1.1.docx](docs/20250419_Sutcliffe_ClaudeCode_PRD_Addendum_v1.1.docx) has been updated (§11.2 sentence softened — see below).

The two remaining spec doc updates are listed here. They were not applied directly because:

- The local Python is 3.9; the docx skill's `pack.py` requires 3.10+ for PEP 604 syntax.
- Each remaining change is a 40+ paragraph block replacement, which is high-risk to do as raw XML edits without the validating pack pipeline.

Both changes can be applied in a follow-up session with Python 3.10+ available, or manually in Word using the text below.

---

## Change 1 — PRD v1.0 §6 (Record Discovery Agent — System Prompt Specification)

**File:** `docs/20250419_Sutcliffe_ClaudeCode_PRD_v1.0.docx`
**Target:** §6, the entire prompt body (between the §6 heading and the start of §7 "Data Structures").
**Action:** Replace the existing prompt body verbatim with the contents of [agent/systemPrompt.js](agent/systemPrompt.js) (the `SYSTEM_PROMPT` template literal, without the surrounding JS).

**Header note to add directly under §6 heading:**

> This prompt is the canonical specification. It is held in source at `agent/systemPrompt.js` and imported by all runtime callers. Any change to this prompt must be made in `agent/systemPrompt.js` first and mirrored here in lockstep. Version each change with a corresponding bump to this PRD.

**Structural changes vs the v1.0 prompt:**

| Section | Status | Notes |
|---|---|---|
| Opening paragraph | Modified | Now anchors the root person by name and date |
| §A KB context | New | Implements PRD Addendum §11.2 — reads `<<RESEARCH_KB_CONTEXT>>` from user message |
| §B sources | Modified | Adds British Newspaper Archive (post-1850 obits); adds 1921/1939 awareness; adds Irish-source guidance (Griffith's Valuation, Tithe Applotment, GRO Ireland) |
| §C rules | Modified | Expanded name variants (adds Sootcliffe, Lizzie, Ann/Anne/Hannah, Joseph/Jos, Mary/Margt, Margaret/Peggy); adds illegitimacy rule (bastardy bonds, Halifax Archives) |
| §D evaluation | Unchanged from revised draft | Adds NO MATCH FOUND as a quality value |
| §E confidence | Modified | Tier-explicit; clarifies Unchanged preserves incoming band; WEAK never justifies a change |
| §F output headings | New | Mandates the 5 PRD-required headings; numbered Match Evaluation steps include explicit Cross-references step |
| §G trailing blocks | New | Three machine-parseable blocks: `<<NEGATIVE_SEARCHES>>`, `<<CROSS_REFERENCE_FLAGS>>`, `<<ALIAS_OBSERVATIONS>>`. Field separator is `||` (not `|`) to avoid query-string collisions |

---

## Change 2 — Requirements §8 (Agent System Prompt)

**File:** `docs/20250419_Sutcliffe_ClaudeCode_Requirements_v1.0.docx`
**Target:** §8, the entire prompt body (between the §8 heading and §9 "Non-Functional Requirements").
**Action:** Replace verbatim with the contents of [agent/systemPrompt.js](agent/systemPrompt.js).

**Header note to add directly under §8 heading:**

> This prompt is held in source at `agent/systemPrompt.js`. The text below is a mirror — `agent/systemPrompt.js` is authoritative. Do not edit this section directly; edit the source file and re-export.

The Requirements §8 prompt was already closer to the patched version than PRD §6 (it included BNA, Irish sources, illegitimacy, and the wider name-variant list), but it lacks Sections A, F, and G entirely and uses different rating wording. After this change the two specs and the source file all match.

---

## Change 3 — Already applied

**File:** `docs/20250419_Sutcliffe_ClaudeCode_PRD_Addendum_v1.1.docx` (new — preserves v1.0 alongside)
**§11.2** — softened sentence:

> ~~The system prompt remains the canonical specification defined in Section 6 of the v1.0 PRD.~~
> The system prompt is updated to add Section A (KB context handling) and Section G (machine-readable trailing blocks); the canonical specification is Section 6 of the v1.0 PRD as patched in lockstep with these additions.

---

## How to apply Changes 1 and 2

**Option A — manual:** Open each docx in Word, navigate to the target section, select the prompt body paragraphs, paste the contents of [agent/systemPrompt.js](agent/systemPrompt.js) (the template literal between the backticks).

**Option B — follow-up session with Python 3.10+:** The docx skill's unpack/edit/pack pipeline can do this cleanly. Recommended approach: (a) `unpack.py` each docx, (b) locate the prompt's start/end anchor paragraphs in `word/document.xml`, (c) replace the run of paragraphs between them with simple `<w:p><w:r><w:t xml:space="preserve">...</w:t></w:r></w:p>` blocks for each line of the new prompt, (d) `pack.py` to validate and produce the new docx. Versioning recommendation: name outputs `*_v1.1.docx` so the v1.0 originals are preserved.
