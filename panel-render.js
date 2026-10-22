// Panel, tooltip and status-bar RENDERING. Pure: no vscode API, no state.
//
// Kept out of extension.js on purpose. A VS Code window freezes extension.js at
// activation and never re-reads it, so every wording or layout tweak used to
// need a window reload — which stalled four changes in a row. extension.js
// re-requires THIS file on every render with its require.cache entry cleared,
// the same trick that lets the forked worker pick up a new core, so anything in
// here takes effect on the next panel refresh with no reload.
//
// The rule that keeps that true: nothing in this file may touch `vscode`, and
// everything it needs must arrive as an argument.
//
// Version of THIS file. preflight.js asserts it equals package.json's version,
// so it cannot drift; the panel footer and the beacon both report it.
const RENDERER_VERSION = '0.0.27';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

function gauge(pct, width) {
  const filled = Math.max(0, Math.min(1, pct / 100)) * width;
  let whole = Math.floor(filled);
  let rest = Math.round((filled - whole) * 8);
  // A fraction above 15/16 rounds to a full eighth: carry it, or the lookup
  // runs off the end of the table and prints "undefined".
  if (rest > 7) {
    whole += 1;
    rest = 0;
  }
  let s = '█'.repeat(Math.min(whole, width));
  if (whole < width && rest > 0) s += EIGHTHS[rest];
  return (s + '░'.repeat(width)).slice(0, width);
}

