#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { due, occurrencesBetween, phaseAt, unconfigured, parseUtc } = require('./schedule.js');

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
  const args = { dryRun: false, now: Date.now(), preview: 0, seed: false, plan: null, send: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--now') args.now = parseUtc(argv[++i]);
    else if (a === '--preview') args.preview = Number(argv[++i] ?? 14);
    else if (a === '--seed') args.seed = true;
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--send') args.send = argv[++i];
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
  // "##" is a markdown heading, which Discord renders in embed descriptions two
  // steps above body text. Headings are already bold, so the ** is dropped.
  const lines = [`## <t:${secs}:F> · <t:${secs}:R>`];
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

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord returned ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
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

  // Second phase: post a payload that `--plan` already recorded.
  if (args.send) {
    const payload = readJson(args.send, null);
    if (!payload) {
      console.log(`${args.send} does not exist — nothing was planned, nothing to send.`);
      return;
    }
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set.');
    await post(url, payload);
    console.log(`Posted ${(payload.embeds || []).length} announcement(s).`);
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

  if (!result.due.length) {
    console.log(`Nothing due at ${fmtUtc(args.now)}.`);
    return;
  }

  for (const item of result.due) {
    console.log(`Due: ${item.event.name} at ${fmtUtc(item.occurrence)}`);
  }

  const mentions = [...new Set(
    result.due
      .map((i) => i.event.mention ?? schedule.defaults?.mention)
      .filter(Boolean)
  )];

  const payload = {
    content: mentions.join(' ') || undefined,
    embeds: result.due.slice(0, 10).map(buildEmbed),
    allowed_mentions: { parse: mentions.length ? ['roles', 'everyone'] : [] },
  };

  if (args.dryRun) {
    console.log('\n--dry-run, would POST:\n' + JSON.stringify(payload, null, 2));
    return;
  }

  state.fired = state.fired || {};
  for (const item of result.due) {
    state.fired[item.event.id] = new Date(item.occurrence).toISOString();
  }
  state.updatedAt = new Date(args.now).toISOString();

  // Two-phase: record first, announce second. `--plan` stops here so the caller
  // can durably commit state.json before anything reaches the channel. If that
  // commit is rejected the run fails having said nothing, and the next run
  // retries. Posting first and failing to record would instead repeat the same
  // ping every run until the grace window closed.
  if (args.plan) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    fs.writeFileSync(args.plan, JSON.stringify(payload, null, 2) + '\n');
    console.log(`\nPlanned ${result.due.length} announcement(s) into ${args.plan}. Nothing posted yet.`);
    return;
  }

  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set.');
  await post(url, payload);
  console.log(`Posted ${result.due.length} announcement(s).`);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
