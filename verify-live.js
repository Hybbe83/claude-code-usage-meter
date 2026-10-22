// What is REGISTERED on disk vs what each running VS Code window is actually RUNNING.
//
// Run after every install and after deploy-live.js. For each running usage worker it
// reports the host (extension host) pid, the extension version that host activated,
// and the renderer version that host last wrote to its beacon file. A window is CURRENT
// when its renderer version equals the registered version. A window is STALE when it
// does not; the next step depends on whether its host can hot-reload (deploy-live.js)
// or needs a window reload.
//
// Exit code 0: every running window renders the registered version (or none is running).
// Exit code 1: at least one window does not.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PKG = require(path.join(__dirname, 'package.json'));
const EXT_ID = PKG.publisher + '.' + PKG.name;
const extDir = path.join(os.homedir(), '.vscode', 'extensions');
const claudeDir = path.join(os.homedir(), '.claude');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORKER_RE = new RegExp(escapeRe(EXT_ID) + '-([0-9.]+)[\\\\/]usage-worker\\.js');
const LOADER = 'delete require.cache[p]';

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let registered = '(none)';
try {
  const obsolete = (() => {
    try {
      return JSON.parse(stripBom(fs.readFileSync(path.join(extDir, '.obsolete'), 'utf8')));
    } catch {
      return {};
    }
  })();
  for (const e of JSON.parse(stripBom(fs.readFileSync(path.join(extDir, 'extensions.json'), 'utf8')))) {
    if ((e.identifier && e.identifier.id) === EXT_ID && !obsolete[e.relativeLocation]) {
      registered = e.version;
    }
  }
} catch {
  /* VS Code never opened */
}

// Every running usage worker, with its parent (the extension host) and version dir.
function listWorkers() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*usage-worker.js*' } | " +
    "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') + '|' + $_.CommandLine }";
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [pid, parentPid, started, ...rest] = line.split('|');
    const m = WORKER_RE.exec(rest.join('|'));
    if (!m) continue;
    rows.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      started,
      version: m[1],
      dir: path.join(extDir, EXT_ID + '-' + m[1]),
    });
  }
  return rows;
}

// The beacon the renderer writes on each render: rendererVersion and the time of that render.
function readBeacon(hostPid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(claudeDir, `usage-render-beacon-${hostPid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

const rows = listWorkers();
console.log(`registered on disk : ${registered}  (what the NEXT reload will load)`);
if (!rows.length) {
  console.log('running windows    : none found — the extension is not active anywhere');
  process.exit(0);
}

let stale = 0;
for (const r of rows) {
  const b = readBeacon(r.parentPid);
  const hot = (() => {
    try {
      return fs.readFileSync(path.join(r.dir, 'extension.js'), 'utf8').includes(LOADER);
    } catch {
      return false;
    }
  })();
  const renderer = b
    ? `renderer v${b.rendererVersion} (last render ${Math.round((Date.now() - b.at) / 1000)}s ago)`
    : 'renderer unknown (no beacon yet)';
  const current = b && b.rendererVersion === registered;
  if (!current) stale += 1;
  const verdict = current
    ? '✔ CURRENT'
    : hot
      ? '✘ STALE — run deploy-live.js (hot-deployable)'
      : '✘ STALE — needs Developer: Reload Window (host predates hot reload)';
  // Information only: the beacon's weekSessions count (null or absent = none seen).
  const weekSeen = b && typeof b.weekSessions === 'number' ? `weekSessions seen: ${b.weekSessions}` : 'weekSessions seen: none';
  console.log(
    `window host pid ${String(r.parentPid).padEnd(6)} : host v${String(r.version).padEnd(8)}, ${renderer}  ${weekSeen}  worker pid ${r.pid} started ${r.started}  ${verdict}`
  );
}
console.log(
  stale
    ? `\n${stale} of ${rows.length} window(s) do NOT render ${registered}. Do not claim a rendered change is visible.`
    : `\nAll ${rows.length} window(s) render ${registered}.`
);
process.exitCode = stale ? 1 : 0;
