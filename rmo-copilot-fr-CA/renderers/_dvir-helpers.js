/**
 * Lumber-Copilot fr-CA peer — DVIR renderer helpers (Session 48).
 *
 * Sibling module imported by draft_dvir.js via `ctx.loadSibling`. The
 * panel propagates the peer's `?v=<manifest.version>` cache-bust tag onto
 * the sibling URL so a peer-manifest bump invalidates both modules
 * together.
 *
 * Mirrors the shape of the English primary's `_dvir-helpers.js` but pins
 * French (Canadian) label strings: NSC Schedule 1 defect-category names,
 * field labels, and defect-status phrasing. The peer manifest's renderer
 * override (`branding.renderers.draft_dvir`) routes the panel's dynamic
 * import here when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set; the English
 * helpers stay loaded for any tool the peer does not override.
 *
 * Kept distinct from the peer's own `_field-helpers.js` (the timesheet
 * sibling) because the DVIR field set doesn't overlap with the
 * timesheet's. Same isolation rationale as the English primary.
 */

export const DVIR_FIELD_LABELS = {
  carrierName: 'Transporteur',
  unitNumber: 'Unité',
  odometer: 'Odomètre',
  location: 'Lieu',
  driverName: 'Conducteur',
  defectStatus: 'État des défectuosités',
  defectNotes: 'Notes',
  mechanicName: 'Mécanicien',
  mechanicSignedAt: 'Signature du mécanicien',
};

// Iteration order — mirrors the English primary so a future field added
// to the primary lands in the same position on the peer.
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
  'safety-equipment': 'Équipement de sécurité',
  'braking': 'Freinage',
  'coupling': 'Attelage',
  'visibility': 'Visibilité',
  'lights': 'Feux',
  'tires-wheels': 'Pneus et roues',
  'steering-suspension': 'Direction et suspension',
  'other': 'Autre',
};

/**
 * Build a single labelled field row for the DVIR card.
 *
 * French typography convention: `Étiquette : valeur` (space before colon).
 * Mirrors the peer's `_field-helpers.js` precedent.
 */
export function createDvirFieldRow(key, value) {
  if (value === undefined || value === null || value === '') return null;
  const row = document.createElement('div');
  row.className = 'ratchet-tool-card-meta lc-dvir-row';

  const label = document.createElement('span');
  label.className = 'lc-dvir-label';
  label.textContent = `${DVIR_FIELD_LABELS[key] || key} : `;

  const val = document.createElement('span');
  val.className = 'lc-dvir-value';
  val.textContent = formatFieldValue(key, value);

  row.appendChild(label);
  row.appendChild(val);
  return row;
}

/**
 * Field-level value formatting. Defect status gets a French phrasing;
 * odometer gets a fr-CA thousands separator. Everything else
 * stringifies.
 */
function formatFieldValue(key, value) {
  if (key === 'odometer' && typeof value === 'number') {
    return `${value.toLocaleString('fr-CA')} km`;
  }
  if (key === 'defectStatus' && typeof value === 'string') {
    return value === 'none'
      ? 'Aucune défectuosité'
      : value === 'minor'
        ? 'Défectuosité(s) mineure(s)'
        : value === 'major'
          ? 'Défectuosité(s) majeure(s) — hors service jusqu’à réparation'
          : value;
  }
  return String(value);
}

/**
 * Format an ISO timestamp into the human-readable stamp the DVIR footer
 * surfaces.
 *
 * Locale-aware mode (Session 50): when the caller threads both
 * `opts.locale` (BCP-47, e.g. `'fr-CA'`) AND `opts.timezone` (IANA, e.g.
 * `'America/Edmonton'`) the stamp shifts into the host's wall-clock time
 * with the timezone short name suffixed. Both must be non-empty strings
 * — without either we fall through to the UTC default for back-compat
 * with every peer renderer + test shipped before Session 50. Mirrors the
 * English primary's `formatDvirStamp` one-for-one.
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
 * order, then unknown keys sorted alphabetically. Defects and photos are
 * stripped — they render as their own sections, not field rows.
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
  if (typeof category !== 'string' || !category) return 'Non catégorisé';
  return DEFECT_CATEGORY_LABELS[category] || category;
}

/**
 * Translate a structured DVIR warning code into its French (Canadian)
 * string (Session 68). Mirrors the English primary's `formatDvirWarning`
 * one-for-one (same code-id branch table, same field reads, same defensive
 * defaults) so the only divergence between locales is the visible copy.
 * Used by the peer's draft_dvir renderer's warnings banner. Unknown codes
 * return '' so a future handler-side code id that isn't wired here can't
 * paint "[object Object]".
 *
 * French typography: NSC Schedule 1 is « l'annexe 1 »; the curly
 * apostrophe (U+2019) matches the peer's badge phrasing.
 */
export function formatDvirWarning(code) {
  if (!code || typeof code !== 'object') return '';
  switch (code.code) {
    case 'defect-status-no-defects':
      return `L’état des défectuosités est « ${code.defectStatus} » mais aucune défectuosité n’a été détaillée — ajoutez au moins une entrée à defects[] ou réglez l’état à « none ».`;
    case 'defects-without-status':
      return `L’état des défectuosités est « none » mais ${code.count} défectuosité${
        code.count === 1 ? ' a été fournie' : 's ont été fournies'
      } — réglez l’état à « minor » ou « major », ou retirez les entrées de défectuosités.`;
    case 'major-needs-mechanic':
      return 'L’état des défectuosités est « major » — l’annexe 1 exige la signature d’un mécanicien avant le retour en service du véhicule.';
    case 'unknown-defect-category':
      return `La catégorie de défectuosité « ${code.category} » ne fait pas partie des catégories de l’annexe 1 (« other » est utilisé).`;
    case 'mechanic-signed-invalid':
      return `mechanicSignedAt « ${code.value} » n’est pas un horodatage ISO 8601 valide.`;
    default:
      return '';
  }
}

/**
 * Resolve the visible warning strings for a DVIR payload that may carry
 * structured `warningCodes` (preferred) or a legacy `warnings: string[]`
 * (fallback). Mirrors the English primary's `resolveDvirWarnings`
 * one-for-one (NON-EMPTY codes win; otherwise the legacy strings paint —
 * so a pre-Session-68 DVIR record still surfaces a warning in the
 * records-history view); only the per-code translation (via this file's
 * `formatDvirWarning`) differs.
 */
export function resolveDvirWarnings(codes, legacyWarnings) {
  if (Array.isArray(codes) && codes.length > 0) {
    return codes.map(formatDvirWarning).filter((s) => s);
  }
  return Array.isArray(legacyWarnings) ? legacyWarnings : [];
}
