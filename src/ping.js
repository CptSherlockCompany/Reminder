#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  due, occurrencesBetween, phaseAt, unconfigured, parseUtc, weekStart, WEEK_MS,
} = require('./schedule.js');

const ROOT = path.join(__dirname, '..');
const SCHEDULE_PATH = path.join(ROOT, 'schedule.json');
const STATE_PATH = path.join(ROOT, 'state.json');

const COLOR = 0x5865f2;

/**
 * Local convenience: pick up DISCORD_WEBHOOK_URL from a gitignored .env so the
 * script can be tested from a laptop. In Actions the secret is already in the
 * environment and this does nothing.
 */
function loadDotEnv() {
  if (process.env.DISCORD_WEBHOOK_URL) return;
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env, nothing to do */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${err.message}`);
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, now: Date.now(), preview: 0, seed: false, plan: null, send: null, forceSummary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--now') args.now = parseUtc(argv[++i]);
    else if (a === '--preview') args.preview = Number(argv[++i] ?? 14);
    else if (a === '--seed') args.seed = true;
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--send') args.send = argv[++i];
    else if (a === '--force-summary') args.forceSummary = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function fmtUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function buildEmbed(item) {
  const secs = Math.floor(item.occurrence / 1000);
  // No hardcoded "starts in N minutes": a scheduled run can land well after its
  // intended minute, which would make that line a lie. <t:...:R> is rendered by
  // Discord at read time, so it stays correct however late the message is - and
  // in each reader's own timezone.
  // "###" is the smallest markdown heading, which Discord renders in embed
  // descriptions one step above body text. Headings are already bold, so the **
  // is dropped.
  const lines = [`### <t:${secs}:F> · <t:${secs}:R>`];
  // The phase cycle is not shown. It still runs behind the scenes, deciding
  // whether Altar of Trial is suppressed this week, but readers only need to
  // know that an event is happening and when.
  if (item.event.note) lines.push(item.event.note);

  return {
    title: item.event.name,
    description: lines.join('\n'),
    color: COLOR,
    footer: { text: fmtUtc(item.occurrence) },
  };
}

async function discord(method, url, payload) {
  const res = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function post(url, payload) {
  await discord('POST', url, payload);
}

/**
 * Post and return the created message's id.
 *
 * `?wait=true` makes the webhook respond with the message object instead of an
 * empty 204. The id is what lets the weekly summary be deleted again later.
 */
async function postAndGetId(url, payload) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await discord('POST', `${url}${sep}wait=true`, payload);
  const body = await res.json().catch(() => null);
  return body && body.id ? String(body.id) : null;
}

/** Delete a message this webhook posted earlier. Missing is treated as success. */
async function deleteMessage(url, messageId) {
  const base = url.split('?')[0].replace(/\/$/, '');
  try {
    await discord('DELETE', `${base}/messages/${messageId}`);
    return true;
  } catch (err) {
    // Already gone, or deleted by hand - either way there is nothing to clean up.
    if (/ 404 /.test(err.message)) return true;
    throw err;
  }
}

/**
 * Whether a mention string will actually notify anyone.
 *
 * Webhooks only raise a notification for a role written as <@&ROLE_ID>, or for
 * the literal @everyone / @here. Anything else - "@member", a role's display
 * name - is delivered as ordinary text and notifies nobody, silently.
 */
function mentionNotifies(mention) {
  return /^<@&\d+>$/.test(mention) || mention === '@everyone' || mention === '@here';
}

/** Sanity-check the config and report anything that will stop an event firing. */
function lint(schedule) {
  const notes = [];
  for (const event of schedule.events || []) {
    const missing = unconfigured(event, schedule.phaseCycle);
    if (missing) notes.push(`"${event.id}" (${event.name}) — ${missing}, will not ping`);
  }

  const seen = new Set([schedule.defaults?.mention, ...(schedule.events || []).map((e) => e.mention)]);
  for (const mention of seen) {
    if (mention && !mentionNotifies(mention)) {
      notes.push(`mention ${JSON.stringify(mention)} will be posted as plain text and notify nobody — a role needs its ID, as "<@&123456789012345678>"`);
    }
  }
  return notes;
}

