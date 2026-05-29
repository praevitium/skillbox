/**
 * Lumber-Copilot — DVIR renderer helpers (Session 42).
 *
 * Sibling module imported by draft_dvir.js via `ctx.loadSibling`. Same
 * multi-file pattern as `_field-helpers.js` (Session 35): the panel
 * propagates the parent's `?v=<manifest.version>` cache-bust tag onto
 * the sibling import so a manifest bump invalidates both modules
 * together.
 *
 * Kept distinct from `_field-helpers.js` because the DVIR field set
 * doesn't overlap with the timesheet's (different labels, different
 * iteration order, different defect / photo affordances). Sharing one
 * helper would force conditionals on every getter; a second sibling
 * keeps each renderer's surface focused.
 */

export const DVIR_FIELD_LABELS = {
  carrierName: 'Carrier',
  unitNumber: 'Unit',
  odometer: 'Odometer',
  location: 'Location',
  driverName: 'Driver',
  defectStatus: 'Defect status',
  defectNotes: 'Notes',
  mechanicName: 'Mechanic',
  mechanicSignedAt: 'Mechanic signed',
};

// Iteration order — keeps the field card stable. Defects and photos
// render as their own dedicated sections, not as field rows, so they
// are intentionally absent here.
export const DVIR_FIELD_ORDER = [
  'carrierName',
  'unitNumber',
  'odometer',
  'location',
  'driverName',
  'defectStatus',
  'defectNotes',
  'mechanicName',
  'mechanicSignedAt',
];

// Human-friendly category labels for the Schedule 1 categories the
// handler emits. Unknown categories fall through to the raw token.
export const DEFECT_CATEGORY_LABELS = {
  'safety-equipment': 'Safety equipment',
  'braking': 'Braking',
  'coupling': 'Coupling',
  'visibility': 'Visibility',
  'lights': 'Lights',
  'tires-wheels': 'Tires & wheels',
  'steering-suspension': 'Steering & suspension',
  'other': 'Other',
};

/**
 * Build a single labelled field row for the DVIR card. Returns the row
 * element or null for empty values so the caller can skip undefined
 * fields without its own guard.
 */
export function createDvirFieldRow(key, value) {
  if (value === undefined || value === null || value === '') return null;
  const row = document.createElement('div');
  row.className = 'ratchet-tool-card-meta lc-dvir-row';

  const label = document.createElement('span');
  label.className = 'lc-dvir-label';
  label.textContent = `${DVIR_FIELD_LABELS[key] || key}: `;

  const val = document.createElement('span');
  val.className = 'lc-dvir-value';
  val.textContent = formatFieldValue(key, value);

  row.appendChild(label);
  row.appendChild(val);
  return row;
}

/**
 * Field-level value formatting. Defect status gets a leading badge dot;
 * odometer gets a thousands separator. Everything else stringifies.
 */
function formatFieldValue(key, value) {
  if (key === 'odometer' && typeof value === 'number') {
    return `${value.toLocaleString('en-CA')} km`;
  }
  if (key === 'defectStatus' && typeof value === 'string') {
    return value === 'none'
      ? 'No defects'
      : value === 'minor'
        ? 'Minor defect(s)'
        : value === 'major'
          ? 'Major defect(s) — out of service until repaired'
          : value;
  }
  return String(value);
}

/**
 * Format an ISO timestamp into the human-readable stamp the DVIR footer
 * surfaces. Defensive — non-ISO input falls through to the raw string so
 * a misconfigured handler shape doesn't crash the renderer.
 *
 * Locale-aware mode (Session 50): when the caller threads both
 * `opts.locale` (BCP-47, e.g. `'en-CA'`) AND `opts.timezone` (IANA, e.g.
 * `'America/Edmonton'`) the stamp shifts into the host's wall-clock time
 * with the timezone short name suffixed (e.g. `'2026-05-20 07:46 MDT'`).
 * Both must be non-empty strings — without either we fall through to the
 * UTC default for back-compat with every renderer + test shipped before
 * Session 50. Mirrors `_field-helpers.js`'s `formatStamp` one-for-one so
 * future locale work touches one shape, not two divergent ones.
 */
