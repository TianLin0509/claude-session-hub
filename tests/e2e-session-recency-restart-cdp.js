'use strict';
// Real Electron shutdown/restart and persistence, synthetic CLI and interaction
// timestamps. No cloud calls or production data are involved.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recency-restart-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const out = path.resolve('artifacts', '20261006-session-recency-restart-codex1-' + Date.now());
  for (const dir of [data, work, bin, out]) fs.mkdirSync(dir, { recursive: true });
  const fixture = path.join(bin, 'fixture.js');
  fs.writeFileSync(fixture, "process.stdout.write('Local CLI fixture ready\\r\\n');setInterval(()=>{},1000);");
  for (const name of ['claude', 'codex', 'gemini', 'kimi']) fs.writeFileSync(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  fs.writeFileSync(path.join(data, 'config.json'), j({ runtime: { agent: 'pty' } }));
  let hub, client;
  const report = { passed: false, boundary: 'Real isolated Hub restart with synthetic CLI and event clocks', checks: [] };
  const until = async expr => { for (let i = 0; i < 300; i++) { if (await client.eval(expr)) return; await _waitMs(100); } throw Error('timeout: ' + expr); };
  const launch = async () => {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'recency-restart', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', AI_HUB_WORKSPACE_ROOT: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
      GEMINI_CLI_HOME: path.join(root, 'gemini'), KIMI_CODE_HOME: path.join(root, 'kimi'),
      KIMI_BIN: path.join(bin, 'kimi.cmd'), PATH: bin + path.delimiter + process.env.PATH,
    } });
    client = await connectFirstPage(hub);
    await until('!!window.__hubE2E');
  };
  try {
    await launch();
    const recent = Date.now() - 5 * 60000, old = Date.now() - 20 * 3600000;
    const cases = [];
    for (const [kind, interrupted] of [['claude', true], ['codex', false]]) {
      const session = await client.eval(`ipcRenderer.invoke('create-session',{kind:${j(kind)},opts:{cwd:${j(work)},mcpProfile:'none',lastMessageTime:${old}}})`);
      assert(session.id);
      await until(`sessions.has(${j(session.id)})`);
      // Reproduce renderer activity newer than Main's original launch snapshot.
      await client.eval(`(()=>{const s=sessions.get(${j(session.id)});Object.assign(s,{title:${j(kind + '-recent-' + (interrupted ? 'interrupted' : 'completed'))},lastMessageTime:${recent},createdAt:${old},lastRunStartedAt:${recent},lastCompletedAt:${interrupted ? old : recent},runStartedAt:null});renderSessionList();return persistWorkscene(true);})()`);
      cases.push({ id: session.id, kind, interrupted, recent });
    }
    await _waitMs(500);
    await client.close(); client = null;
    await gracefulQuit(hub); hub = null;
    for (const item of cases) {
      const disk = JSON.parse(fs.readFileSync(path.join(data, 'sessions', item.id + '.json'), 'utf8'));
      assert.equal(disk.lastMessageTime, recent, item.kind + ' release preserves exact clock');
      report.checks.push(item.kind + ': shutdown release preserves latest interaction');
    }
    await launch();
    for (const item of cases) {
      await until(`sessions.has(${j(item.id)})`);
      const result = await client.eval(`(()=>{const s=sessions.get(${j(item.id)});return {at:require('../core/session-recency').latestActivityTime(s),status:s.status};})()`);
      assert.equal(result.at, recent, item.kind + ' restart preserves exact interaction time');
      report.checks.push(item.kind + ': restart restores exact timestamp without bumping it to now');
    }
    await client.eval('renderSessionList()');
    const rows = await client.eval(`[...document.querySelectorAll('#session-list .session-item')].map(e=>({title:e.querySelector('.sl-title')?.textContent,time:e.querySelector('.sl-time')?.textContent}))`);
    report.rows = rows;
    for (const item of cases) {
      const row = rows.find(r => r.title?.toLowerCase().includes(item.kind));
      assert(row, item.kind + ' sidebar visible');
      assert(/5m/i.test(row.time), 'sidebar should show five minutes, not twenty hours: ' + j(row));
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'after-restart.png'), Buffer.from(shot.data, 'base64'));
    report.checks.push('visible sidebar displays recent minutes after a real restart');
    report.passed = true;
  } catch (e) { report.error = e.stack; console.error(e.stack); process.exitCode = 1; }
  finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, 'evidence.json'), j(report)); console.log(out, report);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
