# cult-booker

Books a cult.fit class as soon as the booking window opens.

Cult lets you book 4 days ahead, and a new day is released every night around 22:00 IST. Popular
slots go within seconds. This sits on the API from well before the release, spots the new day the
moment it appears, and books it.

Node 20+, no dependencies.

## How it works

The classes API returns a `days` array whose last entry is the furthest bookable day. When the
window opens, a new entry appears and that value changes. The script polls for exactly that, so it
never needs to know the release time precisely.

It then walks `slots` and `preferences` in order and books the first class with an open seat. Only
when every combination is full does it fall back to a waitlist, and it won't queue twice for the
same day.

## Setup

### 1. Grab your session

Sign in at cult.fit in Chrome. Open DevTools, go to Network, filter for `api/cult`, reload, and
find a request whose response has a top-level `days` array. Right-click it, Copy as cURL.

Save it straight to a file, since the clipboard is easy to lose:

```bash
pbpaste > ~/cult.curl && export CURL_COMMAND="$(cat ~/cult.curl)"
```

The request has to be one made while signed in. A static asset parses fine but carries no session.

### 2. Find your centers and workouts

```bash
node index.js list
```

Prints every bookable day and class, with center IDs, workout names, states and seat counts.

Two things to watch:

- Center IDs here are not the ones in the website URL. `Cult HSR 14th Main` is `361` on the site
  and `267` in this API. Use the ones from `list`.
- `workoutId` is not unique. `69` is both `HRX WORKOUT` and `ADIDAS STRENGTH+`, and `5` is two
  different yoga formats. Matching is on `workoutName`, ignoring case and spacing.

### 3. Fill in preferences.json

```json
{
  "slots": ["07:00:00"],
  "preferences": [
    { "centerId": "267", "centerName": "Cult HSR 14th Main", "workoutName": "HRX WORKOUT" }
  ],
  "waitlistAsLastResort": true,
  "hotWindows": ["22:00"],
  "hotPollMs": 2000,
  "coolPollMs": 30000,
  "campUntil": "22:30",
  "dryRun": true
}
```

`slots` and `preferences` are both ordered, and the search is slot-major: the first time is tried
at every center before moving to the next time. `centerName` is only a label for the logs.

`hotWindows` are the times it polls every `hotPollMs`, from a minute before to three minutes after.
The rest of the camp runs at `coolPollMs`. All times are IST.

### 4. Try it

```bash
node index.js run
```

With `dryRun` on it logs the class it would book and keeps camping, so an overnight run still
records when the window opened.

### 5. Run it on GitHub Actions

The repo has to be **public** for unlimited free minutes, since the job camps for over an hour.

- Settings, Secrets and variables, Actions, Secrets: `CURL_COMMAND` set to the copied curl.
- Same page, Variables: `DRY_RUN` set to `true`, flipped to `false` once a dry night looks right.

Cron fires at 20:45 and 21:15 IST, well before the window, because GitHub's scheduler drifts 5 to
30 minutes under load and occasionally skips a run entirely. It is only used to get a runner awake
early; the camping loop is the real timer.

Run it once by hand from the Actions tab to check the wiring.

## Rate limiting

The classes endpoint returns `429 Too Many Requests` with no `Retry-After` and no rate-limit
headers. A few dozen requests within a couple of minutes is enough to trip it, and it clears in
about a minute.

429 is treated as back off, not as a failure: 5s, 10s, 20s, 30s, 60s, reset on the first success.
A booking POST that gets a 429 waits and retries the same class instead of dropping to a worse one.

This is why `hotPollMs` is 2000 and not 250. Being throttled during the race costs far more than
polling a second slower. If the log fills with `throttled` lines, raise both intervals.

## When it breaks

`auth expired, re-capture CURL_COMMAND` means the `at` and `st` cookies are stale. Redo step 1 and
update the secret. The run exits non-zero, so GitHub emails you.

If the schedule goes quiet, check the Actions tab. GitHub disables scheduled workflows in a repo
with no commits for 60 days. Any commit or manual run resets it.

## Logs are public

On a public repo anyone can read the run logs, so the script only prints center IDs, workout names,
times, states and seat counts. Error bodies are cut at 200 characters. `--raw` is for local
debugging and isn't used in CI. Secrets are encrypted and masked, and there's no `pull_request`
trigger, so forks can't reach them.

`~/cult.curl` holds live session cookies in plain text. It lives outside the repo and `*.curl` is
gitignored, but treat it like a password.
