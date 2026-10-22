// Shared token-usage aggregator over Claude Code transcripts.
//
// Used by both the Claude Code statusline script and the VS Code status-bar
// extension. Each caller passes its own cacheFile: two processes sharing one
// cache can regress each other's byte offsets and double-count totals.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CACHE_VERSION = 1;
const RETAIN_DAYS = 8; // keep per-request rows this long (week window + slack)

const ZERO = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, count: 0 });

function billable(a) {
  return a.input + a.output + a.cacheWrite + a.cacheRead;
}

function loadCache(cacheFile) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c.version === CACHE_VERSION && c.files) return c;
  } catch {
    /* missing or corrupt -> rebuild */
  }
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(cacheFile, cache) {
  try {
    const tmp = cacheFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cacheFile);
  } catch {
    /* a concurrent refresh won the race; harmless */
  }
}

function listTranscripts(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listTranscripts(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function addUsage(acc, u) {
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.count += 1;
}

// Parse only the bytes appended since last time and fold them into the entry.
// entry = { size, mtime, total, recent: [[tsMs, reqKey, in, out, cw, cr]], ctx }
function updateFile(file, cache, cutoffMs) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    delete cache.files[file];
    return null;
  }

  let entry = cache.files[file];
  const mtime = Math.floor(st.mtimeMs);
  if (entry && entry.size === st.size && entry.mtime === mtime) return entry;

  // Truncated or rewritten -> start this file over.
  if (!entry || st.size < entry.size) {
    entry = { size: 0, mtime: 0, total: ZERO(), recent: [], ctx: 0 };
  }
  if (st.size === entry.size) {
    entry.mtime = mtime;
    cache.files[file] = entry;
    return entry;
  }

  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - entry.size;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, entry.size);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return entry;
  }

  // A partial trailing line means the file is mid-write: park the offset before
  // it so the next pass re-reads that line whole.
  let consumed = Buffer.byteLength(text, 'utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return entry;
  if (lastNl !== text.length - 1) {
    const complete = text.slice(0, lastNl + 1);
    consumed = Buffer.byteLength(complete, 'utf8');
    text = complete;
  }

  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o.message && o.message.usage;
    if (!u) continue;

    addUsage(entry.total, u);
    entry.ctx =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);

    const ts = o.timestamp ? Date.parse(o.timestamp) : mtime;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    entry.recent.push([
      ts,
      String(o.requestId || o.uuid || '').slice(-14),
      u.input_tokens || 0,
      u.output_tokens || 0,
      u.cache_creation_input_tokens || 0,
      u.cache_read_input_tokens || 0,
    ]);
  }

  entry.recent = entry.recent.filter((r) => r[0] >= cutoffMs);
  entry.size += consumed;
  entry.mtime = mtime;
  cache.files[file] = entry;
  return entry;
}

