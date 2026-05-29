/**
 * Server-side handler for the `summarize_pay_period` tool.
 *
 * Aggregates the driver's recorded timesheets across a pay-period window
 * and returns a structured payroll-ready summary: range bounds, totals
 * (days worked, driving hours, on-duty hours, non-driving on-duty hours),
 * a per-day breakdown, and any roll-up HOS warnings.
 *
 * Read-only. No approval required. Reads from `context.services.records`
 * (`list` over `type: 'timesheet'`) — no writes, no records-side mutations.
 * The handler intentionally over-fetches (queries the full timesheet
 * history without a `from`/`to` hint) and filters in JS by each record's
 * `data.draft.tripDate`, NOT by its `createdAt`. The distinction matters:
 * a driver who records Monday's trip on Tuesday morning expects Monday's
 * hours in the Monday-Sunday summary; a `createdAt` filter would put them
 * in the wrong window. Worst-case cost is O(history size) per call; for a
 * driver shipping ~20 timesheets/month that's negligible. A real-deploy
 * Postgres backend could push the tripDate filter into the query layer
 * (see the Notes for future iterations in REVIEW.md), but the in-memory
 * + file backends iterate at the same cost either way.
 *
 * Auto-discovered by ratchet's SkillLoader (convention:
 *   skillbox/<box>/tools/<tool-id>.js, default-export handler).
 *
 * Contract:
 *   args.presetId    : string  (optional) — 'current-pay-period' |
 *                                'last-pay-period'. Resolved against the
 *                                rmo-copilot manifest's pay-period
 *                                anchor + length (hardcoded below — the
 *                                resolver mirrors the frontend's
 *                                `resolveDynamicRange` so chip clicks and
 *                                this tool's defaults stay in lockstep).
 *   args.from        : string  (optional) — explicit YYYY-MM-DD window
 *                                start. Wins over presetId when both
 *                                supplied (caller's explicit override).
 *   args.to          : string  (optional) — explicit YYYY-MM-DD window
 *                                end (inclusive).
 *   args.driverName  : string  (optional) — substring filter applied to
 *                                each row's `data.draft.driverName`
 *                                (case-insensitive). Drops records that
 *                                don't match. Without this, every
 *                                timesheet under `context.userId` is
 *                                considered (matches the records service's
 *                                per-user scoping).
 *
 * Default behaviour when nothing is supplied: resolves to the
 * `current-pay-period` window at handler-call time.
 *
 * Returns:
 *   {
 *     range: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD',
 *              presetId?: string, label?: string },
 *     driverName?: string,        // when filter applied
 *     totals: {
 *       daysWorked: number,
 *       hoursDriving: number,
 *       hoursOnDuty: number,
 *       hoursOther: number,       // onDuty - driving
 *     },
 *     daily: Array<{              // chronological — oldest tripDate first
 *       tripDate: 'YYYY-MM-DD',
 *       hoursDriving: number,
 *       hoursOnDuty: number,
 *       vehicleId?: string,
 *       loadType?: string,
 *       hosCompliant: boolean,
 *       recordId?: string,
 *       recordedAt?: string,
 *       warnings: string[],       // per-trip warnings (English, from the
 *                                 //   stored timesheet record — back-compat).
 *       warningCodes: Array<{     // structured per-trip warning codes from
 *                                 //   the stored record — renderers prefer
 *                                 //   these and translate per locale
 *                                 //   (Session 67). [] for older records.
 *         code: string, ...fields //   see draft_timesheet's CODE_BUILDERS
 *       }>,
 *     }>,
 *     warnings: string[],         // period-level roll-up warnings,
 *                                 //   English strings (kept for tool-call
 *                                 //   protocol back-compat — the LLM
 *                                 //   reads these to reason about HOS).
 *     warningCodes: Array<{       // structured warning codes — renderers
 *                                 //   prefer this and translate per locale.
 *                                 //   Session 58 addition.
 *       code: string,             //   stable identifier (e.g. 'hos-70-7d')
 *       startIso: 'YYYY-MM-DD',   //   first tripDate of the offending window
 *       hours: number,            //   summed hoursOnDuty over the window
 *       cap: number,              //   federal cap that was breached
 *     }>,
 *     recordCount: number,        // raw count of records considered
 *     generatedAt: string,        // ISO 8601
 *     note?: string,              // surfaced when degraded
 *   }
 *
 * Renderer-friendly shape: the panel's `summarize_pay_period` renderer
 * walks `daily` as a small table, paints `totals` as a stacked badge,
 * and surfaces period-level warnings (70h/7d cap, missing days) in a
 * banner. Without a records service wired the handler still returns the
 * resolved range + empty totals so unit tests and host-isolated
 * experiments don't have to stub records.
 */

