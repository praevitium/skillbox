# Skillbox: Portable Content Bundles for Ratchet

## What It Does

A **skillbox** is a declarative, auto-discovered bundle that enriches Ratchet without modifying it.

Contains:
- **Skills** — copilot workflows ("walk me through a DVIR", "explain HOS rules")
- **Tools** — functions ratchet can dispatch (read form state, lookup regulations, draft records, etc.)
- **Prompts** — system prompts, instructions specific to the host domain
- **RAG ingestion** — how to index and embed documents (e.g. trucking-regulations dataset)
- **Branding** — logo, color theme, custom thinking-messages
- **Manifest** — what's in this box and how ratchet should load it

## Core Principle

**Ratchet is host-agnostic; skillbox is host-specific.** A skillbox lets a host (like `web`) deliver its domain content without touching ratchet's core. Ratchet auto-discovers and loads skillboxes at startup.

## Organization

Each skillbox is self-contained:
```
skillbox/
  rmo-copilot/
    manifest.json          # Declaration: skills, tools, RAG ingestion recipe, branding
    skills/
      dvir.json            # Skill definition (name, description, actions)
      timesheet.json
    tools/
      lookup-regulations.ts  # Tool implementation (can read KB, query APIs, etc.)
      draft-timesheet.ts
    rag/
      trucking-rules.pdf   # Source documents for RAG
      hos-limits.json
    prompts/
      system.md            # Domain-specific system prompt
    branding/
      logo.svg
      theme.json
    README.md              # What this skillbox does and how to invoke it
```

## Adding a Skillbox

1. Create folder: `skillbox/name-of-box/`
2. Add `manifest.json` declaring what's inside
3. Add skill definitions (JSON) + tool implementations (code)
4. Add source documents for RAG (PDFs, text, JSON)
5. Add system prompt and branding
6. Write README with examples

## Skill authoring: inline manifest OR `SKILL.md` (Session 88)

Skills can be declared two ways, and a skillbox may use both:

1. **Inline in `manifest.json`** under `skills[]` — `{ id, name, description, instructions, examples?, requires? }`. Good for short skills.
2. **As `skills/<id>/SKILL.md` folders** (Anthropic Agent Skills style). YAML frontmatter + a markdown body:

```markdown
---
id: explain-hos
name: Explain Hours of Service
description: Walk a driver through HOS limits, citing the regulations KB.
examples:
  - How many hours can I drive today?
requires:
  modalities: [text]
---

When the user asks about hours of service, retrieve from the KB first via the
lookup_regulations tool and cite by [n]. …the rest is the skill's instructions.
```

The loader parses each `SKILL.md` into the same internal `Skill` object as the manifest path. Mapping: `id` ← frontmatter `id` ?? directory name; `name` ← frontmatter `name` ?? id; `description` ← frontmatter; `instructions` ← the markdown body; `examples` / `requires.modalities` ← frontmatter (a flat `modalities:` list also works). `SKILL.md` **wins on an id collision** with a manifest skill (the dedicated file is the richer source). The modality gate applies to both. A blank SKILL.md (no description and no body) is skipped. Frontmatter is read by a minimal built-in parser — no YAML dependency — so stick to scalars, inline `[a, b]` lists, block `- item` lists, and one level of nesting (`requires:` → `modalities:`).

**How skills reach the model (progressive disclosure).** Every loaded skill's `name` + `description` is always advertised in the system prompt (cheap routing). The **full `instructions`** of only the few skills most relevant to the current user turn are injected (scored on shared terms, capped by `MAX_ACTIVE_SKILL_INSTRUCTIONS`). With the agentic loop, an injected skill body is a multi-step playbook the model can actually execute across tool rounds — so write `instructions` as a procedure ("retrieve X, then call tool Y, then …"), not just a description.

The reference migration is `rmo-copilot/skills/explain-hos/SKILL.md` (moved out of the manifest).

## Opt-in Peer Skillboxes (Session 46)

