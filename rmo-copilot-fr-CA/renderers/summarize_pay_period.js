/**
 * Lumber-Copilot fr-CA peer — summarize_pay_period renderer (Session 53).
 *
 * French (Canadian) override for the rmo-copilot primary's
 * summarize_pay_period renderer. Mirrors the English primary's DOM shape
 * and CSS class names one-for-one (same `lc-payperiod-…` prefixes,
 * `dataset.tripDate` / `dataset.recordId` selectors, header / range
 * subtitle / totals card / daily table / warnings banner / badge /
 * footer ordering) so theming, layout, and renderer-error isolation
 * behave identically across locales — only the visible strings change.
 *
 * The aggregator's `branding.renderers` map applies last-wins per toolId,
 * and the loader's deterministic alphabetic ordering pins `rmo-copilot`
 * before `rmo-copilot-fr-CA`, so the peer's URL wins on the
 * `/api/branding` wire when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set.
 *
 * Reuses `formatStamp` from the peer's `_field-helpers.js` sibling so the
 * Session-50 locale-aware wall-clock affordance lights up here too —
 * `_opts.locale` + `_opts.timezone` route through to the footer's
 * « Généré … » stamp without a separate code path. Composes on the
 * existing peer sibling rather than carrying its own helpers file, since
 * the only helper needed is `formatStamp` (which already mirrors the
 * primary one-for-one).
 */