// Hardcoded to match the rmo-copilot manifest's pay-period chip config.
// Drifting these from the manifest would mean the LLM's tool-call default
// and the panel's chip click resolve to DIFFERENT windows — a confusing
// payroll experience. Kept here (not imported from the manifest) because
// the handler can't read the manifest at runtime without coupling to
// ratchet internals.
const PAY_PERIOD_ANCHOR = '2026-01-05';
const PAY_PERIOD_LENGTH_DAYS = 14;

const PRESET_OFFSETS = {
  'current-pay-period': 0,
  'last-pay-period': -1,
};

const PRESET_LABELS = {
  'current-pay-period': 'Current pay period',
  'last-pay-period': 'Last pay period',
};

// Federal Canadian HOS roll-up cap. Matches the per-day caps in
// draft_timesheet.js — both are local to the skillbox so ratchet core
// never reasons about the numbers.
const HOS_70_IN_7_DAYS_CAP = 70;

const RECORD_TYPE = 'timesheet';

// Belt-and-braces upper bound on the records.list page so a pathological
// history doesn't accidentally OOM the handler. A driver shipping 20
// timesheets/month hits 240/year; 1000 covers ~4 years of history.
const MAX_RECORDS_FETCH = 1000;

export default async function summarizePayPeriod(args, context) {
  const generatedAt = new Date().toISOString();

  const range = resolveRange(args, new Date(generatedAt));
  if (!range) {
    return {
      range: { from: '', to: '' },
      totals: emptyTotals(),
      daily: [],
      warnings: [],
      warningCodes: [],
      recordCount: 0,
      generatedAt,
      note:
        'Could not resolve a pay-period window — supply presetId ' +
        "('current-pay-period' or 'last-pay-period') or explicit from/to dates.",
    };
  }

  const driverFilter = stringField(args.driverName);

  const records = context && context.services && context.services.records;
  if (!records || typeof records.list !== 'function') {
    return {
      range,
      ...(driverFilter ? { driverName: driverFilter } : {}),
      totals: emptyTotals(),
      daily: [],
      warnings: [],
      warningCodes: [],
      recordCount: 0,
      generatedAt,
      note: 'Records service is not available in this deployment.',
    };
  }

  let allRecords;
  try {
    allRecords = await records.list(context.userId || 'unknown', {
      type: RECORD_TYPE,
      limit: MAX_RECORDS_FETCH,
    });
  } catch (err) {
    return {
      range,
      ...(driverFilter ? { driverName: driverFilter } : {}),
      totals: emptyTotals(),
      daily: [],
      warnings: [],
      warningCodes: [],
      recordCount: 0,
      generatedAt,
      note: `Could not read timesheets: ${(err && err.message) || String(err)}`,
    };
  }

  const fromTs = isoDateToUtcStart(range.from);
  const toTs = isoDateToUtcEnd(range.to);

  const driverNeedle = driverFilter ? driverFilter.toLowerCase() : null;
  const matching = [];
  for (const r of allRecords) {
    const data = (r && r.data) || {};
    const draft = data.draft;
    if (!draft || typeof draft !== 'object') continue;
    const tripDate = stringField(draft.tripDate);
    if (!tripDate || !isIsoDate(tripDate)) continue;
    const tripTs = isoDateToUtcStart(tripDate);
    if (tripTs === null) continue;
    if (tripTs < fromTs || tripTs > toTs) continue;
    if (driverNeedle) {
      const recordedDriver = stringField(draft.driverName);
      if (!recordedDriver || !recordedDriver.toLowerCase().includes(driverNeedle)) {
        continue;
      }
    }
    matching.push({ record: r, draft });
  }

  // De-duplicate by tripDate: if a driver re-recorded a day's timesheet
  // (correction, second-attempt) the newer record wins. We keep the entry
  // whose `record.createdAt` is largest per tripDate, then sort by tripDate
  // for the chronological output ordering.
  const byTripDate = new Map();
  for (const entry of matching) {
    const existing = byTripDate.get(entry.draft.tripDate);
    if (!existing) {
      byTripDate.set(entry.draft.tripDate, entry);
      continue;
    }
    const newTs = new Date(entry.record.createdAt).getTime();
    const oldTs = new Date(existing.record.createdAt).getTime();
    if (Number.isFinite(newTs) && newTs > oldTs) {
      byTripDate.set(entry.draft.tripDate, entry);
    }
  }
  const deduped = Array.from(byTripDate.values()).sort((a, b) =>
    compareIsoDate(a.draft.tripDate, b.draft.tripDate)
  );

  const daily = [];
  let totalDriving = 0;
  let totalOnDuty = 0;
  for (const { record: r, draft } of deduped) {
    const hoursDriving = numericField(draft.hoursDriving) || 0;
    const hoursOnDuty = numericField(draft.hoursOnDuty) || 0;
    const recordData = r.data || {};
    const recordWarnings = Array.isArray(recordData.warnings)
      ? recordData.warnings.filter((w) => typeof w === 'string')
      : [];
    // Session 67: surface the structured per-trip warning codes the
    // draft_timesheet handler now persists so the renderer can paint a
    // per-row warning detail line in the reader's locale. Older records
    // (seeded before Session 67, or hand-rolled fixtures) carry only the
    // legacy English `warnings` strings — the entry keeps both fields, and
    // the renderer prefers codes when present, falls back to strings.
    const recordWarningCodes = Array.isArray(recordData.warningCodes)
      ? recordData.warningCodes.filter((c) => c && typeof c === 'object')
      : [];
    totalDriving += hoursDriving;
    totalOnDuty += hoursOnDuty;
    // Compliant only when NEITHER source reports a warning. A record with
    // codes but no legacy strings (future) is still flagged; a legacy
    // record with strings but no codes (older seed) is too.
    const warnCount = recordWarningCodes.length || recordWarnings.length;
    const entry = {
      tripDate: draft.tripDate,
      hoursDriving,
      hoursOnDuty,
      hosCompliant: warnCount === 0,
      warnings: recordWarnings,
      warningCodes: recordWarningCodes,
    };
    const vehicle = stringField(draft.vehicleId);
    if (vehicle) entry.vehicleId = vehicle;
    const loadType = stringField(draft.loadType);
    if (loadType) entry.loadType = loadType;
    if (r && typeof r.id === 'string') entry.recordId = r.id;
    if (r && r.createdAt) {
      entry.recordedAt =
        typeof r.createdAt === 'string'
          ? r.createdAt
          : typeof r.createdAt.toISOString === 'function'
            ? r.createdAt.toISOString()
            : String(r.createdAt);
    }
    daily.push(entry);
  }

  const totals = {
    daysWorked: daily.length,
    hoursDriving: round2(totalDriving),
    hoursOnDuty: round2(totalOnDuty),
    hoursOther: round2(Math.max(0, totalOnDuty - totalDriving)),
  };

  const warningCodes = computePeriodWarningCodes(daily);
  // Drop empty strings so a future unknown code id (formatter doesn't
  // know about it yet) doesn't leak '' into the legacy English field.
  const warnings = warningCodes.map(formatWarningStringEn).filter((s) => s);

  return {
    range,
    ...(driverFilter ? { driverName: driverFilter } : {}),
    totals,
    daily,
    warnings,
    warningCodes,
    recordCount: allRecords.length,
    generatedAt,
  };
}