A skillbox can declare `"loadByDefault": false` on its manifest to ship on disk alongside a primary skillbox without loading on every deploy. Auto-discovery skips the peer unless the operator sets `SKILLBOX_ENABLE=<name>` (comma-separated for multiple). Useful for locale peers, ops-only debug skillboxes, or experimental tool packs that aren't ready for production.

Naming convention: pair the peer's directory name with the primary it overrides so the loader's alphabetic sort puts the override last (last-wins per branding field). For example, `skillbox/rmo-copilot-fr-CA/` ships next to `skillbox/rmo-copilot/`; when enabled it pins `branding.locale: 'fr-CA'` and translates every `branding.labels.*` key plus the `timesheet` / `dvir` recordType labels. Declare ONLY the fields you want to override — a labels-only peer omits `skills`, `tools`, and `ragContent`.

The allowlist matches against both `manifest.name` and the subdirectory basename so a drifted directory still works (`SKILLBOX_ENABLE=rmo-copilot-fr-CA` matches either identifier). A name in the allowlist that doesn't match any opt-in skillbox earns one `console.warn` at boot, so typos surface immediately.

### Switching a default-loading skillbox off via `SKILLBOX_DISABLE` (Session 49)

The inverse of `SKILLBOX_ENABLE` — a comma-separated denylist matched against the same `manifest.name` / subdirectory-basename identifiers. A name in `SKILLBOX_DISABLE` is skipped before the `loadByDefault` gate runs, so the operator can switch off a primary skillbox without removing its on-disk directory. Useful for staging a replacement skillbox alongside the shipped one, demoing the panel with no host content loaded (`SKILLBOX_DISABLE=rmo-copilot` produces a bare panel), or rolling back a deploy that shipped a broken skillbox without redeploying disk.

Disable wins when both knobs name the same skillbox — explicit "off" intent dominates over an enable in the same boot. An unmatched `SKILLBOX_DISABLE` entry earns one `console.warn` at boot (same posture as `SKILLBOX_ENABLE`); a denylist entry that targets a dormant opt-in peer (`loadByDefault: false` with the peer NOT in `SKILLBOX_ENABLE`) still earns matched credit and suppresses the warn — the operator's "belt and braces" disable is a valid match for the named peer even when the load outcome is identical.

Example combinations:

- `SKILLBOX_ENABLE=rmo-copilot-fr-CA SKILLBOX_DISABLE=rmo-copilot` — staging the French peer as the only loaded skillbox (no English primary fallback). The aggregator's `contributors` list carries only `rmo-copilot-fr-CA`, and the panel reads its branding directly from the peer.
- `SKILLBOX_DISABLE=rmo-copilot` — bare-panel boot. No record types, no skills, no tools registered — useful for proving the ratchet panel itself works without any host content.

### Peer Renderer Overrides (Session 47)

A peer skillbox can override the primary's tool renderers by declaring its own `branding.renderers` entries. The aggregator's last-wins per `toolId` plus the loader's alphabetic sort means the peer's URL wins on `/api/branding` whenever the alphabetic-last skillbox declares the same `toolId` as the primary. Skill-author contract:

