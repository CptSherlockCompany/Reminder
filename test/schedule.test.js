'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { phaseAt, occurrencesBetween, due, parseUtc, weekStart } = require('../src/schedule.js');

const cycle = {
  anchorWeekStart: '2026-01-05', // a Monday, Confluence
  phases: ['Confluence', 'Battle of Disorder', 'Battle of Disorder', 'Battle of Destiny'],
};

const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

test('weekStart snaps to the preceding Monday at UTC midnight', () => {
  assert.equal(iso(weekStart(parseUtc('2026-01-11T23:59'))), '2026-01-05T00:00Z'); // Sunday
  assert.equal(iso(weekStart(parseUtc('2026-01-05T00:00'))), '2026-01-05T00:00Z'); // Monday itself
  assert.equal(iso(weekStart(parseUtc('2026-01-12T00:00'))), '2026-01-12T00:00Z'); // next Monday
});

test('phase cycle walks the four weeks and repeats', () => {
  const weeks = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26', '2026-02-02'];
  const got = weeks.map((w) => phaseAt(parseUtc(w), cycle).phase);
  assert.deepEqual(got, [
    'Confluence', 'Battle of Disorder', 'Battle of Disorder', 'Battle of Destiny', 'Confluence',
  ]);
});

test('phase cycle works for dates before the anchor', () => {
  assert.equal(phaseAt(parseUtc('2025-12-29'), cycle).phase, 'Battle of Destiny');
  assert.equal(phaseAt(parseUtc('2025-12-01'), cycle).phase, 'Battle of Destiny');
  // Exactly four weeks back is a full cycle, so it wraps to the anchor phase.
  assert.equal(phaseAt(parseUtc('2025-12-08'), cycle).phase, 'Confluence');
});

test('phase is null when the cycle is unconfigured', () => {
  assert.equal(phaseAt(Date.now(), { anchorWeekStart: null, phases: [] }), null);
});

test('weekly events land on the right weekday and UTC time', () => {
  const ev = { id: 'skills', type: 'weekly', weekday: 'friday', time: '17:00' };
  const hits = occurrencesBetween(ev, parseUtc('2026-01-05'), parseUtc('2026-01-20'), cycle);
  assert.deepEqual(hits.map(iso), ['2026-01-09T17:00Z', '2026-01-16T17:00Z']);
});

test('interval events step from their anchor', () => {
  const ev = { id: 'altar', type: 'interval', intervalDays: 2, anchorDate: '2026-01-06', time: '12:00' };
  const hits = occurrencesBetween(ev, parseUtc('2026-01-06T12:00'), parseUtc('2026-01-12T12:00'), cycle);
  assert.deepEqual(hits.map(iso), [
    '2026-01-08T12:00Z', '2026-01-10T12:00Z', '2026-01-12T12:00Z',
  ]);
});

test('interval events resolve correctly before their anchor', () => {
  const ev = { id: 'joint', type: 'interval', intervalDays: 14, anchorDate: '2026-03-02', time: '12:00' };
  const hits = occurrencesBetween(ev, parseUtc('2026-02-01'), parseUtc('2026-02-20'), cycle);
  assert.deepEqual(hits.map(iso), ['2026-02-02T12:00Z', '2026-02-16T12:00Z']);
});

test('Altar is suppressed across both Disorder weeks and returns after', () => {
  const ev = {
    id: 'altar', type: 'interval', intervalDays: 2, anchorDate: '2026-01-06', time: '12:00',
    skipDuringPhases: ['Battle of Disorder'],
  };
  const hits = occurrencesBetween(ev, parseUtc('2026-01-05'), parseUtc('2026-01-27'), cycle);
  const days = hits.map((h) => iso(h).slice(0, 10));

  // Weeks of Jan 12 and Jan 19 are Disorder — nothing may fall in them.
  assert.ok(!days.some((d) => d >= '2026-01-12' && d < '2026-01-26'), `leaked: ${days}`);
  // Confluence week (Jan 5) and Destiny week (Jan 26) still fire.
  assert.deepEqual(days, ['2026-01-06', '2026-01-08', '2026-01-10', '2026-01-26']);
});

test('lead time fires the ping ahead of the occurrence', () => {
  const schedule = {
    phaseCycle: cycle,
    defaults: { leadMinutes: 30 },
    events: [{ id: 'skills', name: 'Skills', type: 'weekly', weekday: 'friday', time: '17:00' }],
  };
  // 16:30 on the Friday: ping time reached, occurrence still half an hour out.
  assert.equal(due(schedule, parseUtc('2026-01-09T16:30'), {}, 5).due.length, 1);
  // 16:20: not yet, and outside the 5-minute grace window.
  assert.equal(due(schedule, parseUtc('2026-01-09T16:20'), {}, 5).due.length, 0);
});

