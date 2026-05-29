/**
 * Lumber-Copilot fr-CA peer — draft_timesheet renderer (Session 47).
 *
 * French (Canadian) override for the rmo-copilot primary's draft_timesheet
 * renderer. The aggregator's `branding.renderers` map applies last-wins
 * per toolId, and the loader's deterministic alphabetic ordering pins
 * `rmo-copilot` before `rmo-copilot-fr-CA`, so the peer's URL wins on the
 * `/api/branding` wire when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set.
 *
 * Mirrors the English primary's DOM shape and CSS classes one-for-one so
 * theming, layout, and renderer-error isolation behave identically across
 * locales — only the visible strings change.
 *
 * Pure helpers (FIELD_LABELS / FIELD_ORDER / createFieldRow / formatStamp /
 * fieldIterationOrder) live in the sibling `_field-helpers.js`. The
 * sibling is fetched relative to the peer's URL, so the French labels
 * load alongside the French chrome — no cross-skillbox import dance.
 */

export default async function register(ctx) {
  const { registerRenderer, renderNote, renderJsonBlock, loadSibling } = ctx;
  const helpers = await loadSibling('_field-helpers.js');
  const { createFieldRow, fieldIterationOrder, formatStamp, resolveTimesheetWarnings } =
    helpers;

  registerRenderer('draft_timesheet', (node, payload, _opts) => {
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-timesheet-header';
    header.textContent = 'Brouillon de feuille de temps';
    node.appendChild(header);

    if (!payload || typeof payload !== 'object' || !payload.draft) {
      if (payload && typeof payload.note === 'string') {
        renderNote(node, payload.note);
      } else {
        renderNote(node, 'Aucun brouillon produit.');
      }
      return;
    }

    const draft = payload.draft;

    const card = document.createElement('div');
    card.className = 'ratchet-tool-card lc-timesheet-card';

    for (const key of fieldIterationOrder(Object.keys(draft))) {
      const row = createFieldRow(key, draft[key]);
      if (row) card.appendChild(row);
    }

    node.appendChild(card);

    // Session 67: prefer structured `warningCodes` (translated to French
    // here) over the handler's English fallback strings. Legacy
    // `warnings: string[]` payloads still paint via the fallback path.
    const warnings = resolveTimesheetWarnings(payload.warningCodes, payload.warnings);
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-timesheet-warn';
      banner.textContent =
        warnings.length === 1
          ? `Avertissement : ${warnings[0]}`
          : `${warnings.length} avertissements HOS / données — à vérifier avant approbation.`;
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
      ? 'Conforme aux HOS — prêt à soumettre.'
      : 'Problèmes HOS détectés — à corriger avant soumission.';
    node.appendChild(badge);

    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-timesheet-footer';
    // Locale-aware stamp (Session 50): mirror the English primary's
    // pattern — thread the panel's resolved `_opts.locale` /
    // `_opts.timezone` through `formatStamp`. Absent both = UTC fallback.
    const stampOpts = _opts || {};
    const draftedStamp = formatStamp(payload.generatedAt, stampOpts);
    if (payload.recorded === true && typeof payload.recordId === 'string') {
      footer.className += ' lc-timesheet-footer-recorded';
      const recordedStamp = formatStamp(
        payload.recordedAt || payload.generatedAt,
        stampOpts
      );
      footer.textContent = `Enregistré ${recordedStamp} · id ${payload.recordId}`;
    } else if (typeof payload.generatedAt === 'string' && payload.generatedAt) {
      footer.textContent = `Brouillon ${draftedStamp} · pas encore enregistré`;
    } else {
      footer.textContent = 'Brouillon seulement · pas encore enregistré';
    }
    node.appendChild(footer);

    if (typeof payload.note === 'string' && payload.note) {
      renderNote(node, payload.note);
    }

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
