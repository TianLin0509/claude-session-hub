'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-validation-'));
const data = path.join(root, 'data'), home = path.join(root, 'home'), codex = path.join(home, '.codex');
const art = path.resolve('artifacts/codex-review');
for (const dir of [data, codex, art]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '误粘贴的任务文字' }));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ providers: { codex: { subscription_profile: 'default', subscription_profiles: [{ id: 'default', label: '测试账号', home: codex }] } } }));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
(async () => {
  let hub, cdp;
  const wait = async fn => { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('UI timeout'); };
  const click = async selector => {
    const point = await cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), extraEnv: { CLAUDE_HUB_HOME_DIR: home, CODEX_HOME: codex, AI_HUB_WORKSPACE_ROOT: root } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait(() => cdp.eval('!!document.querySelector("#btn-rail-accounts")'));
    await click('#btn-rail-accounts');
    await wait(() => cdp.eval('!!document.querySelector("[data-tab=cli]")'));
    await click('[data-tab=cli]');
    await wait(() => cdp.eval('document.querySelector("#account-page").textContent.includes("凭据格式错误，需重新授权")'));
    assert(!(await cdp.eval('document.querySelector("#account-page").textContent')).includes('误粘贴的任务文字'));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(art, 'invalid-auth.png'), Buffer.from(shot.data, 'base64'));
    console.log('PASS account UI diagnoses invalid credentials without exposing contents');
  } finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
})().catch(e => { console.error(e); process.exitCode = 1; });