function projectOf(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const seg = rel.split(path.sep)[0] || 'unknown';
  return seg.replace(/^[A-Za-z]--/, '').replace(/-/g, '/');
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * @param {object} opts
 * @param {string} opts.cacheFile     per-caller cache path (do not share)
 * @param {string|null} [opts.transcriptPath] session transcript; null = newest
 * @param {number} [opts.days] long rolling window in days, default 7
 * @param {number} [opts.sessionHours] short rolling window in hours, default 5.
 *   This is the analogue of what /usage calls the session limit: a rolling
 *   window over every session, not the current conversation.
 */
function aggregate({ cacheFile, transcriptPath = null, days = 7, sessionHours = 5 }) {
  const now = Date.now();
  const windowStart = now - days * 24 * 3600 * 1000;
  const rollingStart = now - sessionHours * 3600 * 1000;
  const cutoff = now - RETAIN_DAYS * 24 * 3600 * 1000;

  const cache = loadCache(cacheFile);
  const files = listTranscripts(PROJECTS_DIR);
  const live = new Set(files);
  for (const known of Object.keys(cache.files)) if (!live.has(known)) delete cache.files[known];

  let sessionFile = null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    sessionFile = path.resolve(transcriptPath);
  } else {
    // No transcript handed to us (the extension case): newest top-level session.
    let best = null;
    for (const f of files) {
      if (f.includes(path.sep + 'subagents' + path.sep)) continue;
      try {
        const s = fs.statSync(f);
        if (!best || s.mtimeMs > best.m) best = { f, m: s.mtimeMs };
      } catch {
        /* vanished mid-scan */
      }
    }
    if (best) sessionFile = path.resolve(best.f);
  }

  const week = ZERO();
  const rolling = ZERO();
  const byDay = Object.create(null);
  const byProject = Object.create(null);
  const seen = new Set();
  let sessionEntry = null;
  let scanned = 0;

  for (const file of files) {
    const cached = cache.files[file];
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const isSession = sessionFile && path.resolve(file) === sessionFile;

    // Untouched since before retention and never cached: cannot hold a row in
    // the window, so never open it.
    if (!cached && !isSession && st.mtimeMs < cutoff) continue;

    const entry = updateFile(file, cache, cutoff);
    if (!entry) continue;
    scanned += 1;
    if (isSession) sessionEntry = entry;

    const proj = projectOf(file);
    for (const r of entry.recent) {
      if (r[0] < windowStart) continue;
      if (r[1] && seen.has(r[1])) continue;
      if (r[1]) seen.add(r[1]);
      const tok = r[2] + r[3] + r[4] + r[5];
      week.input += r[2];
      week.output += r[3];
      week.cacheWrite += r[4];
      week.cacheRead += r[5];
      week.count += 1;
      if (r[0] >= rollingStart) {
        rolling.input += r[2];
        rolling.output += r[3];
        rolling.cacheWrite += r[4];
        rolling.cacheRead += r[5];
        rolling.count += 1;
      }
      const dk = dayKey(r[0]);
      (byDay[dk] || (byDay[dk] = ZERO()));
      byDay[dk].input += r[2];
      byDay[dk].output += r[3];
      byDay[dk].cacheWrite += r[4];
      byDay[dk].cacheRead += r[5];
      byDay[dk].count += 1;
      byProject[proj] = (byProject[proj] || 0) + tok;
    }
  }

  saveCache(cacheFile, cache);

  return {
    week,
    rolling,
    rollingHours: sessionHours,
    rollingStart,
    byDay,
    byProject,
    scanned,
    total: files.length,
    session: sessionEntry ? sessionEntry.total : ZERO(),
    ctx: sessionEntry ? sessionEntry.ctx : 0,
    sessionFile,
  };
}

// ---------------------------------------------------------- utilization ----
//
// The rate-limit percentages /usage prints come from GET /api/oauth/usage.
// The CLI caches its last response in ~/.claude.json (cachedUsageUtilization),
// but only refreshes it while a session is actually running — read that alone
// and the numbers sit still for hours. So we poll the same endpoint ourselves
// with the user's own OAuth token and share the result between windows.

const UTIL_CACHE = path.join(CLAUDE_DIR, 'usage-util-cache.json');
const CREDENTIALS = path.join(CLAUDE_DIR, '.credentials.json');

// Both the live response and the CLI's cached copy have this shape.
function normalizeUtil(u, fetchedAtMs, source) {
  if (!u) return null;
  const pick = (o) =>
    o && typeof o.utilization === 'number'
      ? { pct: Math.round(o.utilization), resetsAt: o.resets_at || null }
      : null;
  return {
    source,
    fetchedAtMs: fetchedAtMs || 0,
    ageMs: fetchedAtMs ? Date.now() - fetchedAtMs : null,
    session: pick(u.five_hour),
    week: pick(u.seven_day),
    limits: Array.isArray(u.limits)
      ? u.limits
          .filter((l) => l && typeof l.percent === 'number')
          .map((l) => ({
            kind: l.kind,
            group: l.group,
            pct: Math.round(l.percent),
            severity: l.severity || 'normal',
            resetsAt: l.resets_at || null,
            active: !!l.is_active,
            scope: (l.scope && l.scope.model && l.scope.model.display_name) || null,
          }))
      : [],
    extraUsage: u.extra_usage || null,
  };
}

// The CLI's cached copy — fallback only.
function readUtilization() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const cached = j.cachedUsageUtilization;
    return normalizeUtil(cached && cached.utilization, cached && cached.fetchedAtMs, 'cli-cache');
  } catch {
    return null;
  }
}

// Never refresh the token here: that is the CLI's session to manage, and a
// botched refresh would sign the user out. An expired token just means we fall
// back to whatever was cached.
function readAccessToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')).claudeAiOauth;
    if (!c || !c.accessToken) return null;
    if (c.expiresAt && c.expiresAt - Date.now() < 60_000) return null;
    return c.accessToken;
  } catch {
    return null;
  }
}

