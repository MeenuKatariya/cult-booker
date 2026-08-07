'use strict';

// Runners are UTC, preferences.json is IST. Has to happen before any Date use.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const { loadAuth, loadPrefs } = require('./config');

const HOST = 'https://www.cult.fit';
const CLASSES = '/api/cult/classes/v2?productType=FITNESS';

const HOT_BEFORE = 60_000;
const HOT_AFTER = 180_000;
const MAX_FAILS = 20;
const BACKOFF = [5000, 10000, 20000, 30000, 60000];

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
    signal: AbortSignal.timeout(8000),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: res.ok, status: res.status, json, text };
}

async function getClasses() {
  const res = await call('GET', CLASSES);

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('auth expired, re-capture CURL_COMMAND'), { fatal: true });
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
  const deadline = nextAt(prefs.campUntil, Date.now());
  const windows = prefs.hotWindows.map((w) => nextAt(w, Date.now()));

  log(`camping until ${new Date(deadline).toLocaleString('en-GB')}, dryRun=${prefs.dryRun}`);

  let day = lastDay(await getClasses());
  log(`furthest bookable day is ${day}`);

  let fails = 0;
  let throttles = 0;
  let saidWould = null;
  let saidQueued = null;

  while (Date.now() < deadline) {
    const now = Date.now();
    const hot = windows.some((t) => now >= t - HOT_BEFORE && now <= t + HOT_AFTER);

    let data;
    try {
      data = await getClasses();
      fails = 0;
      throttles = 0;
    } catch (err) {
      if (err.fatal) throw err;

      if (err.throttled) {
        const wait = BACKOFF[Math.min(throttles++, BACKOFF.length - 1)];
        log(`throttled, backing off ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }

      if (++fails >= MAX_FAILS) throw new Error(`giving up after ${fails} failures: ${err.message}`);
      log(`poll failed: ${err.message}`);
      await sleep(hot ? prefs.hotPollMs : prefs.coolPollMs);
      continue;
    }

    const date = lastDay(data);
    if (date !== day) {
      log(`*** window opened: ${day} -> ${date} ***`);
      day = date;
      saidWould = null;
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
      // Keep camping so a dry run still shows when the window actually opened.
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

    await sleep(hot ? prefs.hotPollMs : prefs.coolPollMs);
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