- **Override one tool at a time.** Only renderers explicitly listed in the peer's `branding.renderers` map are replaced; everything the peer omits falls through to the primary. So a fr-CA peer that declares `draft_timesheet` but not `draft_dvir` ships French timesheets and English DVIRs.
- **Mirror the primary's DOM shape and CSS class names.** The peer's renderer module should use the same `lc-…` (or other prefix-based) class names as the primary so CSS theming, renderer-error isolation, and host-side selectors all keep working unchanged. The whole point of a peer override is "same shape, different strings."
- **Sibling helpers live under the peer's own `renderers/` directory.** `ctx.loadSibling('_field-helpers.js')` resolves relative to the peer's renderer URL (the panel propagates the peer's `?v=<version>` cache-bust tag onto the sibling URL), so a peer can ship its own `_field-helpers.js` with locale-specific `FIELD_LABELS` without touching the primary's helpers file.
- **The peer's manifest version drives renderer cache-busting independently of the primary.** A peer-only translation fix bumps the peer's `manifest.version`; that flushes the browser's HTTP + ESM cache for the peer's renderer module alone, without forcing a refetch of the primary's three other renderers. Symmetric in the other direction — bumping the primary's version doesn't force a peer refetch.

Reference impls (Sessions 47 / 48 / 53 / 64 / 65) live under `skillbox/rmo-copilot-fr-CA/renderers/`:

- `draft_timesheet.js` + `_field-helpers.js` (Session 47): mirrors the English primary's draft_timesheet renderer one-for-one but translates every visible string and points `FIELD_LABELS` at French labels (`Conducteur` / `Date du voyage` / `Heures de conduite` / …).
- `draft_dvir.js` + `_dvir-helpers.js` (Session 48): mirrors the English primary's draft_dvir renderer one-for-one — same DOM shape, same CSS class names, same defects-list / photos-grid / warnings-banner / badge / footer ordering — but translates every visible string and points `DVIR_FIELD_LABELS` / `DEFECT_CATEGORY_LABELS` at French equivalents (`Transporteur` / `État des défectuosités` / `Freinage` / `Pneus et roues` / `Conforme à l’annexe 1 — prêt à soumettre.` / …). Odometer renders through `toLocaleString('fr-CA')` for the locale-correct thousands separator. Curly typographic apostrophes (U+2019) are used in fr-CA contractions (`l’annexe`, `jusqu’à`) — straight apostrophes in tests would silently drift.
- `summarize_pay_period.js` (Session 53, no new sibling needed — composes on the existing `_field-helpers.js` for `formatStamp`): mirrors the English primary's read-only pay-period summary renderer one-for-one — same DOM shape, CSS class prefixes (`lc-payperiod-…`), dataset attributes (`dataset.tripDate` / `dataset.recordId`), section ordering — but translates every visible string. Totals labels (`Jours travaillés` / `Conduite` / `En service` / `Hors conduite`), daily table headers (`Date` / `Conduite` / `En service` / `Véhicule` / `Chargement`), empty-state branches differentiating "no records ever" from "none in window," warnings banner with French noun-agreement (`N avertissements de cumul HOS — à vérifier avant la clôture de la paie.`), compliance badge phrasing, and footer with French sheet-count noun-agreement (`1 feuille de temps analysée` vs `N feuilles de temps analysées`) plus a guillemets-wrapped driver filter fragment (` · filtré sur « <driver> »`). Hour formatting uses French typography (`9 h` space-separated, not `9h`). Reuses the peer's `_field-helpers.js` `formatStamp` rather than carrying its own — the only locale-sensitive dependency this renderer needs is the stamp formatter, which is already mirrored at the peer-helpers layer.
- `web_search.js` (Session 64, no sibling needed — pure string assembly like the English primary, so it stays a synchronous `register`): mirrors the English primary's web_search renderer one-for-one — same DOM shape, same CSS class names (`lc-web-header` / `lc-web-filters` / `ratchet-tool-scoring-echo` / `lc-web-footer`), same header → filter-pill → cards → footer ordering, same `renderSourceCards(node, payload, opts)` delegation — but translates every visible string. Header (`Recherche Web — « <q> »` / fallback `Résultats de recherche Web`), filter-echo pill (`fraîcheur : dernière semaine · région : CA`, recency enum→French via a local `recencyLabels` map `day`→`dernier jour` / `week`→`dernière semaine` / `month`→`dernier mois` / `year`→`dernière année`), the Session-63 provider-honoured annotation (`(non appliqué)` suffix on a requested-but-unapplied filter; missing/non-array `appliedFilters` ⇒ all-applied back-compat), footer with French result-count noun-agreement (`1 résultat` vs `N résultats`) and `source : <provider>`, and the no-results note (`Aucun résultat Web trouvé. Essayez une autre requête ou configurez TAVILY_API_KEY / BRAVE_SEARCH_API_KEY pour une meilleure couverture.`). Provider proper nouns (`Tavily` / `Brave Search` / `DuckDuckGo` / fallback `Web`) stay untranslated. Like `lookup_regulations` the web-result *excerpts* stay whatever the source returned — only the renderer chrome is translated.
- `lookup_regulations.js` (Session 65, no sibling needed — pure string assembly like the English primary, so it stays a synchronous `register`): mirrors the English primary's lookup_regulations renderer one-for-one — same DOM shape, same CSS class names (`lc-regs-header` / `lc-regs-footer`), same header → cards → footer ordering, same `renderSourceCards(node, payload, opts)` delegation — but translates the chrome. Header (`Règlements de camionnage — « <q> »` / fallback `Règlements de camionnage`), footer with French source-count noun-agreement (`1 source` vs `N sources`) + the most-recent date (`plus récent : YYYY-MM-DD`, ISO date kept locale-neutral) + the source-of-truth label translated as a noun phrase (`source : base de connaissances réglementation-camionnage`), and the empty-path no-results note (`Aucun règlement correspondant trouvé dans la base de connaissances.`). The KB excerpts the cards paint stay en-CA (the shared trucking-regulations corpus is English) — same "translate the chrome, not the data" posture as `web_search`. Session 65 also fixed a latent dead-code bug in BOTH the primary and the peer: an early `return` above the trailing no-results note meant the note never rendered; the empty-sources branch now skips the footer and drops the (translated) note unless the handler already supplied its own degraded `note`.

All five peer renderers compose on the peer's own `renderers/` directory sibling helpers (or, for `summarize_pay_period` / `web_search` / `lookup_regulations`, no sibling at all) — the primary's helper files stay English. As of Session 65 the peer's `branding.renderers` map covers EVERY tool-result renderer the demo ships (write-side: draft_timesheet, draft_dvir; read-side: summarize_pay_period; web_search; lookup_regulations) — there is no longer a primary-only renderer. The `lookup_regulations` override is chrome-only; a fr-CA RAG corpus (to translate the regulation excerpts themselves) would be a separate slice. To add a future locale peer (es-MX, de-DE), drop a parallel skillbox directory next to `rmo-copilot-fr-CA/` with `loadByDefault: false`, mirror the renderer files, translate the strings — no aggregator change required.

**Composing on the existing sibling vs. shipping a new one.** A peer renderer SHOULD compose on the peer's existing sibling helpers when the renderer's only locale-sensitive needs are already covered by an existing helper export. Session 53's `summarize_pay_period` only needs `formatStamp` from `_field-helpers.js` (which the peer already ships for Session 47's `draft_timesheet`), so adding a new `_payperiod-helpers.js` would have duplicated the same `formatStamp` recipe. A future override that needs new locale-specific tables (e.g. a `draft_loading_ticket` renderer that pulls product-code labels) would ship its own sibling — the rule of thumb is: "does this renderer need helper logic that none of the peer's existing renderers need?" — if no, compose; if yes, ship a new sibling.

