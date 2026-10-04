'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { inside } = require('../core/disk-release-policy');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-disk-release-e2e-'));
const dataDir = path.join(root, 'data');
const cleanupRoot = path.join(root, 'cleanup');
const output = path.join(__dirname, '..', 'artifacts', '20261004-disk-release-codex2');
function fixture(name, size, old = true) {
  const file = path.join(cleanupRoot, name, 'data', 'cache', 'session-search-v3.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(size, 7));
  if (old) { const time = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, time, time); }
  return file;
}
function cleanup() {
  assert.ok(inside(os.tmpdir(), root) && path.basename(root).startsWith('hub-disk-release-e2e-'));
  const stack = [root]; const dirs = [];
  while (stack.length) {
    const folder = stack.pop(); if (!fs.existsSync(folder)) continue; dirs.push(folder);
    for (const name of fs.readdirSync(folder)) {
      const item = path.join(folder, name); const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) { try { fs.unlinkSync(item); } catch { fs.rmdirSync(item); } }
      else if (stat.isDirectory()) stack.push(item);
      else { try { fs.unlinkSync(item); } catch {} }
    }
  }
  for (const folder of dirs.reverse()) { try { fs.rmdirSync(folder); } catch {} }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function waitFor(client, expression, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  const state = await client.eval(`document.querySelector('#disk-release-panel')?.textContent || document.body.innerText.slice(0,500)`);
  throw new Error(`Timeout waiting for ${expression}: ${state}`);
}
async function click(client, selector) {
  const point = await client.eval(`(() => {const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element missing'); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function screenshot(client, name) {
  const captured = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(output, name); fs.writeFileSync(file, Buffer.from(captured.data, 'base64')); return file;
}

(async () => {
  let hub; let client; const captures = [];
  try {
  const removable = fixture('hub-writing-complete', 4 * 1024 ** 2);
  const changed = fixture('hub-writing-changed', 1024 ** 2);
  const recent = fixture('hub-writing-recent', 1024, false);
  const linked = fixture('hub-writing-linked', 1024);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'important.txt'); fs.writeFileSync(sentinel, 'outside remains intact');
  const link = path.join(path.dirname(path.dirname(path.dirname(linked))), 'external-link');
  for (let attempt = 0; ; attempt++) {
    try { fs.symlinkSync(outside, link, 'junction'); break; }
    catch (error) {
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === outside) break;
      if (error.code !== 'EBUSY' || attempt >= 4) throw error;
      await _waitMs(250);
    }
  }
  fs.mkdirSync(output, { recursive: true });
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'disk-release',
      extraEnv: { CLAUDE_HUB_E2E: '1', HUB_DISK_RELEASE_TEST_ROOT: cleanupRoot,
        HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', HUB_SESSION_SEARCH_PREWARM: '0',
        CODEX_HOME: path.join(root, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await waitFor(client, `document.querySelector('#sidebar-strip .strip-disk')`);
    await click(client, '#sidebar-strip .strip-disk');
    await waitFor(client, `!document.querySelector('#disk-release-panel').hidden && document.querySelector('[data-dr-review]')`);
    assert.equal(await client.eval(`document.querySelector('#memory-release-panel').hidden`), true, 'disk entry must not open memory panel');
    assert.equal(await client.eval(`document.querySelectorAll('#disk-release-panel input[data-dr-key]:checked').length`), 2,
      `only the two old safe fixtures should be selected: ${await client.eval("document.querySelector('#disk-release-panel').textContent")}`);
    assert.equal(await client.eval(`(() => {const r=document.querySelector('#disk-release-panel').getBoundingClientRect();return r.top>=0 && r.left>=0 && r.bottom<=innerHeight && r.right<=innerWidth;})()`), true);
    assert.match(await client.eval(`document.querySelector('#disk-release-panel').textContent`), /5\.0 MB/);
    captures.push(await screenshot(client, '20261004-disk-release-list-codex2.png'));
    console.log('PASS disk click opens correct panel, physical sizes visible, recent and linked data protected');

    await click(client, '[data-dr-review]');
    await waitFor(client, `document.querySelector('[data-dr-confirm]')`);
    fs.appendFileSync(changed, 'new work after scan');
    captures.push(await screenshot(client, '20261004-disk-release-confirm-codex2.png'));
    await click(client, '[data-dr-confirm]');
    await waitFor(client, `document.querySelector('#disk-release-panel .dr-result')`);
    assert.equal(fs.existsSync(removable), false, 'confirmed unchanged data really deleted');
    assert.equal(fs.existsSync(changed), true, 'changed file survives revalidation');
    assert.equal(fs.existsSync(recent), true, 'recent data stays intact');
    assert.equal(fs.existsSync(linked), true, 'linked directory stays intact');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside remains intact');
    assert.match(await client.eval(`document.querySelector('#disk-release-panel').textContent`), /已处理 1\/2 项/);
    captures.push(await screenshot(client, '20261004-disk-release-result-codex2.png'));
    console.log('PASS real mouse selection/review/confirm deletes approved files, changed and external files remain');

    await click(client, '#sidebar-strip [data-resource-kind="memory"]');
    await waitFor(client, `!document.querySelector('#memory-release-panel').hidden`);
    assert.equal(await client.eval(`document.querySelector('#disk-release-panel').hidden`), true);
    await click(client, '#sidebar-strip .strip-disk');
    await waitFor(client, `!document.querySelector('#disk-release-panel').hidden`);
    assert.equal(await client.eval(`document.querySelector('#memory-release-panel').hidden`), true);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(client, `document.querySelector('#disk-release-panel').hidden`);
    await client.eval(`document.querySelector('#sidebar-strip .strip-disk').focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(client, `!document.querySelector('#disk-release-panel').hidden`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 80, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 80, button: 'left', clickCount: 1 });
    await waitFor(client, `document.querySelector('#disk-release-panel').hidden`);
    console.log('PASS memory entry preserved, panels mutually close, Escape/Enter/outside click work');

    const forged = await client.eval(`ipcRenderer.invoke('execute-disk-release', {scanId:'forged', keys:['${sentinel.replaceAll('\\','\\\\')}'], confirmed:true})`);
    assert.equal(forged.ok, false); assert.equal(fs.existsSync(sentinel), true);
    const evidence = { ok: true, fixtureData: true, screenshots: captures, protected: ['recent files', 'changed files', 'directory links', 'outside sentinel'], realDeletion: true, backgroundHubPid: hub.pid };
    fs.writeFileSync(path.join(output, '20261004-disk-release-e2e-codex2.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log('E2E PASS', JSON.stringify(evidence));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    cleanup();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
