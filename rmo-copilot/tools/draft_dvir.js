/**
 * Server-side handler for the `draft_dvir` tool (Session 42).
 *
 * Drafts a Driver Vehicle Inspection Report record per Alberta NSC
 * Schedule 1. The dispatch flow parks this call in the approval queue
 * (`requiresApproval: true` in the manifest) so the driver must
 * explicitly confirm before the record lands — same posture as
 * `draft_timesheet` (the audit trail captures what the driver attested
 * to, not a draft the LLM speculated).
 *
 * Records are written through `context.services.records` when wired.
 * Without a records service the handler still produces the structured
 * draft so the renderer can show-and-tell pre-recording, mirroring the
 * timesheet posture.
 *
 * Contract:
 *   args.carrierName        : string  (required) — registered operator
 *   args.unitNumber         : string  (required) — tractor / trailer / bus ID
 *   args.odometer           : number  (required) — mileage at inspection
 *   args.location           : string  (required) — where inspection happened
 *   args.driverName         : string  (required) — inspecting driver
 *   args.defectStatus       : 'none' | 'minor' | 'major'  (required)
 *   args.defects            : Array<{ category, description }>  (required
 *                              when defectStatus !== 'none')
 *   args.defectNotes        : string  (optional) — free-text narrative
 *   args.photos             : Array<{ url, caption? }>  (optional)
 *   args.mechanicName       : string  (optional) — required when
 *                              defectStatus === 'major' (mechanic must
 *                              certify repairs per Schedule 1)
 *   args.mechanicSignedAt   : string  (optional) — ISO 8601 timestamp
 *
 * Returns:
 *   {
 *     draft: { ...mandatory fields, defects?, defectNotes?, photos?,
 *              mechanicName?, mechanicSignedAt? } | null,
 *     warnings: string[],     // Schedule 1 compliance flags (English — kept
 *                             //   for the tool-call protocol + back-compat).
 *     warningCodes: Array<{   // structured compliance codes — renderers prefer
 *                             //   these and translate per locale (Session 68,
 *                             //   mirrors the Session-67 draft_timesheet codes).
 *       code: string,         //   stable id ('defect-status-no-defects'
 *                             //     | 'defects-without-status'
 *                             //     | 'major-needs-mechanic'
 *                             //     | 'unknown-defect-category'
 *                             //     | 'mechanic-signed-invalid')
 *       ...fields             //   shape varies by code (see computeDvirWarningCodes)
 *     }>,
 *     compliant: boolean,     // warningCodes.length === 0
 *     generatedAt: string,    // ISO 8601
 *     recorded: boolean,
 *     recordId?: string,
 *     recordedAt?: string,
 *     note?: string
 *   }
 *
 * The wire shape is renderer-friendly: the panel's renderer
 * (`renderers/draft_dvir.js`) walks the draft as a field card, surfaces
 * defects as a list, renders photo thumbs, and flips the footer between
 * Drafted / Recorded states. Unknown extras round-trip via the JSON
 * debug block so LLM verbosity isn't silently swallowed.
 */

const VALID_DEFECT_STATUS = new Set(['none', 'minor', 'major']);

// NSC Schedule 1 inspection categories. Defect entries SHOULD pick one
// of these (handler logs a warning otherwise — non-fatal so a driver
// describing something with a custom label can still file the report).
const SCHEDULE_1_CATEGORIES = new Set([
  'safety-equipment',
  'braking',
  'coupling',
  'visibility',
  'lights',
  'tires-wheels',
  'steering-suspension',
  'other',
]);

const MANDATORY_FIELDS = [
  'carrierName',
  'unitNumber',
  'odometer',
  'location',
  'driverName',
  'defectStatus',
];

const RECORD_TYPE = 'dvir';

