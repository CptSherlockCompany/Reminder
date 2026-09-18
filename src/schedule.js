'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Parse a "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" string as UTC epoch ms.
 * Everything in this project is UTC; the game schedule is published in UTC
 * and Discord renders per-viewer local time on the receiving end.
 */
function parseUtc(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(value).trim());
  if (!m) throw new Error(`Not a UTC date/time: ${value}`);
  const [, y, mo, d, h = '00', mi = '00'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, 0, 0);
}

/** Parse "HH:MM" into minutes past UTC midnight. */
function parseTime(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`Not a HH:MM time: ${value}`);
  return +m[1] * 60 + +m[2];
}

/** An event's time(s) of day, as an array — events may run several times a day. */
function timesOf(event) {
  if (Array.isArray(event.times)) return event.times;
  return event.time == null || event.time === '' ? [] : [event.time];
}

/** UTC midnight of the Monday on or before `ms`. */
function weekStart(ms) {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const shift = (d.getUTCDay() + 6) % 7; // Monday = 0
  return midnight - shift * DAY_MS;
}

/**
 * Which slot of the repeating phase cycle the week containing `ms` falls in.
 * Returns { offset, phase } or null when no cycle is configured.
 */
function phaseAt(ms, cycle) {
  if (!cycle || !cycle.anchorWeekStart || !Array.isArray(cycle.phases) || !cycle.phases.length) {
    return null;
  }
  const anchor = weekStart(parseUtc(cycle.anchorWeekStart));
  const weeks = Math.round((weekStart(ms) - anchor) / WEEK_MS);
  const n = cycle.phases.length;
  const offset = ((weeks % n) + n) % n;
  return { offset, phase: cycle.phases[offset] };
}

/**
 * The epoch ms of an interval event's reference occurrence.
 *
 * When the event declares a `weekday`, the anchor date is checked against it.
 * A 14-day event on a Thursday only ever lands on Thursdays, so an anchor that
 * falls on some other day is a typo — and a silent one, since the cadence would
 * still look plausible while being a day or two out forever.
 */
function anchorOf(event) {
  const times = timesOf(event);
  if (!event.anchorDate) throw new Error(`No anchorDate on "${event.id}"`);
  if (!times.length) throw new Error(`No time on "${event.id}"`);
  const ms = parseUtc(`${event.anchorDate}T${times[0]}`);

  if (event.weekday) {
    const want = WEEKDAYS[String(event.weekday).toLowerCase()];
    if (want === undefined) throw new Error(`Unknown weekday on "${event.id}": ${event.weekday}`);
    const got = new Date(ms).getUTCDay();
    if (got !== want) {
      const names = Object.keys(WEEKDAYS);
      throw new Error(
        `"${event.id}": anchorDate ${event.anchorDate} is a ${names[got]}, but the event runs on ${names[want]}`
      );
    }
  }
  return ms;
}

/**
 * UTC midnight of the last day of the unbroken run of suppressed weeks that
 * contains `ms`, or null when `ms` is not in a suppressed week.
 *
 * Disorder spans two consecutive weeks, so "the last day of Disorder" is the
 * Sunday ending the second one — not the Sunday of whichever week we happen to
 * be looking at. Walking forward to the end of the run finds it without the
 * cycle's shape being hard-coded here.
 */
function finalDayOfSuppressedRun(ms, cycle, skip) {
  const at = phaseAt(ms, cycle);
  if (!at || !skip.includes(at.phase)) return null;

  let week = weekStart(ms);
  // Bounded by the cycle length: a run cannot be longer than one full cycle.
  for (let i = 0; i < cycle.phases.length; i++) {
    const next = phaseAt(week + WEEK_MS, cycle);
    if (!next || !skip.includes(next.phase)) break;
    week += WEEK_MS;
  }
  return week + 6 * DAY_MS; // Sunday of the final suppressed week
}

/**
 * All occurrences of `event` in the half-open interval (fromMs, toMs].
 * Occurrences suppressed by the phase cycle are dropped here.
 */