export default async function register(ctx) {
  const { registerRenderer, renderNote, renderJsonBlock, loadSibling } = ctx;
  const helpers = await loadSibling('_field-helpers.js');
  const { formatStamp, resolveTimesheetWarnings } = helpers;

  registerRenderer('summarize_pay_period', (node, payload, _opts) => {
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-payperiod-header';
    header.textContent = headerText(payload);
    node.appendChild(header);

    if (!payload || typeof payload !== 'object') {
      renderNote(node, 'Aucun résumé de période de paie produit.');
      return;
    }

    // Degraded path — handler emitted a `note` and no usable totals.
    if (
      typeof payload.note === 'string' &&
      payload.note &&
      (!payload.totals || payload.totals.daysWorked === 0) &&
      (!Array.isArray(payload.daily) || payload.daily.length === 0)
    ) {
      renderNote(node, payload.note);
      return;
    }

    const range = payload.range || {};
    const totals = payload.totals || {};
    const daily = Array.isArray(payload.daily) ? payload.daily : [];
    // Session 58: structured `warningCodes` win when present so the
    // banner / list strings come from the peer's French translator
    // rather than the handler's English fallback. Legacy
    // `warnings: string[]` payloads (handler not yet shipping codes, or
    // hand-rolled French fixtures) still paint via the fallback path.
    const warningCodes = Array.isArray(payload.warningCodes)
      ? payload.warningCodes
      : null;
    const warnings = warningCodes
      ? warningCodes.map(formatWarningFrCA).filter((s) => s)
      : Array.isArray(payload.warnings)
        ? payload.warnings
        : [];

    // Range subtitle — « Période de paie courante · 2026-05-08 → 2026-05-21 ».
    // The range.label fragment is the manifest-supplied preset label; the
    // English primary emits "Current pay period" via its recordsFilterPresets
    // chip config. The fr-CA manifest does NOT carry recordsFilterPresets —
    // the French labels ("Période de paie courante" / "Période de paie
    // précédente") come from this renderer's own formatWarningFrCA path and
    // the tool handler's PRESET_LABELS when the tool resolves the range.
    const subtitle = document.createElement('div');
    subtitle.className = 'ratchet-tool-card-meta lc-payperiod-range';
    const fromTo =
      range.from && range.to
        ? `${range.from} → ${range.to}`
        : '(période inconnue)';
    subtitle.textContent = range.label ? `${range.label} · ${fromTo}` : fromTo;
    node.appendChild(subtitle);

    // Totals card — four labelled cells in a row.
    const totalsCard = document.createElement('div');
    totalsCard.className = 'ratchet-tool-card lc-payperiod-totals';
    appendTotalCell(totalsCard, 'Jours travaillés', formatCount(totals.daysWorked));
    appendTotalCell(totalsCard, 'Conduite', formatHours(totals.hoursDriving));
    appendTotalCell(totalsCard, 'En service', formatHours(totals.hoursOnDuty));
    appendTotalCell(totalsCard, 'Hors conduite', formatHours(totals.hoursOther));
    node.appendChild(totalsCard);

    if (daily.length === 0) {
      // Render the empty-state note inline so the user understands the
      // totals reflect an empty window, not a backend hiccup.
      const empty = document.createElement('div');
      empty.className = 'ratchet-tool-card-meta lc-payperiod-empty';
      empty.textContent =
        payload.recordCount === 0
          ? 'Aucune feuille de temps enregistrée pour le moment.'
          : 'Aucune feuille de temps dans cette période de paie.';
      node.appendChild(empty);
    } else {
      // Daily breakdown — chronological table. Each row carries its own
      // `data-trip-date` so a host stylesheet or selector can target.
      const table = document.createElement('div');
      table.className = 'ratchet-tool-card lc-payperiod-daily';
      const headerRow = document.createElement('div');
      headerRow.className = 'lc-payperiod-daily-row lc-payperiod-daily-row-head';
      appendCell(headerRow, 'Date', 'lc-payperiod-cell-date');
      appendCell(headerRow, 'Conduite', 'lc-payperiod-cell-hours');
      appendCell(headerRow, 'En service', 'lc-payperiod-cell-hours');
      appendCell(headerRow, 'Véhicule', 'lc-payperiod-cell-vehicle');
      appendCell(headerRow, 'Chargement', 'lc-payperiod-cell-load');
      table.appendChild(headerRow);
      for (const entry of daily) {
        const row = document.createElement('div');
        row.className = entry.hosCompliant
          ? 'lc-payperiod-daily-row'
          : 'lc-payperiod-daily-row lc-payperiod-daily-row-warn';
        if (typeof entry.tripDate === 'string') row.dataset.tripDate = entry.tripDate;
        if (typeof entry.recordId === 'string') row.dataset.recordId = entry.recordId;
        appendCell(row, entry.tripDate || '—', 'lc-payperiod-cell-date');
        appendCell(row, formatHours(entry.hoursDriving), 'lc-payperiod-cell-hours');
        appendCell(row, formatHours(entry.hoursOnDuty), 'lc-payperiod-cell-hours');
        appendCell(row, entry.vehicleId || '—', 'lc-payperiod-cell-vehicle');
        appendCell(row, entry.loadType || '—', 'lc-payperiod-cell-load');
        table.appendChild(row);

        // Session 67: French per-row warning detail line, mirroring the
        // English primary's DOM shape + class names one-for-one. Strings
        // come from `resolveTimesheetWarnings` (this peer's French
        // `formatTimesheetWarning` for codes; the legacy `entry.warnings`
        // strings as fallback — which on a fr-CA deploy are whatever the
        // recording stored, kept for back-compat).
        const dayWarnings = resolveTimesheetWarnings(
          entry.warningCodes,
          entry.warnings
        );
        if (dayWarnings.length > 0) {
          const detail = document.createElement('div');
          detail.className =
            'lc-payperiod-daily-row lc-payperiod-daily-warn-detail';
          if (typeof entry.tripDate === 'string') {
            detail.dataset.tripDate = entry.tripDate;
          }
          const cell = document.createElement('span');
          cell.className = 'lc-payperiod-cell lc-payperiod-cell-warn-detail';
          cell.textContent = dayWarnings.join(' · ');
          detail.appendChild(cell);
          table.appendChild(detail);
        }
      }
      node.appendChild(table);
    }

    // Roll-up warnings — period-level only. Per-day warnings render
    // inline as a detail line under their own flagged row (above); this
    // banner is reserved for the period-level roll-up.
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-payperiod-warn';
      banner.textContent =
        warnings.length === 1
          ? `Avertissement : ${warnings[0]}`
          : `${warnings.length} avertissements de cumul HOS — à vérifier avant la clôture de la paie.`;
      node.appendChild(banner);
      if (warnings.length > 1) {
        const list = document.createElement('ul');
        list.className = 'lc-payperiod-warn-list';
        for (const w of warnings) {
          const li = document.createElement('li');
          li.textContent = w;
          list.appendChild(li);
        }
        node.appendChild(list);
      }
    }

    // Compliance badge — independent of per-day badges.
    const badge = document.createElement('div');
    badge.className =
      warnings.length === 0
        ? 'ratchet-tool-card-meta lc-payperiod-badge lc-payperiod-badge-ok'
        : 'ratchet-tool-card-meta lc-payperiod-badge lc-payperiod-badge-bad';
    badge.textContent =
      warnings.length === 0
        ? 'Aucun problème de cumul HOS — période de paie prête à clôturer.'
        : 'Problèmes de cumul HOS détectés — à vérifier avant la clôture.';
    node.appendChild(badge);

    // Footer — generated timestamp + record-count reassurance. Driver
    // filter fragment uses French guillemets « … » with thin-space
    // padding when supplied.
    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-payperiod-footer';
    const stampOpts = _opts || {};
    const stamp =
      typeof payload.generatedAt === 'string' && payload.generatedAt
        ? formatStamp(payload.generatedAt, stampOpts)
        : '(inconnu)';
    const driverFrag =
      typeof payload.driverName === 'string' && payload.driverName
        ? ` · filtré sur « ${payload.driverName} »`
        : '';
    const count = Number.isFinite(payload.recordCount) ? payload.recordCount : 0;
    const sheetNoun =
      count === 1 ? 'feuille de temps analysée' : 'feuilles de temps analysées';
    footer.textContent = `Généré ${stamp} · ${count} ${sheetNoun}${driverFrag}`;
    node.appendChild(footer);

    // Surface a `note` even when daily/totals are present (e.g. records
    // service degraded but a partial answer landed).
    if (typeof payload.note === 'string' && payload.note) {
      renderNote(node, payload.note);
    }

    // Round-trip undocumented payload fields as a debug block so future
    // handler additions don't get silently swallowed.
    const documentedKeys = new Set([
      'range',
      'driverName',
      'totals',
      'daily',
      'warnings',
      'warningCodes',
      'recordCount',
      'generatedAt',
      'note',
    ]);
    const extraTop = Object.keys(payload).filter((k) => !documentedKeys.has(k));
    if (extraTop.length > 0) {
      const extraObj = {};
      for (const k of extraTop) extraObj[k] = payload[k];
      renderJsonBlock(node, extraObj);
    }
  });
}