test('a missed run catches up within the grace window, once', () => {
  const schedule = {
    phaseCycle: cycle,
    events: [{ id: 'skills', name: 'Skills', type: 'weekly', weekday: 'friday', time: '17:00' }],
  };
  // Runner was down until 18:30; a 120-minute grace still catches the 17:00 event.
  const first = due(schedule, parseUtc('2026-01-09T18:30'), {}, 120);
  assert.equal(first.due.length, 1);

  // Having recorded it, the next run must not repeat it.
  const state = { skills: new Date(first.due[0].occurrence).toISOString() };
  assert.equal(due(schedule, parseUtc('2026-01-09T18:45'), state, 120).due.length, 0);
});

test('a run later than the grace window drops the event rather than pinging late', () => {
  const schedule = {
    phaseCycle: cycle,
    events: [{ id: 'skills', name: 'Skills', type: 'weekly', weekday: 'friday', time: '17:00' }],
  };
  assert.equal(due(schedule, parseUtc('2026-01-09T20:00'), {}, 120).due.length, 0);
});

test('events with unset anchors are warned about, not fired', () => {
  const schedule = {
    phaseCycle: cycle,
    events: [
      { id: 'slumbers', name: 'Slumbers', type: 'weekly', weekday: 'friday', time: null },
      { id: 'joint', name: 'Joint', type: 'interval', intervalDays: 14, anchorDate: null, time: '12:00' },
    ],
  };
  const res = due(schedule, parseUtc('2026-01-09T17:00'), {}, 120);
  assert.equal(res.due.length, 0);
  assert.equal(res.warnings.length, 2);
});

test('the real schedule.json is valid and its known events resolve', () => {
  const schedule = require('../schedule.json');
  // Friday 18 Sep: Altar at 17:00 with Skills Activation right after it, which
  // is exactly the pairing the alliance described.
  const res = due(schedule, parseUtc('2026-09-18T17:00'), {}, 120);
  assert.deepEqual(res.due.map((d) => d.event.id).sort(), ['altar', 'skills-friday']);
  // Both at the same instant, so they go out as one message.
  assert.equal(new Set(res.due.map((d) => d.occurrence)).size, 1);
});

test('no webhook URL has leaked into a committable file', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const ignore = new Set(['.git', 'node_modules', '.env']);
  // Built at runtime so this file does not trip its own check. Matches a real
  // webhook (numeric id + token), so documentation placeholders are fine.
  const needle = new RegExp(['discord\\.com', 'api', 'webhooks', '\\d{6,}', '[\\w-]{20,}'].join('/'));
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (needle.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(root, full));
      }
    }
  })(root);

  assert.deepEqual(offenders, [], `webhook URL found in: ${offenders.join(', ')}`);
});

test('a weekly event can run several times on the same day', () => {
  const ev = {
    id: 'slumbers', type: 'weekly', weekday: 'friday',
    times: ['13:00', '14:00', '19:00'],
  };
  const hits = occurrencesBetween(ev, parseUtc('2026-01-05'), parseUtc('2026-01-17'), cycle);
  assert.deepEqual(hits.map(iso), [
    '2026-01-09T13:00Z', '2026-01-09T14:00Z', '2026-01-09T19:00Z',
    '2026-01-16T13:00Z', '2026-01-16T14:00Z', '2026-01-16T19:00Z',
  ]);
});

test('each of a multi-time day fires separately and none repeats', () => {
  const schedule = {
    phaseCycle: cycle,
    defaults: { leadMinutes: 15 },
    events: [{
      id: 'slumbers', name: 'Slumbers of City', type: 'weekly', weekday: 'friday',
      times: ['13:00', '14:00', '19:00'],
    }],
  };
  const state = {};
  const fired = [];
  // Walk the Friday in 5-minute steps, as the cron would.
  for (let t = parseUtc('2026-01-09T12:00'); t <= parseUtc('2026-01-09T21:00'); t += 5 * 60000) {
    for (const item of due(schedule, t, state, 120).due) {
      fired.push(iso(item.occurrence));
      state[item.event.id] = new Date(item.occurrence).toISOString();
    }
  }
  assert.deepEqual(fired, ['2026-01-09T13:00Z', '2026-01-09T14:00Z', '2026-01-09T19:00Z']);
});

