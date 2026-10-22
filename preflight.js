// Build gate. Run before every `vsce package` — each check exists because the
// corresponding mistake was actually shipped to the owner.
//
// ⚠ Edit this file directly, never by generating it through a shell. The
// entity check below was first written via `node -e` inside bash and its
// escaping collapsed, leaving an unparseable regex; preflight then crashed and
// the broken build packaged anyway.
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const fail = (msg) => {
  console.error('PREFLIGHT FAIL - ' + msg);
  process.exit(1);
};

// 1. The worker must not call something the BUNDLED core lacks.
//    0.0.7-0.0.9 shipped broken: the core was edited in ~/.claude while the
//    package was built from this directory, so the worker called
//    getUtilizationWithBurn and the bundled core had never heard of it. Every
//    check at the time resolved ~/.claude, so all four of them passed.
const core = require(path.join(__dirname, 'usage-core.cjs'));
const workerSrc = read('usage-worker.js');
const required = [
  ...workerSrc.matchAll(/\b(?:const|let)\s*\{([^}]+)\}\s*=\s*require\([^)]*usage-core/g),
]
  .flatMap((m) => m[1].split(',').map((s) => s.trim().split(':')[0].trim()))
  .filter(Boolean);
const missing = required.filter((n) => typeof core[n] !== 'function');
console.log('worker requires from core:', required.join(', ') || '(none found)');
if (missing.length) fail('core does not export: ' + missing.join(', '));

// 2. The panel renderer is re-required at runtime, so a broken export shows up
//    only when the user opens the panel.
const panelSrc = read('panel-render.js');
const R = require(path.join(__dirname, 'panel-render.js'));
const needed = ['detailsHtml', 'statusBar', 'tooltip'];
const absent = needed.filter((n) => typeof R[n] !== 'function');
if (absent.length) fail('panel-render.js does not export: ' + absent.join(', '));

