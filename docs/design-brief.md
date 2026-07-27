# FamilyResearchAgent — Visual Direction Brief

A reusable paste-target for design tools (Google Stitch, Claude Design, contractors, future briefs). Update in place as the visual language evolves.

## Core principle
**Clean, fresh, modern, minimalistic.** This is a serious evidence-driven tool, but the visual language is contemporary software, not archival pastiche. Nothing decorative, nothing nostalgic, nothing that gestures at "old documents." The seriousness comes from precision, hierarchy, and restraint — not from texture or period styling.

## Hard prohibitions
- **No serif fonts anywhere.** Headings, body, accents — all sans-serif.
- **No design cues from existing genealogy sites** (Ancestry.com, MyHeritage, FamilySearch, Findmypast, WikiTree). Do not borrow their colour palettes, iconography, tree visualisations, card styles, or marketing tone. If a pattern is recognisable as "genealogy app," reject it.
- No sepia, parchment textures, paper grain, or aged effects.
- No heraldic motifs, crests, scrolls, leaves, or branch illustrations.
- No "discover your story!" marketing warmth or sentimental imagery.
- No skeuomorphism, glassmorphism, or neumorphism.
- No decorative gradients, drop shadows used for ornament, or rounded-everything friendliness.

## Product in one line
A modern research workspace where a genealogist accumulates Bayesian-weighted evidence for each ancestor in their tree. Closer in spirit to Linear, Notion, or a clinical reasoning tool than to any consumer ancestry product.

## Mood
Calm, precise, confident. The interface gets out of the way and lets the data — names, dates, sources, confidence scores — do the talking. Generous whitespace, sharp typography, a small number of well-chosen accents. Think *Linear*, *Stripe Dashboard*, *Vercel*, *Arc*, *Notion* — not any genealogy product.

## Palette
- **Foundation:** true off-white (`#FAFAFA` / `#F7F7F8`) or pure white in light mode; near-black (`#0A0A0B`) in dark mode. Both modes supported, light is default.
- **Text:** high-contrast neutral greys — primary text near-black, secondary text mid-grey, tertiary/metadata light grey. Strict three-tier hierarchy.
- **Surfaces:** subtle elevation via tonal steps (e.g. `#FFFFFF` canvas, `#F4F4F5` panels, `#E4E4E7` borders) — not via shadows.
- **Single accent:** one confident modern colour for primary actions and key highlights. Recommended: a clean cobalt or indigo (`#4F46E5` / `#2563EB`) — neutral, technical, unmistakably not ancestry-green or genealogy-burgundy.
- **Confidence band scale (E→A):** a perceptually ordered, colourblind-safe ramp using modern data-viz palette logic (e.g. Tailwind / Radix scales). Avoid traffic-light reds and greens; lean on a sequential ramp from cool grey through the accent to a saturated success tone only at band A.
- **Status:** contradictions in a clear modern red, pending in amber, resolved in a desaturated green. Used sparingly, never as decoration.

## Typography
- **All sans-serif.** No exceptions.
- **Primary typeface:** *Inter*, *Geist*, *IBM Plex Sans*, or *Söhne* — a precise, contemporary, geometric-leaning humanist sans.
- **Headings:** same family as body, differentiated by weight and size only. Tight tracking on large headings, generous size jumps in the type scale.
- **Numerics & dates:** tabular figures throughout. Dates in a clean fixed format (`12 Mar 1847`) — readable as data, not styled as ledger entries.
- **Monospace** for source IDs, citations, and raw API payloads — *Geist Mono*, *JetBrains Mono*, or *IBM Plex Mono*.

## Layout & density
- Information-dense where it earns it (tables, evidence breakdowns, confidence panels), but always with confident whitespace around the dense regions.
- Multi-column desktop layouts at 1440+; mobile is secondary, view-only.
- Tables: minimal — hairline horizontal rules, no zebra striping, tabular numerics, generous row height. Modern data-table conventions (Linear, Notion, Retool), not printed-register conventions.
- Cards: flat, single hairline border or a single subtle shadow — pick one system and stick to it. Crisp corners or small radius (4–8px), never pill-shaped or heavily rounded.

## Iconography
Line-based, 1.5–2px stroke, modern and geometric. *Lucide*, *Phosphor* (regular), or *Radix Icons*. Never filled cartoon icons, never skeuomorphic icons, never anything that gestures at scrolls, quills, or family trees.

## Motion
Minimal and functional. Confidence bars animate smoothly when evidence updates — this is the one moment where motion carries meaning. Standard modern easing (ease-out, 150–250ms). No bouncy springs, no decorative transitions, no parallax.

## Voice in UI copy
Precise and direct. "Corroborated by 3 independent sources." "Confidence raised from C to B." Buttons are short verbs from the domain: *Claim*, *Reconcile*, *Ingest*, *Run research*. No exclamation marks, no emoji, no marketing warmth, no archaic phrasing.

## Accessibility & constraints
- WCAG AA minimum across both light and dark modes.
- Keyboard navigation first-class (this is a power-user tool).
- Must support a dense desktop layout (1440+) as primary; mobile is secondary, view-only.
- No build step in the real app (vanilla JS) — designs must be implementable in plain HTML/CSS without heavy component frameworks.

## One-line style prompt (paste into Stitch / Claude Design)
> A clean, modern, minimalist research workspace for genealogy evidence analysis. Light off-white canvas, high-contrast neutral greys, a single cobalt/indigo accent, all sans-serif typography (Inter or Geist), tabular numerics, hairline rules, line-art icons (Lucide), generous whitespace. Mood: Linear / Notion / Stripe Dashboard applied to historical evidence. Strictly avoid: serif fonts, sepia, parchment, heraldic motifs, family-tree illustrations, and any visual cues from Ancestry.com, MyHeritage, FamilySearch, or similar genealogy sites.