### Locale-aware stamp helpers in renderer siblings (Session 50)

`_field-helpers.formatStamp(iso, opts)` and `_dvir-helpers.formatDvirStamp(iso, opts)` (both primary and fr-CA peer) accept an optional second argument with `locale` (BCP-47) and `timezone` (IANA) fields. The panel threads its resolved `branding.locale` and `branding.timezone` through every `renderToolResultBody` / `renderRecordEntry` call as `_opts.locale` / `_opts.timezone`; the shipped `draft_timesheet` and `draft_dvir` renderers forward those keys verbatim into the stamp helpers. With BOTH fields supplied the helper produces wall-clock time via `Intl.DateTimeFormat#formatToParts` — output shape is `YYYY-MM-DD HH:MM <TZ>` (24-hour, ISO date, locale-resolved tz short name) so the visual shape stays predictable across locales and Node ICU versions. With either missing — or a bad timezone, or any Intl rejection — the helper falls through to the legacy `YYYY-MM-DD HH:MM UTC` shape, preserving back-compat with every renderer + test shipped before Session 50.

Skill-author contract for new renderers that want locale-aware stamps:

- **Accept `_opts` as the renderer's third argument and forward `_opts.locale` / `_opts.timezone` to your stamp helper.** The shipped renderers do this with a single-line `const stampOpts = _opts || {};` so an absent third arg degrades cleanly to the UTC fallback.
- **Don't try to format the locale's typography yourself.** The primary's `formatStamp` produces an ISO-shaped string for every locale (en-CA `2026-05-20 07:45 MDT` rather than en-CA's idiomatic `2026-05-20, 7:45 AM MDT`; fr-CA `2026-05-20 07:45 HAR` rather than fr-CA's `2026-05-20 07 h 45 HAR`). Predictable shape > idiomatic typography for stamps that paint inside renderer chrome.
- **The helper resolves wall-clock through `Intl.DateTimeFormat`** — no manual offset math, no DST gotchas. America/Edmonton in May is MDT (UTC-6) and in November is MST (UTC-7); the helper handles both transparently.
- **Both `locale` and `timezone` must be present to trigger wall-clock.** A peer that only pins `branding.locale` keeps the UTC stamp; a peer that only pins `branding.timezone` does too. The two-field gate is intentional — a locale-only stamp would render the same UTC instant under different formatting conventions, which is confusing without the timezone shift.

