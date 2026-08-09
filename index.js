'use strict';

// Runners are UTC, preferences.json is IST. Has to happen before any Date use.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const { loadAuth, loadPrefs } = require('./config');

const HOST = 'https://www.cult.fit';
const CLASSES = '/api/cult/classes/v2?productType=FITNESS';

// A longer lead spends the rate limit budget and lands us in backoff as the day rolls.
const HOT_BEFORE = 15_000;
const HOT_AFTER = 180_000;
const MAX_FAILS = 20;
const BACKOFF = [5000, 10000, 20000, 30000, 60000];
// Sleeping 30s through the opening is worse than being throttled.
const HOT_BACKOFF = [2000, 3000, 5000];
const TIMEOUT_MS = 20_000;

let auth;

function log(...args) {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  console.log(`[${now.toLocaleTimeString('en-GB', { hour12: false })}.${ms}]`, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path) {
  const res = await fetch(HOST + path, {
    method,
    headers: { ...auth.headers, Cookie: auth.cookie },
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: res.ok, status: res.status, json, text };
}

async function getClasses() {
  const res = await call('GET', CLASSES);

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('auth expired, refresh the at/st cookies'), { fatal: true });
  }
  if (res.status === 429) {
    throw Object.assign(new Error('rate limited'), { throttled: true });
  }
  if (!res.ok) throw new Error(`classes returned ${res.status}`);
  if (!res.json) throw new Error('classes returned a non-JSON body');

  return res.json;
}

const lastDay = (data) => data.days?.[data.days.length - 1]?.id ?? null;

function* classesOn(data, date) {
  for (const slot of data.classByDateMap?.[date]?.classByTimeList ?? []) {
    for (const center of slot.centerWiseClasses ?? []) {
      for (const cls of center.classes ?? []) {
        yield { ...cls, time: slot.id, centerId: center.centerId };
      }
    }
  }
}

const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

// Matched on name, not workoutId: 69 covers both HRX WORKOUT and ADIDAS STRENGTH+.
function pick(data, date, prefs, states) {
  const all = [...classesOn(data, date)];
  const out = [];

  for (const time of prefs.slots) {
    for (const pref of prefs.preferences) {
      for (const cls of all) {
        if (cls.time !== time) continue;
        if (String(cls.centerId) !== String(pref.centerId)) continue;
        if (norm(cls.workoutName) !== norm(pref.workoutName)) continue;
        if (!states.includes(cls.state)) continue;
        out.push({ ...cls, centerName: pref.centerName });
      }
    }
  }

  return out;
}

function findState(data, date, prefs, states) {
  const centers = new Set(prefs.preferences.map((p) => String(p.centerId)));

  for (const cls of classesOn(data, date)) {
    if (!centers.has(String(cls.centerId))) continue;
    if (states.includes(cls.state)) return cls;
    if (states.includes('BOOKED') && cls.isBooked) return cls;
  }

  return null;
}

function describe(cls) {
  const seats = cls.state === 'WAITLIST_AVAILABLE'
    ? `waitlist +${cls.waitlistInfo?.waitlistedUserCount ?? '?'}`
    : `${cls.availableSeats} seats`;

  return `${cls.workoutName} ${cls.time} at ${cls.centerName ?? cls.centerId} (${cls.state}, ${seats})`;
}

function nextAt(hhmm, from) {
  const [h, m] = hhmm.split(':').map(Number);
  const at = new Date(from);
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= from) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// Each 22:00 release opens release-day + 4.
const DAYS_AHEAD = 4;

function isoDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function book(list) {
  for (const cls of list) {
    log(`booking ${describe(cls)}`);

    for (let i = 0; i < 3; i++) {
      let res;
      try {
        res = await call('POST', `/api/cult/class/${cls.id}/book`);
      } catch (err) {
        log(`  ${err.message}, retrying`);
        continue;
      }

      if (res.ok) return cls;

      const detail = res.text.slice(0, 200);
      if (/already/i.test(detail)) return cls;

      if (res.status === 429) {
        log('  throttled, waiting 5s');
        await sleep(5000);
        continue;
      }
      if (res.status >= 500) {
        log(`  ${res.status}, retrying`);
        continue;
      }

      log(`  ${res.status}, trying next: ${detail}`);
      break;
    }
  }

  return null;
}

