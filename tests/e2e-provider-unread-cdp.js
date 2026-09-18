'use strict';
// Real Main -> native subprocess -> IPC -> sidebar. No synthetic completion IPC.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort } = require('./helpers/usage-refresh-fixture');
const j = JSON.stringify;
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-provider-unread-'));
const out = path.join(root, 'artifacts', 'provider-unread', (baseline ? 'baseline-' : 'fixed-') + Date.now());
fs.mkdirSync(out, { recursive: true });
async function main() {
  let hub, c;
  const result = { scope: 'Isolated Hub with real native protocol fixtures; no cloud calls', rows: [], checks: [], out };
  const dataDir = path.join(temp, 'data');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(dataDir);
  const entryPath = path.join(root, 'tests/fixtures/acp-agent.js');
  const bridgePath = path.join(temp, 'bridge');
  fs.mkdirSync(bridgePath);
  fs.writeFileSync(path.join(bridgePath, 'package.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'config.json'), j({ acp: { nodePath: process.execPath, apiKey: 'fixture-no-cloud', providers: {
    qwen: { entryPath, model: 'qwen3.8-max' },
    'deepseek-acp': { entryPath, bridgePath, model: 'deepseek-v4-pro' },
    glm: { entryPath, backendPath: entryPath, model: 'glm-5.2' },
  } } }));
  fs.writeFileSync(path.join(dataDir, 'prepared-projects.json'), j({ schemaVersion: 1, projects: [], migrations: [] }));
  async function wait(label, fn) {
    const until = Date.now() + 30000;
    while (Date.now() < until) { if (await fn()) return; await _waitMs(100); }
    throw Error('Timeout: ' + label);
  }
  const invoke = (channel, payload) => c.eval(`ipcRenderer.invoke(${j(channel)},${j(payload)})`);
  async function click(sid) {
    const selector = `.session-item[data-session-id="${sid}"]`;
    await wait('row ' + sid, () => c.eval(`!!document.querySelector(${j(selector)})`));
    const point = await c.eval(`(() => { const e=document.querySelector(${j(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await c.send('Page.bringToFront');
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await wait('selection', () => c.eval(`activeSessionId===${j(sid)}`));
  }
  const state = sid => c.eval(`(() => { const s=sessions.get(${j(sid)}); const row=document.querySelector('.session-item[data-session-id="'+${j(sid)}+'"]'); let n=row; while(n && !n.classList.contains('session-sec-header'))n=n.previousElementSibling; return {backend:s.runtimeBackend,state:s.nativeRuntime?.state,turn:s.nativeRuntime?.turnId,unread:s.unreadCount,ready:s.replyReady,section:n?.className,badge:!!row?.querySelector('.sl-unread-badge'),clock:s._attentionClock}; })()`);
  async function send(sid, text) {
    const old = await c.eval(`sessions.get(${j(sid)}).lastCompletedAt || 0`);
    const receipt = await invoke('session:send-prompt', { sessionId: sid, text });
    assert.equal(receipt.ok, true, j(receipt));
    await wait('completed', () => c.eval(`sessions.get(${j(sid)})?.nativeRuntime?.state==='completed' && sessions.get(${j(sid)}).lastCompletedAt>${old}`));
    await wait('sidebar completion', () => c.eval(`document.querySelector('.session-item[data-session-id="'+${j(sid)}+'"]')?.dataset.runtimeState==='completed'`));
  }
  try {
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), windowMode: 'hidden', extraEnv: {
      HUB_ACP_UI_FIXTURE: '1', AI_HUB_WORKSPACE_ROOT: temp,
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(root, 'tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(root, 'tests/fixtures/codex-app-server.js'),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => c.eval('typeof sessions!=="undefined" && !!window.WorkspaceController'));
    const anchor = await invoke('create-session', { kind: 'codex', opts: { cwd: workspace, title: 'Unread control', mcpProfile: 'none' } });
    for (const kind of ['claude', 'codex', 'qwen', 'deepseek-acp', 'glm']) {
      const created = await invoke('create-session', { kind, opts: { cwd: workspace, title: kind + ' unread', mcpProfile: 'none' } });
      assert.ok(created.id, j(created));
      assert.ok(['claude-stream-json', 'codex-app-server', 'acp'].includes(created.runtimeBackend), 'requires protocol fixture backend');
      const sid = created.id;
      await click(anchor.id);
      await send(sid, 'fixture:normal first');
      const row = { kind, sid, first: await state(sid) };
      result.rows.push(row);
      if (baseline) { console.log(j(row)); continue; }
      await wait(kind + ' unread', async () => (await state(sid)).badge);
      row.first = await state(sid);
      assert.equal(row.first.unread, 1, kind);
      assert.match(row.first.section, /sec-unread/, kind);
      // Real metadata broadcast after completion must not erase local unread.
      await invoke('rename-session', { sessionId: sid, title: kind + ' renamed unread' });
      await wait('renamed', () => c.eval(`sessions.get(${j(sid)}).title===${j(kind + ' renamed unread')}`));
      row.afterUpdate = await state(sid);
      assert.equal(row.afterUpdate.unread, 1, kind + ' snapshot');
      await click(sid);
      await wait('read', async () => !(await state(sid)).badge);
      assert.equal((await state(sid)).unread, 0);
      await click(anchor.id);
      await send(sid, 'fixture:normal second');
      await wait('second unread', async () => (await state(sid)).badge);
      assert.equal((await state(sid)).unread, 1, kind + ' second turn');
      await click(sid);
      await wait('focus', () => c.eval('document.hasFocus()'));
      await send(sid, 'fixture:normal seen');
      assert.equal((await state(sid)).unread, 0, kind + ' foreground');
      result.checks.push(kind + ': background completion, snapshot preservation, click read, next turn, foreground read');
      console.log('PASS ' + kind);
    }
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'sidebar.png'), Buffer.from(shot.data, 'base64'));
    result.passed = !baseline || result.rows.every(row => row.first.unread === 1 && row.first.badge);
  } finally {
    if (c) await c.close();
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'result.json'), j(result));
    console.log(j(result));
  }
  assert.equal(result.passed, true, 'provider unread matrix');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
