/**
 * Server-side handler for the `draft_timesheet` tool.
 *
 * Drafts a timesheet record from inputs the LLM has collected from the
 * driver. The dispatch flow parks this call in the approval queue
 * (`requiresApproval: true` in the manifest) so the driver must
 * explicitly confirm before the record lands.
 *
 * Records are written through `context.services.records` when that
 * service is wired (it is, in the shipped ratchet backend). The handler
 * still produces a sensible response without it — the renderer's
 * "Drafted · not yet recorded" footer covers the show-and-tell case so
 * unit tests and host-isolated experiments don't have to stub a
 * records service just to look at the structured draft.
 *
 * Auto-discovered by ratchet's SkillLoader (convention:
 *   skillbox/<box>/tools/<tool-id>.js, default-export handler).
 *
 * Contract:
 *   args.driverName     : string  (required) — full legal name
 *   args.tripDate       : string  (required) — ISO date (YYYY-MM-DD)
 *   args.hoursDriving   : number  (required) — hours behind the wheel
 *   args.hoursOnDuty    : number  (required) — total on-duty (driving + non-driving)
 *   args.vehicleId      : string  (optional) — truck identifier
 *   args.loadType       : string  (optional) — e.g. "logs", "lumber"
 *   args.tripDescription: string  (optional) — free-text trip notes
 *
 * Returns:
 *   {
 *     draft: { driverName, tripDate, hoursDriving, hoursOnDuty,
 *              vehicleId?, loadType?, tripDescription? },
 *     warnings: string[],   // HOS / data-quality flags (English — kept for
 *                           //   the tool-call protocol so the LLM can reason
 *                           //   about breaches, and for back-compat with
 *                           //   hosts/tests that read strings directly).
 *     warningCodes: Array<{ // structured per-trip warning codes — renderers
 *                           //   prefer these and translate per locale
 *                           //   (Session 67, mirrors the Session-58
 *                           //   period-level codes on summarize_pay_period).
 *       code: string,       //   stable id ('hos-driving-cap' | 'hos-onduty-cap'
 *                           //     | 'driving-exceeds-onduty' | 'driving-range'
 *                           //     | 'onduty-range')
 *       ...fields           //   shape varies by code (see CODE_BUILDERS)
 *     }>,
 *     hosCompliant: boolean,
 *     generatedAt: string,  // ISO 8601 timestamp
 *     recorded: boolean,    // true when services.records persisted the draft
 *     recordId?: string,    // set when recorded === true
 *     recordedAt?: string,  // ISO 8601, set when recorded === true
 *     note?: string         // surfaced when inputs degrade or records write fails
 *   }
 *
 * The shape is renderer-friendly: the panel's renderer for this tool
 * (`renderers/draft_timesheet.js`) walks `draft` as a field list, flips
 * the footer to "Recorded …" when `recorded === true`, and surfaces
 * `warnings` in a banner. Unknown extra fields round-trip via the
 * renderer's JSON debug block so LLM verbosity isn't silently swallowed.
 *
 * Recording is a best-effort operation: if `services.records.write`
 * throws, the handler degrades to `recorded: false` with a `note`
 * explaining what happened. The driver still sees the structured draft
 * — losing the recording write is preferable to dropping the entire
 * tool result on the floor.
 */

// Federal Canadian HOS caps used by the rmo-copilot skillbox. Local
// to the handler so it stays self-contained — the renderer doesn't need
// to know the numbers, and ratchet core never reasons about them.
const HOS_DRIVING_CAP_HOURS = 13;
const HOS_ON_DUTY_CAP_HOURS = 14;
const MAX_REASONABLE_HOURS = 24;

const OPTIONAL_FIELDS = ['vehicleId', 'loadType', 'tripDescription'];

const RECORD_TYPE = 'timesheet';

