'use strict';
// Real Chrome on a throw-away profile; websites are local fixtures; every window stays off
// screen. Proves the three ways a login check no longer blocks anyone (2026-10-07):
//   1. a headless check yields when a tool needs the browser, keeping finished results;
//   2. with the Hub Chrome running, a check runs in background tabs beside the tools;
//   3. a headless Chrome left behind with no check running is closed, not obeyed.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('node:assert/strict');
const { HubChrome } = require('../core/hub-chrome');
const { inspectAccounts } = require('../core/hub-login-check');
const { acquire } = require('../core/web-roundtable/store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-yield-'));
const out = path.resolve('artifacts/accounts-yield'); fs.mkdirSync(out, { recursive: true });
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
(async () => {
  // /in: signed in at once. /slow: a page that never shows an account, so the probe keeps looking.
  const server = http.createServer((req, res) => res.end(req.url.startsWith('/slow') ? '<html><p>loading</p></html>' : '<html><button data-testid="user-avatar">Fixture user</button></html>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sites = { deepseek: base + '/in', kimi: base + '/slow', qwen: base + '/in' };
  const fixtureSites = hub => { const real = hub.site.bind(hub); hub.site = key => sites[key] ? { name: key, url: sites[key] } : real(key); return hub; };
  const make = () => fixtureSites(new HubChrome({ root, env: { ...process.env, HUB_CHROME_ROOT: root }, proxy: '' }));
  const chrome = make();
  const evidence = { passed: false, root, checks: [] };
  const results = [];
  const run = signal => inspectAccounts({ chrome, items: ['deepseek', 'kimi', 'qwen'].map(site => ({ identity: 'main', site })), signal,
    createInspector: options => fixtureSites(new HubChrome({ ...options, proxy: '' })), onStage() {}, onResult: async (item, r) => results.push([item.site, r.state]) });
  try {
    // 1. Headless check, then a tool asks for the browser while kimi is still being read.
    const checking = run(new AbortController().signal);
    for (const end = Date.now() + 30000; !results.length && Date.now() < end;) await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(results, [['deepseek', 'signed_in']], 'the first site was confirmed headless');
    assert.equal((await chrome.endpoint()).headless, true);
    const tool = make(), t0 = Date.now();
    const ep = await tool.ensure();
    assert.equal(ep.headless, false, 'the tool got a normal Hub Chrome');
    assert.deepEqual(await checking, { yielded: true });
    assert.deepEqual(results, [['deepseek', 'signed_in']], 'nothing after the yield was concluded');
    evidence.checks.push(`tool waited ${Date.now() - t0} ms; the headless check kept deepseek, stopped at kimi, closed its browser`);
    // 2. The Hub Chrome is running for tools: the next check looks in background tabs there.
    results.length = 0;
    const before = await tool.workTabs();
    await run(new AbortController().signal);
    assert.deepEqual(results.map(r => r[0]), ['deepseek', 'kimi', 'qwen']);
    assert.equal(results[0][1], 'signed_in'); assert.equal(results[2][1], 'signed_in');
    assert.equal((await chrome.endpoint()).ws, ep.ws, 'the same browser kept running');
    assert.equal(await tool.workTabs(), before, 'the check closed its own tabs');
    evidence.checks.push('with the Hub Chrome running, a check ran in place beside the tools: ' + JSON.stringify(results));
    await tool.close();
    // 3. A headless Chrome left behind by an interrupted check: the next caller closes it.
    const stray = make(); stray.inspectionOwner = true;
    const lease = acquire('account-check', path.join(root, 'locks'));
    await stray.ensure({ headless: true });
    lease();
    assert.equal((await chrome.endpoint()).headless, true);
    const next = await make().ensure();
    assert.equal(next.headless, false, 'the orphan was replaced by a normal Hub Chrome');
    evidence.checks.push('an orphaned headless Chrome holding only markers was closed and replaced');
    // Nobody yields for a lease held by a crashed process: a clear message, not a hang.
    const held = acquire('account-check', path.join(root, 'locks'));
    try { await assert.rejects(make().waitForCheck(1000), /没有及时让出/); } finally { held(); }
    evidence.passed = true;
  } catch (e) { evidence.error = e.stack; throw e; }
  finally {
    await make().close().catch(() => {}); server.close();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
  console.log(JSON.stringify(evidence, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
