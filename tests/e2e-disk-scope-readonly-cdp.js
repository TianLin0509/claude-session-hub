'use strict';
// Explicit manual verification against the machine's real directories; no delete IPC is invoked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { inside } = require('../core/disk-release-policy');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-disk-scope-real-'));
const output = path.join(__dirname, '..', 'artifacts', '20261004-disk-scope-codex2');

async function click(client, selector) {
  const point = await client.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
}
async function waitFor(client, expression) {
  const deadline = Date.now() + 240000; let nextLog = 0;
  while (Date.now() < deadline) {
    if (await client.eval(`Boolean(${expression})`)) return;
    if (Date.now() > nextLog) { console.log(await client.eval(`document.querySelector('[data-dr-progress]')?.textContent || 'Waiting for panel'`)); nextLog = Date.now() + 15000; }
    await _waitMs(250);
  }
  throw new Error('Read-only analysis timed out');
}
async function capture(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(output, name); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
}
function cleanupOwnedRoot() {
  assert.ok(inside(os.tmpdir(), root) && path.basename(root).startsWith('hub-disk-scope-real-'));
  const stack = [root]; const dirs = [];
  while (stack.length) {
    const folder = stack.pop(); if (!fs.existsSync(folder)) continue; dirs.push(folder);
    for (const name of fs.readdirSync(folder)) {
      const target = path.join(folder, name); const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) { try { fs.unlinkSync(target); } catch { try { fs.rmdirSync(target); } catch {} } }
      else if (stat.isDirectory()) stack.push(target);
      else { try { fs.unlinkSync(target); } catch {} }
    }
  }
  for (const folder of dirs.reverse()) { try { fs.rmdirSync(folder); } catch {} }
}
(async () => {
  let hub; let client;
  try {
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
    fs.mkdirSync(output, { recursive: true });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'disk-scope-real-readonly',
      extraEnv: { CLAUDE_HUB_E2E: '1', HUB_DISK_RELEASE_TEST_ROOT: '', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', HUB_SESSION_SEARCH_PREWARM: '0',
        CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await waitFor(client, `document.querySelector('#sidebar-strip .strip-disk')`);
    await click(client, '#sidebar-strip .strip-disk');
    await waitFor(client, `document.querySelector('[data-dr-review]')`);
    const cleanupText = await client.eval(`document.querySelector('#disk-release-panel').textContent`);
    const cleanupCapture = await capture(client, '20261004-disk-scope-real-cleanup-codex2.png');
    await click(client, '[data-dr-tab="usage"]');
    await waitFor(client, `document.querySelector('.dr-usage-item')`);
    assert.equal(await client.eval(`document.querySelectorAll('#disk-release-panel input[data-dr-key]').length`), 0);
    const status = await client.eval(`ipcRenderer.invoke('get-disk-release-status')`);
    assert.equal(status.lastUsage.readOnly, true);
    assert.ok(status.lastUsage.items.some(item => item.title.includes('微信')));
    assert.ok(status.lastUsage.items.some(item => item.title.includes('AIWork')));
    const usageCapture = await capture(client, '20261004-disk-scope-real-usage-codex2.png');
    const evidence = { ok: true, realDirectories: true, readOnly: true, deletionInvoked: false,
      cleanupText, usage: status.lastUsage, screenshots: [cleanupCapture, usageCapture], backgroundHubPid: hub.pid };
    fs.writeFileSync(path.join(output, '20261004-disk-scope-real-readonly-codex2.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log('REAL READONLY E2E PASS', JSON.stringify(status.lastUsage.items.map(item => ({ title: item.title, gb: +(item.bytes / 1024 ** 3).toFixed(2), partial: item.partial }))));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    cleanupOwnedRoot();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