The reference impl is the shipped quadruple: `skillbox/rmo-copilot/renderers/_field-helpers.js`, `_dvir-helpers.js`, and their fr-CA peer counterparts. A future locale peer (es-MX / de-DE) drops in the same helper shape; no new branding-aggregation work is needed.

## Keep Lean

- Minimize dependencies. Tools should be simple.
- Self-document. Include examples in README and skill descriptions.
- One domain per box. Don't mix concerns.
- No bloat. Each skill/tool does one thing well.

## Tool Design

Tools can be:
- **Read-only** (query, lookup, retrieve) — instant.
- **Mutating** (write, create, modify) — require `requires_approval: true` in manifest. Ratchet waits for user confirmation.

Include tool metadata:
- Name, description
- Input schema (what params it takes)
- Output schema (what it returns)
- `requires_approval: true` if it modifies data

### Frontend renderers

Want a custom UI for one of your tool's results? Declare it under `branding.renderers`:

```json
"branding": {
  "renderers": { "lookup_regulations": "./renderers/lookup_regulations.js" }
}
```

Then drop a module at the matching path:

```js
// renderers/lookup_regulations.js
export default function register({ registerRenderer, renderSourceCards, renderNote }) {
  registerRenderer('lookup_regulations', (node, payload, opts) => {
    // mutate `node` directly — appendChild + textContent only.
    renderSourceCards(node, payload, opts); // compose on built-ins
  });
}
```

Ratchet serves the file at `/skillbox/<your-box>/renderers/<file>` and the panel dynamic-imports it after the branding fetch. Only `.js` / `.mjs` are accepted. The module runs in the host page's origin and gets full DOM access — same trust posture as host-supplied JS. One renderer per tool id; if two skillboxes declare the same tool, the later one in load order wins.

### Record types (`branding.recordTypes`)

If your skillbox ships an approval-gated tool that writes through `services.records`, declare those record types under `branding` so hosts can discover them:

```json
"branding": {
  "recordTypes": [
    {
      "type": "timesheet",
      "label": "My Timesheets",
      "toolName": "draft_timesheet",
      "emptyLabel": "No timesheets recorded yet."
    }
  ]
}
```

> **The panel no longer ships a built-in records-browsing sidebar.** That persistent per-user surface is now ratchet's core **Memories** (freeform notes + pinned files inlined into every turn — see Lesson 9 / `ratchet/CLAUDE.md`). `recordTypes` is still aggregated and echoed verbatim into the `/api/branding` response so a host page can surface its own record UI; the records themselves persist via `services.records` and are readable by later tool calls (e.g. `summarize_pay_period`). When a record is re-rendered, the renderer registered under `toolName` (defaults to `type`) is reused against a `{ ...record.data, recorded: true, recordId, recordedAt }` envelope, so a renderer that already handles the live "Recorded · id …" footer works on a replayed record for free.

Aggregation across skillboxes: last-wins per `type`, declaration order preserved.

### Server-tool handlers

Server tools (`"type": "server"`) need a JS module in `tools/`. Two conventions are auto-discovered:

