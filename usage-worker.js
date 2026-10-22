// Forked child: aggregation is ~1.6s cold and touches hundreds of MB, so it
// must never run on the extension host thread.
const path = require('node:path');
const { aggregate, getUtilizationWithBurn, billable } = require(path.join(__dirname, 'usage-core.cjs'));

process.on('message', async (msg) => {
  try {
    const u = aggregate({
      cacheFile: msg.cacheFile,
      days: msg.days,
      sessionHours: msg.sessionHours,
      transcriptPath: msg.transcriptPath || null,
    });
    process.send({
      ok: true,
      util: await getUtilizationWithBurn({ pollSeconds: msg.pollSeconds }),
      week: u.week,
      weekTotal: billable(u.week),
      rolling: u.rolling,
      rollingTotal: billable(u.rolling),
      rollingHours: u.rollingHours,
      rollingStart: u.rollingStart,
      session: u.session,
      sessionTotal: billable(u.session),
      ctx: u.ctx,
      byDay: u.byDay,
      byProject: u.byProject,
      sessionFile: u.sessionFile,
      scanned: u.scanned,
      total: u.total,
    });
  } catch (e) {
    process.send({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});