'use strict';

const fs = require('fs');
const path = require('path');

const API_DUMMY_KEY = '9d153009-e961-4718-a343-2a36b0a1d1fd';

function loadAuth() {
  const at = process.env.CULT_AT;
  const st = process.env.CULT_ST;

  if (!at || !st) {
    throw new Error(
      `${!at ? 'CULT_AT' : 'CULT_ST'} is not set. Sign in at cult.fit, open DevTools, ` +
      'Application tab, Cookies, https://www.cult.fit, and copy the "at" and "st" values.'
    );
  }

  return {
    headers: {
      apikey: API_DUMMY_KEY,
      appversion: '7',
      osname: 'browser',
      timezone: 'Asia/Kolkata',
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
    cookie: `at=${at}; st=${st}`,
  };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function loadPrefs() {
  const prefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'preferences.json'), 'utf8'));

  if (!Array.isArray(prefs.defaults?.slots) || !Array.isArray(prefs.defaults?.preferences)) {
    throw new Error('preferences.json needs defaults.slots and defaults.preferences');
  }
  for (const [day, cfg] of Object.entries(prefs.days ?? {})) {
    if (!WEEKDAYS.includes(day)) throw new Error(`unknown day "${day}" in preferences.json`);
    for (const key of ['slots', 'preferences']) {
      if (cfg[key] !== undefined && !Array.isArray(cfg[key])) {
        throw new Error(`days.${day}.${key} must be an array`);
      }
    }
  }

  if (process.env.DRY_RUN !== undefined) prefs.dryRun = process.env.DRY_RUN !== 'false';
  return prefs;
}

// days absent: every day. days present: whitelist, unlisted rest, overrides replace wholesale.
function planFor(prefs, weekday) {
  const day = prefs.days ? prefs.days[weekday] : {};
  if (!day) return null;
  return {
    slots: day.slots ?? prefs.defaults.slots,
    preferences: day.preferences ?? prefs.defaults.preferences,
  };
}

module.exports = { loadAuth, loadPrefs, planFor, WEEKDAYS };
