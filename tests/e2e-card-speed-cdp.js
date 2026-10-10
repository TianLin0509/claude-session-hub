'use strict';
// Real Codex PTY. Never open the CLI before the first speed switch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { Terminal } = require('@xterm/headless');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const n = server.address().port; server.close(() => resolve(n)); });
});
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-speed-'));
  const home = path.join(root, 'codex'), cwd = path.join(root, 'work');
  const out = path.resolve('artifacts', '20261010-card-speed-' + Date.now());
  for (const dir of [home, cwd, out]) fs.mkdirSync(dir, { recursive: true });
  const report = { passed: false, checks: [], root, provider: 'real Codex PTY; no model prompts' };
  let hub, c, sid;
  const until = async (fn, label, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(120); }
    throw Error('Timeout: ' + label);
  };
  const check = (label, value) => { assert(value, label); report.checks.push(label); console.log('PASS', label); };
  const click = async selector => {
    const pos = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e||e.disabled)throw Error('unavailable '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('covered '+${j(selector)});return {x,y};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 });
  };
  const shot = async name => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const screen = async () => {
    const snap = await c.eval(`ipcRenderer.invoke('get-session-buffer-snapshot',${j(sid)})`);
    const term = new Terminal({ cols: snap.baseCols || snap.cols || 120, rows: snap.baseRows || snap.rows || 30, allowProposedApi: true });
    const write = data => new Promise(resolve => term.write(data || '', resolve));
    try {
      await write(snap.text);
      for (const op of snap.operations || []) {
        if (op.type === 'resize') term.resize(op.cols, op.rows);
        else if (op.type === 'write') await write(op.data);
      }
      const b = term.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) || '').join('\n');
    } finally { term.dispose(); }
  };
  try {
    const auth = process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(), '.codex');
    for (const file of ['auth.json', 'models_cache.json']) fs.copyFileSync(path.join(auth, file), path.join(home, file));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6-astra"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n');
    for (const key of ['NO_COLOR','FORCE_COLOR','TERM','COLORTERM','WT_SESSION','TERM_PROGRAM']) delete process.env[key];
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HUB_STARTUP_TRACE: '1',
    } });
    c = await connectFirstPage(hub);
    let ready = false;
    c.ws.on('message', data => { if (String(data).includes('renderer-sidebar-ready sent')) ready = true; });
    await c.send('Runtime.enable');
    await until(() => ready, 'renderer startup');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1450, height: 900, deviceScaleFactor: 1, mobile: false });
    const created = await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-6-astra',effort:'low',mcpProfile:'none',codexSpeedTier:'fast'}})`);
    assert(created.id, j(created)); sid = created.id;
    await until(() => c.eval(`Boolean(document.querySelector('.session-item[data-session-id="${sid}"]'))`), 'session row');
    await click(`.session-item[data-session-id="${sid}"]`);
    await until(async () => /^›\s*Ask Codex to do anything\s*$/m.test(await screen()), 'real Codex prompt', 90000);
    check('card view selected before any CLI click', await c.eval(`currentView==='card'`));
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '保留卡片输入草稿' });
    // Reproduce a missing renderer frame while the real PTY is already ready.
    // This is controlled cache fault injection, not a fake CLI confirmation.
    await c.eval(`terminalCache.get(${j(sid)}).terminal.reset()`);
    check('controlled renderer frame is empty while real PTY is ready', await c.eval(`terminalActivityMonitor.extractLiveScreenLines(${j(sid)}).join('').trim()===''`));
    for (const [index, tier] of ['standard', 'fast', 'standard', 'fast', 'standard'].entries()) {
      if (index === 2) {
        await click('[data-display-mode="phone"]');
        await c.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 800, deviceScaleFactor: 1, mobile: false });
        await sleep(350);
      }
      if (index >= 3) {
        await click('#btn-backstage');
        await until(() => c.eval(`currentView===${j(index === 3 ? 'pty' : 'card')}`), 'view transition');
        await sleep(350);
      }
      await click('.floating-input-bar .composer-speed');
      await until(() => c.eval(`Boolean(document.querySelector('.speed-picker-menu [data-speed="${tier}"]:not(:disabled)'))`), 'speed menu');
      await click(`.speed-picker-menu [data-speed="${tier}"]`);
      await until(async () => {
        const status = await c.eval(`({tier:sessions.get(${j(sid)}).codexSpeedTier,pending:!!sessions.get(${j(sid)})._modelSwitchPending,error:document.querySelector('.speed-picker-menu [data-state="error"]')?.textContent})`);
        if (status.error) throw Error(status.error);
        return status.tier === tier && !status.pending;
      }, 'confirmed speed ' + tier, 25000);
      const text = await screen();
      report['screen' + index] = text;
      check('real CLI confirms ' + tier + ' #' + index, text.includes('Service tier set to ' + (tier === 'fast' ? 'priority' : 'default')));
      check('selected view is preserved #' + index, await c.eval(`currentView===${j(index === 3 ? 'pty' : 'card')}`));
      check('composer draft preserved #' + index, await c.eval(`document.querySelector('.floating-input-box').innerText==='保留卡片输入草稿'`));
      const saved = (await c.eval("ipcRenderer.invoke('get-sessions')")).find(s => s.id === sid);
      check('backend metadata confirms speed; model and effort preserved #' + index, saved.codexSpeedTier === tier && saved.currentModel.id === 'gpt-6-astra' && saved.effort === 'low');
      check('global speed preference untouched #' + index, !fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('service_tier'));
      await shot('card-' + index + '-' + tier);
      await until(() => c.eval("!document.querySelector('.speed-picker-menu')"), 'menu closes');
    }
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (c) { report.ui = await c.eval("document.querySelector('.speed-picker-menu')?.innerText").catch(() => null); await shot('failure').catch(() => {}); }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
    if (c) await c.close();
    if (hub) await gracefulQuit(hub);
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
    console.log('ARTIFACT_ROOT', out);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