export function formatDvirStamp(iso, opts) {
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
      const local = formatDvirStampLocal(d, localeOpt, timezoneOpt);
      if (local) return local;
    }
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch (_e) {
    return iso;
  }
}

function formatDvirStampLocal(date, locale, timezone) {
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
 * Iteration order over the draft's keys: known fields in declaration
 * order, then unknown keys sorted alphabetically (defects and photos
 * are stripped — they render as their own sections, not field rows).
 */
export function dvirFieldIterationOrder(draftKeys) {
  const known = new Set(DVIR_FIELD_ORDER);
  const skip = new Set(['defects', 'photos']);
  const extras = draftKeys
    .filter((k) => !known.has(k) && !skip.has(k))
    .sort();
  return [...DVIR_FIELD_ORDER, ...extras];
}

/** Human-friendly defect-category label with fallback to raw token. */
export function defectCategoryLabel(category) {
  if (typeof category !== 'string' || !category) return 'Uncategorized';
  return DEFECT_CATEGORY_LABELS[category] || category;
}

/**
 * Translate a structured DVIR warning code into its English string
 * (Session 68). The single home for the compliance code → string mapping
 * the draft_dvir renderer's warnings banner consumes — kept alongside the
 * other DVIR chrome (field labels, defect-category labels) so a future
 * locale peer translates one file.
 *
 * Strings are byte-identical to the handler's `formatWarningStringEn`
 * (draft_dvir.js) so a payload's legacy `warnings` array and the codes
 * route through to the same visible copy. Unknown codes return '' so a
 * future handler-side code id that isn't wired here can't paint
 * "[object Object]" or leak a code id into the chrome. Pair with the
 * fr-CA peer's `formatDvirWarning`.
 */
export function formatDvirWarning(code) {
  if (!code || typeof code !== 'object') return '';
  switch (code.code) {
    case 'defect-status-no-defects':
      return `defectStatus is "${code.defectStatus}" but no defects were itemized — add at least one entry to defects[] or set defectStatus to "none".`;
    case 'defects-without-status':
      return `defectStatus is "none" but ${code.count} defect entr${
        code.count === 1 ? 'y was' : 'ies were'
      } supplied — set defectStatus to "minor" or "major", or remove the defect entries.`;
    case 'major-needs-mechanic':
      return 'defectStatus is "major" — Schedule 1 requires a mechanic signature before the vehicle returns to service.';
    case 'unknown-defect-category':
      return `Defect category "${code.category}" is not one of the Schedule 1 categories (using "other").`;
    case 'mechanic-signed-invalid':
      return `mechanicSignedAt "${code.value}" is not a valid ISO 8601 timestamp.`;
    default:
      return '';
  }
}

/**
 * Resolve the visible warning strings for a DVIR payload that may carry
 * structured `warningCodes` (preferred) or a legacy `warnings: string[]`
 * (fallback). Mirrors the timesheet `resolveTimesheetWarnings` precedence:
 *   - `codes` a NON-EMPTY array → translate each via `formatDvirWarning`,
 *     dropping empties (unknown ids).
 *   - otherwise (no codes, or an empty codes array) → the legacy string
 *     array (or []).
 *
 * Empty-codes falls back to legacy rather than meaning "no warnings" so a
 * pre-Session-68 DVIR record (legacy strings, no codes) still paints in the
 * records-history view. draft_dvir always writes codes and legacy strings
 * together, so a genuinely-clean draft has BOTH empty (→ []).
 */
export function resolveDvirWarnings(codes, legacyWarnings) {
  if (Array.isArray(codes) && codes.length > 0) {
    return codes.map(formatDvirWarning).filter((s) => s);
  }
  return Array.isArray(legacyWarnings) ? legacyWarnings : [];
}