// 3. That module must stay free of the vscode API, or re-requiring it breaks.
if (/require\(\s*['"]vscode['"]\s*\)/.test(panelSrc)) {
  fail('panel-render.js must not require vscode');
}

// 4. An HTML entity inside a string that later passes through esc() renders as
//    literal text, because esc() escapes the '&'. 0.0.9 showed the owner
//    "From this machine&rsquo;s shared poll cache". Catch the class.
const entityInString = [];
for (const line of panelSrc.split('\n')) {
  // esc() itself legitimately contains '&amp;', '&lt;', '&gt;' — it is the
  // thing doing the escaping, so its own table is not a finding.
  if (line.includes("'&': '&amp;'")) continue;
  for (const m of line.matchAll(/'[^'\n]*'/g)) {
    if (/&(?:[a-zA-Z]+|#\d+);/.test(m[0])) entityInString.push(m[0].trim());
  }
}
if (entityInString.length) {
  fail('HTML entity inside an esc()-bound string: ' + entityInString.join(' | '));
}

// 5. The renderer must actually produce a panel, with the sections in order.
//    A template-literal slip can leave a section silently empty.
const cfg = {
  pollSeconds: 120,
  windowDays: 7,
  sessionHours: 5,
  sessionBudget: 0,
  weekBudget: 0,
  showBars: true,
  barWidth: 5,
};
const now = Math.round(Date.now() / 1000);
const burn = (v) => ({ verdict: v, pctPerHour: 9, msToFull: 36e5, msToReset: 72e5, windowMinutes: 45, samples: 9 });
const sample = {
  util: {
    source: 'live',
    ageMs: 60000,
    session: { pct: 50 },
    week: { pct: 10 },
    limits: [],
    burn: { five: burn('safe'), seven: burn('slow') },
  },
  rollingTotal: 1, weekTotal: 1, sessionTotal: 1,
  week: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1, count: 1 },
  session: { output: 1, count: 1 },
  rolling: { output: 1, count: 1 },
  rollingHours: 5, ctx: 1, byDay: {}, byProject: {}, scanned: 1, total: 1,
};
const html = R.detailsHtml(sample, cfg, '0.0.0');
const order = [...html.matchAll(/<h2>([^<]+)<\/h2>|class="(meters|cards)"/g)].map((m) => m[1] || m[2]);
const iBurn = order.indexOf('Burn rate');
const iCards = order.indexOf('cards');
if (iBurn === -1) fail('panel has no Burn rate section');
// The owner asked for this placement explicitly on 2026-10-12.
if (!(iBurn < iCards)) fail('Burn rate must sit above the stat cards; order was ' + order.join(' -> '));
const opens = (html.match(/<(table|tr|td|th|svg|div|p|details|summary|span)\b/g) || []).length;
const closes = (html.match(/<\/(table|tr|td|th|svg|div|p|details|summary|span)>/g) || []).length;
if (opens !== closes) fail(`unbalanced block tags in the panel: ${opens} open, ${closes} close`);

// 6. Burn-rate design guards: the sparkline is gone, the Time column exists,
//    the verdict is a traffic light, and the estimate note is a closed <details>.
if (/class="spark"/.test(html)) fail('the burn-rate sparkline is back (class="spark" rendered)');
if (!/<th[^>]*>Time<\/th>/.test(html)) fail('burn table has no "Time" column header');
if (!/<details\b/.test(html)) fail('the rate-estimate note is not a <details> element');
if (/<details\b[^>]*\sopen\b/.test(html)) fail('the rate-estimate <details> must be closed by default');
if (!/class="light"[^>]*role="img"[^>]*aria-label=/.test(html)) fail('verdict traffic light lacks role="img" / aria-label');

// Lamp check: for each verdict, exactly one lamp in the Session row is lit, and
// it is the right colour. measuring lights none.
const sessionRow = (h) => {
  const m = h.match(/<tr><td class="k">Session[\s\S]*?<\/tr>/);
  return m ? m[0] : '';
};
const withFive = (v) => ({ ...sample, util: { ...sample.util, burn: { five: burn(v), seven: burn('slow') } } });
const expectLit = { safe: 'g', tight: 'y', exhaust: 'r', measuring: '' };
const lampReport = [];
for (const [verdict, want] of Object.entries(expectLit)) {
  const row = sessionRow(R.detailsHtml(withFive(verdict), cfg, '0.0.0'));
  const lamps = [...row.matchAll(/class="lamp ([gyr])( on)?"/g)];
  if (lamps.length !== 3) fail(`verdict ${verdict}: expected 3 lamps in the Session row, found ${lamps.length}`);
  const lit = lamps.filter((m) => m[2]).map((m) => m[1]).join('');
  if (lit !== want) fail(`verdict ${verdict} lights "${lit || 'none'}", expected "${want || 'none'}"`);
  lampReport.push(`${verdict}->${lit || 'none'}`);
}
console.log('traffic lights:', lampReport.join(', '));

// 7. Weekly projection assumes 9 idle hours a day (owner, 2026-10-21). Checked
//    against the BUNDLED core on REAL-SHAPE history: pushSample is called every
//    2 minutes on integer-rounded readings of a continuous burn (five-hour 5 %/h,
//    weekly 0.5 %/h, 10 hours of work, ending at 11%). Expected msToFull is
//    (100 - 11) / 0.5 / 0.625 hours, about 284.8 h. Bound: 25%.
const wNowMs = Date.now();
const wNowS = Math.round(wNowMs / 1000);
const wResetIso = new Date((wNowS + 400 * 3600) * 1000).toISOString();
const wFiveIso = new Date((wNowS + 3 * 3600) * 1000).toISOString();
let wHist = [];
let wFive = 5;
let wWeek = 6;
let wT = wNowMs - 10 * 3600e3;
const wRawAt = () => ({
  five_hour: { utilization: Math.round(wFive), resets_at: wFiveIso },
  seven_day: { utilization: Math.round(wWeek), resets_at: wResetIso },
});
wHist = core.pushSample(wHist, wRawAt(), wT);
for (let k = 0; k < 300; k++) {
  wT += 120e3;
  wFive += 5 * (120 / 3600);
  wWeek += 0.5 * (120 / 3600);
  wHist = core.pushSample(wHist, wRawAt(), wT);
}
const wRaw = wRawAt();
const wBurn = core.burnRate({ history: wHist, raw: wRaw, key: 'seven', now: wNowMs });
const wExpectedMs = ((100 - wRaw.seven_day.utilization) / 0.5 / 0.625) * 3600e3;
if (wBurn.basis !== 'active') fail(`weekly burnRate basis is ${wBurn.basis}, expected 'active'`);
if (wBurn.activeFraction !== 0.625) fail(`weekly activeFraction is ${wBurn.activeFraction}, expected 0.625`);
if (!(wBurn.pctPerHour !== null && Math.abs(wBurn.pctPerHour - 0.5) / 0.5 <= 0.25)) {
  fail(`weekly pctPerHour ${wBurn.pctPerHour} is not within 25% of 0.5`);
}
if (!(wBurn.msToFull !== null && Math.abs(wBurn.msToFull - wExpectedMs) / wExpectedMs <= 0.25)) {
  fail(`weekly msToFull ${wBurn.msToFull} is not within 25% of ${wExpectedMs}`);
}
const fBurn = core.burnRate({ history: wHist, raw: wRaw, key: 'five', now: wNowMs });
if (fBurn.basis !== 'clock' || fBurn.activeFraction !== null) fail('five-hour burnRate must be basis clock, activeFraction null');
console.log(`weekly projection: ${wBurn.pctPerHour.toFixed(3)} %/h, msToFull ${(wBurn.msToFull / 3600e3).toFixed(1)} h, expected ${(wExpectedMs / 3600e3).toFixed(1)} h`);

// 8. The renderer reports its own version (footer and beacon). It must equal
//    package.json's version so it cannot drift, and statusBar must call the beacon.
const pkgVersion = JSON.parse(read('package.json')).version;
if (R.RENDERER_VERSION !== pkgVersion) {
  fail(`RENDERER_VERSION ${R.RENDERER_VERSION} does not equal package.json version ${pkgVersion}`);
}
if (typeof R.writeBeacon !== 'function') fail('panel-render.js does not export writeBeacon');
if (!/function statusBar\([^)]*\)\s*\{\s*writeBeacon\([^;]*\);/.test(panelSrc)) fail('statusBar must call writeBeacon(...) first');
if (!html.includes('renderer v' + R.RENDERER_VERSION)) fail('panel footer does not show renderer v' + R.RENDERER_VERSION);
console.log(`renderer version: ${R.RENDERER_VERSION} (matches package.json)`);

// 8b. Status-bar text layout: number first, then a thin 5-cell gauge (▰ filled, ▱ empty).
//     Checked through the pure segment() and thinGauge() helpers, so no beacon is written.
const barCfg = { showBars: true, barWidth: 5 };
const segChecks = [
  [R.thinGauge(0), '▱▱▱▱▱'],
  [R.thinGauge(100), '▰▰▰▰▰'],
  [R.thinGauge(42), '▰▰▱▱▱'],
  [R.thinGauge(59), '▰▰▰▱▱'],
  [R.segment('5h', 42, 0, 0, barCfg).text, '5h 42% ▰▰▱▱▱'],
  [R.segment('7d', 59, 0, 0, barCfg).text, '7d 59% ▰▰▰▱▱'],
  [R.segment('5h', 42, 0, 0, { showBars: false, barWidth: 5 }).text, '5h 42%'],
  [R.segment('5h', 42, 0, 0, { showBars: false }).text, '5h 42%'],
  [R.segment('5h', null, 5000, 0, barCfg).text, '5h:5k'],
];
for (const [got, want] of segChecks) {
  if (got !== want) fail(`status-bar text is "${got}", expected "${want}"`);
}
for (const p of [0, 7, 33, 42, 59, 99, 100, -5, 250]) {
  if ([...R.thinGauge(p, 5)].length !== 5) fail(`thinGauge(${p}) is not exactly 5 cells`);
}
if ([...R.thinGauge(42, 8)].length !== 8) fail('thinGauge(42, 8) is not exactly 8 cells');
console.log(`status-bar text: ${segChecks.slice(4, 6).map((x) => x[0]).join(' | ')}; showBars false has no gauge`);

// 9. Burn-rate table: header text, bare Rate and Verdict cells, the signed Time cell
//    and its title, and the signedSpan unit cases.
const burnTable = (h) => {
  const m = h.match(/<h2>Burn rate<\/h2>\s*<table><tr>([\s\S]*?)<\/tr>/);
  return m ? m[1] : '';
};
const headers = [...burnTable(html).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]).join(' | ');
if (headers !== 'Window | Rate | Time | Verdict') fail(`burn table header is "${headers}", expected "Window | Rate | Time | Verdict"`);
if (html.includes('active</span>')) fail('the word "active" is printed in the burn table Rate cell');
const verdictCells = [...html.matchAll(/<td class="verdict">([\s\S]*?)<\/td>/g)].map((x) => x[1]);
const bareLight = /^<span class="light" role="img" title="[^"]+" aria-label="[^"]*">(?:<span class="lamp [gyr][^"]*"><\/span>){3}<\/span>$/;
if (verdictCells.length !== 2 || !verdictCells.every((c) => bareLight.test(c))) {
  fail('a Verdict cell holds text beside the traffic light, or the light lacks its title/aria-label');
}
const timeOf = (h) => {
  const m = h.match(/<tr><td class="k">Session[\s\S]*?<\/tr>/);
  const t = m ? m[0].match(/<td class="n time([^"]*)" title="([^"]*)">([^<]*)<\/td>/) : null;
  return t ? { cls: t[1], title: t[2], text: t[3] } : null;
};
const timeFixture = (fields) =>
  R.detailsHtml({ ...sample, util: { ...sample.util, burn: { five: { ...burn('safe'), ...fields }, seven: burn('slow') } } }, cfg, '0.0.0');
const H_ = 3600e3;
// wantClass: a class that must be present, or null for "no tone class at all".
const fixtures = [
  ['(a) -2d', { msToFull: 72 * H_, msToReset: 120 * H_, verdict: 'exhaust' }, '-2d', 'bad', 'Full in 3d · resets in 5d'],
  ['(b) +10h', { msToFull: 130 * H_, msToReset: 120 * H_, verdict: 'safe' }, '+10h', 'ok', 'Full in 5d 10h · resets in 5d'],
  ['(c) -12m', { msToFull: 119.8 * H_, msToReset: 120 * H_, verdict: 'tight' }, '-12m', 'warn', 'Full in 4d 23h · resets in 5d'],
  ['(d) idle, no full', { msToFull: null, msToReset: 120 * H_, verdict: 'idle' }, '—', null, 'Full in — · resets in 5d'],
];
for (const [label, fields, wantText, wantClass, wantTitle] of fixtures) {
  const t = timeOf(timeFixture(fields));
  if (!t) fail(`Time cell not found for fixture ${label}`);
  if (t.text !== wantText) fail(`Time cell for ${label} is "${t.text}", expected "${wantText}"`);
  if (wantClass === null) {
    if (t.cls.trim() !== '') fail(`Time cell for ${label} carries tone class "${t.cls.trim()}"; a dash must have none`);
  } else if (!t.cls.split(' ').includes(wantClass)) {
    fail(`Time cell for ${label} has class "${t.cls}", expected ${wantClass}`);
  }
  if (t.title !== wantTitle) fail(`Time cell title for ${label} is "${t.title}", expected "${wantTitle}"`);
}
// The traffic light still shows green for idle, even though the dash is uncoloured.
const idleHtml = timeFixture({ msToFull: null, msToReset: 120 * H_, verdict: 'idle' });
if (!/<span class="lamp g on"><\/span>/.test(idleHtml)) fail('idle must still light the green lamp');
const unitCases = [
  [R.signedSpan(48 * H_), '+2d'],
  [R.signedSpan(-48 * H_), '-2d'],
  [R.signedSpan(-(52 * H_)), '-2d 4h'],
  [R.signedSpan(90 * 60e3), '+1h 30m'],
  [R.signedSpan(-(12 * 60e3)), '-12m'],
  [R.signedSpan(0), '+0m'],
  [R.spanText(130 * H_), '5d 10h'],
  [R.spanText(119.8 * H_), '4d 23h'],
  [R.spanText(48 * H_), '2d'],
  [R.spanText(90 * 60e3), '1h 30m'],
  [R.spanText(12 * 60e3), '12m'],
];
for (const [got, want] of unitCases) {
  if (got !== want) fail(`signedSpan returned "${got}", expected "${want}"`);
}
console.log('burn table: header ok, Time fixtures ok, signedSpan ' + unitCases.map((u) => u[0]).join(' '));

// 10. Weekly reset stamp next to the Weekly label. Dates are built from LOCAL
//     components and then serialised, so these cases hold in any time zone.
const stampCases = [
  [new Date(2026, 9, 26, 18, 0, 0), 'Mon - 18:00'],
  [new Date(2026, 9, 26, 17, 59, 59, 960), 'Mon - 18:00'],
  [new Date(2026, 9, 27, 0, 0, 0), 'Tue - 00:00'],
  [new Date(2026, 9, 25, 9, 5, 0), 'Sun - 09:05'],
];
for (const [d, want] of stampCases) {
  const got = R.resetStamp(d.toISOString());
  if (got !== want) fail(`resetStamp(${d.toISOString()}) is "${got}", expected "${want}"`);
}
for (const bad of [undefined, '', 'garbage']) {
  if (R.resetStamp(bad) !== '') fail(`resetStamp(${String(bad)}) must be an empty string`);
}
const cellText = (h, pattern) => {
  const m = h.match(pattern);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
};
const weekFixture = (week) =>
  R.detailsHtml({ ...sample, util: { ...sample.util, week: { pct: 10, ...week } } }, cfg, '0.0.0');
const stamped = weekFixture({ resetsAt: new Date(2026, 9, 26, 17, 59, 59, 960).toISOString() });
const weeklyWindow = cellText(stamped, /<tr><td class="k">(Weekly[\s\S]*?)<\/td>/);
const sessionWindow = cellText(stamped, /<tr><td class="k">(Session[\s\S]*?)<\/td>/);
if (weeklyWindow !== 'Weekly Mon - 18:00') fail(`weekly Window cell is "${weeklyWindow}", expected "Weekly Mon - 18:00"`);
if (sessionWindow !== 'Session') fail(`session Window cell is "${sessionWindow}", expected "Session"`);
const unstamped = weekFixture({});
const weeklyBare = cellText(unstamped, /<tr><td class="k">(Weekly[\s\S]*?)<\/td>/);
if (weeklyBare !== 'Weekly') fail(`weekly Window cell without resetsAt is "${weeklyBare}", expected "Weekly"`);
console.log(`weekly stamp: ${weeklyWindow}, session: ${sessionWindow}, without resetsAt: ${weeklyBare}`);

// 11. Session row carries its reset stamp in the same markup as Weekly, and the stat
//     cards are half their former width (178 px measured in 0.0.22, now 89 px).
const sessionStampIso = new Date(2026, 9, 21, 14, 10, 0).toISOString();
const bothStamped = R.detailsHtml(
  { ...sample, util: { ...sample.util, session: { pct: 50, resetsAt: sessionStampIso }, week: { pct: 10, resetsAt: new Date(2026, 9, 26, 18, 0, 0).toISOString() } } },
  cfg,
  '0.0.0'
);
const sessionCellText = cellText(bothStamped, /<tr><td class="k">(Session[\s\S]*?)<\/td>/);
const weeklyCellText = cellText(bothStamped, /<tr><td class="k">(Weekly[\s\S]*?)<\/td>/);
if (weeklyCellText !== 'Weekly Mon - 18:00') fail(`Weekly Window cell is "${weeklyCellText}", expected "Weekly Mon - 18:00"`);

// 12. Session row shows the EXPIRY time: 'Session 14:10' when it expires today, or
//     'Session Wed - 01:10' when it expires on another local date. Fixtures come from
//     the real local date, so this holds in any time zone.
const nowLocal = new Date();
const localAt = (dayOffset, h, m, s = 0, ms = 0) => {
  const d = new Date(nowLocal.getTime());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, s, ms);
  return d;
};
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sessionCell = (session) =>
  cellText(R.detailsHtml({ ...sample, util: { ...sample.util, session } }, cfg, '0.0.0'), /<tr><td class="k">(Session[\s\S]*?)<\/td>/);
const todayAt = localAt(0, 14, 10);
const tomorrowAt = localAt(1, 1, 10);
const sessionChecks = [
  [sessionCell({ pct: 50, resetsAt: todayAt.toISOString() }), 'Session 14:10'],
  [sessionCell({ pct: 50, resetsAt: tomorrowAt.toISOString() }), 'Session 01:10'],
  [sessionCell({ pct: 50, resetsAt: localAt(0, 13, 59, 59, 960).toISOString() }), 'Session 14:00'],
  [sessionCell({ pct: 50 }), 'Session'],
];
for (const [got, want] of sessionChecks) {
  if (got !== want) fail(`Session Window cell is "${got}", expected "${want}"`);
}
// No Session cell ever carries a weekday: the expiry is HH:mm in every case.
for (const [got] of sessionChecks) {
  if (got.includes(' - ')) fail(`Session Window cell carries a weekday: "${got}"`);
}
const clockCases = [
  [R.clockStamp(new Date(2026, 9, 21, 14, 10).toISOString()), '14:10'],
  [R.clockStamp(new Date(2026, 9, 22, 1, 10).toISOString()), '01:10'],
  [R.clockStamp(new Date(2026, 9, 21, 13, 59, 59, 960).toISOString()), '14:00'],
  [R.clockStamp(undefined), ''],
  [R.clockStamp('garbage'), ''],
];
for (const [got, want] of clockCases) {
  if (got !== want) fail(`clockStamp returned "${got}", expected "${want}"`);
}
console.log(`session expiry: ${sessionChecks.map((c) => c[0]).join(' | ')}; clockStamp unit cases ok`);

// 13. No "(5h)" anywhere the owner sees: not in the panel, not in the tooltip. The
//     tooltip is rendered with a session limit so its name map is exercised too.
if (html.includes('(5h)')) fail('the rendered panel still contains "(5h)"');
const tipWithLimit = R.tooltip(
  { ...sample, util: { ...sample.util, limits: [{ kind: 'session', pct: 50, resetsAt: sessionStampIso }] } },
  cfg,
  false
);
if (tipWithLimit.includes('(5h)')) fail('the status-bar tooltip still contains "(5h)"');
console.log('no "(5h)" in panel or tooltip');
if (!/\.card \{[^}]*width: 89px;/.test(html)) fail('panel CSS lacks the .card rule with width: 89px');
const cardCount = (html.match(/<div class="card">/g) || []).length;
if (cardCount !== 4) fail(`panel renders ${cardCount} stat cards, expected 4`);
console.log(`session stamp: ${sessionCellText}; four cards at width 89px`);

// 14. Segmented weekly meter. Fixture: baseline 12, sessions [4, 0, 6, 2, 1] with
//     the last one running. Expiries are built from LOCAL components, so the
//     'Wed 09:10-14:10' text holds in any time zone.
const H5 = 5 * 3600e3;
const wkPoints = [4, 0, 6, 2, 1];
const wkExpires = [
  new Date(2026, 9, 20, 10, 0, 0).getTime(),
  new Date(2026, 9, 20, 15, 30, 0).getTime(),
  new Date(2026, 9, 21, 2, 0, 0).getTime(),
  new Date(2026, 9, 21, 7, 20, 0).getTime(),
  new Date(2026, 9, 21, 14, 10, 0).getTime(),
];
const weekSess = {
  totalPct: 25,
  baselinePct: 12,
  trackedSinceMs: wkExpires[0] - H5,
  sessions: wkPoints.map((p, i) => ({
    startMs: wkExpires[i] - H5,
    expiresMs: wkExpires[i],
    lastMs: wkExpires[i] - 60e3,
    points: p,
    current: i === 4,
  })),
};
const weekHtmlOf = (ws) =>
  R.detailsHtml({ ...sample, util: { ...sample.util, week: { pct: 25 }, weekSessions: ws } }, cfg, '0.0.0');
const balancedTags = (h) => {
  const o = (h.match(/<(table|tr|td|th|svg|div|p|details|summary|span)\b/g) || []).length;
  const c = (h.match(/<\/(table|tr|td|th|svg|div|p|details|summary|span)>/g) || []).length;
  return o === c;
};
const wkHtml = weekHtmlOf(weekSess);
const wkSegs = [...wkHtml.matchAll(/<span class="seg( cur)?" style="width:([\d.]+)%;background:([^"]+)" title="([^"]*)"><\/span>/g)];
if (wkSegs.length !== 5) fail(`segmented meter: expected 5 segments (1 baseline + 4 sessions), found ${wkSegs.length}`);
const wkWidths = wkSegs.map((m) => Number(m[2]));
if (wkWidths.join(',') !== '12,4,6,2,1') fail(`segment widths are ${wkWidths.join(',')}, expected 12,4,6,2,1`);
const wkSum = wkWidths.reduce((a, b) => a + b, 0);
if (wkSum !== 25) fail(`segment widths sum to ${wkSum}, expected 25`);
for (let i = 0; i + 1 < wkSegs.length; i++) {
  if (wkSegs[i][3] === wkSegs[i + 1][3]) fail(`consecutive segments ${i} and ${i + 1} share a colour`);
}
if (!wkSegs.every((m) => m[4].length > 0)) fail('a segment has no title');
const wkLast = wkSegs[4];
if (wkLast[1] !== ' cur') fail('the running segment is not marked cur');
if (!wkLast[4].endsWith(' · running')) fail(`running segment title "${wkLast[4]}" does not end with " · running"`);
const WANT_RUN = 'Wed 09:10–14:10 · +1% of the weekly limit · running';
if (wkLast[4] !== WANT_RUN) {
  fail(`running segment title is "${wkLast[4]}", expected "${WANT_RUN}"`);
}
const sessMatch = wkHtml.match(/<details class="sessions"><summary>([^<]*)<\/summary>/);
if (!sessMatch) fail('legend <details class="sessions"> is missing');
if (/<details class="sessions"[^>]*\sopen\b/.test(wkHtml)) fail('legend <details class="sessions"> must be closed by default');
if (sessMatch[1] !== 'Sessions this week (5)') fail(`legend summary is "${sessMatch[1]}", expected "Sessions this week (5)"`);
const WANT_SPAN = 'Wed 09:10–14:10';
const gotSpan = R.sessionSpan(new Date(2026, 9, 21, 14, 10, 0).getTime());
if (gotSpan !== WANT_SPAN) fail(`sessionSpan for a local 14:10 expiry is "${gotSpan}", expected "${WANT_SPAN}"`);
const plainHtml = weekHtmlOf(null);
if (plainHtml.includes('class="sessions"') || plainHtml.includes('class="seg')) fail('fallback (weekSessions null) still renders segments or the legend');
if (weekHtmlOf({ baselinePct: 0, sessions: [] }).includes('class="sessions"')) fail('empty weekSessions must fall back to the plain bar');
const hostile = {
  totalPct: 'x',
  baselinePct: NaN,
  trackedSinceMs: 'x',
  sessions: [
    { expiresMs: 'x', points: NaN, current: 'yes' },
    { points: -3 },
    null,
    { expiresMs: NaN, points: 2 },
  ],
};
let hostileHtml = '';
try {
  hostileHtml = weekHtmlOf(hostile);
} catch (e) {
  fail('hostile weekSessions threw: ' + e.message);
}
const hostileSegs = [...hostileHtml.matchAll(/<span class="seg( cur)?" style="width:([\d.]+)%/g)];
if (hostileSegs.length !== 1 || hostileSegs[0][2] !== '2') fail('hostile data: expected one 2% segment, got ' + hostileSegs.length);
if (!balancedTags(hostileHtml)) fail('hostile weekSessions leaves unbalanced tags');
for (const bad of ['nope', 42, { sessions: 'x' }]) {
  try {
    weekHtmlOf({ baselinePct: 0, sessions: bad });
  } catch (e) {
    fail('odd weekSessions ' + JSON.stringify(bad) + ' threw: ' + e.message);
  }
}
if (!balancedTags(wkHtml)) fail('segmented meter leaves unbalanced tags');
if (wkHtml.includes('(5h)')) fail('segmented meter contains "(5h)"');
console.log(`segmented meter: widths ${wkWidths.join(',')} sum ${wkSum}; legend "${sessMatch[1]}"; fallback plain`);

// 10. Tooltip burn line and Time-cell hover show the SAME two span strings for one
//     row (msToFull 70.2 h, msToReset 128.15 h). The tooltip used whole-day rounding.
const tipH = 3600e3;
const tipSeven = {
  verdict: 'safe',
  pctPerHour: 0.6,
  msToFull: 70.2 * tipH,
  msToReset: 128.15 * tipH,
  windowMinutes: 600,
  basis: 'active',
  activeFraction: 0.625,
  samples: 9,
};
const tipRow = { ...sample, util: { ...sample.util, burn: { five: burn('safe'), seven: tipSeven } } };
const tipSpanFull = R.spanText(70.2 * tipH);
const tipSpanReset = R.spanText(128.15 * tipH);
const tipMd = R.tooltip(tipRow, cfg, false);
const tipCell = R.burnSectionHtml(tipRow);
if (!tipMd.includes(`full in **${tipSpanFull}**`)) fail(`tooltip burn line lacks "full in **${tipSpanFull}**"`);
if (!tipMd.includes(`resets in ${tipSpanReset}`)) fail(`tooltip burn line lacks "resets in ${tipSpanReset}"`);
if (tipMd.includes('full in **3d**')) fail('tooltip burn line still uses whole-day rounding');
if (!tipCell.includes(`title="Full in ${tipSpanFull} · resets in ${tipSpanReset}"`)) {
  fail('Time-cell title does not carry the same span strings as the tooltip');
}
console.log(`tooltip vs Time-cell: "${tipSpanFull}" / "${tipSpanReset}" identical`);

// 11. CONTRACT INTEGRATION. The two halves wired through the BUNDLED files only:
//     pushSample every 2 min for 14 h, three five-hour sessions of 4 active hours
//     each (weekly burns 0.6, 2.0, 1.2 points per hour, baseline 5), then the bundled
//     weeklySessions output must feed the bundled detailsHtml.
const ciNow = Date.now();
const ciWeekIso = new Date(ciNow + 300 * 3600e3).toISOString();
const ciT0 = ciNow - 14 * 3600e3;
const ciRates = [0.6, 2.0, 1.2];
const ciStarts = [0, 1, 2].map((k) => ciT0 + k * 5 * 3600e3);
let ciHist = [];
let ciWeek = 5;
let ciLast = null;
for (let t = ciT0; t <= ciNow; t += 120e3) {
  const k = Math.min(2, Math.floor((t - ciT0) / (5 * 3600e3)));
  const start = ciStarts[k];
  if (t >= start && t < start + 4 * 3600e3) ciWeek += ciRates[k] * (120 / 3600);
  ciLast = {
    five_hour: { utilization: Math.round(Math.max(0, t - start) / 3600e3 * 10), resets_at: new Date(start + 5 * 3600e3).toISOString() },
    seven_day: { utilization: Math.round(ciWeek), resets_at: ciWeekIso },
  };
  ciHist = core.pushSample(ciHist, ciLast, t);
}
const ciWs = core.weeklySessions({ history: ciHist, raw: ciLast, now: ciNow });
if (!ciWs) fail('contract: bundled weeklySessions returned null for simulated history');
const ciPts = ciWs.sessions.map((s) => s.points);
if (ciWs.baselinePct + ciPts.reduce((a, b) => a + b, 0) !== ciWs.totalPct) {
  fail(`contract: baseline ${ciWs.baselinePct} + points ${ciPts.join('+')} != totalPct ${ciWs.totalPct}`);
}
if (ciWs.sessions.length !== 3) fail(`contract: expected 3 sessions, got ${ciWs.sessions.length}`);
const ciHtml = R.detailsHtml(
  { ...sample, util: { ...sample.util, week: { pct: ciWs.totalPct }, weekSessions: ciWs } },
  cfg,
  '0.0.0'
);
const ciSegs = [...ciHtml.matchAll(/<span class="seg( cur)?" style="width:([\d.]+)%/g)];
const ciExpSegs = 1 + ciPts.filter((p) => p >= 1).length;
if (ciSegs.length !== ciExpSegs) fail(`contract: ${ciSegs.length} segments, expected ${ciExpSegs}`);
const ciWidthSum = ciSegs.reduce((a, m) => a + Number(m[2]), 0);
if (ciWidthSum !== ciWs.totalPct) fail(`contract: segment widths sum to ${ciWidthSum}, expected totalPct ${ciWs.totalPct}`);
const ciLegend = ciHtml.match(/<details class="sessions"><summary>([^<]*)<\/summary>/);
if (!ciLegend || ciLegend[1] !== 'Sessions this week (3)') fail(`contract: legend is "${ciLegend && ciLegend[1]}"`);
if (typeof core.weeklySessions !== 'function') fail('bundled core does not export weeklySessions');
const coreText = fs.readFileSync(path.join(__dirname, 'usage-core.cjs'), 'utf8');
const gwbAt = coreText.indexOf('function getUtilizationWithBurn');
const gwbBody = gwbAt < 0 ? '' : coreText.slice(gwbAt, coreText.indexOf('\n}\n', gwbAt));
if (!gwbBody.includes('weekSessions')) fail('getUtilizationWithBurn source does not mention weekSessions');
console.log(
  `contract integration: baseline ${ciWs.baselinePct} + points ${ciPts.join(' + ')} = totalPct ${ciWs.totalPct}; ` +
    `${ciSegs.length} segments, widths sum ${ciWidthSum}; legend "${ciLegend[1]}"`
);

console.log('panel order:', order.join(' -> '));
// 15. Hover tooltip (owner 2026-10-22). The hover shows the page's sections, in the
//     page's order, cut just before 'Per day'. Fixture: the bundled weekly-sessions
//     output from section 11, so the segmented bar and the session list are exercised.
const hoverSample = {
  ...sample,
  util: {
    ...sample.util,
    week: { pct: ciWs.totalPct },
    weekSessions: ciWs,
    burn: { five: burn('tight'), seven: tipSeven },
  },
};
const hoverMd = R.tooltip(hoverSample, cfg, false);
// (a) the verdict table, with the four headers the page's burn table has
if (!hoverMd.includes('| Window | Rate | Time | Verdict |')) fail('hover tooltip lacks the Window / Rate / Time / Verdict table header');
// (b) nothing from 'Per day' downward
if (/per day/i.test(hoverMd)) fail('hover tooltip contains "Per day" text; it must stop before that section');
// (c) section order matches the page's order up to the cut
const hoverPairs = [
  ['Session limit', '**Session limit**'],
  ['Weekly limit', '**Weekly limit**'],
  ['Burn rate', '**Burn rate**'],
  ['this chat', '**this chat**'],
];
const pageHoverHtml = R.detailsHtml(hoverSample, cfg, '0.0.0');
const pageAtLabel = (s) => pageHoverHtml.indexOf(s);
const hoverAtLabel = (s) => hoverMd.indexOf(s);
const pageCut = pageAtLabel('Per day');
if (pageCut < 0) fail('page has no "Per day" heading to cut the hover at');
if (hoverPairs.some(([, h]) => hoverAtLabel(h) < 0)) {
  fail('hover tooltip is missing a section: ' + hoverPairs.filter(([, h]) => hoverAtLabel(h) < 0).map(([, h]) => h).join(', '));
}
const hoverSeq = hoverPairs
  .slice()
  .sort((a, b) => hoverAtLabel(a[1]) - hoverAtLabel(b[1]))
  .map(([p]) => p);
const pageSeq = hoverPairs
  .filter(([p]) => pageAtLabel(p) >= 0 && pageAtLabel(p) < pageCut)
  .sort((a, b) => pageAtLabel(a[0]) - pageAtLabel(b[0]))
  .map(([p]) => p);
if (hoverSeq.join(' -> ') !== pageSeq.join(' -> ')) {
  fail(`hover order "${hoverSeq.join(' -> ')}" differs from page order "${pageSeq.join(' -> ')}"`);
}
// (d) notices: blocked 429 shows its notice first; a healthy window shows none;
//     stale shows the minutes line. The old wording is kept.
const blockedHover = R.tooltip(
  { ...hoverSample, util: { ...hoverSample.util, blocked: { status: 429, consecutive: 3, retryAtMs: Date.now() + 600000, reason: 'http-429' } } },
  cfg,
  false
);
if (!blockedHover.startsWith('⚠ rate limited by the API; 3 failed in a row, next try in ')) {
  fail('blocked 429 hover does not open with the rate-limited notice: ' + blockedHover.split('\n')[0]);
}
const healthyHover = R.tooltip(hoverSample, cfg, false);
if (healthyHover.startsWith('⚠') || healthyHover.includes('failed in a row') || healthyHover.includes('minutes old')) {
  fail('healthy hover shows a notice it should not');
}
const staleHover = R.tooltip(hoverSample, cfg, true);
if (!staleHover.startsWith('numbers are ') || !staleHover.includes('minutes old')) {
  fail('stale hover lacks the "numbers are N minutes old" line: ' + staleHover.split('\n')[0]);
}
console.log('notices: blocked -> "' + blockedHover.split('\n')[0] + '"; healthy -> no notice; stale -> "' + staleHover.split('\n')[0] + '"');
console.log(`hover tooltip: ${hoverSeq.join(' -> ')}; no "Per day"; verdict table headers present`);

console.log('PREFLIGHT OK');
