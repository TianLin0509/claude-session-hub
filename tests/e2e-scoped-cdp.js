'use strict';
// Real Chrome, isolated profile root: a tool step attaches to its own page only. Other tabs
// and the cross-site frame inside the tool's page (where Cloudflare's challenge lives) stay
// unattached, while the old whole-browser attach is shown to reach them. Downloads still work.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { HubChrome } = require('../core/hub-chrome');
const { CDP } = require('../core/web-roundtable/cdp');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-scoped-cdp-'));
const playwright = require.resolve('playwright', { paths: [process.env.HUB_TEST_PLAYWRIGHT || 'C:/DevTools/playwright-cli-0.1.19/node_modules'] });
const env = { ...process.env, HUB_CHROME_ROOT: root };
const hub = new HubChrome({ root, env });
const entry = path.resolve(__dirname, '../core/hub-browser-tool.js');
const binding = id => ({ id, tool: id.startsWith('bridge') ? 'bridge' : 'images', identity: 'main', root, playwright });

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function run(b, args) {
  const file = path.join(root, b.id + '.cjs');
  fs.writeFileSync(file, `require(${JSON.stringify(entry)}).main(${JSON.stringify(b)});`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(Error('bad output: ' + out)); } });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let frameServer, pageServer;
  try {
    frameServer = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>cross-site frame</p>'); });
    const framePort = frameServer.address().port;
    pageServer = await serve((req, res) => {
      if (req.url === '/file') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.bin"' }); res.end(Buffer.alloc(2048, 7)); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      // localhost and 127.0.0.1 are different sites, so Chrome puts the frame in its own process.
      res.end(`<a id=dl href="/file">download</a><button id=go onclick="window.clicked=true">go</button><iframe src="http://localhost:${framePort}/frame"></iframe>`);
    });
    const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
    await hub.ensure();
    const tool = binding('images-a'), other = binding('bridge-b');
    assert.equal((await run(tool, ['open', pageUrl])).result.reused, false);
    await run(other, ['open', 'about:blank']);
    const ep = await hub.endpoint(), cdp = await CDP.connect(ep.ws, ep.port);
    const targets = async () => (await cdp.call('Target.getTargets')).targetInfos;
    let frame;
    for (let i = 0; i < 40 && !frame; i++) { frame = (await targets()).find(t => t.type === 'iframe' && t.url.includes('localhost')); if (!frame) await sleep(250); }
    assert.ok(frame, 'the cross-site frame runs as its own target');
    const ownId = JSON.parse(fs.readFileSync(path.join(root, 'tool-pages', 'images-a.json'), 'utf8')).targetId;
    const otherId = JSON.parse(fs.readFileSync(path.join(root, 'tool-pages', 'bridge-b.json'), 'utf8')).targetId;
    const attached = async () => Object.fromEntries((await targets()).filter(t => [ownId, otherId, frame.targetId].includes(t.targetId)).map(t => [t.targetId === ownId ? 'own' : t.targetId === otherId ? 'other' : 'frame', t.attached]));

    // The measurement can see the problem: the old whole-browser attach reaches all of them.
    const { chromium } = require(playwright);
    const whole = await chromium.connectOverCDP(`http://127.0.0.1:${ep.port}`, { noDefaults: true });
    await sleep(800);
    const before = await attached();
    await whole.close();
    assert.deepEqual(before, { own: true, other: true, frame: true }, 'old attach reaches other tabs and the frame');
    await sleep(500);

    // A tool step now: only its own page is attached while it runs.
    const script = path.join(root, 'slow.js');
    fs.writeFileSync(script, 'async page => { await page.waitForTimeout(3000); return { url: page.url(), frames: page.frames().length }; }');
    const step = run(tool, ['run-code', '--filename', script]);
    let during;
    for (let i = 0; i < 40; i++) { await sleep(150); during = await attached(); if (during.own) break; }
    const result = await step;
    assert.deepEqual(during, { own: true, other: false, frame: false }, 'scoped attach: own page only');
    assert.equal(result.result.url, pageUrl);

    // A tool tab parked off screen is a visible page, so Playwright's own click works (it waits
    // for animation frames, which hidden pages do not get). No clipboard is touched here.
    fs.writeFileSync(script, 'async page => { await page.locator("#go").click({ timeout: 5000 }); return { visibility: await page.evaluate(() => document.visibilityState), clicked: await page.evaluate(() => window.clicked === true) }; }');
    assert.deepEqual((await run(tool, ['run-code', '--filename', script])).result, { visibility: 'visible', clicked: true });

    // The image tool focuses its own page through a session it opens itself (menus close on blur).
    fs.writeFileSync(script, 'async page => { const s = await page.context().newCDPSession(page); await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }); const focused = await page.evaluate(() => document.hasFocus()); await s.send("Emulation.setFocusEmulationEnabled", { enabled: false }); await s.detach(); return { focused }; }');
    assert.deepEqual((await run(tool, ['run-code', '--filename', script])).result, { focused: true });

    // Downloads keep working through the scoped connection. The tool clicks from the page as the
    // image tool does: an off-screen page gets no animation frames, and synthetic focus stays off.
    const saved = path.join(root, 'saved.bin');
    fs.writeFileSync(script, `async page => { const [d] = await Promise.all([page.waitForEvent("download"), page.locator("#dl").evaluate(n => n.click())]); await d.saveAs(${JSON.stringify(saved)}); return { name: d.suggestedFilename() }; }`);
    const download = (await run(tool, ['run-code', '--filename', script])).result;
    assert.equal(download.name, 'fixture.bin');
    assert.equal(fs.statSync(saved).size, 2048);

    // A page script cannot reach the browser beyond its page.
    const pagesBefore = (await targets()).filter(t => t.type === 'page').length;
    fs.writeFileSync(script, 'async page => { try { await page.context().newPage(); return "opened"; } catch (e) { return "refused"; } }');
    assert.equal((await run(tool, ['run-code', '--filename', script])).result, 'refused');
    assert.equal((await targets()).filter(t => t.type === 'page').length, pagesBefore, 'no page was created');
    cdp.close();
    console.log('e2e-scoped-cdp: PASS', JSON.stringify({ before, during, download: download.name }));
  } catch (e) {
    console.error('e2e-scoped-cdp: FAIL', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    await hub.close().catch(() => {});
    frameServer?.close(); pageServer?.close();
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
})();
