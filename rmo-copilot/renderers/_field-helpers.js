/**
 * Lumber-Copilot — shared renderer helpers.
 *
 * Sibling module imported by draft_timesheet.js via `ctx.loadSibling`.
 * Demonstrates the multi-file renderer pattern: a renderer can split
 * pure helpers into a sibling file and the panel propagates the parent's
 * `?v=<manifest.version>` cache-bust tag to the sibling import so a
 * manifest bump invalidates both modules together.
 *
 * Helpers here are intentionally DOM-shape pure — they accept `document`
 * through the caller's existing call graph (no top-level `document`
 * access at module-eval time) so loading the sibling under Node for
 * tests doesn't require a DOM stub at import.
 */

export const FIELD_LABELS = {
  driverName: 'Driver',
  tripDate: 'Trip date',
  hoursDriving: 'Hours driving',
  hoursOnDuty: 'Hours on duty',
  vehicleId: 'Vehicle',
  loadType: 'Load type',
  tripDescription: 'Trip notes',
};

// Iteration order — keeps the field card stable across calls so drivers
// see the same layout every time. Anything not in this list (a future
// optional field the handler picks up) falls to the end alphabetically.
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
  label.textContent = `${FIELD_LABELS[key] || key}: `;

  const val = document.createElement('span');
  val.className = 'lc-timesheet-value';
  val.textContent = String(value);

  row.appendChild(label);
  row.appendChild(val);
  return row;
}

/**
 * Format an ISO timestamp into the human-readable stamp the timesheet
 * footer surfaces. Defensive — non-ISO input falls through to the raw
 * string so a misconfigured handler shape doesn't crash the renderer.
 *
 * Locale-aware mode (Session 50): when the caller threads both
 * `opts.locale` (BCP-47, e.g. `'en-CA'`) AND `opts.timezone` (IANA, e.g.
 * `'America/Edmonton'`) the stamp shifts into the host's wall-clock time
 * with the timezone short name suffixed (e.g. `'2026-05-20 07:45 MDT'`).
 * Both must be non-empty strings — the wall-clock shape only makes sense
 * when the panel has resolved both branding fields. Missing or empty
 * means we fall through to the UTC default to preserve back-compat with
 * every renderer + test shipped before Session 50.
 *
 * Renders via `Intl.DateTimeFormat#formatToParts` + a deterministic
 * recombine (`YYYY-MM-DD HH:MM <TZ>`, 24-hour) so the visual shape stays
 * predictable across locales / Node ICU versions. A bad timezone or any
 * Intl rejection falls back to the UTC default.
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
 * Translate a structured per-trip warning code into its English string
 * (Session 67). The single home for the per-trip code → string mapping
 * used by BOTH the draft_timesheet renderer (its warnings banner) and the
 * summarize_pay_period renderer (the per-row warning detail line) — they
 * both load this sibling, so the mapping lives here once.
 *
 * Strings are byte-identical to the handler's `formatWarningStringEn`
 * (draft_timesheet.js) so a payload's legacy `warnings` array and the
 * codes route through to the same visible copy. Unknown codes return ''
 * so a future handler-side code id that isn't wired here can't paint
 * "[object Object]" or leak a code id into the chrome. Pair with the
 * fr-CA peer's `formatTimesheetWarning`.
 */
export function formatTimesheetWarning(code) {
  if (!code || typeof code !== 'object') return '';
  switch (code.code) {
    case 'hos-driving-cap':
      return `Hours driving (${code.hours}) exceeds federal cap of ${code.cap}h.`;
    case 'hos-onduty-cap':
      return `Hours on duty (${code.hours}) exceeds federal cap of ${code.cap}h.`;
    case 'driving-exceeds-onduty':
      return `Hours driving (${code.hoursDriving}) cannot exceed hours on duty (${code.hoursOnDuty}).`;
    case 'driving-range':
      return `Hours driving (${code.hours}) is outside the reasonable 0..24 range.`;
    case 'onduty-range':
      return `Hours on duty (${code.hours}) is outside the reasonable 0..24 range.`;
    default:
      return '';
  }
}

/**
 * Resolve the visible per-row / banner warning strings for a payload that
 * may carry structured `warningCodes` (preferred) or a legacy
 * `warnings: string[]` (fallback). Centralised so the draft_timesheet and
 * summarize renderers share one precedence rule:
 *   - `codes` a NON-EMPTY array → translate each via `formatTimesheetWarning`,
 *     dropping empties (unknown ids).
 *   - otherwise (no codes, or an empty codes array) → the legacy string
 *     array (or []).
 *
 * Why empty-codes falls back to legacy rather than meaning "no warnings":
 * draft_timesheet always writes codes and legacy strings together, so a
 * genuinely-clean draft has BOTH empty (fallback → []). But
 * summarize_pay_period surfaces older records that predate Session 67 —
 * those carry legacy strings with an empty codes array, and the per-row
 * detail line must still paint. The two never diverge in a way where empty
 * codes should suppress non-empty legacy strings.
 */
export function resolveTimesheetWarnings(codes, legacyWarnings) {
  if (Array.isArray(codes) && codes.length > 0) {
    return codes.map(formatTimesheetWarning).filter((s) => s);
  }
  return Array.isArray(legacyWarnings) ? legacyWarnings : [];
}

/**
 * Iteration order over the draft's keys: known fields in declaration
 * order, then unknown keys sorted alphabetically (deterministic surface
 * for the field card so future-added handler fields don't shuffle the
 * card layout depending on object-construction order).
 */
export function fieldIterationOrder(draftKeys) {
  const known = new Set(FIELD_ORDER);
  const extras = draftKeys.filter((k) => !known.has(k)).sort();
  return [...FIELD_ORDER, ...extras];
}