- `tools/<tool-id>.js` — `default` or named `handler` export. Wins over the index map.
- `tools/index.js` — exports a `handlers: { '<tool-id>': fn }` map for bulk defaults.

Handler signature:

```js
export default async function (args, context) {
  // args   : Record<string, unknown>  — validated against inputSchema
  // context: { userId, sessionId, requestId?, services? }
  //   services.rag     — shared RAG engine (services.rag.retrieve(query, limit))
  //   services.records — approval-gated persistence; see below
  return { /* anything JSON-serializable */ };
}
```

**`services.records`** is the destination for approval-gated mutations. Call
`await services.records.write({ userId, type, sessionId, data, toolCallId? })`
and surface `recordId` + `recordedAt` in your tool's return shape so the panel's
renderer can flip to a "recorded" state. The service is optional — handlers
should still produce a sensible payload when `services.records` is undefined
(makes unit tests and host-isolated experiments work without stubbing).
Write throws degrade to a `note` on the response; don't let a records failure
drop the structured result on the floor.

Handlers must not import ratchet internals — the `services` bag is the contract. New services are added by Ratchet over time; treat what's present at call time as the supported surface.

Handler modules that fail to import (syntax error, throw at load time) are logged and skipped — the rest of the skillbox still loads. The tool will dispatch with "no handler attached" until the file is fixed.

### Approval-gated server tools

Mutating server tools — anything that drafts, writes, edits, or submits — should declare `"requiresApproval": true` in the manifest entry. Ratchet's dispatcher parks the call in its pending queue and only invokes the handler after the panel POSTs an approve decision; rejection short-circuits the handler entirely. The handler signature is unchanged from auto-execute tools — approval is a dispatcher concern, not a handler one.

Five server-tool patterns ship today in `rmo-copilot/`:

- **Read tool, auto-execute.** `lookup_regulations` retrieves regulation excerpts from the shared RAG engine via `context.services.rag`. No approval. Renderer composes on `renderSourceCards` to produce a citation stack.
- **Write tool, approval-gated.** `draft_timesheet` validates inputs (driver name, ISO date, HOS hours), computes HOS warnings, and returns a structured draft. Renderer (`draft_timesheet.js`) walks the `draft` field-by-field into a card with a compliance badge and a warnings banner — proves that the renderer registry handles non-source-card shapes.
  - **Session 67 — structured per-trip `warningCodes`.** Extends the Session-58 code pattern down to the per-trip HOS / data-quality warnings. The handler builds a `warningCodes: Array<{ code, ...fields }>` array FIRST (`computeTimesheetWarningCodes`, stable push order: `hos-driving-cap` → `hos-onduty-cap` → `driving-exceeds-onduty` → `driving-range` → `onduty-range`) then derives the legacy English `warnings: string[]` from it (`formatWarningStringEn`, byte-identical to the pre-Session-67 strings for the tool-call protocol). BOTH fields are persisted into the record's `data` so a downstream reader can translate. `hosCompliant` is computed from `warningCodes.length`. The per-trip code → string mapping lives ONCE per locale in the shared `_field-helpers.js` sibling (`formatTimesheetWarning`) with a `resolveTimesheetWarnings(codes, legacy)` precedence helper (NON-EMPTY codes win; otherwise legacy strings — so older records still paint). Both the `draft_timesheet` renderer (banner) and the `summarize_pay_period` renderer (per-row detail) consume it; the fr-CA peer's `_field-helpers.js` ships the French mapping. To add a new per-trip warning: add a branch to `computeTimesheetWarningCodes` + `formatWarningStringEn` (handler), and a branch to `formatTimesheetWarning` in BOTH `_field-helpers.js` siblings.
