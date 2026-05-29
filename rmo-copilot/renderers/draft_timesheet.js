/**
 * Lumber-Copilot — draft_timesheet renderer.
 *
 * Renders the timesheet handler's structured payload as a labelled field
 * card with a HOS-compliance badge and an optional warnings banner.
 * Demonstrates that the renderer registry handles tool results that are
 * NOT `{ sources: [...] }` — i.e. it's not just for citation cards.
 *
 * Module contract (Session 35: async installer + multi-file pattern):
 *   default export = async function register({ registerRenderer,
 *                                               renderSourceCards,
 *                                               renderNote,
 *                                               renderJsonBlock,
 *                                               loadSibling }) { ... }
 *
 * Pure helpers live in the sibling module `_field-helpers.js`. The panel
 * propagates the parent's `?v=<manifest.version>` cache-bust tag onto
 * the sibling import URL, so a manifest bump invalidates both modules
 * together (a static `import './_field-helpers.js'` from inside the
 * parent module would NOT propagate the version tag — the browser caches
 * the ESM module by its resolved URL, and the query string is dropped
 * by path-relative resolution per the URL spec).
 *
 * Approval state is owned by ratchet's panel, not by this renderer.
 * The body shown here is what the driver sees once the call has been
 * approved (or after the LLM has surfaced the draft pre-approval — the
 * renderer is invoked on every `tool_result`, regardless of source).
 */

export default async function register(ctx) {
  const { registerRenderer, renderNote, renderJsonBlock, loadSibling } = ctx;
  // Pull the field-shaping helpers via the sibling pattern so the cache-
  // bust tag propagates onto the helpers module too.
  const helpers = await loadSibling('_field-helpers.js');
  const { createFieldRow, fieldIterationOrder, formatStamp, resolveTimesheetWarnings } =
    helpers;

  registerRenderer('draft_timesheet', (node, payload, _opts) => {
    // Header banner — visually distinct from source-card stacks so
    // drivers know this is a draft record, not a regulation lookup.
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-timesheet-header';
    header.textContent = 'Draft timesheet';
    node.appendChild(header);

    // Degraded path — handler reported a `note` and no `draft`. Surface
    // the note prominently and stop; nothing else useful to render.
    if (!payload || typeof payload !== 'object' || !payload.draft) {
      if (payload && typeof payload.note === 'string') {
        renderNote(node, payload.note);
      } else {
        renderNote(node, 'No draft produced.');
      }
      return;
    }

    const draft = payload.draft;

    // Field-card stack — one card per non-empty field. We reuse the
    // existing card classes so theming hits this view for free.
    const card = document.createElement('div');
    card.className = 'ratchet-tool-card lc-timesheet-card';

    for (const key of fieldIterationOrder(Object.keys(draft))) {
      const row = createFieldRow(key, draft[key]);
      if (row) card.appendChild(row);
    }

    node.appendChild(card);

    // Warnings / compliance badge. Order matters: a non-compliant draft
    // gets the warnings list (red banner per warning) AND the badge
    // flipped, so the driver sees both signals without scrolling.
    // Session 67: structured `warningCodes` win when present so the visible
    // strings come from this (locale-owning) renderer rather than the
    // handler's English fallback. Legacy `warnings: string[]` payloads
    // (older handler, hand-rolled fixtures) still paint via the fallback.
    const warnings = resolveTimesheetWarnings(payload.warningCodes, payload.warnings);
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-timesheet-warn';
      banner.textContent =
        warnings.length === 1
          ? `Warning: ${warnings[0]}`
          : `${warnings.length} HOS / data warnings — review before approving.`;
      node.appendChild(banner);

      if (warnings.length > 1) {
        const list = document.createElement('ul');
        list.className = 'lc-timesheet-warn-list';
        for (const w of warnings) {
          const li = document.createElement('li');
          li.textContent = w;
          list.appendChild(li);
        }
        node.appendChild(list);
      }
    }

    const badge = document.createElement('div');
    badge.className = payload.hosCompliant
      ? 'ratchet-tool-card-meta lc-timesheet-badge lc-timesheet-badge-ok'
      : 'ratchet-tool-card-meta lc-timesheet-badge lc-timesheet-badge-bad';
    badge.textContent = payload.hosCompliant
      ? 'HOS compliant — ready to submit.'
      : 'HOS issues detected — fix before submitting.';
    node.appendChild(badge);

    // Footer — when the records service captured the draft, surface the
    // record id and the recorded timestamp so the driver can find it
    // again. Otherwise keep the "not yet recorded" framing so liability
    // stays clear if the handler ran without the records service wired.
    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-timesheet-footer';
    // Locale-aware stamp (Session 50): thread the panel's resolved
    // `_opts.locale` / `_opts.timezone` so `formatStamp` produces
    // wall-clock when both are present. Absent both = back-compat UTC.
    const stampOpts = _opts || {};
    const draftedStamp = formatStamp(payload.generatedAt, stampOpts);
    if (payload.recorded === true && typeof payload.recordId === 'string') {
      footer.className += ' lc-timesheet-footer-recorded';
      const recordedStamp = formatStamp(
        payload.recordedAt || payload.generatedAt,
        stampOpts
      );
      footer.textContent = `Recorded ${recordedStamp} · id ${payload.recordId}`;
    } else if (typeof payload.generatedAt === 'string' && payload.generatedAt) {
      footer.textContent = `Drafted ${draftedStamp} · not yet recorded`;
    } else {
      footer.textContent = 'Draft only · not yet recorded';
    }
    node.appendChild(footer);

    // Surface any `note` the handler attached even when there is a
    // draft (e.g. records.write failed but the structured payload is
    // still useful). Degraded-`draft: null` cases already short-circuit
    // above, so this only fires for "draft present but something went
    // sideways with persistence."
    if (typeof payload.note === 'string' && payload.note) {
      renderNote(node, payload.note);
    }

    // If we somehow got an extra payload shape the handler didn't
    // describe, surface it as a debug block so the LLM's quirks don't
    // get silently swallowed. Keeps the slice debuggable in the field.
    const documentedKeys = new Set([
      'draft',
      'warnings',
      'warningCodes',
      'hosCompliant',
      'generatedAt',
      'note',
      'recorded',
      'recordId',
      'recordedAt',
    ]);
    const extraTop = Object.keys(payload).filter((k) => !documentedKeys.has(k));
    if (extraTop.length > 0) {
      const extraObj = {};
      for (const k of extraTop) extraObj[k] = payload[k];
      renderJsonBlock(node, extraObj);
    }
  });
}