// Status-bar gauge: whole cells only, filled with ▰ and empty with ▱. Length is
// exactly width. Used by the status bar only; gauge() above stays for other callers.
function thinGauge(pct, width = 5) {
  const w = Math.max(0, Math.round(width));
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * w);
  return '▰'.repeat(filled) + '▱'.repeat(w - filled);
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function durationTo(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'due';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ageLabel(ms) {
  if (ms === null || ms === undefined) return 'unknown age';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

// One segment of the status bar. Real server percentages when the CLI has
// cached them; otherwise a percentage against a configured token budget;
// otherwise the raw token count.
function segment(label, realPct, total, budget, c) {
  const pct = realPct !== null && realPct !== undefined ? realPct : budget > 0 ? Math.round((total / budget) * 100) : null;
  if (pct === null) return { text: `${label}:${fmt(total)}`, pct: null };
  const bar = c.showBars ? ' ' + thinGauge(pct, c.barWidth) : '';
  return { text: `${label} ${pct}%${bar}`, pct };
}

function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

// One signed span: time to full minus time to reset. '+' when the reset wins, '-'
// when the cap is hit first. Rounded to whole minutes, so a -12 s value shows as '+0m'
// rather than '-0m'. Days: 'Nd' plus ' Mh' when hours are non-zero; hours: 'Nh' plus
// ' Mm' when minutes are non-zero; otherwise 'Nm'. Exactly 48 h gives '+2d' or '-2d'.
// Unsigned duration with the same d/h/m rules: days show hours only when non-zero,
// hours show minutes only when non-zero. Used for the hover titles.
function spanText(ms) {
  const totalMin = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return d + 'd' + (h ? ` ${h}h` : '');
  if (h > 0) return h + 'h' + (m ? ` ${m}m` : '');
  return m + 'm';
}

function signedSpan(ms) {
  const sign = ms >= 0 || Math.round(Math.abs(ms) / 60000) === 0 ? '+' : '-';
  return sign + spanText(ms);
}

// One tooltip line per window. The verdict is the point — the raw rate is
// supporting evidence, not the headline.
function burnLine(label, b) {
  if (!b) return `- ${label}: —\n`;
  const rate = b.pctPerHour === null ? null : `${b.pctPerHour.toFixed(1)} %/h`;
  // Only lines that show a projection carry the 9h-idle assumption.
  const projects = ['safe', 'tight', 'exhaust', 'slow'].includes(b.verdict);
  const idleTag = b.basis === 'active' && projects ? ' · assumes 9h idle per day' : '';

  if (b.verdict === 'measuring') return `- ${label}: measuring — ${b.reason}\n`;
  if (b.verdict === 'idle') return `- ${label}: idle, not climbing\n`;

  const win = b.windowMinutes ? ` over ${b.windowMinutes < 60 ? b.windowMinutes + 'm' : Math.round(b.windowMinutes / 60) + 'h'}` : '';
  const full = b.msToFull !== null ? `full in **${spanText(b.msToFull)}**` : 'no projection';
  const reset = b.msToReset !== null ? `resets in ${spanText(b.msToReset)}` : 'reset unknown';

  const verdict =
    b.verdict === 'exhaust'
      ? ' ⚠ **hits the cap before reset**'
      : b.verdict === 'tight'
        ? ' ⚠ lands close to the reset'
        : b.verdict === 'slow'
          ? ' _(below integer resolution — estimate)_'
          : ' — reset wins';

  return `- ${label}: ${rate}${win} · ${full} · ${reset}${verdict}${idleTag}\n`;
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function meterHtml(label, pct, sub) {
  if (pct === null || pct === undefined) {
    return `<div class="meter">
      <div class="mhead"><span>${esc(label)}</span><span class="dim">n/a</span></div>
      <div class="track"><span style="width:0%"></span></div>
      <div class="dim small">${esc(sub)}</div>
    </div>`;
  }
  const state = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return `<div class="meter">
    <div class="mhead"><span>${esc(label)}</span><span class="pct ${state}">${pct}%</span></div>
    <div class="track ${state}"><span style="width:${Math.min(100, pct)}%"></span></div>
    <div class="dim small">${esc(sub)}</div>
  </div>`;
}

// Horizontal traffic light for the verdict column: three lamps, exactly one lit.
// safe / idle / slow -> green, tight -> yellow, exhaust -> red, measuring -> none.
const LIGHT_NAMES = { g: 'green', y: 'yellow', r: 'red' };
function trafficLightHtml(verdict, note) {
  const lit = verdict === 'exhaust' ? 'r' : verdict === 'tight' ? 'y' : verdict === 'measuring' ? '' : 'g';
  const lamp = (k) => `<span class="lamp ${k}${lit === k ? ' on' : ''}"></span>`;
  const state = lit ? `${LIGHT_NAMES[lit]} lamp lit, ${note}` : `no verdict yet, ${note}`;
  // The short text is shown on hover only (title), not printed beside the lamps.
  return `<span class="light" role="img" title="${esc(note)}" aria-label="${esc('Traffic light: ' + state)}">${lamp('g')}${lamp('y')}${lamp('r')}</span>`;
}

// Weekly reset moment as local weekday and time, e.g. 'Mon - 18:00'. The weekday
// comes from a fixed English table (not Intl), and the time is rounded to the nearest
// minute first: the API stamps like :59.96 must read as the next minute. Anything that
// is not a parseable string gives ''.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// ISO stamp -> Date rounded to the nearest minute, or null when unusable.
function roundedLocal(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(Math.round(parsed / 60000) * 60000);
}

const pad2 = (n) => String(n).padStart(2, '0');

function resetStamp(iso) {
  const d = roundedLocal(iso);
  if (!d) return '';
  return `${WEEKDAYS[d.getDay()]} - ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Session expiry for the burn table: local 24 h HH:mm, rounded to the nearest minute.
// Never carries a weekday, not even when the expiry falls on another calendar day.
function clockStamp(iso) {
  const d = roundedLocal(iso);
  if (!d) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Segmented weekly meter: one coloured segment per 5-hour session, as wide as the
// weekly points that session burned, in chronological order, after a grey block
// for usage that predates tracking. Points are whole percentage points of the
// weekly limit, so every share is only accurate to about one point.
const SESSION_MS = 5 * 3600 * 1000;
const SEG_PALETTE = [
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-purple, #b180d7)',
  'var(--vscode-charts-green, #89d185)',
  'var(--vscode-charts-yellow, #cca700)',
  '#4ec9b0',
  '#e06c9f',
  '#7d8ea3',
];
const BASELINE_COLOUR = 'rgba(127,127,127,.45)';

// 'Ddd HH:mm-HH:mm' in local time for the 5 h window that ends at expiresMs.
// Rounded to the nearest minute like resetStamp. '' when the input is unusable.
function sessionSpan(expiresMs) {
  if (typeof expiresMs !== 'number' || !Number.isFinite(expiresMs)) return '';
  const end = new Date(Math.round(expiresMs / 60000) * 60000);
  if (!Number.isFinite(end.getTime())) return '';
  const start = new Date(end.getTime() - SESSION_MS);
  const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${WEEKDAYS[start.getDay()]} ${hm(start)}–${hm(end)}`;
}

// Clean the weekSessions data: anything odd is clamped or skipped, never thrown on.
// Returns null when there is nothing to draw (fallback to the plain bar).
function weekSegments(ws) {
  if (!ws || typeof ws !== 'object') return null;
  const pts = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
  const baseline = pts(ws.baselinePct);
  const list = Array.isArray(ws.sessions) ? ws.sessions : [];
  const sessions = list.map((s, i) => {
    const o = s && typeof s === 'object' ? s : {};
    const expires = typeof o.expiresMs === 'number' && Number.isFinite(o.expiresMs) ? o.expiresMs : null;
    return { index: i, expires, points: pts(o.points), current: o.current === true };
  });
  if (!baseline && !sessions.length) return null;

  const colourOf = (i) => SEG_PALETTE[i % SEG_PALETTE.length];
  let used = 0;
  const take = (points) => {
    const w = Math.min(points, 100 - used);
    if (w <= 0) return 0;
    used += w;
    return w;
  };
  const segs = [];
  const base = take(baseline);
  if (base > 0) {
    segs.push({ width: base, index: -1, colour: BASELINE_COLOUR, cur: false, title: `Before tracking started · +${base}% of the weekly limit` });
  }
  for (const s of sessions) {
    const w = take(s.points);
    if (w <= 0) continue;
    const span = sessionSpan(s.expires) || 'Session';
    segs.push({
      width: w,
      index: s.index, colour: colourOf(s.index),
      cur: s.current,
      title: `${span} · +${w}% of the weekly limit${s.current ? ' · running' : ''}`,
    });
  }
  return { baseline, sessions, segs, colourOf };
}

// The weekly meter. Plain bar (meterHtml) unless weekSessions has data to draw.
function weekMeterHtml(label, pct, sub, ws) {
  const data = weekSegments(ws);
  if (!data) return meterHtml(label, pct, sub);
  const hasPct = pct !== null && pct !== undefined;
  const state = hasPct ? (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok') : null;
  const head = hasPct ? `<span class="pct ${state}">${pct}%</span>` : '<span class="dim">n/a</span>';
  const segHtml = data.segs
    .map(
      (g) =>
        `<span class="seg${g.cur ? ' cur' : ''}" style="width:${g.width}%;background:${g.colour}" title="${esc(g.title)}"></span>`
    )
    .join('');
  const rows = [];
  if (data.baseline > 0) {
    rows.push(
      `<tr><td class="sw"><span class="swatch" style="background:${BASELINE_COLOUR}"></span></td><td>Before tracking</td><td class="n">+${data.baseline}%</td></tr>`
    );
  }
  for (const s of data.sessions) {
    const span = sessionSpan(s.expires) || 'Session';
    rows.push(
      `<tr><td class="sw"><span class="swatch" style="background:${data.colourOf(s.index)}"></span></td><td>${esc(span)}${s.current ? ' · running' : ''}</td><td class="n">+${s.points}%</td></tr>`
    );
  }
  return `<div class="meter">
    <div class="mhead"><span>${esc(label)}</span>${head}</div>
    <div class="track seg-track">${segHtml}</div>
    <div class="dim small">${esc(sub)}</div>
    <details class="sessions"><summary>Sessions this week (${data.sessions.length})</summary>
      <table>${rows.join('')}</table>
      <p class="dim small">Shares are approximate, within ±1 point, because the weekly percentage is a whole number. Sessions are only tracked while VS Code is open.</p>
    </details>
  </div>`;
}

// Shared facts for the meters and the burn rows. The page and the hover both read
// these, so a number, a tone or a word cannot differ between them.
const SOURCE_TEXT = {
  live: 'Fetched from the API',
  'shared-cache': 'From this machine’s shared poll cache',
  'cli-cache': 'From Claude Code’s own cache — our live fetch is unavailable',
};
// The page's source sentence. The page appends its blocked note itself.
function sourceSentence(r) {
  if (!r.util) return 'No cached /usage data found.';
  return (
    'Percentages are the server-side plan limits. ' +
    (SOURCE_TEXT[r.util.source] || 'Cached') +
    ', ' +
    ageLabel(r.util.ageMs) +
    '.'
  );
}
// Why the poll is blocked, in words. The page's blocked note points at the hover.
function blockedWhy(b) {
  if (b.status === 429) return 'rate limited by the API';
  if (b.status === 401 || b.status === 403) return 'token rejected — run any Claude Code session to refresh it';
  if (b.reason === 'no-token') return 'OAuth token expired';
  return `fetch failed (${b.reason || b.status})`;
}
// Session and weekly meters: percent and sub-line, for the page and the hover alike.
function meterData(r, c) {
  const u = r.util;
  const hours = r.rollingHours || c.sessionHours;
  return {
    sessionPct:
      u && u.session ? u.session.pct : c.sessionBudget > 0 ? Math.round((r.rollingTotal / c.sessionBudget) * 100) : null,
    sessionSub:
      u && u.session && u.session.resetsAt
        ? `resets in ${durationTo(u.session.resetsAt)} · ${fmt(r.rollingTotal)} tokens measured in ${hours}h`
        : `no cached /usage data · ${fmt(r.rollingTotal)} tokens measured in ${hours}h`,
    weekPct: u && u.week ? u.week.pct : c.weekBudget > 0 ? Math.round((r.weekTotal / c.weekBudget) * 100) : null,
    weekSub:
      u && u.week && u.week.resetsAt
        ? `resets in ${durationTo(u.week.resetsAt)} · ${fmt(r.weekTotal)} tokens measured in ${c.windowDays}d`
        : `no cached /usage data · ${fmt(r.weekTotal)} tokens measured in ${c.windowDays}d`,
  };
}
// One burn row's facts. The page table and the hover both read these.
function burnFacts(x) {
  const hasBoth = x.msToFull !== null && x.msToReset !== null && x.verdict !== 'measuring';
  const exact = (ms) => (ms === null || ms === undefined ? '—' : spanText(ms));
  const verdictTone = x.verdict === 'exhaust' ? 'bad' : x.verdict === 'tight' ? 'warn' : 'ok';
  // A dash carries no tone: green, amber or red only colour a real value.
  const note =
    x.verdict === 'measuring'
      ? x.reason || 'measuring'
      : x.verdict === 'idle'
        ? 'idle'
        : x.verdict === 'exhaust'
          ? 'hits the cap before reset'
          : x.verdict === 'tight'
            ? 'lands close to the reset'
            : x.verdict === 'slow'
              ? 'below resolution — estimate'
              : 'reset wins';
  return {
    rate: x.pctPerHour === null ? '—' : `${x.pctPerHour.toFixed(1)} %/h`,
    tone: hasBoth ? verdictTone : '',
    // One signed net value: time to full minus time to reset.
    time: hasBoth ? signedSpan(x.msToFull - x.msToReset) : '—',
    fullText: exact(x.msToFull),
    resetText: exact(x.msToReset),
    note,
  };
}

function burnSectionHtml(r) {
  const b = r.util && r.util.burn;
  if (!b) return '';
  const weekStamp = resetStamp(r.util.week && r.util.week.resetsAt);
  const sessionStamp = clockStamp(r.util.session && r.util.session.resetsAt);
  const row = (label, x, stamp) => {
    if (!x) return '';
    // Each row shows when its window resets, after its label, in the same markup.
    const windowCell = stamp ? `${esc(label)} <span class="dim small">${esc(stamp)}</span>` : esc(label);
    const f = burnFacts(x);
    // The two inputs of the Time value go in its title.
    const inputs = `Full in ${f.fullText} · resets in ${f.resetText}`;
    return `<tr><td class="k">${windowCell}</td><td class="n">${f.rate}</td><td class="n time${f.tone ? ' ' + f.tone : ''}" title="${esc(inputs)}">${esc(f.time)}</td><td class="verdict">${trafficLightHtml(x.verdict, f.note)}</td></tr>`;
  };
  return `<h2>Burn rate</h2>
<table><tr><th>Window</th><th class="n">Rate</th><th class="n">Time</th><th>Verdict</th></tr>
${row('Session', b.five, sessionStamp)}${row('Weekly', b.seven, weekStamp)}</table>
<details class="note"><summary>How the rate is estimated</summary>
<p>Rate is a least-squares fit over recent polls, not the last two readings — burn is
bursty and the percentages are integers. Samples are confined to the current window, so a reset
never enters the fit. ⚠ The 5h window appears to be <em>rolling</em>, meaning old usage ages out
continuously; if so these projections are pessimistic, because they assume nothing ages out while
you keep working. The weekly row assumes at least 9 hours of idle time every day: the rate is
measured per active hour and the time to full is stretched by 24/15, so it does not pretend you
work around the clock. Time is the time to full minus the time to reset; a negative value means
you reach the cap before the reset.</p></details>`;
}

function detailsHtml(r, c, extVersion) {
  const m = meterData(r, c);
  const days = Object.keys(r.byDay).sort();
  const maxDay = Math.max(
    1,
    ...days.map((d) => {
      const a = r.byDay[d];
      return a.input + a.output + a.cacheWrite + a.cacheRead;
    })
  );
  const rows = days
    .map((d) => {
      const a = r.byDay[d];
      const t = a.input + a.output + a.cacheWrite + a.cacheRead;
      const pct = Math.round((t / maxDay) * 100);
      return `<tr><td class="k">${esc(d)}</td><td class="bar"><span style="width:${pct}%"></span></td>
        <td class="n">${fmt(t)}</td><td class="n dim">${fmt(a.output)}</td><td class="n dim">${a.count}</td></tr>`;
    })
    .join('');

  const projects = Object.entries(r.byProject)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const maxProj = Math.max(1, ...projects.map((p) => p[1]));
  const projRows = projects
    .map(
      ([name, t]) =>
        `<tr><td class="k" title="${esc(name)}">${esc(name.split('/').pop() || name)}</td>
         <td class="bar"><span style="width:${Math.round((t / maxProj) * 100)}%"></span></td>
         <td class="n">${fmt(t)}</td></tr>`
    )
    .join('');

  return `<!doctype html><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 12px 16px; }
  h2 { font-size: 1.05em; margin: 18px 0 8px; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  td, th { padding: 4px 8px; }
  th { text-align: left; font-weight: 600; opacity: .7; border-bottom: 1px solid var(--vscode-panel-border); }
  .k { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dim { opacity: .6; }
  .bar { width: 100%; }
  .bar span { display: block; height: 8px; border-radius: 4px;
              background: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .meters { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
  .meter { flex: 1 1 300px; max-width: 460px; }
  .mhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; font-weight: 600; }
  .pct { font-size: 1.35em; font-variant-numeric: tabular-nums; }
  .pct.ok { color: var(--vscode-charts-green, #3fb950); }
  .pct.warn { color: var(--vscode-charts-yellow, #d29922); }
  .pct.bad { color: var(--vscode-charts-red, #f85149); }
  .track { height: 12px; border-radius: 6px; overflow: hidden;
           background: var(--vscode-editorWidget-background, rgba(127,127,127,.25));
           border: 1px solid var(--vscode-panel-border); }
  .track span { display: block; height: 100%; background: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .track.ok span { background: var(--vscode-charts-green, #3fb950); }
  .track.warn span { background: var(--vscode-charts-yellow, #d29922); }
  .track.bad span { background: var(--vscode-charts-red, #f85149); }
  .small { font-size: .85em; margin-top: 5px; }
  .track.seg-track { display: flex; }
  .track.seg-track span { flex: 0 0 auto; height: 100%; box-shadow: inset -1px 0 0 rgba(0,0,0,.6); }
  .track.seg-track span.cur { box-shadow: inset 0 0 0 1px rgba(255,255,255,.8), inset -1px 0 0 rgba(0,0,0,.6); }
  details.sessions { margin-top: 6px; font-size: .9em; }
  details.sessions > summary { cursor: pointer; white-space: nowrap; }
  details.sessions table { margin-top: 4px; width: auto; min-width: 60%; }
  details.sessions td { padding: 2px 6px 2px 0; }
  details.sessions .sw { width: 16px; }
  details.sessions p { margin: 6px 0 0; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; }
  .time.ok { color: var(--vscode-charts-green, #3fb950); }
  .time.warn { color: var(--vscode-charts-yellow, #d29922); }
  .time.bad { color: var(--vscode-charts-red, #f85149); }
  .verdict { white-space: nowrap; }
  .light { display: inline-flex; align-items: center; gap: 4px; vertical-align: middle;
           padding: 3px 5px; margin-right: 6px; border-radius: 10px; background: #1b1d21;
           border: 1px solid #000; }
  .lamp { width: 9px; height: 9px; border-radius: 50%; display: inline-block; opacity: .18; }
  .lamp.g { background: var(--vscode-charts-green, #3fb950); }
  .lamp.y { background: var(--vscode-charts-yellow, #d29922); }
  .lamp.r { background: var(--vscode-charts-red, #f85149); }
  .lamp.on { opacity: 1; }
  .lamp.g.on { box-shadow: 0 0 6px 1px var(--vscode-charts-green, #3fb950); }
  .lamp.y.on { box-shadow: 0 0 6px 1px var(--vscode-charts-yellow, #d29922); }
  .lamp.r.on { box-shadow: 0 0 6px 1px var(--vscode-charts-red, #f85149); }
  details.note > summary { cursor: pointer; white-space: nowrap; font-size: .9em; list-style-position: inside; }
  details.note > p { margin: 6px 0 0; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { box-sizing: border-box; width: 89px; min-width: 0; flex: 0 0 auto;
          border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 8px; }
  .card .v { font-size: 1.3em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: clip; }
  .card .l { opacity: .65; font-size: .8em; white-space: nowrap; overflow: hidden; text-overflow: clip; }
  .note { opacity: .6; font-size: .85em; margin-top: 18px; max-width: 720px; line-height: 1.5; }
</style>
<div class="meters">
  ${meterHtml('Session limit', m.sessionPct, m.sessionSub)}
  ${weekMeterHtml('Weekly limit', m.weekPct, m.weekSub, r.util ? r.util.weekSessions : null)}
</div>
<p class="dim small">${esc(sourceSentence(r))}${r.util && r.util.blocked ? ' ⚠ Refresh is currently blocked — see the status bar tooltip.' : ''}</p>
${burnSectionHtml(r)}
<div class="cards">
  <div class="card"><div class="v">${fmt(r.sessionTotal)}</div><div class="l">this chat</div></div>
  <div class="card"><div class="v">${fmt(r.weekTotal)}</div><div class="l">${c.windowDays}d tokens</div></div>
  <div class="card"><div class="v">${fmt(r.week.output)}</div><div class="l">${c.windowDays}d output</div></div>
  <div class="card"><div class="v">${fmt(r.ctx)}</div><div class="l">live context</div></div>
</div>
<h2>Per day</h2>
<table><tr><th>day</th><th></th><th class="n">tokens</th><th class="n">output</th><th class="n">reqs</th></tr>${rows}</table>
<h2>Per project</h2>
<table>${projRows}</table>
<p class="note">Percentages are the server-side plan limits, polled by this extension from
<code>GET /api/oauth/usage</code> every ${c.pollSeconds}s using the OAuth token in
<code>~/.claude/.credentials.json</code>, and shared between VS Code windows so the request is made
once per machine. If that fetch is unavailable it falls back to Claude Code's own cached copy in
<code>~/.claude.json</code>, which only moves while a session is running. Token counts are separate:
aggregated from the transcripts under <code>~/.claude/projects</code>, all-in (input + cache write +
cache read + output), so cache reads dominate. The two do not track each other linearly.</p>
<p class="note">Host v${esc(extVersion)} · renderer v${esc(RENDERER_VERSION)}. A window keeps the
extension.js it started with; the panel and status bar renderer is reloaded on every refresh.</p>`;
}

// THE ONE ALLOWED SIDE EFFECT in this module. Writes a small beacon file per
// extension host, so the renderer version can be checked from OUTSIDE the window
// (verify-live.js, deploy-live.js). Best-effort: every error is swallowed, nothing
// waits on it, and it skips the write when this same renderer version wrote less
// than 10 s ago. Beacons older than 3 days are removed opportunistically.
const BEACON_PREFIX = 'usage-render-beacon-';
const BEACON_MIN_GAP_MS = 10 * 1000;
const BEACON_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// Session count for the beacon: null when weekSessions is absent, else its session list length (0 when empty).
function weekSessionCount(ws) {
  try {
    if (!ws || typeof ws !== 'object') return null;
    return Array.isArray(ws.sessions) ? ws.sessions.length : 0;
  } catch {
    return null;
  }
}

function writeBeacon(weekSessions) {
  try {
    const dir = path.join(os.homedir(), '.claude');
    const file = path.join(dir, BEACON_PREFIX + process.pid + '.json');
    const now = Date.now();
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && prev.rendererVersion === RENDERER_VERSION && now - prev.at < BEACON_MIN_GAP_MS) return;
    } catch {
      /* no previous beacon for this host */
    }
    const weekCount = weekSessionCount(weekSessions);
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, rendererVersion: RENDERER_VERSION, at: now, weekSessions: weekCount })
    );
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(BEACON_PREFIX)) continue;
      const old = path.join(dir, name);
      try {
        if (now - fs.statSync(old).mtimeMs > BEACON_MAX_AGE_MS) fs.unlinkSync(old);
      } catch {
        /* another window may be removing it */
      }
    }
  } catch {
    /* best-effort only: a render must never fail because of the beacon */
  }
}