/**
 * Resolve `args` to a `{ from, to, presetId?, label? }` shape. Explicit
 * `from`/`to` win over `presetId`; with neither, defaults to
 * `current-pay-period`. Returns null when the inputs are unrecoverable
 * (bad ISO date, unknown preset, etc.).
 */
function resolveRange(args, now) {
  const explicitFrom = stringField(args.from);
  const explicitTo = stringField(args.to);
  if (explicitFrom && explicitTo) {
    if (!isIsoDate(explicitFrom) || !isIsoDate(explicitTo)) return null;
    if (compareIsoDate(explicitFrom, explicitTo) > 0) return null;
    const preset = lookupPresetByRange(explicitFrom, explicitTo, now);
    return preset
      ? { from: explicitFrom, to: explicitTo, presetId: preset.id, label: preset.label }
      : { from: explicitFrom, to: explicitTo };
  }
  // Single-sided explicit window doesn't make sense for a pay-period summary —
  // a payroll cycle has both ends. Refuse silently and fall through.
  if (explicitFrom || explicitTo) return null;

  const presetId = stringField(args.presetId) || 'current-pay-period';
  const offset = PRESET_OFFSETS[presetId];
  if (offset === undefined) return null;
  const window = computePayPeriodWindow(now, offset);
  if (!window) return null;
  return { ...window, presetId, label: PRESET_LABELS[presetId] };
}

