/**
 * Lumber-Copilot fr-CA peer — draft_dvir renderer (Session 48).
 *
 * French (Canadian) override for the rmo-copilot primary's draft_dvir
 * renderer. The aggregator's `branding.renderers` map applies last-wins
 * per toolId, and the loader's deterministic alphabetic ordering pins
 * `rmo-copilot` before `rmo-copilot-fr-CA`, so the peer's URL wins on the
 * `/api/branding` wire when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set.
 *
 * Mirrors the English primary's DOM shape and CSS classes one-for-one
 * (same `lc-dvir-header`, `lc-dvir-card`, `lc-dvir-defects-list`,
 * `lc-dvir-photos-grid`, `lc-dvir-badge-ok` / `-bad`, footer states) so
 * theming, layout, and renderer-error isolation behave identically
 * across locales — only the visible strings change.
 *
 * Pure helpers (DVIR_FIELD_LABELS / DEFECT_CATEGORY_LABELS /
 * createDvirFieldRow / formatDvirStamp / defectCategoryLabel /
 * dvirFieldIterationOrder) live in the sibling `_dvir-helpers.js`. The
 * sibling is fetched relative to the peer's URL, so the French
 * Schedule-1 category names load alongside the French chrome — no
 * cross-skillbox import dance.
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
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-dvir-header';
    header.textContent = 'Brouillon de RIVC';
    node.appendChild(header);

    if (!payload || typeof payload !== 'object' || !payload.draft) {
      if (payload && typeof payload.note === 'string') {
        renderNote(node, payload.note);
      } else {
        renderNote(node, 'Aucun RIVC produit.');
      }
      return;
    }

    const draft = payload.draft;

    const card = document.createElement('div');
    card.className = 'ratchet-tool-card lc-dvir-card';

    for (const key of dvirFieldIterationOrder(Object.keys(draft))) {
      const row = createDvirFieldRow(key, draft[key]);
      if (row) card.appendChild(row);
    }

    node.appendChild(card);

    const defects = Array.isArray(draft.defects) ? draft.defects : [];
    if (defects.length > 0) {
      const defectsHeader = document.createElement('div');
      defectsHeader.className = 'ratchet-tool-card-meta lc-dvir-defects-header';
      defectsHeader.textContent =
        defects.length === 1
          ? '1 défectuosité détaillée'
          : `${defects.length} défectuosités détaillées`;
      node.appendChild(defectsHeader);

      const list = document.createElement('ul');
      list.className = 'lc-dvir-defects-list';
      for (const defect of defects) {
        const li = document.createElement('li');
        li.className = 'lc-dvir-defect-row';
        li.dataset.category = defect.category || 'other';
        const cat = document.createElement('span');
        cat.className = 'lc-dvir-defect-category';
        cat.textContent = `${defectCategoryLabel(defect.category)} : `;
        const desc = document.createElement('span');
        desc.className = 'lc-dvir-defect-description';
        desc.textContent = String(defect.description || '');
        li.appendChild(cat);
        li.appendChild(desc);
        list.appendChild(li);
      }
      node.appendChild(list);
    }

    const photos = Array.isArray(draft.photos) ? draft.photos : [];
    if (photos.length > 0) {
      const photosHeader = document.createElement('div');
      photosHeader.className = 'ratchet-tool-card-meta lc-dvir-photos-header';
      photosHeader.textContent =
        photos.length === 1 ? '1 photo jointe' : `${photos.length} photos jointes`;
      node.appendChild(photosHeader);

      const grid = document.createElement('div');
      grid.className = 'lc-dvir-photos-grid';
      for (const photo of photos) {
        const tile = document.createElement('figure');
        tile.className = 'lc-dvir-photo-tile';
        const img = document.createElement('img');
        img.className = 'lc-dvir-photo-img';
        img.src = String(photo.url || '');
        img.alt = String(photo.caption || photo.url || 'Photo de RIVC');
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

    // Prefer the structured `warningCodes` (Session 68), translating to
    // French via the peer's sibling; fall back to the legacy strings for
    // pre-Session-68 payloads / records. Before Session 68 this banner
    // painted the handler's English strings — now it is actually French.
    const warnings = resolveDvirWarnings(payload.warningCodes, payload.warnings);
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-dvir-warn';
      banner.textContent =
        warnings.length === 1
          ? `Avertissement : ${warnings[0]}`
          : `${warnings.length} avertissements de conformité — à vérifier avant approbation.`;
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
      ? 'Conforme à l’annexe 1 — prêt à soumettre.'
      : 'Problèmes liés à l’annexe 1 détectés — à corriger avant soumission.';
    node.appendChild(badge);

    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-dvir-footer';
    // Locale-aware stamp (Session 50): mirror the English primary's
    // pattern — thread the panel's resolved `_opts.locale` /
    // `_opts.timezone` through `formatDvirStamp`. Absent both = UTC.
    const stampOpts = _opts || {};
    const draftedStamp = formatDvirStamp(payload.generatedAt, stampOpts);
    if (payload.recorded === true && typeof payload.recordId === 'string') {
      footer.className += ' lc-dvir-footer-recorded';
      const recordedStamp = formatDvirStamp(
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