// Status-bar text, plus the worst percentage so the caller can pick a colour.
// Returns data, not a vscode object, so this file stays free of the API.
function statusBar(r, c) {
  writeBeacon(r && r.util ? r.util.weekSessions : null);
  const u = r.util;
  // Three missed polls in a row means the fetch is failing, not merely idle.
  const staleAfterMs = Math.max(5 * 60 * 1000, c.pollSeconds * 3 * 1000);
  const stale = u && u.ageMs !== null && u.ageMs > staleAfterMs;

  const s = segment(`5h`, u && u.session ? u.session.pct : null, r.rollingTotal, c.sessionBudget, c);
  const w = segment(`7d`, u && u.week ? u.week.pct : null, r.weekTotal, c.weekBudget, c);
  // "~" = the numbers are older than they should be. "!" = we know why, and it
  // is not going to fix itself on the next tick.
  const mark = u && u.blocked ? '!' : stale ? '~' : '';

  return {
    text: `$(pulse) ${s.text} · ${w.text}${mark ? ' ' + mark : ''}`,
    worst: Math.max(s.pct === null ? -1 : s.pct, w.pct === null ? -1 : w.pct),
    stale,
  };
}

// ---- Hover tooltip -----------------------------------------------------------
// Markdown text for the status-bar MarkdownString (supportThemeIcons on, no HTML).
// Same sections, same order and the same helpers as detailsHtml(), cut just before
// 'Per day'. Nothing below the cut is in the hover.
const BAR_CELLS = 20; // one cell = 5 points of the weekly limit
const SEG_EMOJI = ['🟦', '🟧', '🟪', '🟩', '🟨']; // the first five SEG_PALETTE colours, in order
const BASELINE_EMOJI = '⬜'; // usage before tracking started (grey on the page)
const LAMP_MD = { g: '🟢', y: '🟡', r: '🔴', off: '⚪' };
const pctText = (p) => (p === null || p === undefined ? 'n/a' : `${p}%`);