export default async function draftTimesheet(args, context) {
  const driverName = stringField(args.driverName);
  const tripDate = stringField(args.tripDate);
  const hoursDriving = numericField(args.hoursDriving);
  const hoursOnDuty = numericField(args.hoursOnDuty);

  if (!driverName || !tripDate || hoursDriving === null || hoursOnDuty === null) {
    return {
      draft: null,
      warnings: [],
      warningCodes: [],
      hosCompliant: false,
      generatedAt: new Date().toISOString(),
      recorded: false,
      note: 'Missing one or more required fields: driverName, tripDate, hoursDriving, hoursOnDuty.',
    };
  }

  if (!isIsoDate(tripDate)) {
    return {
      draft: null,
      warnings: [],
      warningCodes: [],
      hosCompliant: false,
      generatedAt: new Date().toISOString(),
      recorded: false,
      note: `tripDate "${tripDate}" is not a valid YYYY-MM-DD date.`,
    };
  }

  // Build structured warning codes first, then derive the legacy English
  // strings from them (Session 67). The codes are the source of truth so
  // a locale-owning renderer can translate per locale; the English strings
  // stay byte-identical to the pre-Session-67 output for the tool-call
  // protocol and for hosts/tests that read the strings directly. The push
  // order is preserved so the legacy `warnings` array order is unchanged.
  const warningCodes = computeTimesheetWarningCodes(hoursDriving, hoursOnDuty);
  // Drop empty strings so an unknown code id (formatter not yet wired) can't
  // leak '' into the legacy field.
  const warnings = warningCodes.map(formatWarningStringEn).filter((s) => s);

  const draft = {
    driverName,
    tripDate,
    hoursDriving,
    hoursOnDuty,
  };
  for (const key of OPTIONAL_FIELDS) {
    const val = stringField(args[key]);
    if (val) draft[key] = val;
  }

  const generatedAt = new Date().toISOString();
  const response = {
    draft,
    warnings,
    warningCodes,
    hosCompliant: warningCodes.length === 0,
    generatedAt,
    recorded: false,
  };

  // Best-effort persistence. The dispatcher only runs the handler after
  // the user has approved the call (manifest `requiresApproval: true`),
  // so reaching this point is itself the green light to record. We
  // deliberately don't refuse to record on warnings — the driver may
  // have valid reasons to log a 14-hour day (split-duty deferral, e.g.)
  // and the recording exists to memorialise what happened, not to
  // enforce policy after-the-fact.
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
          // Persist the structured codes so a downstream read tool
          // (summarize_pay_period) can surface per-day warnings in the
          // reader's locale rather than re-parsing the English strings.
          warningCodes,
          hosCompliant: response.hosCompliant,
          generatedAt,
        },
      });
      response.recorded = true;
      response.recordId = stored.id;
      // Stored.createdAt is a Date from the in-memory impl; coerce to
      // ISO so the wire shape stays string-typed.
      response.recordedAt =
        stored.createdAt && typeof stored.createdAt.toISOString === 'function'
          ? stored.createdAt.toISOString()
          : String(stored.createdAt || generatedAt);
    } catch (err) {
      response.recorded = false;
      response.note = `Could not record timesheet: ${(err && err.message) || String(err)}`;
    }
  }

  return response;
}

/**
 * Compute the per-trip HOS / data-quality warning codes for a draft.
 * Returns structured codes in a stable push order (driving cap → on-duty
 * cap → driving>on-duty → driving range → on-duty range) so the derived
 * legacy `warnings` array order matches the pre-Session-67 output exactly.
 *
 * Each code carries only the fields its formatter needs:
 *   hos-driving-cap        { hours, cap }
 *   hos-onduty-cap         { hours, cap }
 *   driving-exceeds-onduty { hoursDriving, hoursOnDuty }
 *   driving-range          { hours }
 *   onduty-range           { hours }
 */
function computeTimesheetWarningCodes(hoursDriving, hoursOnDuty) {
  const codes = [];
  if (hoursDriving > HOS_DRIVING_CAP_HOURS) {
    codes.push({ code: 'hos-driving-cap', hours: hoursDriving, cap: HOS_DRIVING_CAP_HOURS });
  }
  if (hoursOnDuty > HOS_ON_DUTY_CAP_HOURS) {
    codes.push({ code: 'hos-onduty-cap', hours: hoursOnDuty, cap: HOS_ON_DUTY_CAP_HOURS });
  }
  if (hoursDriving > hoursOnDuty) {
    codes.push({ code: 'driving-exceeds-onduty', hoursDriving, hoursOnDuty });
  }
  if (hoursDriving < 0 || hoursDriving > MAX_REASONABLE_HOURS) {
    codes.push({ code: 'driving-range', hours: hoursDriving });
  }
  if (hoursOnDuty < 0 || hoursOnDuty > MAX_REASONABLE_HOURS) {
    codes.push({ code: 'onduty-range', hours: hoursOnDuty });
  }
  return codes;
}

/**
 * Render a structured per-trip warning code as its English string. Kept
 * handler-side so the legacy `warnings: string[]` field stays populated
 * without locale-aware code paths leaking into the server tool. The
 * strings are byte-identical to the pre-Session-67 output (the renderer's
 * `formatTimesheetWarning` reproduces these for the no-codes fallback).
 * Unknown codes return '' so a future code id that isn't wired here can't
 * leak into the legacy field. Mirror any change in the renderer-side
 * `formatTimesheetWarning` (`_field-helpers.js`).
 */
function formatWarningStringEn(code) {
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

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}
