const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fork } = require('node:child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
// One cache file per extension host. Any two processes sharing a cache can
// overwrite each other with an older snapshot, regressing byte offsets so
// already-counted bytes get folded in twice. Every VS Code window has its own
// extension host, and several windows are normal.
const CACHE_FILE = path.join(CLAUDE_DIR, `usage-cache-vscode-${process.pid}.json`);

// A new pid means a cold rebuild (seconds over ~600 MB of transcripts), so
// adopt the freshest existing cache as a starting point. Safe because from
// here on this process is the only writer of its own file.
function seedCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return;
    let best = null;
    for (const name of fs.readdirSync(CLAUDE_DIR)) {
      if (!/^usage-cache-vscode(-\d+)?\.json$/.test(name)) continue;
      const full = path.join(CLAUDE_DIR, name);
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.m) best = { full, m: st.mtimeMs };
    }
    if (best) fs.copyFileSync(best.full, CACHE_FILE);
  } catch {
    /* a cold rebuild is the fallback, not an error */
  }
}

// Each reload gets a new pid, so old files would pile up.
function sweepStaleCaches() {
  const maxAgeMs = 3 * 24 * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(CLAUDE_DIR)) {
      if (!/^usage-cache-vscode(-\d+)?\.json(\.\d+\.tmp)?$/.test(name)) continue;
      const full = path.join(CLAUDE_DIR, name);
      if (full === CACHE_FILE) continue;
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(full);
    }
  } catch {
    /* housekeeping only */
  }
}

// Stamped into the panel. A VS Code window keeps the extension.js it activated
// with until the WINDOW is reloaded — reopening the panel re-renders the old
// code and looks convincingly fresh. Without a visible version there is no way
// to tell a stale window from a broken feature; that cost three rounds of
// "I see no update" on 2026-09-30.
let extVersion = 'unknown';

let item;
let panel;
let worker;
let timer;
let watcher;
let debounce;
let busy = false;
let last = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  return {
    refreshSeconds: c.get('refreshSeconds', 15),
    pollSeconds: c.get('pollSeconds', 120),
    windowDays: c.get('windowDays', 7),
    sessionHours: c.get('sessionWindowHours', 5),
    weekBudget: c.get('weekTokenBudget', 0),
    sessionBudget: c.get('sessionTokenBudget', 0),
    showBars: c.get('showBars', true),
    barWidth: c.get('barWidth', 5),
    alignment: c.get('alignment', 'right'),
  };
}

// Eighth-block partials give a 5-cell gauge 40 steps of resolution, which is
// enough to see movement without widening the status bar.

