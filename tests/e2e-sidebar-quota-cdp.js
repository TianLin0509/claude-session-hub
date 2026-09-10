'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, seedUsageData, waitFor, click, key } = require('./helpers/usage-refresh-fixture');
const { measureQuota, setStaticSidebarLayout, waitForSidebarLayout,
  assertSidebarLayout } = require('./helpers/sidebar-quota-geometry');
const {runSidebarAnimation}=require('./helpers/sidebar-quota-animation');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_QUOTA_EVIDENCE_DIR || path.join(ROOT, 'artifacts', '20260910-sidebar-quota-a'));

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-quota-a-'));
  const fixture = seedUsageData(dataDir, 'regression');
  const configPath = path.join(dataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.proxy = { http: 'http://127.0.0.1:9' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const networkFixture = {
    foreign: { ok: true, ip: '203.0.113.10', countryCode: 'US', country: 'United States', city: 'Los Angeles' },
    domestic: { ok: true, ip: '192.0.2.20', countryCode: 'CN', country: 'China', city: 'Beijing' },
  };
  let hub, cdp;
  const evidence = { root: ROOT, sha: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(), dataDir, checks: [], geometry: [], fixture: 'Controlled Codex app-server + cached Claude/DeepSeek + egress probe; real Hub UI/IPC/services and real system telemetry' };
  const check = (name, condition) => { assert.ok(condition, name); evidence.checks.push(name); console.log('PASS', name); };
  const btn = p => `.sidebar-quota-provider[data-provider="${p}"] .sidebar-quota-refresh`;
  const shot = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  try {
    const port = await getFreePort();
    hub = await launchIsolatedHub({ dataDir, port, label: 'sidebar-quota-a', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E:'1', APPDATA: fixture.fakeAppData, CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify(networkFixture) } });
    evidence.pid = hub.pid; evidence.cdpPort = port;
    cdp = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `document.querySelectorAll('.sidebar-quota-refresh').length === 3`);
    await waitFor(cdp, `accountUsageController.getSnapshot().codex?.source === 'app-server'`);
    await waitFor(cdp, `document.querySelector('.strip-location').textContent.includes('洛杉矶')`);
    check('isolated hook server started', hub.log().some(line => line.includes('hook server listening')));
    check('no production meetings', (await cdp.eval(`ipcRenderer.invoke('get-meetings')`)).length === 0);
    const values = await cdp.eval(`Array.from(document.querySelectorAll('.sidebar-quota-value'), e=>e.textContent)`);
    assert.deepStrictEqual(values, ['0%', '86%', '93%', '¥60.60']);
    check('remaining percentages and weekly-only Codex mapping', true);
    check('no visible quota ring in rail', await cdp.eval(`!document.querySelector('#scene-rail #rail-usage') && getComputedStyle(document.querySelector('.rail-usage-ring')).display === 'none'`));
    await waitFor(cdp, `Number.isFinite(systemResourceUsage?.cpuPct) && Number.isFinite(systemResourceUsage?.memoryPct)`);
    const telemetry = await cdp.eval(`({ text:document.querySelector('.strip-resources').textContent, sample:systemResourceUsage, location:document.querySelector('.strip-network').textContent })`);
    check('CPU and memory numeric values match actual sample', telemetry.text.includes(Math.round(telemetry.sample.cpuPct) + '%') && telemetry.text.includes(Math.round(telemetry.sample.memoryPct) + '%'));
    check('VPN uses Chinese city and hides IP', telemetry.location.includes('美国 洛杉矶') && !/\d+\.\d+\.\d+\.\d+/.test(telemetry.location));
    evidence.telemetry = telemetry;
    await shot('A-default');
    evidence.layoutMode='Hidden static flow disables sidebar transitions. After teardown a separate visible isolated window verifies unmodified product animations.';
    for (const zoom of [1, 1.25]) {
      for (const width of [280, 340, 380, 440]) {
        // Layout stress only; CSS sizes change, no product state or data is bypassed.
        const settled=await setStaticSidebarLayout(cdp,width,zoom);
        const geometry = await cdp.eval(`(() => {
          const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
          const quota=document.querySelector('.sidebar-quota');
          const providers=[...document.querySelectorAll('.sidebar-quota-provider')];
          const elements=[...document.querySelectorAll('.sidebar-quota-name,.sidebar-quota-value,.sidebar-quota-refresh')];
          return { quota:rect(quota), providers:providers.map(rect), resources:rect(document.querySelector('.strip-resources')), network:rect(document.querySelector('.strip-network')),
            overflow:elements.filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('.sidebar-quota-provider').getBoundingClientRect();return r.x<p.x-.5||r.right>p.right+.5;}).map(e=>e.className),
            buttonWidths:[...document.querySelectorAll('.sidebar-quota-refresh')].map(e=>e.getBoundingClientRect().width) };
        })()`);
        assert.deepStrictEqual(geometry.overflow, [], `overflow at ${width}/${zoom}`);
        geometry.adjacent = await measureQuota(cdp);
        geometry.stability=settled.stability;
        assertSidebarLayout(geometry.adjacent,width,zoom);
        assert.deepStrictEqual(geometry.adjacent.overlaps, [], `adjacent overlap at ${width}/${zoom}`);
        assert.deepStrictEqual(geometry.adjacent.overflow, [], `leaf overflow at ${width}/${zoom}`);
        assert.strictEqual(geometry.providers[1].y, geometry.providers[2].y);
        assert.ok(geometry.providers[0].bottom <= geometry.providers[1].y + 1);
        assert.ok(geometry.quota.bottom <= geometry.resources.y);
        assert.ok(geometry.resources.bottom <= geometry.network.y + 1);
        evidence.geometry.push({ width, zoom, ...geometry });
      }
    }
    check('280/340/380/440 widths at 100% and 125%', true);
    await setStaticSidebarLayout(cdp,380,1);
    await shot('A-wide');

    const snapshot = () => cdp.eval(`accountUsageController.getSnapshot()`);
    const requests = () => fs.readFileSync(fixture.controlPath + '.requests', 'utf8').trim().split('\n').length;
    const initial = await snapshot(), initialReads = requests();
    await click(cdp, btn('claude'));
    await waitFor(cdp, `!!accountUsageController.getSnapshot().refresh.providers.claude.result`);
    check('Claude cached snapshot stays explicitly old', (await snapshot()).claude.lastSeen === initial.claude.lastSeen
      && (await cdp.eval(`document.querySelector('.sidebar-quota-feedback').textContent`)).includes('未取得新数据'));
    check('Claude refresh does not query Codex', requests() === initialReads);
    const statusline = JSON.parse(fs.readFileSync(path.join(dataDir, 'statusline-cache.json'), 'utf8'));
    statusline['session-usage-e2e'].ts = Date.now(); statusline['session-usage-e2e'].usage5h.pct = 20;
    // A drop from 101% to 20% is valid only in a new fixed 5h window.
    statusline['session-usage-e2e'].usage5h.resetsAt = Date.now() + 5 * 3600000;
    fs.writeFileSync(path.join(dataDir, 'statusline-cache.json'), JSON.stringify(statusline));
    await click(cdp, btn('claude'));
    await waitFor(cdp, `accountUsageController.getSnapshot().claude.usage5h.pct === 20`);
    check('Claude newer disk snapshot updates via UI and IPC', (await cdp.eval(`document.querySelector('.sidebar-quota-value').textContent`)) === '80%');
    // Hold the fixture response until both duplicate clicks have actually been
    // delivered. A fixed 1200ms response can finish before the second CDP click.
    const releasePath=path.join(dataDir,'release-codex-response');
    fs.writeFileSync(fixture.controlPath, JSON.stringify({ mode: 'ring', percent: 66, releasePath }));
    const before = await snapshot(), readsBefore = requests();
    await click(cdp, btn('codex'));
    await waitFor(cdp, `accountUsageController.getSnapshot().refresh.providers.codex.inFlight`);
    await waitFor(cdp, `require('fs').readFileSync(${JSON.stringify(fixture.controlPath + '.requests')},'utf8').match(/read/g).length > ${readsBefore}`);
    await click(cdp, btn('codex'));
    await click(cdp, btn('deepseek'));
    evidence.pendingRefresh=await snapshot();
    evidence.requestsBeforeRelease=requests()-readsBefore;
    assert.ok(evidence.pendingRefresh.refresh.providers.codex.inFlight, 'Codex response stays pending during duplicate clicks');
    assert.strictEqual(evidence.requestsBeforeRelease,1,'one Codex request before releasing fixture response');
    fs.writeFileSync(releasePath,'release');
    await waitFor(cdp, `!accountUsageController.getSnapshot().refresh.providers.codex.inFlight && !!accountUsageController.getSnapshot().refresh.providers.codex.result`);
    const after = await snapshot();
    check('Codex UI duplicate requests coalesce', requests() - readsBefore === 1);
    check('Codex refresh updates selected provider only', after.codex.usage5h.pct === 66 && after.claude.lastSeen === before.claude.lastSeen && after.deepseek.lastSeen === before.deepseek.lastSeen);
    check('DeepSeek missing key fails truthfully while Codex finishes', !!after.refresh.providers.deepseek.error && !after.refresh.providers.codex.error);
    evidence.refresh = { before, after };
    await shot('A-independent-refresh');
    fs.writeFileSync(fixture.controlPath, JSON.stringify({ error: true }));
    await click(cdp, btn('codex'));
    await waitFor(cdp, `!!accountUsageController.getSnapshot().refresh.providers.codex.error`);
    const failure = await snapshot();
    check('Codex failure preserves observation and value', failure.codex.lastSeen === after.codex.lastSeen && failure.codex.usage5h.pct === after.codex.usage5h.pct);
    check('error feedback names provider', (await cdp.eval(`document.querySelector('.sidebar-quota-feedback').textContent`)).includes('Codex 刷新失败'));
    evidence.failure = failure.refresh.providers;
    await shot('A-refresh-failure');

    await click(cdp, '.sidebar-account-usage .rail-usage-button');
    await waitFor(cdp, `!document.querySelector('.usage-popover').hidden`);
    await click(cdp, '.usage-popover [data-action="open-memo"]');
    check('memo entry remains accessible', await cdp.eval(`getComputedStyle(document.querySelector('#memo-panel')).display !== 'none'`));
    await click(cdp, '.usage-popover [data-action="open-memo"]');
    await key(cdp, 'Escape', 'Escape', 27);
    check('Escape closes details and restores focus', await cdp.eval(`document.querySelector('.usage-popover').hidden && document.activeElement.matches('.rail-usage-button')`));
    await click(cdp, '.sidebar-account-usage .rail-usage-button');
    await click(cdp, '.usage-home');
    check('home entry remains accessible', await cdp.eval(`document.querySelector('.usage-popover').hidden`));
    await cdp.eval(`document.querySelector('#session-sidebar').style.width='';document.querySelector('#session-sidebar').style.minWidth=''`);
    // Home can collapse the sidebar. Resolve its real class/state before toggling.
    if(await cdp.eval(`document.querySelector('.app-container').classList.contains('sidebar-collapsed')`)) await click(cdp,'#btn-expand-sidebar');
    evidence.expanded=await waitForSidebarLayout(cdp,280,1);
    await click(cdp, '#btn-expand-sidebar');
    evidence.collapsed=await waitForSidebarLayout(cdp,0,1);
    await shot('A-collapsed');
    await click(cdp, '#btn-expand-sidebar');
    evidence.reexpanded=await waitForSidebarLayout(cdp,280,1);
    check('collapse and expand preserve quota controls', await cdp.eval(`document.querySelector('.sidebar-quota-refresh').getBoundingClientRect().width > 0`));
    await cdp.eval(`document.querySelector('#session-sidebar').style.width=''; document.querySelector('#session-sidebar').style.minWidth=''`);
    const terminal = await cdp.eval(`ipcRenderer.invoke('create-session', {kind:'powershell',opts:{cwd:${JSON.stringify(dataDir)},title:'A 方案真实终端'}})`);
    await waitFor(cdp, `!!document.querySelector('[data-session-id="${terminal.id}"]')`);
    await click(cdp, `[data-session-id="${terminal.id}"]`);
    await waitFor(cdp, `activeSessionId === '${terminal.id}'`);
    check('quota remains available in real shell session', await cdp.eval(`document.querySelectorAll('.sidebar-quota-refresh').length === 3 && document.querySelector('.sidebar-quota').getBoundingClientRect().height > 0`));
    await shot('A-real-session');
    const roomIds = [];
    for (let i = 0; i < 22; i++) {
      const meeting = await cdp.eval(`ipcRenderer.invoke('create-meeting', {title:'A 布局验收群 ${i + 1}',workspace:${JSON.stringify(dataDir)},slots:[]})`);
      roomIds.push(meeting.id);
    }
    const roomSelector = `[data-meeting-id="${roomIds[21]}"]`;
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(roomSelector)})`);
    await waitFor(cdp, `Object.keys(meetings).length === 22`);
    await _waitMs(600); // Let the final create event finish sorting the list before pointer hit-testing.
    await cdp.eval(`document.querySelector(${JSON.stringify(roomSelector)}).scrollIntoView({block:'nearest'})`);
    await click(cdp, roomSelector);
    await waitFor(cdp, `activeMeetingId === '${roomIds[21]}'`);
    check('quota remains available in real group view', await cdp.eval(`document.querySelector('.sidebar-quota').getBoundingClientRect().height > 0`));
    await shot('A-real-group');
    const scroll = await cdp.eval(`(() => {const e=document.querySelector('#session-list'),r=e.getBoundingClientRect();e.scrollTop=0;return {x:r.x+r.width/2,y:r.y+r.height/2,quotaY:document.querySelector('.sidebar-quota').getBoundingClientRect().y};})()`);
    await cdp.eval(`window.quotaWheelEvents=[];document.querySelector('#session-list').addEventListener('wheel',e=>window.quotaWheelEvents.push({x:e.clientX,y:e.clientY,deltaY:e.deltaY,trusted:e.isTrusted}),{passive:true})`);
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved',x:scroll.x,y:scroll.y });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseWheel', x:scroll.x,y:scroll.y,deltaX:0,deltaY:1000 });
    try { await waitFor(cdp,`document.querySelector('#session-list').scrollTop > 0`); }
    finally { evidence.scroll={before:scroll,after:await cdp.eval(`({top:document.querySelector('#session-list').scrollTop,quotaY:document.querySelector('.sidebar-quota').getBoundingClientRect().y,events:window.quotaWheelEvents})`)}; }
    check('real list wheel scroll leaves bottom quota fixed', await cdp.eval(`document.querySelector('#session-list').scrollTop > 0 && document.querySelector('.sidebar-quota').getBoundingClientRect().y === ${scroll.quotaY}`));
    await click(cdp, btn('claude'));
    await key(cdp, 'Tab', 'Tab', 9);
    check('keyboard can move from Claude refresh to Codex refresh', await cdp.eval(`document.activeElement === document.querySelector(${JSON.stringify(btn('codex'))})`));
    await shot('A-final');
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = error.stack;
    evidence.layoutEvidence=error.layoutEvidence;
    if (cdp) { try { await shot('failure'); } catch (shotError) { evidence.screenshotError = shotError.message; } }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close();
    try { if (hub) evidence.teardown = await gracefulQuit(hub); }
    catch (error) { evidence.ok = false; evidence.teardownError = error.stack; throw error; }
    finally { fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(evidence, null, 2)); }
    // Keep isolated inputs with evidence for independent review; no recursive cleanup.
  }
  try { evidence.animation=await runSidebarAnimation(path.join(OUT,'animation'),evidence.sha); }
  catch(error) {evidence.ok=false;evidence.animationError=error.stack;throw error;}
  finally {fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(evidence,null,2));}
  console.log('Sidebar quota A real Hub verification PASS:', path.join(OUT, 'verification.json'));
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