export default async function draftDvir(args, context) {
  const generatedAt = new Date().toISOString();

  const carrierName = stringField(args && args.carrierName);
  const unitNumber = stringField(args && args.unitNumber);
  const odometer = numericField(args && args.odometer);
  const location = stringField(args && args.location);
  const driverName = stringField(args && args.driverName);
  const defectStatus = stringField(args && args.defectStatus);

  const missing = [];
  if (!carrierName) missing.push('carrierName');
  if (!unitNumber) missing.push('unitNumber');
  if (odometer === null) missing.push('odometer');
  if (!location) missing.push('location');
  if (!driverName) missing.push('driverName');
  if (!defectStatus) missing.push('defectStatus');

  if (missing.length > 0) {
    return {
      draft: null,
      warnings: [],
      warningCodes: [],
      compliant: false,
      generatedAt,
      recorded: false,
      note: `Missing required field(s): ${missing.join(', ')}.`,
    };
  }

  if (!VALID_DEFECT_STATUS.has(defectStatus)) {
    return {
      draft: null,
      warnings: [],
      warningCodes: [],
      compliant: false,
      generatedAt,
      recorded: false,
      note: `defectStatus "${defectStatus}" must be one of: none, minor, major.`,
    };
  }

  if (odometer < 0) {
    return {
      draft: null,
      warnings: [],
      warningCodes: [],
      compliant: false,
      generatedAt,
      recorded: false,
      note: `odometer (${odometer}) cannot be negative.`,
    };
  }

  const defects = normalizeDefects(args && args.defects);
  const photos = normalizePhotos(args && args.photos);
  const defectNotes = stringField(args && args.defectNotes);
  const mechanicName = stringField(args && args.mechanicName);
  const mechanicSignedAt = stringField(args && args.mechanicSignedAt);

  // Build structured warning codes first, then derive the legacy English
  // strings from them (Session 68, mirrors the Session-67 per-trip codes on
  // draft_timesheet). The codes are the source of truth so a locale-owning
  // renderer can translate per locale; the English strings stay
  // byte-identical to the pre-Session-68 output for the tool-call protocol
  // and for hosts/tests that read the strings directly. The push order is
  // preserved so the legacy `warnings` array order is unchanged.
  const warningCodes = computeDvirWarningCodes(
    defectStatus,
    defects,
    mechanicName,
    mechanicSignedAt
  );
  // Drop empty strings so an unknown code id (formatter not yet wired) can't
  // leak '' into the legacy field.
  const warnings = warningCodes.map(formatWarningStringEn).filter((s) => s);

  const draft = {
    carrierName,
    unitNumber,
    odometer,
    location,
    driverName,
    defectStatus,
  };
  if (defects.length > 0) draft.defects = defects;
  if (defectNotes) draft.defectNotes = defectNotes;
  if (photos.length > 0) draft.photos = photos;
  if (mechanicName) draft.mechanicName = mechanicName;
  if (mechanicSignedAt) draft.mechanicSignedAt = mechanicSignedAt;

  const response = {
    draft,
    warnings,
    warningCodes,
    compliant: warningCodes.length === 0,
    generatedAt,
    recorded: false,
  };

  // Best-effort persistence — same posture as draft_timesheet. The
  // dispatcher only invokes this handler after the driver approves the
  // call, so reaching here IS the green light to record. A warning state
  // does not block the write: capturing what happened is the audit
  // value, not enforcing policy after-the-fact.
  const records = context && context.services && context.services.records;
  if (records && typeof records.write === 'function') {
    try {
      const stored = await records.write({
        userId: context.userId || 'unknown',
        type: RECORD_TYPE,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        data: {
          draft,
          warnings,
          // Persist the structured codes so a downstream reader (e.g. the
          // records-history view re-running the renderer) can surface the
          // compliance warnings in the reader's locale rather than
          // re-parsing the English strings.
          warningCodes,
          compliant: response.compliant,
          generatedAt,
        },
      });
      response.recorded = true;
      response.recordId = stored.id;
      response.recordedAt =
        stored.createdAt && typeof stored.createdAt.toISOString === 'function'
          ? stored.createdAt.toISOString()
          : String(stored.createdAt || generatedAt);
    } catch (err) {
      response.recorded = false;
      response.note = `Could not record DVIR: ${(err && err.message) || String(err)}`;
    }
  }

  return response;
}

/**
 * Compute the Schedule 1 compliance warning codes for a DVIR draft.
 * Returns structured codes in a stable push order (no-defects → defects
 * without status → major-needs-mechanic → unknown-category per defect →
 * mechanic-signed-invalid) so the derived legacy `warnings` array order
 * matches the pre-Session-68 output exactly.
 *
 * Each code carries only the fields its formatter needs:
 *   defect-status-no-defects { defectStatus }
 *   defects-without-status   { count }
 *   major-needs-mechanic     { }
 *   unknown-defect-category  { category }   (one per off-schedule defect)
 *   mechanic-signed-invalid  { value }
 */
function computeDvirWarningCodes(defectStatus, defects, mechanicName, mechanicSignedAt) {
  const codes = [];

  // Schedule 1 cross-checks.
  if (defectStatus !== 'none' && defects.length === 0) {
    codes.push({ code: 'defect-status-no-defects', defectStatus });
  }
  if (defectStatus === 'none' && defects.length > 0) {
    codes.push({ code: 'defects-without-status', count: defects.length });
  }
  // Major defects MUST have a certifying mechanic per Schedule 1; minor
  // defects are observable-and-loggable without mechanic involvement.
  if (defectStatus === 'major' && !mechanicName) {
    codes.push({ code: 'major-needs-mechanic' });
  }

  for (const defect of defects) {
    if (defect.category && !SCHEDULE_1_CATEGORIES.has(defect.category)) {
      codes.push({ code: 'unknown-defect-category', category: defect.category });
    }
  }

  if (mechanicSignedAt && !isIsoTimestamp(mechanicSignedAt)) {
    codes.push({ code: 'mechanic-signed-invalid', value: mechanicSignedAt });
  }

  return codes;
}

/**
 * Render a structured DVIR warning code as its English string. Kept
 * handler-side so the legacy `warnings: string[]` field stays populated
 * without locale-aware code paths leaking into the server tool. The
 * strings are byte-identical to the pre-Session-68 output (the renderer's
 * `formatDvirWarning` in `_dvir-helpers.js` reproduces these for the
 * no-codes fallback). Unknown codes return '' so a future code id that
 * isn't wired here can't leak into the legacy field. Mirror any change in
 * the renderer-side `formatDvirWarning`.
 */
function formatWarningStringEn(code) {
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

function stringField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numericField(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeDefects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const description = stringField(entry.description);
    if (!description) continue;
    const category = stringField(entry.category) || 'other';
    out.push({ category, description });
  }
  return out;
}

function normalizePhotos(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const url = stringField(entry.url);
    if (!url) continue;
    const photo = { url };
    const caption = stringField(entry.caption);
    if (caption) photo.caption = caption;
    out.push(photo);
  }
  return out;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.valueOf());
}
