'use strict';

const fs = require('fs');
const path = require('path');

// Chrome writes an embedded quote as '\'' inside a shell-quoted value.
const QUOTED = "((?:[^']|'\\\\'')*)";
const HEADER_RE = new RegExp(`(?:-H|--header)\\s+'${QUOTED}'`, 'g');
const COOKIE_RE = new RegExp(`(?:-b|--cookie)\\s+'${QUOTED}'`);

// Replaying these breaks the request.
const SKIP = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cookie']);

const unquote = (v) => v.replace(/'\\''/g, "'");

function parseCurl(curl) {
  const headers = {};

  for (const m of curl.matchAll(HEADER_RE)) {
    const raw = unquote(m[1]);
    const i = raw.indexOf(':');
    if (i === -1) continue;
    const name = raw.slice(0, i).trim().toLowerCase();
    if (SKIP.has(name)) continue;
    headers[name] = raw.slice(i + 1).trim();
  }

  // Chrome puts cookies on -b, Firefox folds them into a cookie header.
  const flag = curl.match(COOKIE_RE);
  const header = curl.match(/(?:-H|--header)\s+'cookie:\s*([\s\S]*?)'\s*(?:\\|-|$)/i);

  return { headers, cookie: unquote(flag ? flag[1] : header ? header[1] : '') };
}

function loadAuth() {
  const curl = process.env.CURL_COMMAND;
  if (!curl) throw new Error('CURL_COMMAND is not set, see the README');

  const auth = parseCurl(curl);

  if (!/\bat=/.test(auth.cookie) && !auth.headers.authorization) {
    const found = Object.keys(auth.headers).join(', ') || 'none';
    throw new Error(
      `no session in CURL_COMMAND (headers: ${found}, starts with ${JSON.stringify(curl.slice(0, 40))}). ` +
      'Copy a /api/cult/ request from DevTools while signed in.'
    );
  }

  if (!auth.headers.apikey) console.warn('warning: no apikey header, sending without it');

  auth.headers.accept = 'application/json';
  auth.headers['content-type'] = 'application/json';

  return auth;
}

function loadPrefs() {
  const prefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'preferences.json'), 'utf8'));
  if (process.env.DRY_RUN !== undefined) prefs.dryRun = process.env.DRY_RUN !== 'false';
  return prefs;
}

module.exports = { loadAuth, loadPrefs };
