'use strict';
// Real isolated Hub + CDP interaction. Upgrade/control states below are explicit
// UI component fixtures, not evidence of an actual backend update or takeover.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const baseline = process.argv.includes('--baseline');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quiet-notice-'));
const out = path.resolve('output/playwright/backend-update-notice-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
(async () => {
  let hub, c;
  const evidence = { baseline, scope: 'isolated Hub UI component fixtures; real CDP clicks', checks: [], passed: false };
  try {
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, windowMode: 'hidden',
      ...(baseline ? { entryPath: 'C:/Users/lintian/claude-session-hub' } : {}), extraEnv: {
        CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CLAUDE_HUB_CODEX_SHARED_RUNTIME: '1',
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
      } });
    c = await connectFirstPage(hub); await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    async function until(expr) { const end = Date.now() + 30000; while (!await c.eval(expr)) { if (Date.now() > end) throw Error('timeout: ' + expr); await sleep(75); } }
    async function click(selector) {
      const point = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    async function shot(name) { const value = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(value.data, 'base64')); }
    await until('typeof sessions!=="undefined" && typeof codexSharedStatus!=="undefined"');
    const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'codex', opts: { cwd: root, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none' } })})`);
    const sid = j(created.id);
    await until(`sessions.get(${sid})?.codexSharedControl?.role==='controller'`);
    await until(`!!document.querySelector('.session-item[data-session-id="${created.id}"]')`);
    await click(`.session-item[data-session-id="${created.id}"]`);
    await until('!!document.querySelector(".floating-input-box")');
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-box');b.textContent='请保留这条未发送的草稿';b.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    // Observe the exact renderer component used by normal runtime updates.
    await c.eval(`window.__quietRealUpdate=codexSharedStatus.update.bind(codexSharedStatus);
      window.__quietOriginal=sessions.get(${sid}).codexSharedControl;
      window.__quietFixture={...__quietOriginal,runtimeBuild:null,role:'viewer',canTransfer:true,canRecover:true,controller:{...__quietOriginal.controller,connected:false},
        backendUpgrade:{status:'legacy',reason:'共享后台尚未支持安全更新，现有工作保持运行；旧后台退出后才会加载新代码'}};
      codexSharedStatus.update=s=>__quietRealUpdate(s?.id===${sid}?{...s,codexSharedControl:__quietFixture}:s);
      updateFloatingBarState();`);
    await c.eval(`__quietFixture={...__quietFixture,role:'controller'};updateFloatingBarState()`);
    if (baseline) {
      await c.eval(`window.__quietControlClicks=0;const realInvoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,payload)=>{
        if(channel==='codex:native-action'&&payload?.action==='request-control'){__quietControlClicks++;return Promise.resolve({ok:true,result:__quietFixture});}
        return realInvoke(channel,payload);
      };`);
      const bug = await c.eval(`(()=>{const e=document.querySelector('#codex-shared-status'),a=e.querySelector('.codex-shared-status-actions');return{bannerVisible:!e.hidden,actionsHidden:a.hidden,actionsDisplay:getComputedStyle(a).display,button:e.querySelector('button.primary').textContent};})()`);
      assert.equal(bug.bannerVisible, true); assert.equal(bug.actionsHidden, true); assert.equal(bug.actionsDisplay, 'flex');
      await click('#codex-shared-status button.primary');
      await until('window.__quietControlClicks===1');
      assert.equal(await c.eval('document.querySelector("#codex-shared-status").hidden'), false);
      bug.buttonStaysDisabled = await c.eval('document.querySelector("#codex-shared-status button.primary").disabled');
      assert.equal(bug.buttonStaysDisabled, true);
      evidence.reproduction = bug; evidence.checks.push('reproduced hidden actions displayed and control click does not dismiss update banner');
      await shot('baseline');
    } else {
      await until('!!document.querySelector(".composer-secondary-actions #backend-update-notice")');
      assert.equal(await c.eval('document.querySelector("#codex-shared-status").hidden'), true);
      assert.equal(await c.eval('document.querySelector("#terminal-panel").classList.contains("shared-control-visible")'), false);
      assert.equal(await c.eval('getComputedStyle(document.querySelector(".codex-shared-status-actions")).display'), 'none');
      const chip = await c.eval(`(()=>{const e=document.querySelector('#backend-update-notice'),r=e.getBoundingClientRect();return{height:r.height,width:r.width,top:r.top,viewport:innerHeight};})()`);
      assert(chip.height > 0 && chip.height <= 30 && chip.width < 130 && chip.top > chip.viewport / 2, j(chip));
      await shot('collapsed-desktop');
      await click('.backend-update-toggle');
      await until('!document.querySelector("#backend-update-details").hidden');
      assert((await c.eval('document.querySelector("#backend-update-details").textContent')).includes('切换操作权不会更新后台'));
      assert.equal(await c.eval('document.querySelectorAll("#backend-update-details button").length'), 1);
      await shot('expanded-desktop');
      await click('.backend-update-toggle');
      await until('document.querySelector("#backend-update-details").hidden');
      // Updates are frequent; a closed explanation must stay closed and avoid
      // rewriting its subtree or moving the reader on identical snapshots.
      const mutations = await c.eval(`(async()=>{let count=0;const o=new MutationObserver(list=>count+=list.length);o.observe(document.querySelector('#backend-update-details'),{childList:true,subtree:true,characterData:true});for(let i=0;i<100;i++)codexSharedStatus.update(sessions.get(${sid}));await Promise.resolve();o.disconnect();return count;})()`);
      assert.equal(mutations, 0); assert.equal(await c.eval('document.querySelector("#backend-update-details").hidden'), true);
      await click('.backend-update-toggle'); await click('.backend-update-close');
      await until('document.querySelector("#backend-update-details").hidden');
      await click('.backend-update-toggle'); await click('.floating-input-box');
      await until('document.querySelector("#backend-update-details").hidden');
      await click('.backend-update-toggle'); await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await until('document.querySelector("#backend-update-details").hidden');
      evidence.checks.push('update info is a small composer entry; toggle, close, outside click and Escape collapse it; 100 snapshots cause no detail mutations');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'b', code: 'KeyB', modifiers: 2, windowsVirtualKeyCode: 66 });
      await until('document.querySelector("#app-container").classList.contains("sidebar-collapsed")');
      await until('document.querySelector(".session-sidebar").getBoundingClientRect().width<1');
      await click('.backend-update-toggle');
      const narrow = await c.eval(`(()=>{const r=document.querySelector('#backend-update-details').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,pageWidth:document.documentElement.scrollWidth};})()`);
      assert(narrow.left >= 0 && narrow.right <= 391 && narrow.top >= 0 && narrow.bottom < 844 && narrow.pageWidth === 390, j(narrow));
      await shot('expanded-mobile'); await click('.backend-update-close');
      await c.eval(`__quietFixture={...__quietFixture,role:'viewer',canTransfer:false,canRecover:false,transferReason:'工作中，结束后才能切换'};updateFloatingBarState()`);
      assert.equal(await c.eval('document.querySelector("#codex-shared-status").hidden'), false);
      assert.equal(await c.eval('document.querySelector("#codex-shared-status button.primary").disabled'), true);
      await c.eval(`__quietFixture={...__quietFixture,canRecover:true};updateFloatingBarState()`);
      assert.equal(await c.eval('document.querySelector("#codex-shared-status button.primary").disabled'), false);
      await c.eval(`__quietFixture={...__quietFixture,role:'controller',backendUpgrade:null};updateFloatingBarState()`);
      assert.equal(await c.eval('document.querySelector("#backend-update-notice").hidden'), true);
      assert.equal(await c.eval('document.querySelector("#codex-shared-status").hidden'), true);
      assert.equal(await c.eval('document.querySelector(".floating-input-box").textContent'), '请保留这条未发送的草稿');
      await c.eval('codexSharedStatus.update=__quietRealUpdate;updateFloatingBarState()');
      evidence.checks.push('390px explanation fits; viewer handoff remains guarded/reachable; resolved update disappears; unsent draft survives');
      evidence.geometry = { chip, narrow };
    }
    evidence.passed = true;
  } finally {
    if (c) await c.close();
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence));
    console.log(j({ ...evidence, out }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