function occurrencesBetween(event, fromMs, toMs, cycle) {
  const hits = [];
  const times = timesOf(event).map(parseTime);

  if (event.type === 'weekly') {
    const weekday = WEEKDAYS[String(event.weekday).toLowerCase()];
    if (weekday === undefined) throw new Error(`Unknown weekday on "${event.id}": ${event.weekday}`);
    // Walk day by day from the day before `from` to cover any UTC offset edge.
    for (let t = fromMs - DAY_MS; t <= toMs + DAY_MS; t += DAY_MS) {
      const d = new Date(t);
      if (d.getUTCDay() !== weekday) continue;
      const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      for (const minutes of times) {
        const occ = midnight + minutes * 60000;
        if (occ > fromMs && occ <= toMs) hits.push(occ);
      }
    }
  } else if (event.type === 'interval') {
    const anchor = anchorOf(event);
    const period = Number(event.intervalDays) * DAY_MS;
    if (!(period > 0)) throw new Error(`intervalDays must be positive on "${event.id}"`);
    // Extra times of day ride along on each occurrence date.
    const offsets = times.map((m) => (m - times[0]) * 60000);
    const n = Math.ceil((fromMs - anchor) / period);
    for (let occ = anchor + n * period - period; occ <= toMs + period; occ += period) {
      for (const off of offsets) {
        const t = occ + off;
        if (t > fromMs && t <= toMs) hits.push(t);
      }
    }
  } else {
    throw new Error(`Unknown event type on "${event.id}": ${event.type}`);
  }

  hits.sort((a, b) => a - b);

  const skip = event.skipDuringPhases;
  if (!skip || !skip.length) return hits;
  return hits.filter((occ) => {
    const p = phaseAt(occ, cycle);
    if (!p || !skip.includes(p.phase)) return true;
    // Suppressed — unless the event runs on the final day of the run.
    if (!event.runsOnFinalDayOfSkippedRun) return false;
    const finalDay = finalDayOfSuppressedRun(occ, cycle, skip);
    const d = new Date(occ);
    return finalDay !== null && Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) === finalDay;
  });
}

/** Whether a phase cycle has enough configuration to be evaluated. */
function cycleReady(cycle) {
  return Boolean(cycle && cycle.anchorWeekStart && Array.isArray(cycle.phases) && cycle.phases.length);
}

/**
 * Why an event cannot run yet, or null when it is fully configured.
 *
 * An event that opts out of phases needs the cycle anchor too: without it we
 * cannot tell a Disorder week from a Confluence one, and announcing through a
 * suppressed week is worse than staying quiet.
 */
function unconfigured(event, cycle) {
  if (!timesOf(event).length) return 'time not set';
  if (event.type === 'interval' && !event.anchorDate) return 'anchor date not set';
  if (event.skipDuringPhases && event.skipDuringPhases.length && !cycleReady(cycle)) {
    return 'phaseCycle.anchorWeekStart not set, so its ' + event.skipDuringPhases.join('/') + ' exemption cannot be applied';
  }
  return null;
}

/**
 * Everything that should be announced right now.
 *
 * A ping fires at `occurrence - leadMinutes`. We look back `graceMinutes` so a
 * delayed or skipped Actions run still catches up, and `lastFired` (from
 * state.json) keeps a caught-up occurrence from being announced twice.
 */
function due(schedule, nowMs, state = {}, graceMinutes = 120) {
  const defaults = schedule.defaults || {};
  const graceMs = graceMinutes * 60000;
  const out = [];
  const warnings = [];

  for (const event of schedule.events || []) {
    if (event.enabled === false) continue;

    const missing = unconfigured(event, schedule.phaseCycle);
    if (missing) {
      warnings.push(`skipping "${event.id}" — ${missing}`);
      continue;
    }

    const lead = Number(event.leadMinutes ?? defaults.leadMinutes ?? 0);
    const leadMs = lead * 60000;
    // pingAt in (now - grace, now]  <=>  occurrence in (now - grace + lead, now + lead]
    const hits = occurrencesBetween(event, nowMs - graceMs + leadMs, nowMs + leadMs, schedule.phaseCycle);

    const lastFired = state[event.id] ? parseUtc(state[event.id].slice(0, 16)) : -Infinity;
    for (const occ of hits) {
      if (occ <= lastFired) continue;
      out.push({
        event,
        occurrence: occ,
        leadMinutes: lead,
        phase: phaseAt(occ, schedule.phaseCycle),
      });
    }
  }

  out.sort((a, b) => a.occurrence - b.occurrence);
  return { due: out, warnings };
}

module.exports = {
  DAY_MS, WEEK_MS, WEEKDAYS,
  parseUtc, parseTime, timesOf, weekStart, phaseAt, anchorOf, cycleReady,
  occurrencesBetween, unconfigured, due, finalDayOfSuppressedRun,
};
