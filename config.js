'use strict';

const fs = require('fs');
const path = require('path');

function loadAuth() {
  const at = process.env.CULT_AT;
  const st = process.env.CULT_ST;
  const apikey = process.env.CULT_API_KEY;

  const missing = [!at && 'CULT_AT', !st && 'CULT_ST', !apikey && 'CULT_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} not set. Sign in at cult.fit; the "at" and "st" values are under ` +
      'DevTools > Application > Cookies, and "apikey" is a request header on any /api/cult/ call.'
    );
  }

  return {
    headers: {
      apikey,
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

function loadPrefs() {
  const prefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'preferences.json'), 'utf8'));
  if (process.env.DRY_RUN !== undefined) prefs.dryRun = process.env.DRY_RUN !== 'false';
  return prefs;
}

module.exports = { loadAuth, loadPrefs };
