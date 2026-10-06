'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function wait(client, expression) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { if (await client.eval(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('界面等待超时：' + expression);
}
async function click(client, selector) {
  const rect = await client.eval(`(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if(nodes.length !== 1) throw new Error('按钮不唯一'); const r=nodes[0].getBoundingClientRect(); if(!r.width||!r.height) throw new Error('按钮不可见'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-desktop-e2e-'));
  const testRoot = path.join(temp, 'fixture'), desktop = path.join(testRoot, 'Desktop');
  await fs.mkdir(desktop, { recursive: true });
  await fs.writeFile(path.join(desktop, '桌面报告.pptx'), 'original report');
  await fs.writeFile(path.join(desktop, 'AI Hub.lnk'), 'launcher');
  const hub = await launchIsolatedHub({ dataDir: path.join(temp, 'hub-data'), port: await freePort(), label: 'desktop-organizer', extraEnv: { CLAUDE_HUB_E2E: '1', HUB_DESKTOP_ORGANIZER_TEST_ROOT: testRoot } });
  let client;
  try {
    client = await connectFirstPage(hub);
    await wait(client, "Boolean(document.getElementById('desktop-organizer-panel'))");
    const trigger = await client.eval("({label:document.getElementById('btn-desktop-organizer').textContent, title:document.getElementById('btn-desktop-organizer').title})");
    assert.match(trigger.label, /整理桌面/);
    await click(client, '#btn-desktop-organizer');
    await wait(client, "document.querySelectorAll('#desktop-organizer-panel input').length===2");
    assert.equal(await client.eval("document.querySelectorAll('#desktop-organizer-panel input:checked').length"), 1);
    const screenshotDir = path.join(__dirname, '..', 'artifacts'); await fs.mkdir(screenshotDir, { recursive: true });
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(path.join(screenshotDir, '20261006-desktop-clean-preview-codex1.png'), Buffer.from(shot.data, 'base64'));
    await click(client, '#desktop-organizer-panel [data-do="execute"]');
    await wait(client, "document.querySelector('#desktop-organizer-panel .do-message').textContent.includes('已收走 1 项')");
    await assert.rejects(fs.access(path.join(desktop, '桌面报告.pptx')));
    assert.equal(await fs.readFile(path.join(desktop, 'AI Hub.lnk'), 'utf8'), 'launcher');
    await click(client, '#desktop-organizer-panel [data-do="undo"]');
    await wait(client, "document.querySelector('#desktop-organizer-panel .do-message').textContent.includes('已还原 1 项')");
    assert.equal(await fs.readFile(path.join(desktop, '桌面报告.pptx'), 'utf8'), 'original report');
    await click(client, '#desktop-organizer-panel [data-do="close"]');
    assert.equal(await client.eval("document.getElementById('desktop-organizer-panel').hidden"), true);
    await fs.writeFile(path.join(screenshotDir, '20261006-desktop-clean-e2e-codex1.json'), JSON.stringify({ ok: true, temp, pid: hub.pid, checks: ['visible navigation', 'scan', 'default launcher retained', 'real mouse archive', 'real mouse undo', 'close'] }, null, 2));
    console.log('PASS isolated Hub mouse clicks: scan → archive → undo; launcher retained');
  } finally { if (client) await client.close(); await gracefulQuit(hub); }
})().catch(error => { console.error(error); process.exitCode = 1; });
