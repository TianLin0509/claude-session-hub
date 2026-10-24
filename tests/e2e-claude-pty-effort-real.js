'use strict';
// 真实 E2E：隔离 Hub 里开一个真实 PTY Claude，在界面上点「推理」chip 选档位，
// 以会话元数据和 Claude 自己的 transcript 为准核对；并核对账号默认 effortLevel 被还原。
// 凭据取自 HUB_E2E_CLAUDE_CREDENTIALS_DIR（默认第二账号）的临时副本；/effort 不调用模型，不耗额度。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const run = '20261024-claude-pty-effort-claude-' + Date.now();
const out = path.resolve(__dirname, '../artifacts', run);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-effort-'));
  const configDir = path.join(root, 'claude'), work = path.join(root, 'work');
  fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const source = process.env.HUB_E2E_CLAUDE_CREDENTIALS_DIR || path.join(os.homedir(), '.claude-profiles', 'second');
  for (const name of ['.credentials.json', '.claude.json']) fs.copyFileSync(path.join(source, name), path.join(configDir, name));
  // 预先信任工作目录，避免首次启动的信任对话框。
  const state = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  state.projects = { ...(state.projects || {}), [work.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } };
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ theme: 'light', effortLevel: 'low' }));
  ensureClaudeHookIntegration({ claudeDir: configDir, sourceScriptsDir: path.resolve(__dirname, '../scripts'), logger: { log() {}, warn() {} } });
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const report = { scope: 'Real isolated Hub + real PTY Claude (temporary credential copy); UI click on the effort chip', checks: [] };
  let hub, c;
  const check = (ok, label) => { assert.ok(ok, label); report.checks.push(label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: run, extraEnv: { CLAUDE_CONFIG_DIR: configDir } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (!await c.eval(expr)) { if (Date.now() > end) throw new Error('timeout ' + label); await sleep(100); } };
    const click = async selector => {
      const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const shot = async name => { const img = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${run}-${name}.png`), Buffer.from(img.data, 'base64')); };
    await until('typeof sessions!=="undefined"', 'renderer');
    const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd: work, model: 'claude-sonnet-5-5', effort: 'medium' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'sidebar row');
    await click(`.session-item[data-session-id="${sid}"]`);
    // 等 Claude TUI 起到主提示符。
    await until(`(window.getTerminalScreenText ? getTerminalScreenText(${q}) : '').includes('/effort') || (window.getTerminalScreenText ? getTerminalScreenText(${q}) : '').includes('? for shortcuts')`, 'Claude prompt', 90000).catch(() => {});
    await sleep(4000);
    await until(`!!document.querySelector('.composer-thinking:not([hidden])')`, 'thinking chip');
    check(await c.eval(`document.querySelector('.composer-thinking').dataset.interactive==='1'`), 'PTY Claude effort chip is clickable');
    await click('.composer-thinking');
    await until(`!!document.querySelector('.effort-picker-menu [data-effort="high"]')`, 'effort menu');
    await shot('menu');
    await click('.effort-picker-menu [data-effort="high"]');
    await until(`sessions.get(${q})?.effort==='high'`, 'session effort high', 30000);
    check(true, 'choosing high in the UI is confirmed by Claude and saved on the session');
    check(await c.eval(`document.querySelector('.composer-thinking').textContent.includes('高') || document.querySelector('.composer-thinking').textContent.toLowerCase().includes('high')`), 'chip label follows the confirmed level');
    const info = await c.eval(`ipcRenderer.invoke('get-sessions').then(list=>list.find(s=>s.id===${q}))`);
    const transcript = info?.transcriptPath || path.join(configDir, 'projects', require('../core/claude-transcript-locator').projectSlug(work), info.ccSessionId + '.jsonl');
    check(/Set effort level to high/.test(fs.readFileSync(transcript, 'utf8')), 'Claude transcript records the switch');
    await sleep(500);
    check(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).effortLevel === 'low', 'account default effortLevel restored (only this session changed)');
    const screen = await c.eval(`window.getTerminalScreenText ? getTerminalScreenText(${q}) : ''`);
    report.enterCount = (screen.match(/\/effort high/g) || []).length;
    await shot('after');
    report.passed = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    if (c) { try { const img = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, run + '-failure.png'), Buffer.from(img.data, 'base64')); } catch {} }
  } finally {
    if (c) await c.close();
    if (hub) { await gracefulQuit(hub); fs.writeFileSync(path.join(out, run + '-hub.log'), hub.log().join('\n')); }
    fs.writeFileSync(path.join(out, run + '.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(path.join(configDir, '.credentials.json'), { force: true }); } catch {}
    console.log(JSON.stringify({ passed: report.passed, error: report.error && report.error.split('\n')[0], out }, null, 2));
  }
})();