test('interval events keep their own time of day', () => {
  const showdown = { id: 'showdown', type: 'interval', intervalDays: 14, anchorDate: '2026-01-07', time: '12:00' };
  const shrine   = { id: 'shrine',   type: 'interval', intervalDays: 14, anchorDate: '2026-01-07', time: '16:00' };
  const window = [parseUtc('2026-01-01'), parseUtc('2026-01-22')];
  assert.deepEqual(occurrencesBetween(showdown, ...window, cycle).map(iso),
    ['2026-01-07T12:00Z', '2026-01-21T12:00Z']);
  assert.deepEqual(occurrencesBetween(shrine, ...window, cycle).map(iso),
    ['2026-01-07T16:00Z', '2026-01-21T16:00Z']);
});

test('an interval event starting before its anchor is still found', () => {
  const ev = { id: 'altar', type: 'interval', intervalDays: 2, anchorDate: '2026-01-10', time: '17:00' };
  const hits = occurrencesBetween(ev, parseUtc('2026-01-03'), parseUtc('2026-01-09'), cycle);
  assert.deepEqual(hits.map(iso), [
    '2026-01-04T17:00Z', '2026-01-06T17:00Z', '2026-01-08T17:00Z',
  ]);
});

test('every event in the real schedule.json has a time set', () => {
  const schedule = require('../schedule.json');
  const { timesOf, unconfigured } = require('../src/schedule.js');
  for (const ev of schedule.events) {
    assert.ok(timesOf(ev).length > 0, `${ev.id} has no time`);
    const missing = unconfigured(ev, schedule.phaseCycle);
    assert.ok(missing === null || missing === 'anchor date not set',
      `${ev.id}: unexpected gap "${missing}"`);
  }
});

test('a phase-dependent event stays quiet while the cycle anchor is missing', () => {
  const schedule = {
    phaseCycle: { anchorWeekStart: null, phases: ['Confluence', 'Battle of Disorder'] },
    events: [{
      id: 'altar', name: 'Altar of Trial', type: 'interval', intervalDays: 2,
      anchorDate: '2026-01-06', time: '17:00', skipDuringPhases: ['Battle of Disorder'],
    }],
  };
  const res = due(schedule, parseUtc('2026-01-08T17:00'), {}, 120);
  assert.equal(res.due.length, 0, 'must not announce when Disorder weeks cannot be identified');
  assert.match(res.warnings[0], /anchorWeekStart/);

  // With the anchor supplied it fires normally.
  schedule.phaseCycle.anchorWeekStart = '2026-01-05';
  assert.equal(due(schedule, parseUtc('2026-01-08T17:00'), {}, 120).due.length, 1);
});

test('an interval anchor on the wrong weekday is rejected, not silently used', () => {
  const { anchorOf } = require('../src/schedule.js');
  const ok = { id: 'showdown', anchorDate: '2026-01-08', time: '12:00', weekday: 'thursday' };
  assert.equal(iso(anchorOf(ok)), '2026-01-08T12:00Z');

  const wrong = { ...ok, anchorDate: '2026-01-09' }; // a Friday
  assert.throws(() => anchorOf(wrong), /is a friday, but the event runs on thursday/);
});

test('a biweekly weekday event only ever lands on that weekday', () => {
  const showdown = {
    id: 'showdown', type: 'interval', intervalDays: 14,
    weekday: 'thursday', anchorDate: '2026-01-08', time: '12:00',
  };
  const hits = occurrencesBetween(showdown, parseUtc('2026-01-01'), parseUtc('2026-03-01'), cycle);
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.equal(new Date(h).getUTCDay(), 4, `${iso(h)} is not a Thursday`);
  }
  // Every other Thursday, not every Thursday.
  assert.deepEqual(hits.map(iso).slice(0, 3), [
    '2026-01-08T12:00Z', '2026-01-22T12:00Z', '2026-02-05T12:00Z',
  ]);
});

