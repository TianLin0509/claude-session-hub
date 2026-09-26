'use strict';
// Real isolated Hub + local HTTP capability fixtures. No research service or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit, listCdpTargets } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const wait = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-research-recovery-'));
const out = path.resolve('artifacts/groupchat-experience');
fs.mkdirSync(out, { recursive: true });

(async () => {
  let modern = false, hub, client;
  const evidence = { passed: false, scope: 'Isolated Hub; local HTTP capability fixtures; no production services', checks: [] };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); return;
    }
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json'); res.end('{}'); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><title>Research capability fixture</title>'
      + (modern ? '<nav>本页导航</nav><script>parent.postMessage({source:"chuxin",type:"chuxin-ready"},"*");addEventListener("hashchange",()=>parent.postMessage({source:"chuxin",type:"chuxin-view",hash:location.hash.slice(1)},"*"));</script>' : '<p>Legacy page without inner navigation</p>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const until = async (expression, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await client.eval(`Boolean(${expression})`)) return;
      await wait(100);
    }
    throw Error('timeout: ' + label);
  };
  const frameEval = async expression => {
    const target = (await listCdpTargets(hub)).find(t => t.url.startsWith(base));
    assert(target?.webSocketDebuggerUrl, 'fixture frame is exposed');
    const frame = await connectCDP(target.webSocketDebuggerUrl);
    try { return await frame.eval(expression); } finally { await frame.close(); }
  };
  const visible = selector => `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`;
  try {
    // Let the launcher reserve an independent debugging port.
    const net = require('node:net');
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'research-recovery', extraEnv: { CHUXIN_API_BASE: base, CHUXIN_WEB_BASE: base } });
    client = await connectFirstPage(hub);
    await until('document.querySelector("#btn-research") && document.querySelector(".cx-status")', 'research entry');
    await client.eval(`window.__recoveryErrors=[];addEventListener('error',e=>window.__recoveryErrors.push(String(e.message)));document.querySelector('#btn-research').click();true`);
    await until('document.querySelector("#chuxin-panel.cx-online")', 'health status');
    // Re-enter through the real tab after the configured base has loaded.
    await client.eval('document.querySelector(".cx-primary-tab[data-tab=today]").click()');
    await until(`document.querySelector('.cx-frame')?.src.startsWith(${JSON.stringify(base)})`, 'configured frame');
    await wait(6500);
    assert(await client.eval(visible('.cx-primary-nav')), 'legacy page retains Hub navigation');
    evidence.checks.push('legacy deployment keeps outer navigation');

    modern = true;
    await frameEval('location.reload();true');
    await until('document.querySelector("#chuxin-panel.cx-inner-nav")', 'new document handshake');
    assert(!(await client.eval(visible('.cx-header'))), 'online confirmed document hides duplicate header');
    evidence.checks.push('modern document confirms and hides duplicate navigation');
    await frameEval('location.hash="notes";true');
    await until('localStorage.getItem("chuxin.hub.active-tab")==="notes"', 'hash view memory');
    assert(await client.eval('document.querySelector("#chuxin-panel").classList.contains("cx-inner-nav")'));
    evidence.checks.push('same-document navigation retains confirmation and remembers view');

    modern = false;
    await frameEval('location.reload();true');
    await wait(6500);
    assert(await client.eval(visible('.cx-primary-nav')), 'reload must revoke previous document confirmation');
    evidence.checks.push('modern to legacy reload restores navigation');

    modern = true;
    await frameEval('location.reload();true');
    await until('document.querySelector("#chuxin-panel.cx-inner-nav")', 'second modern document');
    // Inject only the rejected IPC boundary; UI status handling remains production code.
    await client.eval(`window.__originalInvoke=require('electron').ipcRenderer.invoke;require('electron').ipcRenderer.invoke=function(channel,...args){return channel==='chuxin:status'?Promise.reject(new Error('fixture status unavailable')):window.__originalInvoke.call(this,channel,...args)};document.querySelector('#btn-home').click();document.querySelector('#btn-research').click();true`);
    await until('document.querySelector(".cx-status")?.textContent.includes("状态检测失败")', 'status rejection');
    assert(await client.eval(visible('.cx-header')), 'status failure must expose recovery header');
    evidence.checks.push('rejected status IPC exposes recovery controls');
    await client.eval(`require('electron').ipcRenderer.invoke=window.__originalInvoke;document.querySelector('#btn-home').click();document.querySelector('#btn-research').click();true`);
    await until('document.querySelector("#chuxin-panel.cx-online")', 'status recovery');
    assert(!(await client.eval(visible('.cx-header'))));
    assert.deepEqual(await client.eval('window.__recoveryErrors'), []);
    evidence.checks.push('status recovery restores compact view without renderer errors');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'research-recovery.png'), Buffer.from(shot.data, 'base64'));
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    if (client) evidence.ui = await client.eval('document.body.innerText.slice(-7000)');
    if (hub) evidence.logs = hub.log();
    throw error;
  }
  finally {
    if (client) await client.close();
    if (hub) evidence.quit = await gracefulQuit(hub);
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'research-recovery.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