- **Write tool with structured sub-collections.** `draft_dvir` (Session 42) records an Alberta NSC Schedule 1 Driver Vehicle Inspection Report. Inputs cover the nine mandatory fields plus optional `defects[]`, `photos[]`, and a conditional mechanic signature (required when `defectStatus === 'major'`). The handler emits Schedule 1 compliance warnings (mismatched defect/status, unknown defect category, missing mechanic on major defects, malformed ISO timestamps); the renderer (`draft_dvir.js` + sibling `_dvir-helpers.js`) paints the field card, defects list grouped by category, photos grid, warnings banner, compliance badge, and Drafted / Recorded footer. Mirrors the dvir record-type declaration so the dvir type is published in the `/api/branding` response for host-side consumers on the next branding load.
  - **Session 68 — structured compliance `warningCodes`.** Applies the Session-67 per-trip-code pattern to the DVIR Schedule 1 warnings. The handler builds a `warningCodes: Array<{ code, ...fields }>` array FIRST via `computeDvirWarningCodes(defectStatus, defects, mechanicName, mechanicSignedAt)` (stable push order: `defect-status-no-defects` → `defects-without-status` → `major-needs-mechanic` → `unknown-defect-category` (one per off-schedule defect, in defects order) → `mechanic-signed-invalid`) then derives the legacy English `warnings: string[]` from it via `formatWarningStringEn` (byte-identical to the pre-Session-68 strings for the tool-call protocol). BOTH fields are persisted into the record's `data` so any later re-render of the record (which re-runs the renderer) translates in the reader's locale. `compliant` is computed from `warningCodes.length`. The code → string mapping lives ONCE per locale in the shared `_dvir-helpers.js` sibling (`formatDvirWarning`) with a `resolveDvirWarnings(codes, legacy)` precedence helper (NON-EMPTY codes win; otherwise legacy strings — so older records still paint). The draft_dvir renderers (primary + fr-CA peer) consume `resolveDvirWarnings` and add `warningCodes` to `documentedKeys`; the fr-CA peer's warnings banner is now actually French (it previously painted the handler's English strings — the same bug class Session 67 closed for timesheets). To add a new DVIR warning: add a branch to `computeDvirWarningCodes` + `formatWarningStringEn` (handler), and a branch to `formatDvirWarning` in BOTH `_dvir-helpers.js` siblings.
- **Read tool over `services.records` (Session 52).** `summarize_pay_period` rolls up the driver's recorded timesheets across a pay-period window into structured payroll-ready output: range bounds, totals (days worked / driving / on-duty / non-driving hours), chronological per-day breakdown, and period-level HOS warnings (70h-in-7-days cap). Inputs: `presetId` (`'current-pay-period'` | `'last-pay-period'`, resolved against the same anchor + length the panel's chip uses), or explicit `from`/`to` ISO dates, plus optional `driverName` substring filter. Defaults to current pay period when nothing is supplied. The handler queries `context.services.records.list(userId, { type: 'timesheet' })` and filters in JS by each record's `data.draft.tripDate` (NOT by `createdAt` — a timesheet recorded the morning after the trip still belongs to the trip's pay period). De-duplicates re-recorded tripDates keeping the newest `createdAt`. Renderer (`summarize_pay_period.js`) paints a header, range subtitle, four-cell totals card, daily table with per-row HOS warn class, roll-up warnings banner, compliance badge, and `Generated …` footer routed through the locale-aware `formatStamp` helper. Demonstrates the read-only-over-records pattern complementing the write-side handlers — Postgres-grade backends can push the tripDate filter into the query layer without changing the handler contract.
  - **Session 58 — structured `warningCodes` for locale-aware rendering.** The handler emits a parallel `warningCodes: Array<{ code: 'hos-70-7d', startIso, hours, cap }>` field alongside the legacy `warnings: string[]` (English) for the PERIOD-level roll-up. Renderers prefer `warningCodes` when present and translate per locale (the English primary renderer ships `formatWarningEn`, the fr-CA peer ships `formatWarningFrCA`); they fall back to the legacy string array when codes are absent (back-compat with older payloads / hand-rolled fixtures). The handler's legacy string field stays populated for the tool-call protocol so the LLM can still reason about HOS breaches in plain text. To add a new warning type: add the code branch to `computePeriodWarningCodes` in the handler, add an English entry to `formatWarningStringEn` (handler-side, for the legacy field) AND `formatWarningEn` (primary renderer), and add a French entry to `formatWarningFrCA` (peer renderer). Unknown codes drop silently — neither renderer paints an empty banner. The same code-to-string pattern is the recommended path for any future read-tool output that carries warning copy across locales.
  - **Session 67 — per-day `warningCodes` + localized per-row detail line.** Closes the Session-58 follow-up ("per-day warning translation") *and* its blocker ("no per-row surface paints strings yet"). Each `daily[]` entry now carries the stored timesheet's `warningCodes` (read from `data.warningCodes`, `[]` for pre-Session-67 records) alongside the legacy `warnings` strings; `hosCompliant` is non-compliant when EITHER source is non-empty. The renderer paints a per-row DETAIL line (`lc-payperiod-daily-warn-detail`, carrying `dataset.tripDate`) under each flagged data row, translated via the shared `resolveTimesheetWarnings` helper (per-trip codes preferred, legacy strings as fallback so older records still surface a reason). The period-level banner stays reserved for the roll-up so the two signals are visually distinct. fr-CA peer mirrors the DOM shape; French strings come from the peer's `_field-helpers.js` `formatTimesheetWarning`.
