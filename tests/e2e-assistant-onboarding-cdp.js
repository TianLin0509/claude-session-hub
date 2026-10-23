'use strict';
// Actual isolated Electron renderer and mouse/keyboard input; connection states
// are synthetic IPC fixtures. No installation, login or external messages.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
(async () => {
  const out = path.resolve(__dirname, '../artifacts', `20261023-onboarding-codex1-${process.pid}`); fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-onboarding-')); const result = { syntheticStates: true, realHub: true, checks: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'onboarding', windowMode: 'background', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_TEAM: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async expr => { const end = Date.now() + 20000; while (Date.now() < end) { if (await c.eval(expr) === true) return; await pause(100); } throw new Error('timeout: ' + expr); };
    const click = async selector => { const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`); assert.ok(point, selector); for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); };
    const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); };
    await until(`!!document.getElementById('btn-company-assistant')`);
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;window.__onboardingIpc=ipc;window.__onboardingOriginal=ipc.invoke.bind(ipc);window.__onboardingCalls=[];window.__onboardingState={cliFound:false,cliSearch:{state:'notfound'},auth:{state:'unknown'},settings:{chips:[]},chips:[],chat:[],brief:{by:'none',sections:[],total:0,note:'等待连接'},counts:{}};ipc.invoke=async(channel,payload)=>{if(channel==='company-assistant:status')return structuredClone(window.__onboardingState);if(channel.startsWith('company-assistant:')){window.__onboardingCalls.push({channel,payload});if(channel==='company-assistant:find-cli'&&window.__failFind)throw new Error('模拟查找失败');if(channel==='company-assistant:refresh')return structuredClone(window.__onboardingState);return {ok:true};}return window.__onboardingOriginal(channel,payload);};})()`);
    const state = async value => { await c.eval(`Object.assign(window.__onboardingState,${JSON.stringify(value)});window.__onboardingIpc.emit('company-assistant:changed',{});`); };
    await click('#btn-company-assistant'); await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='missing'`);
    await click('.ca-onboarding .ca-install-guide summary'); await until(`document.querySelector('.ca-onboarding details').open===true`);
    assert.match(await c.eval(`document.querySelector('.ca-onboarding').textContent`), /npm install -g @welink\/welink-cli/); await shot('01-install');
    await c.eval(`window.__failFind=true`); await click('.ca-onboarding [data-ca="find-cli"]'); await until(`document.querySelector('[data-slot="action-error"]').hidden===false`);
    assert.equal(await c.eval(`document.querySelector('.ca-onboarding [data-ca="find-cli"]').disabled`), false);
    await c.eval(`window.__failFind=false`); await click('.ca-onboarding [data-ca="find-cli"]'); await until(`document.querySelector('[data-slot="action-error"]').hidden===true`);
    assert.equal(await c.eval(`getComputedStyle(document.querySelector('[data-slot="action-error"]')).display`), 'none');
    await until(`document.querySelector('.ca-onboarding [data-ca="find-cli"]').disabled===false`);
    await click('.ca-onboarding [data-ca="find-cli"]'); await until(`document.querySelector('.ca-onboarding [data-ca="find-cli"]').disabled===false`);
    result.checks.push('missing: installation guide, detection retry and failure recovery');
    await state({ cliFound: true, auth: { state: 'unknown', error: '公司网络暂不可用', login: { ok: false, reason: 'error' } }, login: { ok: true, uid: 'stale' } });
    await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='unknown'`);
    await click('.ca-onboarding [data-ca="refresh"]'); await until(`document.querySelector('.ca-onboarding [data-ca="refresh"]').disabled===false`);
    await click('.ca-onboarding [data-ca="refresh"]'); await until(`document.querySelector('.ca-onboarding [data-ca="refresh"]').disabled===false`);
    await click('[data-ca="settings-tab:welink"]'); await until(`document.querySelector('[data-slot="panel"]')?.dataset.tab==='welink'`);
    assert.equal(await c.eval(`!!document.querySelector('[data-slot="panel"] [data-ca="login"]')`), false); await shot('02-unknown');
    await click('[data-ca="close-panel"]');
    await state({ auth: { state: 'needs-scan', login: { ok: false, reason: 'expired' } }, login: { ok: false } }); await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='login'`);
    await click('.ca-onboarding [data-ca="login"]'); await until(`window.__onboardingCalls.some(c=>c.channel==='company-assistant:login')`);
    result.checks.push('unknown network failure is not expired; only confirmed expiry offers QR login');
    await state({ auth: { state: 'online', login: { ok: true, uid: 'fixture' } }, login: { ok: true }, refreshedAt: Date.now() }); await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='online'`);
    await click('[data-ca="starter:0"]'); await until(`document.querySelector('.ca-input textarea').value.includes('下一场会议')`);
    await click('[data-ca="starter:1"]'); assert.match(await c.eval(`document.querySelector('.ca-input textarea').value`), /下一场会议/);
    assert.equal(await c.eval(`window.__onboardingCalls.some(c=>c.channel==='company-assistant:ask')`), false); await shot('03-ready');
    result.checks.push('starter fills a reviewable draft, preserves existing text, never auto sends');
    await state({ cliFound: false, cliSearch: { state: 'searching' } }); await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='searching'`);
    assert.equal(await c.eval(`!!document.querySelector('.ca-onboarding [data-ca="find-cli"]')`), false);
    await click('.ca-onboarding [data-ca="ppt-assist"]'); assert.match(await c.eval(`document.querySelector('.ca-input textarea').value`), /下一场会议/);
    await c.eval(`document.querySelector('.ca-input textarea').value=''`);
    await click('.ca-onboarding [data-ca="ppt-assist"]'); await until(`document.querySelector('.ca-input textarea').value.includes('已有 PPT')`);
    await c.eval(`document.querySelector('.ca-input textarea').value=''`);
    await state({ cliFound: true, auth: { state: 'online', login: { ok: true, uid: 'fixture' } } }); await until(`document.querySelector('.ca-onboarding')?.dataset.connection==='online'`);
    await click('[data-ca="starter:0"]'); await click('.ca-input button[type="submit"]');
    await until(`window.__onboardingCalls.some(c=>c.channel==='company-assistant:ask')`);
    assert.equal(await c.eval(`window.__onboardingCalls.find(c=>c.channel==='company-assistant:ask').payload.entry||''`), '');
    result.checks.push('switching from discarded PPT draft to starter clears PPT-only routing');
    for (const [width, height] of [[1440,1000],[1366,680]]) { await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); assert.equal(await c.eval(`document.documentElement.scrollWidth>innerWidth+1`), false); }
    result.checks.push('search progress, independent PPT entry and desktop widths'); result.passed = true;
  } finally { if (hub) await gracefulQuit(hub); if (c) await c.close(); fs.writeFileSync(path.join(out, '20261023-acceptance.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ out, ...result })); }
})().catch(e => { console.error(e); process.exitCode = 1; });
