'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, waitFor, seedUsageData, click, key } = require('./helpers/usage-refresh-fixture');
const { setStaticSidebarLayout, measureQuota } = require('./helpers/sidebar-quota-geometry');
const OUT = path.resolve(__dirname, '../output/playwright/sidebar-insights');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-insights-'));
  let hub; let cdp;
  const evidence = { checks: [], scope: 'Real isolated Hub + native CDP pointer/keyboard. Provider quota and egress fixtures; real Windows resources.' };
  const check = (name, value) => { assert.ok(value, name); evidence.checks.push(name); console.log('PASS', name); };
  const settled = collapsed => waitFor(cdp, `(() => { const root=document.querySelector('#sidebar-insights'); const content=document.querySelector('#sidebar-insights-content'); return root.classList.contains('is-collapsed')===${collapsed} && !content.getAnimations().some(a=>a.playState==='running') && ${collapsed ? 'content.getBoundingClientRect().height < 1' : 'content.getBoundingClientRect().height > 200'}; })()`);
  const geometry = () => cdp.eval(`(() => { const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width};};return {root:box('sidebar-insights'),content:box('sidebar-insights-content'),list:box('session-list')}; })()`);
  const shot = async (name, full = false) => {
    const clip = await cdp.eval(`(() => {const r=document.querySelector('#sidebar-insights').getBoundingClientRect();return {x:r.x,y:Math.max(0,r.bottom-380),width:r.width,height:Math.min(r.bottom,380),scale:1};})()`);
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, ...(full ? {} : { clip }) });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const fixture = seedUsageData(dataDir, 'regression');
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), label: 'sidebar-insights', windowMode: 'visible', extraEnv: {
      CLAUDE_HUB_E2E: '1',
      APPDATA: fixture.fakeAppData,
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ foreign: { ok: true, ip: '203.0.113.10', countryCode: 'US', country: 'United States', city: 'Los Angeles' }, domestic: { ok: true, ip: '192.0.2.20', countryCode: 'CN', country: 'China', city: 'Beijing' } }),
    } });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `document.querySelectorAll('.sidebar-quota-provider').length===4 && !!document.querySelector('.strip-resource')`);
    check('isolated hook server listening', hub.log().some(line => line.includes('hook server listening')));
    await setStaticSidebarLayout(cdp, 340, 1);
    await settled(false);
    await cdp.eval(`window.insightsClicks=[];document.querySelector('#sidebar-insights-toggle').addEventListener('click',event=>window.insightsClicks.push(event.isTrusted))`);
    await cdp.eval('refreshSystemResourceUsage(true)');
    await waitFor(cdp, `!!systemResourceUsage.network`);
    await waitFor(cdp, `Date.now()-systemResourceUsage.network.sampledAt > 2600`);
    await cdp.eval('refreshSystemResourceUsage(true)');
    await waitFor(cdp, `systemResourceUsage.network.status === 'ok'`);
    await shot('expanded-dark');
    evidence.expanded = await geometry();
    const type = await cdp.eval(`({label:getComputedStyle(document.querySelector('.strip-resource')).fontSize,value:getComputedStyle(document.querySelector('.strip-resource b')).fontSize,route:getComputedStyle(document.querySelector('.strip-route-row')).fontSize})`);
    check('resource type increased to 13px / 16px; route 12px', type.label === '13px' && type.value === '16px' && type.route === '12px');
    await click(cdp, '.rail-usage-button');
    await waitFor(cdp, `!document.querySelector('#rail-usage-popover').hidden`);
    check('quota details remain visible through the wrapper', await cdp.eval(`(() => {const e=document.querySelector('#rail-usage-popover'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+20,r.y+20));})()`));
    // Capture the real collapse transition, without disabling product animation.
    // Slow playback through CDP so a loaded host cannot skip the entire 200ms
    // transition between two frames. Product duration/styles remain unchanged.
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.2 });
    evidence.motion = await cdp.eval(`({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,transition:getComputedStyle(document.querySelector('#sidebar-insights-content')).transition})`);
    evidence.motion.cdpPlaybackRate = 0.2;
    await cdp.eval(`window.insightsFrames=[]; document.querySelector('#sidebar-insights-toggle').addEventListener('click',()=>{const start=performance.now();const collect=()=>{const r=document.querySelector('#sidebar-insights').getBoundingClientRect();window.insightsFrames.push({at:performance.now()-start,top:r.top,bottom:r.bottom,height:r.height});if(performance.now()-start<1500)requestAnimationFrame(collect);};collect();},{once:true})`);
    await click(cdp, '#sidebar-insights-toggle');
    await settled(true);
    evidence.collapsed = await geometry();
    check('whole area collapses to a 33px bottom handle', evidence.collapsed.root.height <= 34 && evidence.collapsed.content.height < 1);
    check('bottom stays anchored, session list reclaims the released height', Math.abs(evidence.expanded.root.bottom - evidence.collapsed.root.bottom) < 1 && Math.abs(evidence.collapsed.list.height - evidence.expanded.list.height - evidence.expanded.content.height) < 2);
    check('all hidden controls inert and quota popover closed', await cdp.eval(`document.querySelector('#sidebar-insights-content').inert && document.querySelector('#rail-usage-popover').hidden && document.querySelector('#sidebar-insights-toggle').getAttribute('aria-expanded')==='false'`));
    check('collapse preference persisted', await cdp.eval(`localStorage.getItem('hub.sidebarInsightsCollapsed')==='true'`));
    await shot('collapsed-dark');
    const sampleBefore = await cdp.eval('systemResourceUsage.sampledAt');
    await cdp.eval('refreshSystemResourceUsage(true)');
    check('collapsed resource panel skips polling', sampleBefore === await cdp.eval('systemResourceUsage.sampledAt'));
    evidence.animation = await cdp.eval('window.insightsFrames');
    check('real downward collapse animation sampled', evidence.animation.some(frame => frame.height > evidence.collapsed.root.height + 2 && frame.height < evidence.expanded.root.height - 2));
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    check('toggle click was trusted', await cdp.eval('window.insightsClicks.length===1 && window.insightsClicks.every(Boolean)'));
    await cdp.send('Page.reload');
    await waitFor(cdp, `typeof sidebarInsights !== 'undefined' && !!document.querySelector('.sidebar-quota-provider')`);
    await settled(true);
    check('reload restores collapsed preference', true);
    await click(cdp, '#sidebar-insights-toggle');
    await settled(false);
    await waitFor(cdp, `!!systemResourceUsage.network`);
    check('expand restores all 4 providers and both resource controls', await cdp.eval(`document.querySelectorAll('.sidebar-quota-provider').length===4 && document.querySelectorAll('[data-resource-kind]').length===2 && !document.querySelector('#sidebar-insights-content').inert`));
    // Native keyboard activation must work with focus still on the toggle.
    await key(cdp, 'Enter', 'Enter', 13); await settled(true);
    await key(cdp, 'Enter', 'Enter', 13); await settled(false);
    check('keyboard Enter toggles collapse and expand', true);
    await click(cdp, '.sidebar-quota-provider[data-provider="codex"]');
    await waitFor(cdp, `accountUsageController.getSnapshot().refresh.providers.codex.result`);
    check('provider refresh still works after collapse/reload/expand', true);
    evidence.geometry = [];
    for (const zoom of [1, 1.25]) for (const width of [280, 340, 440]) {
      await setStaticSidebarLayout(cdp, width, zoom);
      const quota = await measureQuota(cdp);
      check(`quota readable without overlap at ${width}/${zoom}`, !quota.overlaps.length && !quota.overflow.length);
      const layout = await cdp.eval(`(() => {const root=document.querySelector('#sidebar-strip'),r=root.getBoundingClientRect();const nodes=[...root.querySelectorAll('.strip-resource,.strip-route-row,.strip-transfer>span')];return nodes.map(e=>{const b=e.getBoundingClientRect();return {name:e.className,width:b.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,left:b.left,right:b.right,inside:b.left>=r.left-.5&&b.right<=r.right+.5};});})()`);
      check(`resource rows do not overflow at ${width}/${zoom}`, layout.every(row => row.inside && row.scrollWidth <= row.clientWidth + 1));
      evidence.geometry.push({ width, zoom, quota, layout });
    }
    await setStaticSidebarLayout(cdp, 340, 1);
    await cdp.eval(`themeController.setTheme('claude')`);
    await shot('expanded-light');
    await click(cdp, '#sidebar-insights-toggle'); await settled(true);
    await shot('collapsed-light');
    check('light theme collapse works', true);
    evidence.ok = true;
  } catch (error) {
    evidence.error = error.stack; console.error(error); process.exitCode = 1;
    if (cdp) await shot('failure', true).catch(() => {});
    if (hub) console.error(hub.log().slice(-25).join('\n'));
  } finally {
    if (cdp) await cdp.close();
    if (hub) evidence.shutdown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, shutdown: evidence.shutdown, output: OUT }));
  }
})();