- **Read tool over the public web, auto-execute.** `web_search` searches the web (Tavily / Brave / DuckDuckGo, provider auto-selected from env at call time) when a question is current-events / vendor-specific / not in the KB. No approval — searching is a read. Returns the same `sources[]` shape as `lookup_regulations` so `renderSourceCards` paints citation cards for free. The renderer (`web_search.js`) wraps the cards with a query-echo header and a `N results · source: <provider>` footer.
  - **Session 62 — `recency` / `region` filter echo.** The handler echoes the *resolved* `recency` (`'day' | 'week' | 'month' | 'year'`) and `region` filters back in the payload (only the fields that resolved to a valid value are spread, mirroring `lookup_regulations`' `scoringMode` / `hybridWeight` echo). The renderer paints a `ratchet-tool-scoring-echo lc-web-filters` pill *between the header and the cards* — `freshness: past week · region: CA` — only when at least one filter resolved. To add a new filter echo: validate + resolve it in the handler, add `if (resolved) echo.<field> = resolved`, and add a `filterParts.push(...)` branch in the renderer.
  - **Session 63 — provider-honoured filter reporting (`appliedFilters`).** Closes the Session-62 caveat that the echo reflected the *requested* filter, not the *applied* one. Each provider function now returns an `appliedFilters: Array<'recency' | 'region'>` reporting which requested filters it actually mapped onto a provider parameter: Tavily and Brave push `'recency'` / `'region'` as they set `days`/`freshness` and `country` (Brave only counts `region` once a country code resolves); DuckDuckGo's Instant Answer endpoint supports neither, so it returns `[]`. The handler spreads `appliedFilters` into the payload **only when at least one filter resolved** (an unfiltered search omits it) and **only on the success path** — a provider that threw never reported what it applied, so the catch path keeps the requested-filter echo without an `appliedFilters` array. A no-key keyed-provider branch reports `[]` (the search never ran). The renderer reads `payload.appliedFilters`: any requested filter *absent* from it is painted with a `(not applied)` annotation (`freshness: past week (not applied) · region: CA (not applied)` for a DDG search). A **missing or non-array** `appliedFilters` is treated as "all applied" — back-compat with pre-Session-63 payloads and the catch path. To make a new provider honest about a filter: push the filter name onto its `appliedFilters` array at the point it sets the provider parameter.

## RAG Ingestion Recipe

Specify in manifest how ratchet should index documents:
- File paths (local PDFs, text, JSON)
- Chunk size, overlap
- Metadata to extract (e.g. province, regulation type)
- How to serve it to the LLM (retrieval top-k)

The same dataset can be indexed by both ratchet (RAG) and the host (structured lookup). Build it once.

## Testing

- Unit: tool implementation (can read/write data correctly)
- Integration: ratchet can load the skillbox, dispatch tools, stream responses
- E2E: full workflow (user asks question → ratchet retrieves from KB → tool executes → user approves/declines)

Ratchet owns the dispatch and approval flow. You own the tool logic.
