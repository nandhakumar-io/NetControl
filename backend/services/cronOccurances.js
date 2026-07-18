// services/cronOccurrences.js — expands a standard 5-field cron expression
// (minute hour day-of-month month day-of-week) into concrete occurrence
// timestamps within a date range.
//
// node-cron (already a dependency, used everywhere else in this app for
// actually *running* schedules) has no "give me the next N run times"
// API — it only fires a callback when the schedule ticks. This is a small,
// dependency-free stand-in built specifically for the Ops Calendar, which
// only ever needs "what fires this week/month", not second-level precision
// or non-standard cron dialects (@yearly, etc.) — every cron_expr already
// stored in this app (backup/bulk-command/digest/SLA/log-export schedules)
// is a plain 5-field expression, so that's all this supports.
'use strict';

function parseField(field, min, max) {
  // Returns a Set of every value in [min, max] that this field matches.
  // Supports: *, */step, a-b, a-b/step, comma-separated lists of the above.
  const matches = new Set();
  for (const part of field.split(',')) {
    let [range, step] = part.split('/');
    step = step ? parseInt(step, 10) : 1;
    let lo = min, hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        lo = a; hi = b;
      } else {
        lo = hi = parseInt(range, 10);
      }
    }
    for (let v = lo; v <= hi; v += step) matches.add(v);
  }
  return matches;
}

function compileCron(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected a 5-field cron expression, got "${cronExpr}"`);
  const [minute, hour, dom, month, dow] = parts;
  return {
    minutes: parseField(minute, 0, 59),
    hours:   parseField(hour, 0, 23),
    doms:    parseField(dom, 1, 31),
    months:  parseField(month, 1, 12),
    dows:    parseField(dow, 0, 6), // 0 = Sunday, matching JS Date#getUTCDay()
    domIsWildcard: dom === '*',
    dowIsWildcard: dow === '*',
  };
}

// Returns occurrence timestamps (unix seconds, UTC) for `cronExpr` between
// fromMs and toMs (inclusive), capped at `max` results as a safety valve —
// a malformed range or a once-a-minute expression over a huge window
// shouldn't be able to spin this into a multi-second loop on request.
function occurrencesInRange(cronExpr, fromMs, toMs, max = 500) {
  let compiled;
  try { compiled = compileCron(cronExpr); } catch { return []; }

  const out = [];
  // Walk minute-by-minute in UTC — cheap even over a month (~43,200 steps)
  // and avoids any DST ambiguity since everything in this app is stored/
  // scheduled in UTC already (see db/index.js's timezone: '+00:00').
  const cursor = new Date(Math.ceil(fromMs / 60000) * 60000);
  const end = new Date(toMs);

  while (cursor <= end && out.length < max) {
    const minute = cursor.getUTCMinutes();
    const hour   = cursor.getUTCHours();
    const dom    = cursor.getUTCDate();
    const month  = cursor.getUTCMonth() + 1;
    const dow    = cursor.getUTCDay();

    // Standard cron quirk: if BOTH day-of-month and day-of-week are
    // restricted (neither is "*"), a match on EITHER is sufficient: OR,
    // not AND. If only one is restricted, that one must match normally.
    const domMatch = compiled.doms.has(dom);
    const dowMatch = compiled.dows.has(dow);
    const dayMatches = (compiled.domIsWildcard && compiled.dowIsWildcard) ? true
      : (compiled.domIsWildcard) ? dowMatch
      : (compiled.dowIsWildcard) ? domMatch
      : (domMatch || dowMatch);

    if (compiled.minutes.has(minute) && compiled.hours.has(hour) && compiled.months.has(month) && dayMatches) {
      out.push(Math.floor(cursor.getTime() / 1000));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return out;
}

module.exports = { occurrencesInRange };