test('the live schedule matches the known September/October calendar', () => {
  const schedule = require('../schedule.json');
  const { occurrencesBetween } = require('../src/schedule.js');
  const byId = Object.fromEntries(schedule.events.map((e) => [e.id, e]));
  const from = parseUtc('2026-09-18T00:00');
  const to = parseUtc('2026-10-20T00:00');

  // Altar runs today, once more in the Confluence week, then goes quiet through
  // Disorder apart from its final day — the Sunday closing the second Disorder
  // week — before resuming normally in the Destiny week.
  const altar = occurrencesBetween(byId.altar, from, to, schedule.phaseCycle).map(iso);
  assert.deepEqual(altar.slice(0, 4), [
    '2026-09-18T17:00Z', '2026-09-20T17:00Z', '2026-10-04T17:00Z', '2026-10-06T17:00Z',
  ]);
  // Silent for everything between, which is the whole of Disorder bar that day.
  assert.ok(
    !altar.some((d) => d >= '2026-09-21' && d < '2026-10-04'),
    `Altar leaked into a Disorder week: ${altar}`
  );
  // The cadence keeps counting through the gap rather than restarting from it.
  assert.ok(altar.includes('2026-10-08T17:00Z'));

  // Joint Competition starts with the first Disorder week, then every 14 days.
  assert.deepEqual(
    occurrencesBetween(byId.joint, from, to, schedule.phaseCycle).map(iso),
    ['2026-09-21T12:00Z', '2026-10-05T12:00Z', '2026-10-19T12:00Z']
  );

  // Showdown is weekly and unaffected by the phase cycle.
  assert.deepEqual(
    occurrencesBetween(byId.showdown, from, parseUtc('2026-10-10T00:00'), schedule.phaseCycle).map(iso),
    ['2026-09-24T12:00Z', '2026-10-01T12:00Z', '2026-10-08T12:00Z']
  );
});

test('the phase cycle agrees with the weeks the alliance reported', () => {
  const schedule = require('../schedule.json');
  const weeks = {
    '2026-09-14': 'Confluence',
    '2026-09-21': 'Battle of Disorder',
    '2026-09-28': 'Battle of Disorder',
    '2026-10-05': 'Battle of Destiny',
    '2026-10-12': 'Confluence',
  };
  for (const [monday, phase] of Object.entries(weeks)) {
    assert.equal(phaseAt(parseUtc(monday), schedule.phaseCycle).phase, phase, `week of ${monday}`);
  }
});

test('the final-day exception fires only on the last day of the whole run', () => {
  const { finalDayOfSuppressedRun } = require('../src/schedule.js');
  const skip = ['Battle of Disorder'];

  // Both Disorder weeks resolve to the same final day: the Sunday ending the
  // second one, not the Sunday of whichever week was asked about.
  const fromFirst = finalDayOfSuppressedRun(parseUtc('2026-09-22'), cycle, skip);
  const fromSecond = finalDayOfSuppressedRun(parseUtc('2026-09-30'), cycle, skip);
  assert.equal(iso(fromFirst), '2026-10-04T00:00Z');
  assert.equal(fromFirst, fromSecond, 'both Disorder weeks share one final day');
  assert.equal(new Date(fromFirst).getUTCDay(), 0, 'final day must be a Sunday');

  // A non-suppressed week has no run to end.
  assert.equal(finalDayOfSuppressedRun(parseUtc('2026-09-16'), cycle, skip), null);
});

test('without the exception flag an event stays suppressed for the entire run', () => {
  const base = {
    id: 'altar', type: 'interval', intervalDays: 2,
    anchorDate: '2026-09-18', time: '17:00', skipDuringPhases: ['Battle of Disorder'],
  };
  const window = [parseUtc('2026-09-21'), parseUtc('2026-10-05')];

  const strict = occurrencesBetween(base, ...window, cycle);
  assert.deepEqual(strict, [], 'no exception flag means no Disorder pings at all');

  const lenient = occurrencesBetween({ ...base, runsOnFinalDayOfSkippedRun: true }, ...window, cycle);
  assert.deepEqual(lenient.map(iso), ['2026-10-04T17:00Z']);
});

test('every event in the live schedule is fully configured', () => {
  const schedule = require('../schedule.json');
  const { unconfigured } = require('../src/schedule.js');
  const gaps = schedule.events
    .map((e) => [e.id, unconfigured(e, schedule.phaseCycle)])
    .filter(([, missing]) => missing !== null);
  assert.deepEqual(gaps, [], `still unconfigured: ${JSON.stringify(gaps)}`);
});

test('Shrine runs every other Sunday from its anchor', () => {
  const schedule = require('../schedule.json');
  const { occurrencesBetween } = require('../src/schedule.js');
  const shrine = schedule.events.find((e) => e.id === 'shrine');
  const hits = occurrencesBetween(shrine, parseUtc('2026-09-18'), parseUtc('2026-11-01'), schedule.phaseCycle);
  assert.deepEqual(hits.map(iso), [
    '2026-09-27T16:00Z', '2026-10-11T16:00Z', '2026-10-25T16:00Z',
  ]);
  for (const h of hits) assert.equal(new Date(h).getUTCDay(), 0, `${iso(h)} is not a Sunday`);
});