// Horizontal traffic light, green-yellow-red, one lamp lit. None lit while measuring.
function trafficLightMd(verdict) {
  const lit = verdict === 'exhaust' ? 'r' : verdict === 'tight' ? 'y' : verdict === 'measuring' ? '' : 'g';
  return ['g', 'y', 'r'].map((k) => (lit === k ? LAMP_MD[k] : LAMP_MD.off)).join('');
}

// Weekly bar: one coloured square per session (grey for baseline), then empty cells.
// Largest-remainder split, so the filled cells always add up to the rounded total.
function weekBarMd(data) {
  const segs = data.segs.map((g) => ({
    pts: g.width,
    emoji: g.index < 0 ? BASELINE_EMOJI : SEG_EMOJI[g.index % SEG_EMOJI.length],
  }));
  const total = segs.reduce((a, g) => a + g.pts, 0);
  const cells = Math.min(BAR_CELLS, Math.round(total / 5));
  if (!cells) return '▱'.repeat(BAR_CELLS);
  const exact = segs.map((g) => (g.pts / total) * cells);
  const counts = exact.map((x) => Math.floor(x));
  const left = cells - counts.reduce((a, b) => a + b, 0);
  exact
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, left)
    .forEach(([, i]) => counts[i]++);
  return segs.map((g, i) => g.emoji.repeat(counts[i])).join('') + '▱'.repeat(BAR_CELLS - cells);
}

