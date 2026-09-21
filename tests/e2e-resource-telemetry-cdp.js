'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, waitFor } = require('./helpers/usage-refresh-fixture');
const { setStaticSidebarLayout } = require('./helpers/sidebar-quota-geometry');
const OUT = path.resolve(__dirname, '../output/playwright/resource-telemetry');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resource-telemetry-'));
  let hub; let cdp;
  const evidence = { checks: [], scope: 'Real Windows telemetry, real isolated Hub IPC and trusted CDP hover; egress geography fixture only' };
  const check = (name, condition) => { assert.ok(condition, name); evidence.checks.push(name); console.log('PASS', name); };
  const hover = async kind => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 200 });
    const point = await cdp.eval(`(() => { const r=document.querySelector('[data-resource-kind="${kind}"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  };
  const screenshot = async name => {
    const clip = await cdp.eval(`(() => { const r=document.querySelector('#sidebar-strip').getBoundingClientRect(); return {x:Math.max(0,r.x-3),y:Math.max(0,r.y-290),width:Math.max(r.width+6,310),height:Math.min(r.y,290)+r.height+3,scale:1}; })()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ proxy: { http: 'http://127.0.0.1:9' } }));
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), label: 'resource-telemetry', windowMode: 'hidden', extraEnv: {
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ foreign: { ok: true, ip: '203.0.113.10', countryCode: 'US', country: 'United States', city: 'Los Angeles' }, domestic: { ok: true, ip: '192.0.2.20', countryCode: 'CN', country: 'China', city: 'Beijing' } }),
    } });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `!!document.querySelector('[data-resource-kind="cpu"]')`);
    check('hook server listening', hub.log().some(line => line.includes('hook server listening')));
    // Hidden test windows skip normal background polling. Invoke the product refresh
    // entry point; the backend and measurements remain real, with no injected values.
    await cdp.eval('refreshSystemResourceUsage(true)');
    await waitFor(cdp, `!!systemResourceUsage.network`);
    await waitFor(cdp, `Date.now()-systemResourceUsage.network.sampledAt > 2600`);
    await cdp.eval('refreshSystemResourceUsage(true)');
    await waitFor(cdp, `systemResourceUsage.network.status === 'ok'`);
    evidence.network = await cdp.eval('systemResourceUsage.network');
    check('actual physical-adapter upload/download displayed', await cdp.eval(`document.querySelector('.strip-transfer').title.includes('本机物理网卡合计') && !document.querySelector('.strip-transfer').textContent.includes('—')`));
    await setStaticSidebarLayout(cdp, 340, 1);
    await cdp.eval(`window.resourceEvents=[];for(const type of ['pointerover','pointerout','focusin','focusout','visibilitychange'])document.addEventListener(type,e=>window.resourceEvents.push({type,target:e.target.className,related:e.relatedTarget?.className,at:Date.now()}),true);addEventListener('resize',()=>window.resourceEvents.push({type:'resize',at:Date.now()}))`);
    await hover('cpu');
    await waitFor(cdp, `document.querySelector('#resource-process-tooltip:not([hidden]) .resource-tip-row')`);
    check('CPU hover shows 3 real processes', await cdp.eval(`document.querySelectorAll('#resource-process-tooltip .resource-tip-row').length === 3 && document.querySelector('#resource-process-tooltip').innerText.includes('CPU 占用 Top 3')`));
    evidence.cpuTooltip = await cdp.eval(`document.querySelector('#resource-process-tooltip').innerText`);
    await waitFor(cdp, `!document.querySelector('#resource-process-tooltip').hidden && document.querySelector('#resource-process-tooltip').innerText !== ${JSON.stringify(evidence.cpuTooltip)} && !!document.querySelector('#resource-process-tooltip .resource-tip-row')`);
    check('held hover refreshes process sample', true);
    await cdp.eval('refreshSystemResourceUsage(true)');
    check('tooltip stays open through resource refresh', await cdp.eval(`!document.querySelector('#resource-process-tooltip').hidden`));
    await screenshot('cpu-dark');
    await hover('memory');
    await waitFor(cdp, `document.querySelector('#resource-process-tooltip').innerText.includes('内存占用 Top 3')`);
    evidence.memoryTooltip = await cdp.eval(`document.querySelector('#resource-process-tooltip').innerText`);
    check('memory hover switches Top 3', evidence.memoryTooltip.includes('PID') && /MB|GB/.test(evidence.memoryTooltip));
    await screenshot('memory-dark');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 200 });
    await waitFor(cdp, `document.querySelector('#resource-process-tooltip').hidden`);
    check('leaving resource hides tooltip', true);
    evidence.geometry = [];
    for (const zoom of [1, 1.25]) {
      for (const width of [280, 340, 440]) {
        await setStaticSidebarLayout(cdp, width, zoom);
        const geometry = await cdp.eval(`(() => {
          const root=document.querySelector('#sidebar-strip'); const bounds=root.getBoundingClientRect();
          const parts=[...root.querySelectorAll('.strip-resource,.strip-route-foreign,.strip-transfer,.strip-route-domestic')].map(e=>{const r=e.getBoundingClientRect();return {name:e.className,x:r.x,right:r.right,top:r.top,bottom:r.bottom};});
          return {width:bounds.width,height:bounds.height,overflow:parts.filter(r=>r.x<bounds.x-1||r.right>bounds.right+1),parts};
        })()`);
        check(`no strip overflow at ${width}/${zoom}`, geometry.overflow.length === 0);
        const network = geometry.parts.slice(2);
        check(`network labels share one row without overlap at ${width}/${zoom}`, network[0].right <= network[1].x + .5 && network[1].right <= network[2].x + .5 && Math.max(...network.map(n=>n.top)) < Math.min(...network.map(n=>n.bottom)));
        evidence.geometry.push({ width, zoom, ...geometry });
      }
    }
    await setStaticSidebarLayout(cdp, 340, 1);
    await cdp.eval(`themeController.setTheme('claude')`);
    await hover('memory');
    await waitFor(cdp, `!document.querySelector('#resource-process-tooltip').hidden && document.querySelector('#resource-process-tooltip .resource-tip-row')`);
    await screenshot('memory-light');
    check('light theme uses the real theme controller', await cdp.eval(`themeController.getTheme() === 'claude'`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `document.querySelector('#resource-process-tooltip').hidden`);
    check('Escape dismisses process tooltip', true);
    evidence.dataDir = dataDir; evidence.pid = hub.pid; evidence.cdpPort = hub.port;
    evidence.ok = true;
  } catch (error) {
    if (cdp) evidence.failureState = await cdp.eval(`({hidden:document.hidden,tooltip:document.querySelector('#resource-process-tooltip').outerHTML,theme:document.documentElement.dataset.theme,events:window.resourceEvents})`).catch(() => null);
    evidence.error = error.stack; process.exitCode = 1; console.error(error);
    if (hub) console.error(hub.log().slice(-30).join('\n'));
  } finally {
    if (cdp) await cdp.close();
    if (hub) evidence.shutdown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, output: OUT, shutdown: evidence.shutdown }));
  }
})();