function headerText(payload) {
  if (payload && payload.range && payload.range.label) {
    return `Résumé de période de paie · ${payload.range.label}`;
  }
  return 'Résumé de période de paie';
}

function appendTotalCell(parent, label, value) {
  const cell = document.createElement('div');
  cell.className = 'lc-payperiod-totals-cell';
  const labelEl = document.createElement('span');
  labelEl.className = 'lc-payperiod-totals-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'lc-payperiod-totals-value';
  valueEl.textContent = value;
  cell.appendChild(labelEl);
  cell.appendChild(valueEl);
  parent.appendChild(cell);
}

function appendCell(parent, text, extraClass) {
  const cell = document.createElement('span');
  cell.className = extraClass
    ? `lc-payperiod-cell ${extraClass}`
    : 'lc-payperiod-cell';
  cell.textContent = String(text);
  parent.appendChild(cell);
}

function formatHours(n) {
  if (!Number.isFinite(n)) return '0 h';
  return `${roundOneDp(n)} h`;
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Math.trunc(n));
}

function roundOneDp(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Session 58 — translate a structured warning code into its French
 * (Canadian) banner string. Mirrors `formatWarningEn` in the English
 * primary one-for-one (same code-id branch table, same field reads,
 * same defensive defaults) so the only divergence between locales is
 * the visible copy. Unknown codes return an empty string so a future
 * handler-side addition that hasn't been wired here doesn't paint
 * "[object Object]" or leak a code id into the chrome.
 *
 * Wording matches the Session-53 hand-written French fallback the
 * peer's tests already pin (« Cumul d'heures de service > 70 h sur 7
 * jours (fenêtre se terminant le YYYY-MM-DD) »); the same strings
 * survive the route through structured codes.
 */
function formatWarningFrCA(code) {
  if (!code || typeof code !== 'object') return '';
  if (code.code === 'hos-70-7d') {
    const cap = Number.isFinite(code.cap) ? code.cap : 70;
    const startIso = typeof code.startIso === 'string' ? code.startIso : '';
    const endIso = addDaysIso(startIso, 6);
    return (
      `Cumul d’heures de service > ${cap} h sur 7 jours ` +
      `(fenêtre se terminant le ${endIso}).`
    );
  }
  return '';
}

/**
 * Add N UTC days to an ISO-formatted date string. Returns '' on bad
 * input — the caller paints whatever the format string produces, which
 * for an empty endIso renders "fenêtre se terminant le ." (visibly
 * degraded but not crashy).
 */
function addDaysIso(iso, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = date.getUTCMonth() + 1;
  const dd = date.getUTCDate();
  return `${yy}-${mm < 10 ? `0${mm}` : mm}-${dd < 10 ? `0${dd}` : dd}`;
}