// Resolves { ok, raw, status, retryAfterMs } — never rejects. The caller needs
// to tell "rate limited" apart from "offline", because they earn different
// backoffs and a different message in the UI.
function fetchLiveUtilization(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const token = readAccessToken();
    if (!token) return resolve({ ok: false, status: 0, reason: 'no-token' });
    const req = https.request(
      {
        host: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'claude-usage-statusbar',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          const retryAfterMs = Math.max(0, Number(res.headers['retry-after'] || 0) * 1000);
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode, retryAfterMs });
          }
          try {
            resolve({ ok: true, raw: JSON.parse(body), status: 200 });
          } catch {
            resolve({ ok: false, status: 200, reason: 'bad-json' });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, reason: e.code || 'network' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, reason: 'timeout' });
    });
    req.end();
  });
}

function readUtilCache() {
  try {
    const j = JSON.parse(fs.readFileSync(UTIL_CACHE, 'utf8'));
    if (j && j.raw && j.fetchedAtMs) return j;
  } catch {
    /* first run, or a torn write */
  }
  return null;
}

// A failure must cost MORE than a success, or every refresh tick retries and
// the pollSeconds ceiling stops applying. Without this, three windows failing
// on a 15s aggregation tick produced ~12 requests a minute and earned a 429 —
// which then kept failing, which kept retrying.
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000];
// Hard floor between two attempts from this machine, whatever else happens.
const MIN_ATTEMPT_GAP_MS = 30_000;

function backoffFor(consecutive, retryAfterMs) {
  const step = BACKOFF_MS[Math.min(consecutive, BACKOFF_MS.length) - 1] || BACKOFF_MS[0];
  return Math.max(step, retryAfterMs || 0);
}