function ensureWorker(context) {
  if (worker && worker.connected) return worker;
  worker = fork(path.join(context.extensionPath, 'usage-worker.js'), [], {
    // process.execPath here is Code.exe: without ELECTRON_RUN_AS_NODE the fork
    // opens a new VS Code window instead of running the script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  worker.on('message', onResult);
  worker.on('exit', () => {
    worker = null;
    busy = false;
  });
  worker.on('error', () => {
    worker = null;
    busy = false;
  });
  return worker;
}

function onResult(res) {
  busy = false;
  if (!res || !res.ok) {
    item.text = '$(warning) usage n/a';
    item.tooltip = res && res.error ? 'Claude usage: ' + res.error : 'Claude usage unavailable';
    return;
  }
  last = res;
  render(res);
  if (panel) panel.webview.html = detailsHtml(res);
}



// Re-read the renderer on EVERY call, with its cache entry cleared. This is the
// whole point of the split: extension.js is frozen until a window reload, but a
// module it re-requires is not, so panel layout and wording change without one.
function renderer() {
  const p = require.resolve('./panel-render.js');
  delete require.cache[p];
  return require(p);
}

function render(r) {
  const c = cfg();
  const R = renderer();
  const bar = R.statusBar(r, c);
  item.text = bar.text;
  item.color =
    bar.worst >= 90
      ? new vscode.ThemeColor('statusBarItem.errorForeground')
      : bar.worst >= 70
        ? new vscode.ThemeColor('statusBarItem.warningForeground')
        : undefined;
  const md = new vscode.MarkdownString(R.tooltip(r, c, bar.stale));
  md.supportThemeIcons = true;
  item.tooltip = md;
}

function detailsHtml(r) {
  return renderer().detailsHtml(r, cfg(), extVersion);
}

function refresh(context) {
  if (busy) return;
  const w = ensureWorker(context);
  if (!w) return;
  busy = true;
  const { windowDays, sessionHours, pollSeconds } = cfg();
  try {
    w.send({ cacheFile: CACHE_FILE, days: windowDays, sessionHours, pollSeconds });
  } catch {
    busy = false;
  }
}

// /usage reports percentages the API computes server-side; nothing local
// exposes the underlying limits. So ask for the percentage once and back out
// the denominator from the tokens we did measure.
async function calibrate(context) {
  const { fmt } = renderer();
  if (!last) {
    refresh(context);
    vscode.window.showInformationMessage('Claude Usage: still measuring, try again in a moment.');
    return;
  }
  const c = cfg();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: `Session (last ${last.rollingHours || c.sessionHours}h)`,
        detail: `measured ${fmt(last.rollingTotal)} tokens`,
        key: 'sessionTokenBudget',
        total: last.rollingTotal,
      },
      {
        label: `Weekly (last ${c.windowDays}d)`,
        detail: `measured ${fmt(last.weekTotal)} tokens`,
        key: 'weekTokenBudget',
        total: last.weekTotal,
      },
    ],
    { title: 'Which limit are you calibrating?', ignoreFocusOut: true }
  );
  if (!pick) return;

  const answer = await vscode.window.showInputBox({
    title: `Run /usage in Claude Code — what percent does it show for "${pick.label}"?`,
    prompt: 'Enter the number only, e.g. 42',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(String(v).replace('%', '').trim());
      if (!Number.isFinite(n) || n <= 0 || n > 100) return 'Enter a percentage between 1 and 100.';
      return null;
    },
  });
  if (!answer) return;

  const pct = Number(String(answer).replace('%', '').trim());
  const budget = Math.round(pick.total / (pct / 100));
  await vscode.workspace
    .getConfiguration('claudeUsage')
    .update(pick.key, budget, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Claude Usage: ${pick.label} budget set to ${fmt(budget)} tokens (${fmt(
      pick.total
    )} measured at ${pct}%).`
  );
  render(last);
}



function showDetails(context) {
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('claudeUsage', 'Claude Usage', vscode.ViewColumn.Active, {
      enableScripts: false,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => (panel = null));
  }
  if (last) panel.webview.html = detailsHtml(last);
  refresh(context);
}

function activate(context) {
  try {
    extVersion =
      (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) ||
      JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')).version;
  } catch {
    /* the stamp is a diagnostic, never a reason to fail activation */
  }
  seedCache();
  sweepStaleCaches();
  const { alignment, refreshSeconds } = cfg();
  item = vscode.window.createStatusBarItem(
    alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
    1000
  );
  item.text = '$(pulse) usage …';
  item.command = 'claudeUsage.showDetails';
  item.show();
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsage.showDetails', () => showDetails(context)),
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(context)),
    vscode.commands.registerCommand('claudeUsage.calibrate', () => calibrate(context))
  );

  refresh(context);
  timer = setInterval(() => refresh(context), Math.max(5, refreshSeconds) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Transcripts are appended constantly while a session runs; coalesce the
  // storm into one refresh.
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      watcher = fs.watch(PROJECTS_DIR, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => refresh(context), 2000);
      });
      context.subscriptions.push({
        dispose: () => {
          clearTimeout(debounce);
          watcher && watcher.close();
        },
      });
    }
  } catch {
    /* recursive watch unsupported: the interval still covers us */
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeUsage')) return;
      clearInterval(timer);
      timer = setInterval(() => refresh(context), Math.max(5, cfg().refreshSeconds) * 1000);
      if (last) render(last);
      refresh(context);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (worker) worker.kill();
    },
  });
}

function deactivate() {
  if (worker) worker.kill();
}

module.exports = { activate, deactivate };
// Exposed for the offline render test; the extension host never touches it.
module.exports.__test = require('./panel-render.js');