test('seeding state prevents a first run from backfilling stale events', () => {
  const schedule = require('../schedule.json');
  const { occurrencesBetween, unconfigured } = require('../src/schedule.js');
  const now = parseUtc('2026-09-18T15:00');

  // An unseeded first run reaches back over its grace window and would
  // announce Slumbers pings that already finished.
  const cold = due(schedule, now, {}, 120);
  assert.ok(cold.due.length > 0, 'precondition: an empty state does backfill');
  assert.ok(cold.due.every((d) => d.occurrence <= now), 'backfill is all in the past');

  // Seeding records the last past occurrence of each event, as --seed does.
  const seeded = {};
  for (const ev of schedule.events) {
    if (unconfigured(ev, schedule.phaseCycle)) continue;
    const past = occurrencesBetween(ev, now - 30 * 24 * 3600e3, now, schedule.phaseCycle);
    if (past.length) seeded[ev.id] = new Date(past[past.length - 1]).toISOString();
  }
  assert.deepEqual(due(schedule, now, seeded, 120).due, [], 'nothing stale after seeding');

  // Genuinely upcoming events are untouched by the seed.
  const later = due(schedule, parseUtc('2026-09-18T16:45'), seeded, 120);
  assert.deepEqual(later.due.map((d) => d.event.id).sort(), ['altar', 'skills-friday']);
});

test('times are accepted with or without a leading zero', () => {
  const { parseTime, normalizeTime } = require('../src/schedule.js');
  assert.equal(parseTime('8:00'), parseTime('08:00'));
  assert.equal(parseTime('8:05'), 8 * 60 + 5);
  assert.equal(normalizeTime('8:00'), '08:00');
  assert.equal(normalizeTime('17:30'), '17:30');

  // A weekly event lands identically either way.
  const padded = { id: 'a', type: 'weekly', weekday: 'sunday', time: '08:00' };
  const bare = { id: 'a', type: 'weekly', weekday: 'sunday', time: '8:00' };
  const window = [parseUtc('2026-09-18'), parseUtc('2026-09-21')];
  assert.deepEqual(
    occurrencesBetween(bare, ...window, cycle),
    occurrencesBetween(padded, ...window, cycle)
  );
});

test('an interval anchor works with a single-digit hour too', () => {
  const ev = { id: 'x', type: 'interval', intervalDays: 14, weekday: 'sunday', anchorDate: '2026-09-27', time: '8:00' };
  const hits = occurrencesBetween(ev, parseUtc('2026-09-20'), parseUtc('2026-10-20'), cycle);
  assert.deepEqual(hits.map(iso), ['2026-09-27T08:00Z', '2026-10-11T08:00Z']);
});

test('a nonsensical time is still rejected', () => {
  const { parseTime } = require('../src/schedule.js');
  for (const bad of ['25:00', '12:70', '1200', 'noon', '', '8:0']) {
    assert.throws(() => parseTime(bad), new RegExp('time'), `should reject ${JSON.stringify(bad)}`);
  }
});

test('notBefore defers the first announcement without changing the cadence', () => {
  const ev = { id: 'x', type: 'weekly', weekday: 'sunday', time: '8:00', notBefore: '2026-09-21' };
  const hits = occurrencesBetween(ev, parseUtc('2026-09-14'), parseUtc('2026-10-05'), cycle);
  assert.deepEqual(hits.map(iso), [
    '2026-09-27T08:00Z', '2026-10-04T08:00Z',
  ]);

  // Without it, the skipped Sunday is present and the rest are unchanged.
  const { notBefore, ...plain } = ev;
  assert.deepEqual(
    occurrencesBetween(plain, parseUtc('2026-09-14'), parseUtc('2026-10-05'), cycle).map(iso),
    ['2026-09-20T08:00Z', '2026-09-27T08:00Z', '2026-10-04T08:00Z']
  );
});

test('this Sunday is skipped for Gathering Speed-up, next Sunday is not', () => {
  const schedule = require('../schedule.json');
  const sunday = schedule.events.find((e) => e.id === 'skills-sunday');
  const hits = occurrencesBetween(sunday, parseUtc('2026-09-18'), parseUtc('2026-09-30'), schedule.phaseCycle);
  assert.deepEqual(hits.map(iso), ['2026-09-27T08:00Z']);

  // And nothing fires for it at its usual ping time this Sunday.
  const atPingTime = due(schedule, parseUtc('2026-09-20T07:15'), {}, 120);
  assert.ok(
    !atPingTime.due.some((d) => d.event.id === 'skills-sunday'),
    'Gathering Speed-up must stay quiet on 20 Sep'
  );
});
