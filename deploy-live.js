// Hot-deploy into the windows that are ALREADY RUNNING, then prove the change is live.
//
// Per running window: copy panel-render.js, usage-core.cjs and usage-worker.js from this
// directory into that window's extension directory (after backing up what was there),
// stop ONLY that window's usage worker, and wait for the extension to re-fork it and for
// the renderer beacon to report the new RENDERER_VERSION. No window reload, no VS Code
// restart. Processes that do not match the worker pattern are never touched.
//
// Only a window whose extension.js contains the re-require loader is hot-deployable. A
// window running an older host is reported as NEEDS RELOAD and skipped.
// extension.js and package.json are NOT hot: a window keeps the copies it loaded.
//
// Build-time only. Excluded from the vsix (.vscodeignore).
// Exit code 0: every hot-deployable window is LIVE. 1: any NOT CONFIRMED or an abort.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const OPS = __dirname;
const HOT = ['panel-render.js', 'usage-core.cjs', 'usage-worker.js'];
const NOT_HOT = ['extension.js', 'package.json'];
const EXT = path.join(os.homedir(), '.vscode', 'extensions');
const CLAUDE = path.join(os.homedir(), '.claude');
const PKG = require(path.join(OPS, 'package.json'));
const EXT_ID = PKG.publisher + '.' + PKG.name;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORKER_RE = new RegExp(escapeRe(EXT_ID) + '-([0-9.]+)[\\\\/]usage-worker\\.js');
const LOADER = 'delete require.cache[p]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      dir: path.join(EXT, EXT_ID + '-' + m[1]),
    });
  }
  return rows;
}

function readBeacon(hostPid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE, `usage-render-beacon-${hostPid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

const same = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

async function main() {
  // 1. Preflight first, then the authored core must match the one the ops copy holds.
  const pf = spawnSync(process.execPath, ['preflight.js'], { cwd: OPS, encoding: 'utf8' });
  process.stdout.write(pf.stdout || '');
  if (pf.status !== 0) {
    console.log('ABORT: preflight failed; nothing was copied or stopped.');
    return 1;
  }
  // Optional: only when the owner's private ~/.claude/usage-core.cjs is present.
  const ownerCore = path.join(CLAUDE, 'usage-core.cjs');
  if (fs.existsSync(ownerCore)) {
    if (!same(path.join(OPS, 'usage-core.cjs'), ownerCore)) {
      console.log('ABORT: ops usage-core.cjs is not byte-identical to ~/.claude/usage-core.cjs.');
      return 1;
    }
  } else {
    console.log('owner core check skipped: ~/.claude/usage-core.cjs not present');
  }
  const RV = require(path.join(OPS, 'panel-render.js')).RENDERER_VERSION;
  console.log(`deploying renderer v${RV} from ${OPS}`);

  // 2. Every running usage worker.
  const workers = listWorkers();
  if (!workers.length) {
    console.log('no running usage workers: nothing to deploy into.');
    return 0;
  }

  // 3. Hot-deployable or not, per window.
  const results = [];
  const byDir = new Map();
  for (const w of workers) {
    let loader = false;
    try {
      loader = fs.readFileSync(path.join(w.dir, 'extension.js'), 'utf8').includes(LOADER);
    } catch {
      /* missing dir */
    }
    if (!loader) {
      console.log(`host pid ${w.parentPid} v${w.version}: NEEDS RELOAD (host v${w.version} predates hot reload)`);
      results.push({ w, status: 'NEEDS RELOAD (predates hot reload)' });
      continue;
    }
    const notHotDiffs = NOT_HOT.filter((f) => !same(path.join(OPS, f), path.join(w.dir, f)));
    console.log(
      `host pid ${w.parentPid} v${w.version}: hot-deployable; not-hot files that differ from ops: ${notHotDiffs.join(', ') || 'none'}`
    );
    if (!byDir.has(w.dir)) byDir.set(w.dir, { workers: [] });
    byDir.get(w.dir).workers.push(w);
  }

  // 4. Back up, copy in, verify byte-for-byte. Once per version directory.
  for (const [dir, info] of byDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(dir, '.hot-backup-' + stamp);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of HOT) {
      const src = path.join(dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, f));
    }
    for (const f of HOT) fs.copyFileSync(path.join(OPS, f), path.join(dir, f));
    info.copyAt = Date.now();
    info.verified = HOT.every((f) => same(path.join(OPS, f), path.join(dir, f)));
    console.log(`${path.basename(dir)}: backed up to ${path.basename(backup)}, copied ${HOT.join(', ')}, byte-verified ${info.verified}`);
    if (byDir.get(dir).workers.length > 1) {
      console.log(`  note: ${byDir.get(dir).workers.length} windows share this directory; they all pick up the new files on their next render.`);
    }
  }

  // 5 and 6. Per window: stop only its worker, wait for the re-fork, then for the beacon.
  for (const [dir, info] of byDir) {
    for (const w of info.workers) {
      if (!info.verified) {
        results.push({ w, status: 'NOT CONFIRMED (copy verification failed)' });
        continue;
      }
      execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(w.pid)} -ErrorAction Stop`]);
      console.log(`host pid ${w.parentPid}: stopped worker pid ${w.pid} (only that process)`);

      let fresh = null;
      const reforkDeadline = Date.now() + 45000;
      while (Date.now() < reforkDeadline && !fresh) {
        await sleep(2000);
        fresh = listWorkers().find(
          (x) => x.dir === dir && x.parentPid === w.parentPid && x.pid !== w.pid && x.started > w.started
        );
      }
      if (!fresh) {
        results.push({ w, status: 'NOT CONFIRMED (no new worker within 45 s)' });
        console.log(`host pid ${w.parentPid}: NOT CONFIRMED, no new worker within 45 s`);
        continue;
      }
      console.log(`host pid ${w.parentPid}: new worker pid ${fresh.pid} started ${fresh.started}`);

      let beacon = null;
      const beaconDeadline = Date.now() + 60000;
      while (Date.now() < beaconDeadline) {
        const b = readBeacon(w.parentPid);
        if (b && b.rendererVersion === RV && b.at > info.copyAt) {
          beacon = b;
          break;
        }
        await sleep(2000);
      }
      if (beacon) {
        const age = Math.round((Date.now() - beacon.at) / 1000);
        console.log(`LIVE: host pid ${w.parentPid} now renders v${RV} (beacon age ${age}s)`);
        results.push({ w, status: `LIVE v${RV} (beacon ${age}s old)` });
      } else {
        console.log(`NOT CONFIRMED: host pid ${w.parentPid} has not written a v${RV} beacon within 60 s`);
        results.push({ w, status: 'NOT CONFIRMED (no v' + RV + ' beacon within 60 s)' });
      }
    }
  }

  // Summary.
  console.log('\nhost pid   host ver   worker pid   status');
  for (const { w, status } of results) {
    console.log(`${String(w.parentPid).padEnd(10)} ${String(w.version).padEnd(10)} ${String(w.pid).padEnd(12)} ${status}`);
  }
  return results.every((r) => r.status.startsWith('LIVE') || r.status.startsWith('NEEDS RELOAD')) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.log('ERROR: ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
);
