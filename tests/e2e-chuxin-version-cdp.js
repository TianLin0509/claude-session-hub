'use strict';
// A running Hub keeps its iframe while the served research build changes.
// Verify actual loaded version, explicit refresh, identity and navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit, _waitMs, listCdpTargets } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', '20261010-chuxin-version-codex');
async function wait(client, expression, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await client.eval(`Boolean(${expression})`)) return;
    await _waitMs(150);
  }
  throw new Error(`timeout: ${label}`);
}
async function frameClient(hub) {
  const targets = await listCdpTargets(hub);
  const target = targets.find(t => /embed=hub/.test(t.url || '') && t.webSocketDebuggerUrl);
  assert(target, 'embedded research document must be inspectable');
  return connectCDP(target.webSocketDebuggerUrl);
}
(async () => {
  let version = '20261010.1';
  let unavailable = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/health') ? { status: 'ok', version: '1.11.0' } : {}));
    } else if (req.url.startsWith('/ui-version.json')) {
      res.setHeader('Content-Type', 'application/json');
      if (unavailable) { res.statusCode = 503; res.end('{}'); }
      else res.end(JSON.stringify({ version }));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><body><h1>作手林铛</h1>${version === '20261010.1' ? '<span>51 候选</span>' : '<button id="candidates" onclick="document.querySelector(\'output\').textContent=\'全部候选\'">51 候选</button><output></output>'}<script>parent.postMessage({source:'chuxin',type:'chuxin-ui-version',version:${JSON.stringify(version)},requestId:new URLSearchParams(location.search).get('hubUi')},'*');</script></body></html>`);
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(out, { recursive: true });
  let hub, client, embedded;
  const checks = [];
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(os.tmpdir(), `chuxin-version-${process.pid}`, 'data'), port: 25291,
      label: 'chuxin-version', extraEnv: { CLAUDE_HUB_E2E: '1', CHUXIN_API_BASE: base, CHUXIN_WEB_BASE: base } });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable'); await client.send('Page.enable');
    await wait(client, 'document.querySelector("#btn-research") && window.__chuxinShow', 'Hub ready');
    await client.eval(`document.querySelector('#btn-research').click(); document.querySelector('[data-tab="lindang"]').click()`);
    await wait(client, 'document.querySelector("#toolbar-crumb .cx-ui-version")?.textContent === "UI 20261010.1"', 'loaded version in the requested title bar');
    embedded = await frameClient(hub);
    assert.equal(await embedded.eval('document.querySelector("#candidates") === null'), true);
    checks.push('old live document reproduced; title reports loaded build');
    const before = await client.eval(`({src:document.querySelector('.cx-frame').src, workspace:localStorage.getItem('chuxin.hub.workspace')})`);
    version = '20261010.2';
    await client.eval('window.__chuxinCheckVersion()');
    await wait(client, 'document.querySelector(".cx-ui-version")?.textContent.includes("更新至 20261010.2")', 'new build announcement');
    assert.equal(await embedded.eval('document.querySelector("#candidates") === null'), true);
    assert((await client.eval('document.querySelector(".cx-ui-version").textContent')).startsWith('UI 20261010.1'), 'old document cannot claim new build');
    checks.push('new build is offered without replacing unsaved live content');
    await client.eval('document.querySelector(".cx-ui-version").click()');
    await wait(client, 'document.querySelector(".cx-ui-version")?.textContent === "UI 20261010.2"', 'explicit research refresh');
    await embedded.close(); embedded = await frameClient(hub);
    await embedded.eval('document.querySelector("#candidates").click()');
    assert.equal(await embedded.eval('document.querySelector("output").textContent'), '全部候选');
    const after = await client.eval(`({src:document.querySelector('.cx-frame').src, workspace:localStorage.getItem('chuxin.hub.workspace'), count:document.querySelectorAll('.cx-frame').length})`);
    assert.notEqual(after.src, before.src);
    assert(after.src.endsWith('#lindang'));
    assert.equal(new URL(after.src).searchParams.get('workspace'), before.workspace);
    assert.equal(after.workspace, before.workspace); assert.equal(after.count, 1);
    checks.push('refresh loads new candidate control and preserves tab, workspace and shared frame');
    await client.eval(`window.dispatchEvent(new MessageEvent('message',{origin:${JSON.stringify(base)},source:window,data:{source:'chuxin',type:'chuxin-ui-version',version:'20990101.9'}}))`);
    assert.equal(await client.eval('document.querySelector(".cx-ui-version").textContent'), 'UI 20261010.2');
    await embedded.eval(`parent.postMessage({source:'chuxin',type:'chuxin-ui-version',version:'20990101.9',requestId:${JSON.stringify(new URL(before.src).searchParams.get('hubUi'))}},'*')`);
    await _waitMs(200);
    assert.equal(await client.eval('document.querySelector(".cx-ui-version").textContent'), 'UI 20261010.2');
    checks.push('foreign windows and stale navigation receipts cannot replace version');
    unavailable = true;
    await client.eval('window.__chuxinCheckVersion()');
    assert.equal(await client.eval('document.querySelector(".cx-ui-version").textContent'), 'UI 20261010.2');
    checks.push('release lookup failure retains actual loaded build');
    await client.eval('document.querySelector("#btn-home").click()');
    await wait(client, '!document.querySelector("#toolbar-crumb .cx-ui-version")', 'other view title');
    await client.eval('document.querySelector("#btn-research").click()');
    await wait(client, 'document.querySelector(".cx-ui-version")?.textContent === "UI 20261010.2"', 'research title restored');
    checks.push('version is only attached to research view and survives view switching');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20261010-research-title-codex.png'), Buffer.from(shot.data, 'base64'));
    assert(!requests.some(r => r.method !== 'GET'), 'no write or model invocation is allowed');
    if (process.env.CHUXIN_E2E_API_BASE && process.env.CHUXIN_E2E_WEB_BASE) {
      const api = process.env.CHUXIN_E2E_API_BASE, web = process.env.CHUXIN_E2E_WEB_BASE;
      for (const url of [api, web]) assert(![3003, 3004].includes(Number(new URL(url).port)), 'real-record check must use isolated services');
      await embedded.close(); embedded = null;
      await client.close(); client = null;
      await gracefulQuit(hub); hub = null;
      hub = await launchIsolatedHub({ dataDir: path.join(os.tmpdir(), `chuxin-real-version-${process.pid}`, 'data'), port: 25292,
        label: 'chuxin-real-version', extraEnv: { CLAUDE_HUB_E2E: '1', CHUXIN_API_BASE: api, CHUXIN_WEB_BASE: web } });
      client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
      await client.send('Runtime.enable'); await client.send('Page.enable');
      await wait(client, 'document.querySelector("#btn-research") && window.__chuxinShow', 'real-record Hub ready');
      await client.eval(`document.querySelector('#btn-research').click(); document.querySelector('[data-tab="lindang"]').click()`);
      const release = await (await fetch(web + '/ui-version.json', { cache: 'no-store' })).json();
      await wait(client, `document.querySelector('.cx-ui-version')?.textContent === ${JSON.stringify('UI ' + release.version)}`, 'real document version receipt');
      embedded = await frameClient(hub);
      await wait(embedded, 'document.querySelector(".ld-funnel [data-action=ld-candidates]")', 'real history funnel');
      await embedded.eval('document.querySelector("[data-action=ld-candidates]").click()');
      await wait(embedded, 'document.querySelector("[data-count]")?.textContent === "51 只"', 'all 51 real candidates');
      const desk = await (await fetch(api + '/api/lindang/runs/20261009-030004-aee5/desk')).json();
      const row = desk.screening.rows.find(r => r.forwarded);
      await embedded.eval(`(()=>{const s=document.querySelector('[data-search]'); s.value=${JSON.stringify(row.symbol)};s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(embedded, 'document.querySelector("[data-count]")?.textContent === "1 只"', 'real candidate search');
      const text = await embedded.eval('document.querySelector("[data-rules]").textContent');
      assert(text.includes(row.source) && text.includes(row.fact) && text.includes('交给 AI'));
      checks.push('real copied history: title receipt, 51 candidates, recorded source and selection facts');
      await embedded.eval(`(()=>{const s=document.querySelector('[data-search]');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.ld-funnel').scrollIntoView();})()`);
      const frameBefore = await client.eval('document.querySelector(".cx-frame").src');
      const box = await client.eval('(()=>{const b=document.querySelector(".cx-ui-version").getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()');
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
      await wait(client, `document.querySelector('.cx-frame').src !== ${JSON.stringify(frameBefore)} && document.querySelector('.cx-ui-version')?.textContent === ${JSON.stringify('UI ' + release.version)}`, 'pointer click on title refresh');
      await embedded.close(); embedded = await frameClient(hub);
      await wait(embedded, 'document.querySelector("[data-action=ld-candidates]")', 'real page refreshed');
      await embedded.eval('document.querySelector("[data-action=ld-candidates]").click();document.querySelector(".ld-funnel").scrollIntoView()');
      await wait(embedded, 'document.querySelector("[data-count]")?.textContent === "51 只"', 'real candidate control after title refresh');
      checks.push('real Hub pointer refresh keeps LinDang route and the candidate tab works after refresh');
      const actual = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, '20261010-real-research-title-codex.png'), Buffer.from(actual.data, 'base64'));
    }
    fs.writeFileSync(path.join(out, '20261010-checks-codex.json'), JSON.stringify({ checks, writes: 0 }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks, output: out }));
  } finally {
    await embedded?.close(); await client?.close(); if (hub) await gracefulQuit(hub);
    await new Promise(r => server.close(r));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
