'use strict';
// 会话独占在 PTY 模式下同样成立：同一个 Claude 会话同时只能在一个 Hub 打开。
// 不调用模型、不拷登录凭据 —— 只验证归属：Hub A 开着时 Hub B 被拒并看到占用者 PID；
// A 关闭（释放）后 B 能打开，且打开的是 PTY 会话。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function until(label, read, timeout = 60000) { const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await read(); if (v) return v; await sleep(150); } throw Error('Timeout: ' + label); }
async function click(c, selector) {
  const r = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-exclusive-'));
  const out = path.resolve('artifacts/cli-pty-core/session-exclusive-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace'), claudeHome = path.join(root, 'claude');
  for (const d of [workspace, claudeHome]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
  const env = { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9' };
  const hubs = [], checks = [];
  let passed = false;
  const launch = async label => { const hub = await launchIsolatedHub({ dataDir, port: await port(), label, extraEnv: env, windowMode: 'hidden' });
    hubs.push(hub); const c = await connectFirstPage(hub); await until(label + ' ready', () => c.eval('typeof sessions!=="undefined"')); return { hub, c }; };
  const shot = async (c, name) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  try {
    const a = await launch('pty-exclusive-a');
    const s = await a.c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'claude', opts: { cwd: workspace, model: 'claude-haiku-4-5-20251001', mcpProfile: 'none', fastMode: false } })})`);
    const id = s.id, key = JSON.stringify(id);
    assert.equal(s.agentRuntime, 'pty');
    assert.match(String(s.ccSessionId || ''), /^[0-9a-f-]{36}$/, 'identity claimed at launch');
    await until('metadata persisted', () => Promise.resolve(fs.existsSync(path.join(dataDir, 'sessions', id + '.json'))));
    const b = await launch('pty-exclusive-b');
    await until('restored row in B', () => b.c.eval(`sessions.has(${key}) && !!document.querySelector('.session-item[data-session-id="${id}"]')`));
    await click(b.c, `.session-item[data-session-id="${id}"]`);
    await until('occupied dialog shows owner PID', () => b.c.eval(`document.querySelector('dialog[open]')?.textContent.includes('PID ${a.hub.pid}')`));
    assert.equal(await b.c.eval(`sessions.get(${key}).status`), 'dormant');
    await shot(b.c, 'occupied');
    await click(b.c, 'dialog[open] .hub-dialog-actions button:last-child');
    checks.push('Hub B refuses a PTY Claude session Hub A owns and names the owner PID');

    await click(a.c, `.session-item[data-session-id="${id}"]`);
    await until('selected in A', () => a.c.eval(`activeSessionId===${key} && !!document.querySelector('.btn-close-session')`));
    await click(a.c, '.btn-close-session');
    await until('released in A', () => a.c.eval(`sessions.get(${key})?.status==='dormant'`));
    await click(b.c, `.session-item[data-session-id="${id}"]`);
    await until('B opens it after release', () => b.c.eval(`sessions.get(${key})?.status!=='dormant' && sessions.get(${key})?.agentRuntime==='pty'`), 60000);
    assert.equal(await b.c.eval(`sessions.get(${key}).ccSessionId`), s.ccSessionId, 'same native identity after the handover');
    await shot(b.c, 'reopened');
    checks.push('after A releases it, B reopens the same PTY session with the same Claude identity');
    passed = true;
  } catch (error) { checks.push('FAILED: ' + error.message); process.exitCode = 1; }
  finally {
    for (const hub of hubs.reverse()) { try { await gracefulQuit(hub); } catch {} }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed, checks }, null, 2));
    console.log(JSON.stringify({ out, passed, checks }));
  }
}
main();