// Per-session share list, in the page's order. Shares are whole points of the weekly limit.
function weekListMd(data) {
  const rows = [];
  if (data.baseline > 0) rows.push(`- ${BASELINE_EMOJI} Before tracking · +${data.baseline}%`);
  for (const s of data.sessions) {
    const span = sessionSpan(s.expires) || 'Session';
    rows.push(`- ${SEG_EMOJI[s.index % SEG_EMOJI.length]} ${span}${s.current ? ' · running' : ''} · +${s.points}%`);
  }
  return rows.join('\n');
}

// The tooltip body. The caller wraps it in a MarkdownString. `stale` is accepted for
// the caller's signature only: the page shows no stale flag, so the hover shows none.
function tooltip(r, c, stale) {
  const u = r.util;
  const m = meterData(r, c);
  const wsData = weekSegments(u ? u.weekSessions : null);
  const blocks = [];

  // 0. Notices first, in the wording the 0.0.26 tooltip used: blocked, then stale.
  if (u && u.blocked) {
    const retry = durationTo(new Date(u.blocked.retryAtMs).toISOString()) || 'a moment';
    blocks.push(`⚠ ${blockedWhy(u.blocked)}; ${u.blocked.consecutive} failed in a row, next try in ${retry}`);
  }
  if (stale && u && Number.isFinite(u.ageMs)) {
    blocks.push(`numbers are ${Math.round(u.ageMs / 60000)} minutes old`);
  }

  // 1. Session limit (the page's first meter)
  blocks.push(`**Session limit** — ${pctText(m.sessionPct)}`);
  if (m.sessionPct !== null && m.sessionPct !== undefined) blocks.push(thinGauge(m.sessionPct, BAR_CELLS));
  blocks.push(m.sessionSub);

  // 2. Weekly limit (the page's second meter, split by session when there is data)
  blocks.push(`**Weekly limit** — ${pctText(m.weekPct)}`);
  if (wsData) {
    blocks.push(weekBarMd(wsData));
    blocks.push(m.weekSub);
    blocks.push(`Sessions this week (${wsData.sessions.length}):\n\n${weekListMd(wsData)}`);
    blocks.push(
      'Shares are approximate, within ±1 point, because the weekly percentage is a whole number. Sessions are only tracked while VS Code is open.'
    );
  } else {
    if (m.weekPct !== null && m.weekPct !== undefined) blocks.push(thinGauge(m.weekPct, BAR_CELLS));
    blocks.push(m.weekSub);
  }

  // 3. Source line under the meters (its blocked notice is already at the top)
  blocks.push(sourceSentence(r));

  // 4. Burn rate: the verdict table, each row's inputs (the page shows them in the Time
  //    cell's title), then the estimate note.
  if (u && u.burn) {
    const stamps = {
      Session: clockStamp(u.session && u.session.resetsAt),
      Weekly: resetStamp(u.week && u.week.resetsAt),
    };
    const rows = [];
    const inputs = [];
    for (const [label, x] of [
      ['Session', u.burn.five],
      ['Weekly', u.burn.seven],
    ]) {
      if (!x) continue;
      const f = burnFacts(x);
      const stamp = stamps[label];
      rows.push(`| ${label}${stamp ? ' ' + stamp : ''} | ${f.rate} | ${f.time} | ${trafficLightMd(x.verdict)} ${f.note} |`);
      inputs.push(`- ${label}: full in **${f.fullText}** · resets in ${f.resetText}`);
    }
    blocks.push(`**Burn rate**\n\n| Window | Rate | Time | Verdict |\n|---|--:|--:|---|\n${rows.join('\n')}`);
    blocks.push(inputs.join('\n'));
    blocks.push(
      '_How the rate is estimated:_ rate is a least-squares fit over recent polls, not the last two readings, because burn is bursty and the percentages are integers. Samples are confined to the current window, so a reset never enters the fit. ⚠ The 5h window appears to be _rolling_, meaning old usage ages out continuously; if so these projections are pessimistic, because they assume nothing ages out while you keep working. The weekly row assumes at least 9 hours of idle time every day: the rate is measured per active hour and the time to full is stretched by 24/15, so it does not pretend you work around the clock. Time is the time to full minus the time to reset; a negative value means you reach the cap before the reset.'
    );
  }

  // 5. Stat cards. The 7d token count is already the weekly meter's sub-line, so it is
  //    not repeated here.
  blocks.push(
    `**this chat** ${fmt(r.sessionTotal)} · **${c.windowDays}d output** ${fmt(r.week.output)} · **live context** ${fmt(r.ctx)}`
  );
  return blocks.join('\n\n') + '\n';
}

module.exports = {
  detailsHtml,
  statusBar,
  segment,
  thinGauge,
  tooltip,
  burnLine,
  burnSectionHtml,
  trafficLightHtml,
  shortDuration,
  signedSpan,
  spanText,
  resetStamp,
  clockStamp,
  sessionSpan,
  weekSegments,
  weekMeterHtml,
  fmt,
  esc,
  writeBeacon,
  RENDERER_VERSION,
};
