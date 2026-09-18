# Reminder

Serverless Discord reminders for alliance events. No bot process, no host — a
GitHub Actions cron job runs a small Node script every 15 minutes, and anything
due gets posted to a channel webhook.

## Setup

1. **Create the webhook.** In Discord: Channel → Edit Channel → Integrations →
   Webhooks → New Webhook. Copy the URL.
2. **Store it as a secret.** Repo → Settings → Secrets and variables → Actions →
   New repository secret, named `DISCORD_WEBHOOK_URL`. Never commit the URL.
3. **Fill in `schedule.json`.** Every `null` is a value still to be confirmed;
   events with one are skipped and logged rather than guessed at.
4. **Keep the repo public** so Actions minutes stay free.
5. **Test before trusting it.** Actions → Alliance event pinger → Run workflow,
   with `dry_run` left on.

For local testing, put the same URL in a `.env` file at the repo root:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

`.env` is gitignored and must stay that way — anyone holding that URL can post
to the channel. A test in the suite fails the build if the URL ever appears in a
committable file.

6. **Seed the state before the first live run** (see below), so the first run
   does not announce events that already finished.

## Before going live: seed the state

```sh
node src/ping.js --seed
```

This records the most recent past occurrence of every event without posting
anything. Skip it and the first real run finds an empty `state.json`, looks back
over its grace window, and announces events that finished hours ago. Commit the
seeded `state.json`.

## Checking it without pinging anyone

```sh
npm run preview            # next 14 days of occurrences
npm run dry-run            # what would be posted right now, as JSON
npm test                   # cycle math, suppression, catch-up behaviour

node src/ping.js --preview 30 --now 2026-01-05T12:00   # pretend it is another day
```

`--now` is the one to reach for when verifying against dates you already know
the answer to.

## `schedule.json`

All times are UTC. Discord renders each announcement in the reader's own
timezone, so nobody has to convert anything.

### Event types

**`weekly`** — a fixed weekday and time:

```json
{ "id": "skills-friday", "name": "Skills Activation", "type": "weekly", "weekday": "friday", "time": "17:00" }
```

Use `times` instead of `time` when an event runs more than once in a day. Each
one is announced separately:

```json
{ "id": "slumbers", "name": "Slumbers of City", "type": "weekly", "weekday": "friday",
  "times": ["13:00", "14:00", "19:00"] }
```

**`interval`** — every N days, counted from one known occurrence:

```json
{ "id": "altar", "name": "Altar of Trial", "type": "interval", "intervalDays": 2,
  "anchorDate": "2026-01-06", "time": "17:00" }
```

`anchorDate` is the date of any single occurrence, past or future — the maths
works in both directions — and `time` is when it runs. Splitting them means
filling in a new event only takes a date, since the times are already known.

### The phase cycle

`phaseCycle` is the repeating four-week rotation. `anchorWeekStart` must be a
Monday that begins a Confluence week; the weeks then run Confluence → Disorder →
Disorder → Destiny and repeat.

Any event can opt out of chosen phases:

```json
"skipDuringPhases": ["Battle of Disorder"]
```

That is what keeps Altar of Trial quiet through the Disorder weeks. The
suppression is judged by the week the occurrence itself falls in, and the
two-day cadence keeps counting through the skipped weeks rather than restarting
after them.

Disorder runs for two consecutive weeks and Altar returns for the last day of
it, so the suppression has an exception:

```json
"runsOnFinalDayOfSkippedRun": true
```

That releases the final day of the *whole* run — the Sunday ending the second
Disorder week, not the Sunday of each one. Without the flag an event stays
suppressed for the entire run.

### Optional settings

| Key | Where | Meaning |
|---|---|---|
| `leadMinutes` | `defaults` or an event | Ping this many minutes *before* the event. `0` pings at start. |
| `mention` | `defaults` or an event | Role to ping, as `<@&ROLE_ID>`. `null` posts without pinging. |
| `enabled` | an event | `false` turns it off without deleting it. |
| `notBefore` | an event | Skip occurrences before this UTC date. Defers the first announcement; the cadence is unchanged. |
| `note` | an event | Extra line shown in the announcement. |
| `weekday` | an `interval` event | Validates the anchor date falls on this day, catching a mistyped anchor. |
| `runsOnFinalDayOfSkippedRun` | an event | Fire on the last day of a suppressed run instead of skipping it too. |
| `graceMinutes` | top level | How late a delayed run may still announce an event. Default `120`. |

To get a role ID: enable Developer Mode in Discord, then right-click the role →
Copy ID, and write it as `"<@&123456789012345678>"`.

## The weekly summary

At the start of each week one message lists everything expected that week,
grouped by day. When the week turns it is deleted and replaced, so the channel
never accumulates them.

It is deliberately silent — no role mention. The per-event reminders already
notify; a second notification for something nobody has to act on yet is noise.

The summary reflects the phase cycle like everything else: a Disorder week
lists no Altar of Trial except its final day, and shows the Sunday gathering
rather than the Thursday one.

Set `"weeklySummary": false` at the top level of `schedule.json` to turn it off.

If you delete the summary by hand, the recorded id makes the next run think
it is still up. Run the workflow with **repost_summary** ticked (or
`node src/ping.js --force-summary` locally) to post a fresh one.

Deleting works because a webhook can remove its own messages. Posting with
`?wait=true` returns the message id, which is kept in `state.json` until the
following week uses it to `DELETE .../messages/<id>`. There is no age limit on
deleting a single message this way.

## How it avoids double and missed pings

Actions cron is best-effort: runs drift, and occasionally one is dropped. So the
script does not assume it runs at an exact minute.

- Each run looks back `graceMinutes` (default two hours), so a missed or delayed
  run still catches the event.
- Everything announced is recorded in `state.json`, which the workflow commits
  back. An occurrence already listed there is never announced again.
- An event older than the grace window is dropped rather than announced hours
  late.

Those commits have a useful side effect: GitHub disables scheduled workflows on
repos with no activity for 60 days, and this keeps the repo active.

## Layout

```
schedule.json              the events, anchors, and phase cycle
state.json                 what has already been announced
src/schedule.js            date maths — occurrences, phases, what is due
src/ping.js                runner: reads state, posts, records
test/schedule.test.js      tests
.github/workflows/ping.yml the cron job
```

`src/schedule.js` is pure and has no I/O, which is what makes the behaviour
testable against arbitrary dates.
