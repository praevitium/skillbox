/**
 * Lumber-Copilot — draft_dvir renderer (Session 42).
 *
 * Renders the DVIR handler's structured payload as a labelled field
 * card with a defect list, photo thumbs, compliance badge, and an
 * optional warnings banner. Mirrors the timesheet renderer's overall
 * shape so a driver who's used both surfaces sees a consistent record
 * affordance.
 *
 * Module contract (Session 35: async installer + multi-file pattern):
 *   default export = async function register({ registerRenderer,
 *                                               renderSourceCards,
 *                                               renderNote,
 *                                               renderJsonBlock,
 *                                               loadSibling }) { ... }
 *
 * Pure helpers live in the sibling module `_dvir-helpers.js`. The panel
 * propagates the parent's `?v=<manifest.version>` cache-bust tag onto
 * the sibling import so a manifest bump invalidates both modules
 * together.
 */

export default async function register(ctx) {
  const { registerRenderer, renderNote, renderJsonBlock, loadSibling } = ctx;
  const helpers = await loadSibling('_dvir-helpers.js');
  const {
    createDvirFieldRow,
    dvirFieldIterationOrder,
    formatDvirStamp,
    defectCategoryLabel,
    resolveDvirWarnings,
  } = helpers;

  registerRenderer('draft_dvir', (node, payload, _opts) => {
    // Header banner — visually distinct from source-card stacks so the
    // driver knows this is a draft record, not a regulation lookup.
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-dvir-header';
    header.textContent = 'Draft DVIR';
    node.appendChild(header);

    // Degraded path — handler reported a `note` and no `draft`. Surface
    // the note prominently and stop; nothing else useful to render.
    if (!payload || typeof payload !== 'object' || !payload.draft) {
      if (payload && typeof payload.note === 'string') {
        renderNote(node, payload.note);
      } else {
        renderNote(node, 'No DVIR produced.');
      }
      return;
    }

    const draft = payload.draft;

    // Field-card stack — one row per non-empty field. Defects and photos
    // are stripped from the field iteration order and render below as
    // dedicated sections.
    const card = document.createElement('div');
    card.className = 'ratchet-tool-card lc-dvir-card';

    for (const key of dvirFieldIterationOrder(Object.keys(draft))) {
      const row = createDvirFieldRow(key, draft[key]);
      if (row) card.appendChild(row);
    }

    node.appendChild(card);

    // Defects section — bulleted list grouped by category. We render
    // even when defectStatus is 'none' and defects[] is empty (omitted),
    // so the absence of the section IS the "no defects" affordance —
    // the field card's "Defect status: No defects" line covers it.
    const defects = Array.isArray(draft.defects) ? draft.defects : [];
    if (defects.length > 0) {
      const defectsHeader = document.createElement('div');
      defectsHeader.className = 'ratchet-tool-card-meta lc-dvir-defects-header';
      defectsHeader.textContent =
        defects.length === 1
          ? '1 defect itemized'
          : `${defects.length} defects itemized`;
      node.appendChild(defectsHeader);

      const list = document.createElement('ul');
      list.className = 'lc-dvir-defects-list';
      for (const defect of defects) {
        const li = document.createElement('li');
        li.className = 'lc-dvir-defect-row';
        li.dataset.category = defect.category || 'other';
        const cat = document.createElement('span');
        cat.className = 'lc-dvir-defect-category';
        cat.textContent = `${defectCategoryLabel(defect.category)}: `;
        const desc = document.createElement('span');
        desc.className = 'lc-dvir-defect-description';
        desc.textContent = String(defect.description || '');
        li.appendChild(cat);
        li.appendChild(desc);
        list.appendChild(li);
      }
      node.appendChild(list);
    }

    // Photos section — thumbnail grid. Caption falls back to the
    // filename slug taken from the URL when the LLM didn't supply one.
    const photos = Array.isArray(draft.photos) ? draft.photos : [];
    if (photos.length > 0) {
      const photosHeader = document.createElement('div');
      photosHeader.className = 'ratchet-tool-card-meta lc-dvir-photos-header';
      photosHeader.textContent =
        photos.length === 1 ? '1 photo attached' : `${photos.length} photos attached`;
      node.appendChild(photosHeader);

      const grid = document.createElement('div');
      grid.className = 'lc-dvir-photos-grid';
      for (const photo of photos) {
        const tile = document.createElement('figure');
        tile.className = 'lc-dvir-photo-tile';
        const img = document.createElement('img');
        img.className = 'lc-dvir-photo-img';
        img.src = String(photo.url || '');
        img.alt = String(photo.caption || photo.url || 'DVIR photo');
        img.loading = 'lazy';
        const cap = document.createElement('figcaption');
        cap.className = 'lc-dvir-photo-caption';
        cap.textContent = String(photo.caption || '');
        tile.appendChild(img);
        if (photo.caption) tile.appendChild(cap);
        grid.appendChild(tile);
      }
      node.appendChild(grid);
    }

    // Warnings / compliance — same dual-signal posture as the
    // timesheet renderer. A non-compliant draft gets a per-warning list
    // AND the badge flipped, so the driver sees both signals without
    // scrolling.
    // Prefer the structured `warningCodes` (Session 68), translating per
    // locale via the sibling; fall back to the legacy English strings for
    // pre-Session-68 payloads / records.
    const warnings = resolveDvirWarnings(payload.warningCodes, payload.warnings);
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-dvir-warn';
      banner.textContent =
        warnings.length === 1
          ? `Warning: ${warnings[0]}`
          : `${warnings.length} compliance warnings — review before approving.`;
      node.appendChild(banner);

      if (warnings.length > 1) {
        const list = document.createElement('ul');
        list.className = 'lc-dvir-warn-list';
        for (const w of warnings) {
          const li = document.createElement('li');
          li.textContent = w;
          list.appendChild(li);
        }
        node.appendChild(list);
      }
    }

    const badge = document.createElement('div');
    badge.className = payload.compliant
      ? 'ratchet-tool-card-meta lc-dvir-badge lc-dvir-badge-ok'
      : 'ratchet-tool-card-meta lc-dvir-badge lc-dvir-badge-bad';
    badge.textContent = payload.compliant
      ? 'Schedule 1 compliant — ready to submit.'
      : 'Schedule 1 issues detected — fix before submitting.';
    node.appendChild(badge);

    // Footer — when the records service captured the draft, surface
    // the record id and timestamp so the driver can find it again.
    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-dvir-footer';
    // Locale-aware stamp (Session 50): thread the panel's resolved
    // `_opts.locale` / `_opts.timezone` so `formatDvirStamp` produces
    // wall-clock when both are present. Absent both = back-compat UTC.
    const stampOpts = _opts || {};
    const draftedStamp = formatDvirStamp(payload.generatedAt, stampOpts);
    if (payload.recorded === true && typeof payload.recordId === 'string') {
      footer.className += ' lc-dvir-footer-recorded';
      const recordedStamp = formatDvirStamp(
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
    // still useful). Degraded-`draft: null` cases short-circuit above.
    if (typeof payload.note === 'string' && payload.note) {
      renderNote(node, payload.note);
    }

    // Round-trip undocumented top-level keys via the JSON debug block
    // so LLM verbosity isn't silently swallowed. Keeps the slice
    // debuggable in the field.
    const documentedKeys = new Set([
      'draft',
      'warnings',
      'warningCodes',
      'compliant',
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