/** "YYYY-MM-DD" in UTC, used to label which week a summary belongs to. */
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every occurrence in the Monday-to-Sunday week beginning at `weekStartMs`. */
function weekOccurrences(schedule, weekStartMs) {
  const rows = [];
  for (const event of schedule.events || []) {
    if (event.enabled === false || unconfigured(event, schedule.phaseCycle)) continue;
    for (const occ of occurrencesBetween(event, weekStartMs - 1, weekStartMs + WEEK_MS, schedule.phaseCycle)) {
      rows.push({ occ, name: event.name });
    }
  }
  return rows.sort((a, b) => a.occ - b.occ);
}

/**
 * The week-ahead summary.
 *
 * Deliberately silent: the per-event reminders already carry the mention, and a
 * second notification for something nobody has to act on yet is just noise.
 */
function buildSummaryPayload(schedule, weekStartMs) {
  const rows = weekOccurrences(schedule, weekStartMs);
  const phase = phaseAt(weekStartMs, schedule.phaseCycle);

  const byDay = new Map();
  for (const r of rows) {
    const day = isoDate(r.occ);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  const lines = [];
  for (const [day, items] of byDay) {
    // "### " is the smallest markdown heading — one step above body text, which
    // is enough to separate the days without making the list tower. The date is
    // spelled out because a week can straddle two months.
    const label = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    });
    lines.push(`### ${label}`);
    for (const r of items) {
      lines.push(`**<t:${Math.floor(r.occ / 1000)}:t> · ${r.name}**`);
    }
  }
  if (!lines.length) lines.push('_Nothing scheduled this week._');

  const ends = weekStartMs + WEEK_MS;
  return {
    embeds: [{
      title: `This week${phase ? ` · ${phase.phase}` : ''}`,
      description: lines.join('\n'),
      color: COLOR,
      footer: { text: `${isoDate(weekStartMs)} to ${isoDate(ends - 1)} · replaced when the week turns` },
    }],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Mark everything already in the past as announced, without posting anything.
 *
 * Run once before going live. Otherwise the first real run finds an empty
 * state.json, looks back over its grace window, and announces events that
 * already finished hours ago.
 */
function seed(schedule, nowMs) {
  const state = { fired: {}, updatedAt: new Date(nowMs).toISOString() };
  const lookback = 30 * 24 * 60 * 60 * 1000;

  for (const event of schedule.events || []) {
    if (event.enabled === false || unconfigured(event, schedule.phaseCycle)) continue;
    const past = occurrencesBetween(event, nowMs - lookback, nowMs, schedule.phaseCycle);
    if (!past.length) continue;
    const last = past[past.length - 1];
    state.fired[event.id] = new Date(last).toISOString();
    console.log(`  ${event.name.padEnd(22)} last ran ${fmtUtc(last)}`);
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`\nSeeded state.json — nothing before ${fmtUtc(nowMs)} will be announced.`);
}

/** Print the next `days` of occurrences without touching Discord or state. */
function preview(schedule, nowMs, days) {
  const to = nowMs + days * 24 * 60 * 60 * 1000;
  console.log(`Upcoming occurrences, ${fmtUtc(nowMs)} → ${fmtUtc(to)}\n`);

  const rows = [];
  for (const event of schedule.events || []) {
    if (event.enabled === false || unconfigured(event, schedule.phaseCycle)) continue;
    for (const occ of occurrencesBetween(event, nowMs, to, schedule.phaseCycle)) {
      const p = phaseAt(occ, schedule.phaseCycle);
      rows.push({ occ, name: event.name, phase: p ? p.phase : '' });
    }
  }
  rows.sort((a, b) => a.occ - b.occ);

  if (!rows.length) {
    console.log('  (nothing — are the anchors filled in?)');
    return;
  }
  for (const r of rows) {
    console.log(`  ${fmtUtc(r.occ)}  ${r.name.padEnd(28)}${r.phase && `  [${r.phase}]`}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();

  // Second phase: carry out what `--plan` already recorded.
  if (args.send) {
    const plan = readJson(args.send, null);
    if (!plan) {
      console.log(`${args.send} does not exist — nothing was planned, nothing to send.`);
      return;
    }
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set.');

    if (plan.announcement) {
      await post(url, plan.announcement);
      console.log(`Posted ${(plan.announcement.embeds || []).length} announcement(s).`);
    }

    if (plan.summary) {
      // Last week's summary goes first, so a failure to post the new one cannot
      // leave the channel with two.
      if (plan.summary.deleteId) {
        await deleteMessage(url, plan.summary.deleteId);
        console.log(`Deleted the previous week's summary.`);
      }
      const id = await postAndGetId(url, plan.summary.payload);
      console.log(`Posted this week's summary${id ? ` (message ${id})` : ''}.`);

      // Record the id so next week can delete it. This write happens after
      // posting because the id does not exist until then; losing it costs only
      // a stale summary left in the channel, never a duplicate post.
      const state = readJson(STATE_PATH, { fired: {} });
      state.summary = { weekStart: plan.summary.weekStart, messageId: id };
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    }
    return;
  }

  const schedule = readJson(SCHEDULE_PATH);

  for (const note of lint(schedule)) console.warn(`  config: ${note}`);

  if (args.preview) {
    preview(schedule, args.now, args.preview);
    return;
  }

  if (args.seed) {
    seed(schedule, args.now);
    return;
  }

  const state = readJson(STATE_PATH, { fired: {} });
  const grace = Number(schedule.graceMinutes ?? 120);
  const result = due(schedule, args.now, state.fired || {}, grace);

  for (const w of result.warnings) console.warn(`  ${w}`);

  // The summary is owed whenever the week has turned since the last one posted.
  const thisWeek = isoDate(weekStart(args.now));
  const lastSummary = state.summary || {};
  // --force-summary reposts even when this week's is already recorded, for when
  // the message was deleted by hand. The stale id is still passed along so the
  // old message is cleaned up if it does somehow still exist; a 404 is fine.
  const summaryDue = schedule.weeklySummary !== false
    && (args.forceSummary || lastSummary.weekStart !== thisWeek);

  if (!result.due.length && !summaryDue) {
    console.log(`Nothing due at ${fmtUtc(args.now)}.`);
    return;
  }

  for (const item of result.due) {
    console.log(`Due: ${item.event.name} at ${fmtUtc(item.occurrence)}`);
  }
  if (summaryDue) console.log(`Due: weekly summary for the week of ${thisWeek}`);

  const mentions = [...new Set(
    result.due
      .map((i) => i.event.mention ?? schedule.defaults?.mention)
      .filter(Boolean)
  )];

  const announcement = result.due.length ? {
    content: mentions.join(' ') || undefined,
    embeds: result.due.slice(0, 10).map(buildEmbed),
    allowed_mentions: { parse: mentions.length ? ['roles', 'everyone'] : [] },
  } : null;

  const summary = summaryDue ? {
    weekStart: thisWeek,
    deleteId: lastSummary.messageId || null,
    payload: buildSummaryPayload(schedule, weekStart(args.now)),
  } : null;

  if (args.dryRun) {
    console.log('\n--dry-run, would send:\n' + JSON.stringify({ announcement, summary }, null, 2));
    return;
  }

  state.fired = state.fired || {};
  for (const item of result.due) {
    state.fired[item.event.id] = new Date(item.occurrence).toISOString();
  }
  state.updatedAt = new Date(args.now).toISOString();
  // Claim the summary for this week before posting it. If the run dies between
  // here and the post, the week is simply missed - far better than every run
  // for the next seven days posting another copy.
  if (summary) state.summary = { weekStart: thisWeek, messageId: null };

  // Two-phase: record first, announce second. `--plan` stops here so the caller
  // can durably commit state.json before anything reaches the channel. If that
  // commit is rejected the run fails having said nothing, and the next run
  // retries. Posting first and failing to record would instead repeat the same
  // ping every run until the grace window closed.
  if (args.plan) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    fs.writeFileSync(args.plan, JSON.stringify({ announcement, summary }, null, 2) + '\n');
    console.log(`\nPlanned into ${args.plan}: ${result.due.length} announcement(s)${summary ? ' and a weekly summary' : ''}. Nothing posted yet.`);
    return;
  }

  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set.');

  if (announcement) {
    await post(url, announcement);
    console.log(`Posted ${result.due.length} announcement(s).`);
  }
  if (summary) {
    if (summary.deleteId) await deleteMessage(url, summary.deleteId);
    state.summary = { weekStart: thisWeek, messageId: await postAndGetId(url, summary.payload) };
    console.log(`Posted this week's summary.`);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// Only run when invoked directly, so the tests can import the helpers below.
if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildEmbed, buildSummaryPayload, weekOccurrences, mentionNotifies, lint, isoDate };