/**
 * Mirror of the frontend `resolveDynamicRange({ kind: 'pay-period', ... })`
 * for the rmo-copilot manifest's fixed anchor + length. Returns
 * `{ from, to }` in `YYYY-MM-DD` form.
 */
function computePayPeriodWindow(now, offset) {
  const anchor = parseIsoDate(PAY_PERIOD_ANCHOR);
  if (!anchor) return null;
  const nowStart = startOfUtcDay(now);
  const daysSinceAnchor = Math.floor(
    (nowStart.getTime() - anchor.getTime()) / 86_400_000
  );
  const currentIdx = Math.floor(daysSinceAnchor / PAY_PERIOD_LENGTH_DAYS);
  const targetIdx = currentIdx + offset;
  const start = addUtcDays(anchor, targetIdx * PAY_PERIOD_LENGTH_DAYS);
  const end = addUtcDays(start, PAY_PERIOD_LENGTH_DAYS - 1);
  return { from: formatUtcDate(start), to: formatUtcDate(end) };
}

/**
 * Reverse-lookup: if explicit `from`/`to` exactly match a known preset's
 * current window, attach the presetId + label so the renderer can paint
 * "Current pay period · 2026-05-08 → 2026-05-21" without a separate hint.
 */
function lookupPresetByRange(from, to, now) {
  for (const presetId of Object.keys(PRESET_OFFSETS)) {
    const window = computePayPeriodWindow(now, PRESET_OFFSETS[presetId]);
    if (window && window.from === from && window.to === to) {
      return { id: presetId, label: PRESET_LABELS[presetId] };
    }
  }
  return null;
}

/**
 * Period-level roll-up warning codes. Today the only one is the federal
 * 70-hour-in-7-days cap (`hoursOnDuty` summed across any 7 consecutive
 * tripDates exceeds 70). Returns structured codes — the renderer translates
 * to a locale-appropriate string. The handler still ships a parallel
 * `warnings: string[]` array (English) for the tool-call protocol (the
 * LLM reads it to reason about HOS) and for back-compat with hosts/tests
 * that consume the legacy field directly.
 *
 * The per-day record warnings are already surfaced on each `daily[]`
 * entry; we don't duplicate them here.
 */
function computePeriodWarningCodes(daily) {
  if (daily.length === 0) return [];
  const codes = [];
  // Sliding window over consecutive sorted tripDates.
  for (let i = 0; i < daily.length; i++) {
    let sum = 0;
    const startIso = daily[i].tripDate;
    const startTs = isoDateToUtcStart(startIso);
    if (startTs === null) continue;
    for (let j = i; j < daily.length; j++) {
      const ts = isoDateToUtcStart(daily[j].tripDate);
      if (ts === null) continue;
      if (ts - startTs > 6 * 86_400_000) break;
      sum += daily[j].hoursOnDuty || 0;
    }
    if (sum > HOS_70_IN_7_DAYS_CAP) {
      codes.push({
        code: 'hos-70-7d',
        startIso,
        hours: round2(sum),
        cap: HOS_70_IN_7_DAYS_CAP,
      });
      // One code per offending window start is enough. A 14-day period
      // can produce two such windows; both worth surfacing.
    }
  }
  return codes;
}

/**
 * Render a structured warning code as an English string. Kept here (not
 * in the renderer) so the handler's `warnings: string[]` back-compat
 * field stays populated without locale-aware code paths leaking into the
 * server tool. The renderer's primary path consumes `warningCodes`
 * directly and ignores this function.
 */
function formatWarningStringEn(code) {
  if (!code || typeof code !== 'object') return '';
  if (code.code === 'hos-70-7d') {
    return (
      `Hours on duty (${code.hours}h) over 7 days starting ${code.startIso} ` +
      `exceeds federal cap of ${code.cap}h.`
    );
  }
  return '';
}

function emptyTotals() {
  return { daysWorked: 0, hoursDriving: 0, hoursOnDuty: 0, hoursOther: 0 };
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

function parseIsoDate(value) {
  if (!isIsoDate(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoDateToUtcStart(value) {
  const d = parseIsoDate(value);
  return d ? d.getTime() : null;
}

function isoDateToUtcEnd(value) {
  const d = parseIsoDate(value);
  if (!d) return null;
  return d.getTime() + 86_400_000 - 1;
}

function compareIsoDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function startOfUtcDay(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addUtcDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatUtcDate(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return `${y}-${m < 10 ? `0${m}` : m}-${d < 10 ? `0${d}` : d}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