// Always merge onto the copy on disk, never onto the snapshot this call read
// at entry. A sibling window may have written a fresh success in between, and
// spreading a stale snapshot over it silently reverts the numbers.
function updateUtilCache(mutate) {
  const current = readUtilCache() || {};
  const next = mutate(current);
  try {
    const tmp = `${UTIL_CACHE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, UTIL_CACHE);
  } catch {
    /* another window won the race; its copy is just as good */
  }
  return next;
}

// Real single-flight. The previous "write attemptAtMs, then fetch" was a
// check-then-act: all three windows read the same stale timestamp within the
// same millisecond, all three wrote it, and all three fetched. Three identical
// requests arriving together is what the API answered with 429 — the endpoint
// serves a single request fine.
//
// O_EXCL file creation is atomic, so exactly one process wins.
function acquireFetchLock(ttlMs = 30_000) {
  const lock = `${UTIL_CACHE}.lock`;
  try {
    const st = fs.statSync(lock);
    // A crashed holder must not block polling forever.
    if (Date.now() - st.mtimeMs > ttlMs) fs.unlinkSync(lock);
  } catch {
    /* no lock present */
  }
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* already reaped as stale */
      }
    };
  } catch {
    return null; // someone else is fetching right now
  }
}

// ------------------------------------------------------------- burn rate ----
//
// Sampling is free: the poll already runs every 120s, so history is just the
// values we were throwing away. 24h at 2 minutes is 720 samples; each is a
// 4-number array, so the cache grows by tens of KB, not MB.
//
// Stored as [epochSeconds, fivePct, sevenPct, fiveResetEpochSeconds] to keep
// the file small and diffable.
// Raised from 720 (one day) to hold a full weekly window: the weekly "sessions"
// breakdown needs every sample of the current week. At 2 minutes a poll that is
// at most 720 per day, so 8000 covers 9 days even before flat runs are collapsed.
// Samples older than HISTORY_KEEP_DAYS are dropped too, so the cache stays a few
// hundred KB and a finished weekly window does not linger in the file.
const HISTORY_MAX = 8000;
const HISTORY_KEEP_DAYS = 9;
// Below this, the reading cannot be told from not working at all.
const IDLE_FLOOR_PCT_PER_HOUR = 0.05;

// Owner assumption, 2026-10-21: the weekly projection must not assume the user
// works around the clock. At least 9 idle hours every day, so at most 15 active
// hours per 24. The weekly rate is measured per ACTIVE hour and the time to full
// is stretched by 1 / WEEKLY_ACTIVE_FRACTION (24 / 15) into wall-clock time.
const WEEKLY_IDLE_HOURS_PER_DAY = 9;
const WEEKLY_ACTIVE_FRACTION = (24 - WEEKLY_IDLE_HOURS_PER_DAY) / 24; // 0.625

function pushSample(history, raw, atMs) {
  const list = Array.isArray(history) ? history.slice() : [];
  const five = raw && raw.five_hour;
  const seven = raw && raw.seven_day;
  if (!five || typeof five.utilization !== 'number') return list;

  const sample = [
    Math.round(atMs / 1000),
    five.utilization,
    seven && typeof seven.utilization === 'number' ? seven.utilization : null,
    five.resets_at ? Math.round(Date.parse(five.resets_at) / 1000) : null,
    seven && seven.resets_at ? Math.round(Date.parse(seven.resets_at) / 1000) : null,
  ];

  // Identical consecutive readings carry no signal about slope, but dropping
  // them entirely would hide "flat for an hour". Keep the first and last of a
  // flat run: overwrite the previous sample only when it too was a repeat.
  const n = list.length;
  if (n >= 2 && list[n - 1][1] === sample[1] && list[n - 2][1] === sample[1] && list[n - 1][3] === sample[3] && list[n - 1][4] === sample[4]) {
    list[n - 1] = sample;
  } else {
    list.push(sample);
  }
  const cutoffSec = Math.round(atMs / 1000) - HISTORY_KEEP_DAYS * 86400;
  const kept = list.filter((s) => s[0] >= cutoffSec);
  return kept.length > HISTORY_MAX ? kept.slice(kept.length - HISTORY_MAX) : kept;
}

// -------------------------------------------------------- weekly sessions ----
//
// The weekly bar is split into one segment per five-hour session, each as wide
// as the share of the weekly limit that session burned.
//
// Accuracy: the weekly percentage is an INTEGER that only rises within one
// weekly window, so each session's share is accurate to about +-1 point.
//
// Session ownership: a session owns the weekly points from its first sample to
// the first sample of the next session. Levels are a running maximum so the
// points can never go negative; the last session takes everything up to
// totalPct, which is what makes baselinePct + sum(points) === totalPct hold.
const SESSION_STAMP_TOL_SEC = 120;
const FIVE_HOUR_MS = 5 * 3600 * 1000;

function weeklySessions({ history, raw, now = Date.now() } = {}) {
  const seven = raw && raw.seven_day;
  if (!seven || typeof seven.utilization !== 'number') return null;
  const weekSec = seven.resets_at ? Math.round(Date.parse(seven.resets_at) / 1000) : NaN;
  if (!Number.isFinite(weekSec)) return null;

  // Only samples of the CURRENT weekly window. An undefined stamp belongs to it,
  // as in burnRate; a null stamp (no weekly reading) does not.
  const win = (Array.isArray(history) ? history : []).filter(
    (s) =>
      Array.isArray(s) &&
      typeof s[2] === 'number' &&
      typeof s[0] === 'number' &&
      (s[4] === undefined || Math.abs(s[4] - weekSec) <= SESSION_STAMP_TOL_SEC)
  );
  if (win.length === 0) return null;

  // Five-hour stamp per sample: a null stamp inherits the previous one, and any
  // leading nulls inherit the first real stamp.
  const stamps = win.map((s) => (typeof s[3] === 'number' && Number.isFinite(s[3]) ? s[3] : null));
  let last = null;
  for (let i = 0; i < stamps.length; i++) {
    if (stamps[i] === null) stamps[i] = last;
    else last = stamps[i];
  }
  const firstReal = stamps.find((x) => x !== null);
  if (firstReal === undefined) return null;
  for (let i = 0; i < stamps.length && stamps[i] === null; i++) stamps[i] = firstReal;

  // Group consecutive samples: a new session starts when the stamp moves by more
  // than the tolerance (the rounded stamp can differ by 1 s between polls).
  const groups = [];
  for (let i = 0; i < win.length; i++) {
    const g = groups[groups.length - 1];
    if (!g || Math.abs(stamps[i] - g.stampSec) > SESSION_STAMP_TOL_SEC) {
      groups.push({ stampSec: stamps[i], first: i, lastIdx: i });
    } else {
      g.lastIdx = i;
    }
  }

  const totalPct = Math.max(Math.round(seven.utilization), win[win.length - 1][2]);

  // Running maximum of weekly level at each session's first sample.
  const levels = [];
  let runMax = -Infinity;
  let sampleMax = -Infinity;
  let gi = 0;
  for (let i = 0; i < win.length && gi < groups.length; i++) {
    sampleMax = Math.max(sampleMax, win[i][2]);
    if (i === groups[gi].first) {
      runMax = Math.max(runMax, sampleMax);
      levels.push(runMax);
      gi++;
    }
  }
  const baselinePct = Math.min(levels[0], totalPct);

  const sessions = groups.map((g, k) => {
    const expiresMs = g.stampSec * 1000;
    const levelNext = k + 1 < levels.length ? Math.min(levels[k + 1], totalPct) : totalPct;
    const points = Math.max(0, Math.round(levelNext - Math.min(levels[k], totalPct)));
    return {
      startMs: expiresMs - FIVE_HOUR_MS,
      expiresMs,
      lastMs: win[g.lastIdx][0] * 1000,
      points,
      current: k === groups.length - 1 && expiresMs > now,
    };
  });

  // Rounding every level already keeps the sum exact; this only guards against
  // a future change to the arithmetic above.
  const sum = sessions.reduce((a, s) => a + s.points, 0);
  if (baselinePct + sum !== totalPct && sessions.length) {
    sessions[sessions.length - 1].points += totalPct - baselinePct - sum;
    sessions[sessions.length - 1].points = Math.max(0, sessions[sessions.length - 1].points);
  }

  return {
    totalPct,
    baselinePct,
    trackedSinceMs: win[0][0] * 1000,
    sessions,
  };
}

/**
 * Burn rate and time-to-exhaustion for one limit window.
 *
 * ⚠ The question that matters is NOT "when do I run out" on its own — it is
 * whether running out happens BEFORE the window resets. A 90%/hour burn is
 * harmless with ten minutes left on the clock, and a 5%/hour burn matters when
 * four hours remain. So this returns both and a verdict comparing them.
 *
 * Least squares over a trailing window rather than last-minus-first: burn is
 * bursty (one long agentic turn is a spike), and two adjacent samples of an
 * integer percentage are mostly quantisation noise.
 */
function burnRate({ history, raw, key = 'five', windowMinutes = null, now = Date.now() } = {}) {
  // The 7-day number climbs so slowly that a 45-minute window is always below
  // integer resolution, so a single fixed window would report it as idle
  // forever. Escalate instead: use the shortest window that actually resolves,
  // so a fast burn stays responsive and a slow one still gets an answer.
  const windows = windowMinutes
    ? [windowMinutes]
    : key === 'seven'
      ? [180, 720, 2880]
      : [45, 180, 720];
  const idx = key === 'seven' ? 2 : 1;
  const live = raw && (key === 'seven' ? raw.seven_day : raw.five_hour);
  const pct = live && typeof live.utilization === 'number' ? live.utilization : null;
  const resetsAtMs = live && live.resets_at ? Date.parse(live.resets_at) : null;
  const msToReset = resetsAtMs ? resetsAtMs - now : null;

  const out = {
    key,
    pct,
    msToReset,
    pctPerHour: null,
    msToFull: null,
    verdict: 'measuring',
    samples: 0,
    reason: null,
    basis: key === 'seven' ? 'active' : 'clock',
    activeFraction: key === 'seven' ? WEEKLY_ACTIVE_FRACTION : null,
  };

  // Wall-clock hours to reach 100% at the fitted slope. For the weekly window the
  // slope is per ACTIVE hour, so the wall-clock time is stretched by 1 / 0.625.
  const msToFullFor = (slope) => {
    const hours = (100 - pct) / slope;
    return (key === 'seven' ? hours / WEEKLY_ACTIVE_FRACTION : hours) * 3600_000;
  };
  if (pct === null) {
    out.reason = 'no reading';
    return out;
  }

  const all = Array.isArray(history) ? history : [];

  // ⚠ A reset makes utilization fall off a cliff. Fitting across one yields a
  // large negative slope and a nonsense "you have forever" answer, so only
  // samples sharing the current window's reset timestamp may be used.
  // Each series has its own reset stamp: column 3 for the 5h window, 4 for the
  // 7d one. Filtering the weekly fit on the five-hour stamp excluded every
  // sample and reported "measuring" forever.
  const resetIdx = key === 'seven' ? 4 : 3;
  const resetSec = resetsAtMs ? Math.round(resetsAtMs / 1000) : null;
  const sameWindow = all.filter(
    (s) =>
      typeof s[idx] === 'number' &&
      // Never match a missing stamp to a real one, or rows from one window leak
      // into another window's fit.
      // resets_at carries fractional seconds that vary between polls, so the
      // rounded stamp can land on either of two adjacent seconds. Real window
      // boundaries differ by hours or days, so a 120 s tolerance is safe.
      (resetSec === null || s[resetIdx] === undefined || Math.abs(s[resetIdx] - resetSec) <= 120)
  );

  const fit = (mins) => {
    const cutoffSec = (now - mins * 60_000) / 1000;
    const win = sameWindow.filter((s) => s[0] >= cutoffSec);
    if (win.length < 3) return { fail: 'not enough samples yet', win };

    // x axis in hours. Five-hour: plain wall-clock hours from the first sample.
    // Weekly: ACTIVE hours only, so the rate is per active hour and the 9 idle
    // hours are not discounted again on the rate (WEEKLY_ACTIVE_FRACTION is
    // applied only to the time-to-full).
    //
    // Which series signals activity: the FIVE-hour one, not the weekly one. The
    // weekly percentage is an integer that ticks about once every two hours of
    // real work at ~0.5 %/h. History collapses flat runs, so during ordinary
    // work the weekly value is equal across many minutes; judging idleness by
    // it would call active work idle and inflate the slope. The five-hour value
    // ticks every few minutes while work continues.
    //
    // An interval is idle (adds 0 to x) iff it is longer than 45 minutes AND the
    // five-hour value is unchanged across it. A flat five-hour stretch of 45+
    // minutes means almost no consumption. The weekly value is deliberately NOT
    // part of the test: an integer weekly tick at the edge of an idle block is
    // rounding, not activity, and requiring the weekly value to be unchanged
    // made such a block count as active. Any other interval counts at its full
    // wall-clock length.
    const t0 = win[0][0];
    const xs = win.map((s) => (s[0] - t0) / 3600);
    if (key === 'seven') {
      for (let i = 1; i < win.length; i++) {
        const dtHours = (win[i][0] - win[i - 1][0]) / 3600;
        const idleGap = dtHours > 45 / 60 && win[i][1] === win[i - 1][1];
        xs[i] = xs[i - 1] + (idleGap ? 0 : dtHours);
      }
    }
    if (xs[xs.length - 1] - xs[0] < 1 / 6)
      return { fail: 'window shorter than 10 minutes', win };

    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < win.length; k++) {
      const x = xs[k];
      const y = win[k][idx];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const n = win.length;
    const denom = n * sxx - sx * sx;
    if (denom === 0) return { fail: 'degenerate window', win };
    const slope = (n * sxy - sx * sy) / denom;
    const spread = Math.max(...win.map((s) => s[idx])) - Math.min(...win.map((s) => s[idx]));
    return { slope, spread, win, mins };
  };

  let best = null;
  for (const mins of windows) {
    const r = fit(mins);
    best = best || r;
    if (r.fail) continue;
    best = r;
    // Conclusive: enough movement to be sure it is signal, not rounding.
    if (r.spread >= 2 || r.slope <= 0) break;
  }

  out.samples = best.win ? best.win.length : 0;
  out.windowMinutes = best.mins || null;
  if (best.fail) {
    out.reason = best.fail;
    return out;
  }

  out.pctPerHour = best.slope;
  // Least squares over a flat run returns dust, not exactly zero, and dividing
  // by dust produced "full in 241704419454411 hours".
  if (best.slope <= IDLE_FLOOR_PCT_PER_HOUR) {
    out.verdict = 'idle';
    out.reason = 'not climbing';
    return out;
  }
  if (best.spread < 2) {
    // Still below resolution even at the widest window. The slope is a hint,
    // not a measurement — but a hint is enough to say "nowhere near the cap".
    out.verdict = 'slow';
    out.reason = 'movement below resolution; rate is an estimate';
    out.msToFull = msToFullFor(best.slope);
    return out;
  }

  out.msToFull = msToFullFor(best.slope);

  if (msToReset === null) out.verdict = 'unknown-reset';
  else if (out.msToFull > msToReset) out.verdict = 'safe';
  else if (out.msToFull > msToReset - 30 * 60_000) out.verdict = 'tight';
  else out.verdict = 'exhaust';
  return out;
}

/**
 * Utilization plus a burn-rate projection for each window.
 *
 * Kept separate from getUtilization so the fetch path stays about fetching:
 * this only re-reads the cache the fetch just wrote and does arithmetic on it.
 */
async function getUtilizationWithBurn(opts = {}) {
  const util = await getUtilization(opts);
  if (!util) return util;
  const cached = readUtilCache();
  const history = cached && cached.history;
  const raw = cached && cached.raw;
  if (!raw) {
    util.weekSessions = null;
    return util;
  }
  util.burn = {
    five: burnRate({ history, raw, key: 'five' }),
    seven: burnRate({ history, raw, key: 'seven' }),
  };
  util.historyCount = Array.isArray(history) ? history.length : 0;
  try {
    util.weekSessions = weeklySessions({ history, raw });
  } catch {
    util.weekSessions = null; // a bug here must never break the poll
  }

  // Series for the panel chart: only the current 5h window, so the line never
  // draws the cliff of a reset.
  const fiveReset = raw.five_hour && raw.five_hour.resets_at
    ? Math.round(Date.parse(raw.five_hour.resets_at) / 1000)
    : null;
  util.spark = (Array.isArray(history) ? history : [])
    .filter((s) => typeof s[1] === 'number' && (fiveReset === null || s[3] === fiveReset))
    .map((s) => [s[0], s[1]]);
  return util;
}

/**
 * Freshest utilization available, preferring a live fetch.
 *
 * The cache file is shared across every window on purpose: whichever extension
 * host notices it has gone stale does the fetch, and the others read the
 * result. It also carries the failure state, so a backoff earned by one window
 * is respected by all of them instead of each keeping its own private counter.
 */
async function getUtilization({ pollSeconds = 120 } = {}) {
  const cached = readUtilCache() || {};
  const now = Date.now();
  const stale = (src) => (cached.raw ? normalizeUtil(cached.raw, cached.fetchedAtMs, src) : null);

  if (cached.raw && now - cached.fetchedAtMs < pollSeconds * 1000) {
    return stale('shared-cache');
  }

  const failure = cached.failure;
  if (failure && now < failure.atMs + backoffFor(failure.consecutive, failure.retryAfterMs)) {
    const held = stale('shared-cache') || readUtilization();
    if (held) {
      held.blocked = {
        status: failure.status,
        reason: failure.reason,
        consecutive: failure.consecutive,
        retryAtMs: failure.atMs + backoffFor(failure.consecutive, failure.retryAfterMs),
      };
    }
    return held;
  }

  if (cached.attemptAtMs && now - cached.attemptAtMs < MIN_ATTEMPT_GAP_MS) {
    return stale('shared-cache') || readUtilization();
  }

  // Losing the lock is not a failure: a sibling is fetching, and its result
  // lands in the shared cache within a second or two. Recording a failure here
  // would let one slow fetch look like an outage to every other window.
  const release = acquireFetchLock();
  if (!release) return stale('shared-cache') || readUtilization();

  let res;
  try {
    updateUtilCache((c) => ({ ...c, attemptAtMs: now }));
    res = await fetchLiveUtilization();
  } finally {
    release();
  }

  if (res.ok) {
    const fetchedAtMs = Date.now();
    updateUtilCache((c) => ({
      fetchedAtMs,
      raw: res.raw,
      attemptAtMs: fetchedAtMs,
      history: pushSample(c.history, res.raw, fetchedAtMs),
    }));
    return normalizeUtil(res.raw, fetchedAtMs, 'live');
  }

  const consecutive = (failure && failure.consecutive ? failure.consecutive : 0) + 1;
  updateUtilCache((c) => ({
    ...c,
    attemptAtMs: now,
    failure: {
      atMs: Date.now(),
      status: res.status,
      reason: res.reason,
      retryAfterMs: res.retryAfterMs || 0,
      consecutive,
    },
  }));

  const held = stale('shared-cache') || readUtilization();
  if (held) {
    held.blocked = {
      status: res.status,
      reason: res.reason,
      consecutive,
      retryAtMs: Date.now() + backoffFor(consecutive, res.retryAfterMs),
    };
  }
  return held;
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

module.exports = {
  aggregate,
  readUtilization,
  getUtilization,
  getUtilizationWithBurn,
  burnRate,
  pushSample,
  weeklySessions,
  billable,
  fmt,
  ZERO,
  CLAUDE_DIR,
  PROJECTS_DIR,
};