async function list(args) {
  const data = await getClasses();

  if (args.includes('--raw')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const days = (data.days ?? []).map((d) => d.id);
  const workouts = new Set();
  const centers = new Set();

  for (const date of days) {
    for (const cls of classesOn(data, date)) {
      workouts.add(cls.workoutName);
      centers.add(String(cls.centerId));
    }
  }

  console.log(`days: ${days.join(', ')}`);
  console.log(`centers: ${[...centers].join(', ')}`);
  console.log(`workouts: ${[...workouts].join(', ')}`);
  console.log();

  const i = args.indexOf('--date');
  for (const date of i === -1 ? days : [args[i + 1]]) {
    for (const cls of classesOn(data, date)) {
      console.log([
        date,
        cls.time,
        String(cls.centerId).padEnd(5),
        (cls.workoutName ?? '').padEnd(22),
        (cls.state ?? '').padEnd(20),
        `seats=${cls.availableSeats}`,
        `id=${cls.id}`,
      ].join(' '));
    }
  }
}

async function run() {
  const prefs = loadPrefs();
  const start = Date.now();

  let deadline = Math.min(nextAt(prefs.campUntil, start), start + 4 * 3600_000);
  let windows = prefs.hotWindows.map((w) => nextAt(w, start));

  // Windows all past the deadline mean the release already happened: anchor to
  // yesterday's occurrence and take one short shot instead of camping to tomorrow.
  let anchor = windows.length ? Math.min(...windows) : nextAt('22:00', start);
  if (anchor > deadline) anchor -= 86_400_000;
  const target = isoDate(anchor + DAYS_AHEAD * 86_400_000);

  if (windows.length && windows.every((t) => t > deadline)) {
    windows = [start];
    if (deadline - start > 30 * 60_000) deadline = start + 15 * 60_000;
  }

  log(`camping until ${new Date(deadline).toLocaleString('en-GB')}, target day ${target}, dryRun=${prefs.dryRun}`);

  let day = null;
  let fails = 0;
  let throttles = 0;
  let saidWould = null;
  let saidQueued = null;

  while (Date.now() < deadline) {
    const now = Date.now();
    const hot = windows.some((t) => now >= t - HOT_BEFORE && now <= t + HOT_AFTER);

    // Capped, or a long cool interval steps over the start of a hot window.
    const upcoming = windows.map((t) => t - HOT_BEFORE).filter((t) => t > now).sort((a, b) => a - b);
    const wait = hot
      ? prefs.hotPollMs
      : Math.min(prefs.coolPollMs, ...(upcoming.length ? [upcoming[0] - now] : []));
    // Recomputed at sleep time: a slow fetch must not push the wake past the window.
    const nap = () => sleep(Math.min(wait, Math.max(250, (upcoming[0] ?? Infinity) - Date.now())));

    let data;
    try {
      data = await getClasses();
      throttles = 0;
    } catch (err) {
      if (err.fatal) throw err;

      if (err.throttled) {
        const ladder = hot ? HOT_BACKOFF : BACKOFF;
        // Same cap as the poll sleep: a 60s backoff must not sleep over the window.
        const back = Math.min(
          ladder[Math.min(throttles++, ladder.length - 1)],
          Math.max(1000, (upcoming[0] ?? Infinity) - Date.now()),
        );
        log(`throttled, backing off ${back / 1000}s`);
        await sleep(back);
        continue;
      }

      if (++fails >= MAX_FAILS) throw new Error(`giving up after ${fails} failures: ${err.message}`);
      log(`poll failed: ${err.message}`);
      await nap();
      continue;
    }

    const date = lastDay(data);
    if (!date) {
      if (++fails >= MAX_FAILS) throw new Error(`giving up after ${fails} failures: no days in response`);
      log('poll returned no days');
      await nap();
      continue;
    }
    fails = 0;

    if (day === null) {
      log(`furthest bookable day is ${date}${date === target ? ' (window already open)' : ''}`);
    } else if (date !== day) {
      log(`*** window opened: ${day} -> ${date} ***`);
      saidWould = null;
    }
    day = date;

    // Earlier days carry previous nights' bookings: exiting on them, or booking
    // around them, acts on the wrong day. >= so a release past the target
    // (catch-up, longer horizon) still books. Dry runs report throughout.
    const windowOpen = date >= target;
    if (!windowOpen && !prefs.dryRun) {
      await nap();
      continue;
    }

    const held = findState(data, date, prefs, ['BOOKED']);
    if (held && !prefs.dryRun) {
      log(`already booked on ${date}: ${describe(held)}`);
      return;
    }

    let picks = pick(data, date, prefs, ['AVAILABLE']);

    // A real seat still beats a waitlist we already hold, but don't queue twice.
    if (!picks.length && prefs.waitlistAsLastResort) {
      const queued = findState(data, date, prefs, ['WAITLISTED']);
      if (queued) {
        if (saidQueued !== date) {
          saidQueued = date;
          log(`already waitlisted on ${date}, leaving it alone`);
        }
      } else {
        picks = pick(data, date, prefs, ['WAITLIST_AVAILABLE']);
      }
    }

    if (picks.length && prefs.dryRun) {
      if (saidWould !== picks[0].id) {
        saidWould = picks[0].id;
        log(`would book ${describe(picks[0])} on ${date}`);
      }
    } else if (picks.length) {
      const got = await book(picks);
      if (got) {
        log(`booked ${describe(got)} on ${date}`);
        return;
      }
      log('nothing bookable, still camping');
    }

    await nap();
  }

  if (prefs.dryRun) return log('camp ended (dry run)');

  log('camp ended without booking');
  process.exitCode = 1;
}

async function main() {
  auth = loadAuth();
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'list') return list(args);
  if (cmd === 'run') return run();

  console.error('usage: node index.js list [--date YYYY-MM-DD] [--raw]');
  console.error('       node index.js run');
  process.exitCode = 2;
}

main().catch((err) => {
  log(`failed: ${err.message}`);
  process.exitCode = 1;
});
