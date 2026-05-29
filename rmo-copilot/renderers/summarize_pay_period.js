/**
 * Lumber-Copilot — summarize_pay_period renderer.
 *
 * Renders the payroll-summary handler's structured payload as a stacked
 * card: header (range + label), totals badge (days / driving / on-duty /
 * non-driving), per-day table, and a roll-up warnings banner. The card
 * composes on the same `lc-…` class prefixes the timesheet + DVIR
 * renderers use so existing CSS theming hits this view for free.
 *
 * Module contract (Session 35: async installer + multi-file pattern):
 *   default export = async function register({ registerRenderer,
 *                                               renderNote,
 *                                               renderJsonBlock,
 *                                               loadSibling }) { ... }
 *
 * Reuses `formatStamp` from the shared `_field-helpers.js` sibling so the
 * Session-50 locale-aware wall-clock affordance lights up here too —
 * `_opts.locale` + `_opts.timezone` route through to the footer's
 * "Generated …" stamp without a separate code path.
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
      renderNote(node, 'No pay-period summary produced.');
      return;
    }

    // Degraded path — handler emitted a `note` and no usable totals.
    // Surface the note and stop; nothing else useful to render.
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
    // visible strings come from the locale-owning renderer rather than
    // the handler's English fallback. Legacy `warnings: string[]`
    // payloads (handler not yet shipping codes, or hand-rolled fixtures)
    // still paint via the fallback path.
    const warningCodes = Array.isArray(payload.warningCodes)
      ? payload.warningCodes
      : null;
    const warnings = warningCodes
      ? warningCodes.map(formatWarningEn).filter((s) => s)
      : Array.isArray(payload.warnings)
        ? payload.warnings
        : [];

    // Range subtitle — "Current pay period · 2026-05-08 → 2026-05-21"
    const subtitle = document.createElement('div');
    subtitle.className = 'ratchet-tool-card-meta lc-payperiod-range';
    const fromTo =
      range.from && range.to ? `${range.from} → ${range.to}` : '(unknown window)';
    subtitle.textContent = range.label ? `${range.label} · ${fromTo}` : fromTo;
    node.appendChild(subtitle);

    // Totals card — four labelled cells in a row.
    const totalsCard = document.createElement('div');
    totalsCard.className = 'ratchet-tool-card lc-payperiod-totals';
    appendTotalCell(totalsCard, 'Days worked', formatCount(totals.daysWorked));
    appendTotalCell(totalsCard, 'Driving', formatHours(totals.hoursDriving));
    appendTotalCell(totalsCard, 'On duty', formatHours(totals.hoursOnDuty));
    appendTotalCell(totalsCard, 'Non-driving', formatHours(totals.hoursOther));
    node.appendChild(totalsCard);

    if (daily.length === 0) {
      // Render the empty-state note inline so the user understands the
      // totals reflect an empty window, not a backend hiccup. Note: we
      // still paint the totals card above (all zeros) — visually
      // reinforces "we looked and there's nothing here."
      const empty = document.createElement('div');
      empty.className = 'ratchet-tool-card-meta lc-payperiod-empty';
      empty.textContent =
        payload.recordCount === 0
          ? 'No timesheets recorded yet.'
          : 'No timesheets fell inside this pay period.';
      node.appendChild(empty);
    } else {
      // Daily breakdown — chronological table of tripDate / driving /
      // on-duty / vehicle / loadType. Each row carries its own
      // `data-trip-date` so a host stylesheet or selector can target.
      const table = document.createElement('div');
      table.className = 'ratchet-tool-card lc-payperiod-daily';
      const headerRow = document.createElement('div');
      headerRow.className = 'lc-payperiod-daily-row lc-payperiod-daily-row-head';
      appendCell(headerRow, 'Date', 'lc-payperiod-cell-date');
      appendCell(headerRow, 'Driving', 'lc-payperiod-cell-hours');
      appendCell(headerRow, 'On duty', 'lc-payperiod-cell-hours');
      appendCell(headerRow, 'Vehicle', 'lc-payperiod-cell-vehicle');
      appendCell(headerRow, 'Load', 'lc-payperiod-cell-load');
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

        // Session 67: surface WHY a row is flagged. The data row paints a
        // warn class but no reason; a driver scanning the table can't tell
        // a 13h-driving day from a data-entry slip. Append a detail line
        // beneath each flagged row listing the per-trip warnings, translated
        // from `entry.warningCodes` when present (locale-owned) and falling
        // back to the legacy `entry.warnings` strings otherwise.
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

    // Roll-up warnings — period-level only (70h/7d cap). Per-day warnings
    // render inline as a detail line under their own flagged row (above);
    // this banner is reserved for the period-level roll-up so the two
    // signals stay visually distinct.
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'ratchet-tool-note lc-payperiod-warn';
      banner.textContent =
        warnings.length === 1
          ? `Warning: ${warnings[0]}`
          : `${warnings.length} HOS roll-up warnings — review before payroll close.`;
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

    // Compliance badge — green when no roll-up warnings, amber otherwise.
    // Independent of per-day warnings: a single 13h-driving day is a
    // per-row warning but doesn't necessarily breach the 70h/7d roll-up.
    const badge = document.createElement('div');
    badge.className =
      warnings.length === 0
        ? 'ratchet-tool-card-meta lc-payperiod-badge lc-payperiod-badge-ok'
        : 'ratchet-tool-card-meta lc-payperiod-badge lc-payperiod-badge-bad';
    badge.textContent =
      warnings.length === 0
        ? 'No roll-up HOS issues — pay period ready to close.'
        : 'Roll-up HOS issues detected — review before pay period close.';
    node.appendChild(badge);

    // Footer — generated timestamp + record-count reassurance ("we
    // looked at N of your timesheets to build this").
    const footer = document.createElement('div');
    footer.className = 'ratchet-tool-card-meta lc-payperiod-footer';
    const stampOpts = _opts || {};
    const stamp =
      typeof payload.generatedAt === 'string' && payload.generatedAt
        ? formatStamp(payload.generatedAt, stampOpts)
        : '(unknown)';
    const driverFrag =
      typeof payload.driverName === 'string' && payload.driverName
        ? ` · filtered to "${payload.driverName}"`
        : '';
    const count = Number.isFinite(payload.recordCount) ? payload.recordCount : 0;
    footer.textContent = `Generated ${stamp} · ${count} timesheet${count === 1 ? '' : 's'} scanned${driverFrag}`;
    node.appendChild(footer);

    // Surface a `note` even when daily/totals are present (e.g. records
    // service degraded but we still produced a partial answer).
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
    return `Pay period summary · ${payload.range.label}`;
  }
  return 'Pay period summary';
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
  if (!Number.isFinite(n)) return '0h';
  return `${roundOneDp(n)}h`;
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Math.trunc(n));
}

function roundOneDp(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Session 58 — translate a structured warning code into its English
 * banner string. Unknown codes return an empty string so a future
 * handler-side addition that hasn't been wired here doesn't paint
 * "[object Object]" or leak a code id into the chrome. Pair with
 * `formatWarningFrCA` in the peer renderer.
 */
function formatWarningEn(code) {
  if (!code || typeof code !== 'object') return '';
  if (code.code === 'hos-70-7d') {
    const hours = Number.isFinite(code.hours) ? code.hours : 0;
    const cap = Number.isFinite(code.cap) ? code.cap : 70;
    const startIso = typeof code.startIso === 'string' ? code.startIso : '';
    return (
      `Hours on duty (${hours}h) over 7 days starting ${startIso} ` +
      `exceeds federal cap of ${cap}h.`
    );
  }
  return '';
}
