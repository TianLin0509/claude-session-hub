'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'sidebar-running-send');
fs.mkdirSync(out, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-send-'));
  const dataDir = path.join(temp, 'data');
  const workDir = path.join(temp, 'work');
  fs.mkdirSync(dataDir); fs.mkdirSync(workDir);
  let hub;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'sidebar-running-send',
      windowMode: 'background', extraEnv: { AI_HUB_WORKSPACE_ROOT: workDir, AGENT_STUDY_DIR: path.join(temp, 'study') } });
    const cdp = await connectFirstPage(hub);
    for (let i = 0; i < 100; i += 1) {
      if (await cdp.eval("typeof showTerminal === 'function' && typeof renderSidebarStrip === 'function'")) break;
      await _waitMs(100);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    const delay = await cdp.eval("require('electron').ipcRenderer.invoke('get-clash-proxy-delay')");
    const disk = await cdp.eval("require('electron').ipcRenderer.invoke('get-system-resource-usage',{extended:false})");
    assert.ok(Number.isFinite(disk.disk?.usagePct), '磁盘采样必须来自主进程');
    const report = { disk: disk.disk, delay, composers: {} };
    await cdp.eval(`(() => {
      systemResourceUsage = { ...systemResourceUsage, disk: ${JSON.stringify(disk.disk)}, cpuPct: 23, memoryPct: 67 };
      hubProxyInfo = { proxy: 'http://127.0.0.1:7890', clashDelay: ${JSON.stringify(delay)},
        egress: { foreign: { ok: true, countryZh:'美国', cityZh:'洛杉矶', locationLabel:'美国·洛杉矶' },
          domestic: { ok:true, countryZh:'中国', cityZh:'北京' } } };
      renderSidebarStrip();
    })()`);
    const strip = await cdp.eval("document.querySelector('#sidebar-strip').innerText");
    assert.match(strip, /硬盘/);
    assert.match(strip, new RegExp(`${disk.disk.usagePct}%`));
    if (delay.status === 'ok') assert.match(strip, new RegExp(`${delay.delayMs} ms`));
    report.strip = strip;
    for (const kind of ['codex', 'claude']) {
      const id = `sidebar-send-${kind}`;
      await cdp.eval(`(() => {
        sessions.set(${JSON.stringify(id)}, { id:${JSON.stringify(id)}, kind:${JSON.stringify(kind)}, title:'运行中补充',
          status:'running', agentRuntime:'pty', cwd:${JSON.stringify(workDir)}, createdAt:Date.now(),
          runStartedAt:Date.now()-3000, _runSource:'semantic',
          runtimeTruth:{state:'running',source:'task_started',confidence:'authoritative',observedAt:Date.now(),startedAt:Date.now()-3000,sequence:1} });
        activeSessionId=${JSON.stringify(id)}; activeMeetingId=null; currentView='pty';
        showTerminal(${JSON.stringify(id)}, {focus:false}); updateFloatingBarState();
      })()`);
      await _waitMs(200);
      const state = await cdp.eval(`(() => {
        const bar=document.querySelector('.floating-input-bar[data-session-id=${JSON.stringify(id)}]');
        const send=bar?.querySelector('.floating-input-send'), stop=bar?.querySelector('.floating-input-stop');
        const r=send?.getBoundingClientRect(), hit=r&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return {sendVisible:!!send&&!send.hidden&&r.width>0&&r.height>0,sendHit:hit===send||send?.contains(hit),
          stopVisible:stop?.classList.contains('visible'),sendTitle:send?.title};
      })()`);
      assert.equal(state.sendVisible, true, `${kind} 工作时必须显示发送键`);
      assert.equal(state.sendHit, true, `${kind} 工作时发送键必须可点击`);
      assert.equal(state.stopVisible, true, `${kind} 工作时停止键必须保留`);
      report.composers[kind] = state;
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(out, 'sidebar-running-send.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
