/**
 * Lumber-Copilot fr-CA peer — shared renderer helpers (Session 47).
 *
 * Sibling module imported by draft_timesheet.js via `ctx.loadSibling`. The
 * panel propagates the peer's `?v=<manifest.version>` cache-bust tag onto
 * the sibling URL so a peer-manifest bump invalidates both modules together.
 *
 * Mirrors the shape of the English primary's `_field-helpers.js` but pins
 * French (Canadian) label strings. The peer manifest's renderer override
 * (`branding.renderers.draft_timesheet`) routes the panel's dynamic import
 * here when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set; the English helpers
 * stay loaded for any tool the peer does not override.
 */

export const FIELD_LABELS = {
  driverName: 'Conducteur',
  tripDate: 'Date du voyage',
  hoursDriving: 'Heures de conduite',
  hoursOnDuty: 'Heures de service',
  vehicleId: 'Véhicule',
  loadType: 'Type de chargement',
  tripDescription: 'Notes de voyage',
};

// Iteration order — keeps the field card stable across calls. Mirrors the
// English helper so a future field added on the primary lands in the same
// position on the peer.
export const FIELD_ORDER = [
  'driverName',
  'tripDate',
  'hoursDriving',
  'hoursOnDuty',
  'vehicleId',
  'loadType',
  'tripDescription',
];

/**
 * Build a single labelled field row for the timesheet card.
 *
 * Returns the row element. Callers append it to their card container.
 * `null` for empty values (caller can skip undefined fields without
 * needing its own guard).
 */
export function createFieldRow(key, value) {
  if (value === undefined || value === null || value === '') return null;
  const row = document.createElement('div');
  row.className = 'ratchet-tool-card-meta lc-timesheet-row';

  const label = document.createElement('span');
  label.className = 'lc-timesheet-label';
  label.textContent = `${FIELD_LABELS[key] || key} : `;

  const val = document.createElement('span');
  val.className = 'lc-timesheet-value';
  val.textContent = String(value);

  row.appendChild(label);
  row.appendChild(val);
  return row;
}

/**
 * Format an ISO timestamp for the timesheet footer.
 *
 * Locale-aware mode (Session 50): when the caller threads both
 * `opts.locale` (BCP-47, e.g. `'fr-CA'`) AND `opts.timezone` (IANA, e.g.
 * `'America/Edmonton'`) the stamp shifts into the host's wall-clock time
 * with the timezone short name suffixed (e.g. `'2026-05-20 07 h 45 HAR'`
 * under fr-CA ICU). Both must be non-empty strings — without either we
 * fall through to the UTC default to preserve back-compat with every
 * peer renderer + test shipped before Session 50.
 *
 * Mirrors the English primary's `formatStamp` one-for-one so a future
 * locale shift on the timestamp formatter lands in both helpers as a
 * single coherent change. We deliberately reuse the primary's
 * deterministic `Intl.DateTimeFormat#formatToParts` recombine
 * (`YYYY-MM-DD HH:MM <TZ>`, 24-hour) so the visual shape stays
 * predictable across locales / Node ICU versions — French typography's
 * `HH h MM` time convention would otherwise diverge from the ISO date
 * shape, and the renderer's footer prose ("Brouillon … · pas encore
 * enregistré") already reads naturally with the ISO-style stamp.
 */
export function formatStamp(iso, opts) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return iso;
    const localeOpt =
      opts && typeof opts.locale === 'string' && opts.locale.trim()
        ? opts.locale.trim()
        : null;
    const timezoneOpt =
      opts && typeof opts.timezone === 'string' && opts.timezone.trim()
        ? opts.timezone.trim()
        : null;
    if (localeOpt && timezoneOpt) {
      const local = formatStampLocal(d, localeOpt, timezoneOpt);
      if (local) return local;
    }
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch (_e) {
    return iso;
  }
}

function formatStampLocal(date, locale, timezone) {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(date);
    const pick = (type) => {
      const found = parts.find((p) => p.type === type);
      return found ? found.value : '';
    };
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    const hour = pick('hour');
    const minute = pick('minute');
    const tz = pick('timeZoneName');
    if (!year || !month || !day || !hour || !minute) return null;
    const datePart = `${year}-${month}-${day}`;
    const timePart = `${hour}:${minute}`;
    return tz ? `${datePart} ${timePart} ${tz}` : `${datePart} ${timePart}`;
  } catch (_e) {
    return null;
  }
}

/**
 * Translate a structured per-trip warning code into its French (Canadian)
 * string (Session 67). Mirrors the English primary's `formatTimesheetWarning`
 * one-for-one (same code-id branch table, same field reads, same defensive
 * defaults) so the only divergence between locales is the visible copy.
 * Used by BOTH the peer's draft_timesheet renderer (warnings banner) and
 * its summarize_pay_period renderer (per-row warning detail line) — they
 * both load this sibling. Unknown codes return '' so a future handler-side
 * code id that isn't wired here can't paint "[object Object]".
 */
export function formatTimesheetWarning(code) {
  if (!code || typeof code !== 'object') return '';
  switch (code.code) {
    case 'hos-driving-cap':
      return `Heures de conduite (${code.hours}) dépassent le plafond fédéral de ${code.cap} h.`;
    case 'hos-onduty-cap':
      return `Heures de service (${code.hours}) dépassent le plafond fédéral de ${code.cap} h.`;
    case 'driving-exceeds-onduty':
      return `Les heures de conduite (${code.hoursDriving}) ne peuvent pas dépasser les heures de service (${code.hoursOnDuty}).`;
    case 'driving-range':
      return `Heures de conduite (${code.hours}) hors de la plage raisonnable de 0 à 24.`;
    case 'onduty-range':
      return `Heures de service (${code.hours}) hors de la plage raisonnable de 0 à 24.`;
    default:
      return '';
  }
}

/**
 * Resolve the visible per-row / banner warning strings for a payload that
 * may carry structured `warningCodes` (preferred) or a legacy
 * `warnings: string[]` (fallback). Mirrors the English primary's
 * `resolveTimesheetWarnings` one-for-one (NON-EMPTY codes win; otherwise
 * the legacy strings paint — so summarize_pay_period's pre-Session-67
 * records still surface their per-row detail line); only the per-code
 * translation (via this file's `formatTimesheetWarning`) differs.
 */
export function resolveTimesheetWarnings(codes, legacyWarnings) {
  if (Array.isArray(codes) && codes.length > 0) {
    return codes.map(formatTimesheetWarning).filter((s) => s);
  }
  return Array.isArray(legacyWarnings) ? legacyWarnings : [];
}

/**
 * Iteration order over the draft's keys: known fields in declaration
 * order, then unknown keys sorted alphabetically.
 */
export function fieldIterationOrder(draftKeys) {
  const known = new Set(FIELD_ORDER);
  const extras = draftKeys.filter((k) => !known.has(k)).sort();
  return [...FIELD_ORDER, ...extras];
}
