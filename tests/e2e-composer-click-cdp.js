'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort } = require('./helpers/usage-refresh-fixture');
const ROOT = path.resolve(__dirname, '..'), j = JSON.stringify;
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-composer-click-'));
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const out = path.join(ROOT, 'artifacts/composer-click', String(Date.now())); fs.mkdirSync(out, { recursive: true });
  let hub, c;
  const evidence = { out, rows: [], checks: [], errors: [], scope: 'Real isolated Hub + CDP clicks; provider replies and external company sync use fixtures. No external message/upload or microphone recording.' };
  async function until(label, fn) {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await fn()) return; await _waitMs(100); }
    throw Error('Timeout: ' + label);
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await getFreePort(), windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: temp,
      DASHSCOPE_API_KEY: '',
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests/fixtures/codex-app-server.js'),
    } });
    c = await connectFirstPage(hub); await c.send('Page.bringToFront');
    await until('renderer', () => c.eval('!!window.WorkspaceController'));
    const invoke = (channel, args) => c.eval(`ipcRenderer.invoke(${j(channel)},${j(args)})`);
    const session = await invoke('create-session', { kind: 'claude', opts: { cwd: workspace, title: 'Button probe', mcpProfile: 'none' } });
    const group = await invoke('create-meeting', { title: 'Buttons group', groupChat: true, scene: 'general', workspace, slots: [{ kind: 'claude', mcpProfile: 'none' }, { kind: 'codex', mcpProfile: 'none' }] });
    async function click(selector) {
      const p = await c.eval(`(() => {const e=document.querySelector(${j(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Blocked '+${j(selector)});return {x,y};})()`);
      for (const type of ['mousePressed','mouseReleased']) await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
    }
    await c.eval(`(() => {const original=ipcRenderer.invoke;ipcRenderer.invoke=function(channel,...args){if(channel==='sync-path-to-company')return Promise.resolve({success:true,filename:'AI_HUB_groupchat_provider_composer_verification_report_20260918.html'});return original.call(this,channel,...args);};})()`);
    await c.eval(`pathLinkContextMenu.runAction('sync-company',{absPath:'C:/fixture/report.html',isUrl:false})`);
    assert.equal(await c.eval(`getComputedStyle(document.querySelector('#path-link-sync-status')).pointerEvents`),'none','Visible file sync notice cannot intercept clicks');
    await until('toast faded', () => c.eval(`getComputedStyle(document.querySelector('#path-link-sync-status')).opacity==='0'`));
    // The bridge has the same lifetime bug. Exercise its real display controller
    // without contacting the external account/service.
    for (const state of ['working','error','success']) {
      await c.eval(`chatgptBridgeController.showStatus(${j('ChatGPT bridge status fixture\nverification report')},${j(state)})`);
      assert.equal(await c.eval(`getComputedStyle(document.querySelector('#chatgpt-bridge-status')).pointerEvents`),'none');
    }
    await until('bridge faded', () => c.eval(`getComputedStyle(document.querySelector('#chatgpt-bridge-status')).opacity==='0'`));
    for (const groupView of [false, true]) {
      await c.eval(groupView ? `selectMeeting(${j(group.id)})` : `selectSession(${j(session.id)})`);
      const selectors = groupView ? ['.mr-input-row .voice-mic', '#mr-workflow-btn', '#mr-send-btn'] : ['#terminal-panel .voice-mic', '#terminal-panel .floating-input-send'];
      await until('buttons', () => c.eval(`!!document.querySelector(${j(selectors[0])})`));
      for (const size of [[1440,1000], [1000,700], [1920,1080]]) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
        const row = await c.eval(`(() => { const selectors=${j(selectors)}; return selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {selector,rect:r.toJSON(),disabled:el.disabled,hit:el.contains(document.elementFromPoint(x,y)),stack:document.elementsFromPoint(x,y).slice(0,7).map(e=>({tag:e.tagName,id:e.id,cls:e.className,position:getComputedStyle(e).position,z:getComputedStyle(e).zIndex}))};}); })()`);
        evidence.rows.push({ groupView, size, buttons: row });
        assert(row.every(button=>button.hit && !button.disabled), 'All composer buttons remain reachable');
        if (!groupView) {
          const rail = await c.eval(`(() => {const e=document.querySelector('#terminal-panel .composer-rail');return {client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]};})()`);
          evidence.rows.push({groupView,size,rail});
          assert(rail.scroll[0] <= rail.client[0] && rail.scroll[1] <= rail.client[1],
            'Composer send hit area must not introduce horizontal or vertical scrollbars: '+j(rail));
        }
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `${groupView?'group':'session'}-${size[0]}.png`), Buffer.from(shot.data,'base64'));
      }
      await click(selectors[0]);
      await until('microphone settings open', () => c.eval('!!document.querySelector(".voice-settings")'));
      await click('.voice-settings .voice-actions button:last-child');
      await until('microphone settings close', () => c.eval('!document.querySelector(".voice-settings")'));
      if (groupView) {
        await click('#mr-workflow-btn');
        await until('workflow open', () => c.eval('document.querySelector("#workflow-config-modal")?.style.display!=="none" && !!document.querySelector("#wf-body textarea")'));
        await click('#workflow-config-modal .mcm-close');
        await until('workflow closed', () => c.eval('document.querySelector("#workflow-config-modal").style.display==="none"'));
      }
      const box = groupView ? '#mr-input-box' : '#terminal-panel .floating-input-box';
      await click(box); await c.send('Input.insertText', {text:'fixture:search'});
      await click(selectors[selectors.length-1]);
      await until('reply after actual send click', () => c.eval(`document.querySelector(${j(groupView?'.mr-gc-messages':'#msg-overlay')})?.textContent.includes('融合最后一处')`));
      evidence.checks.push(groupView?'Group: mic/settings, workflow modal, actual send + fixture reply':'Session: mic/settings, actual send + fixture reply');
    }
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) { evidence.errors.push(error.stack); throw error; }
  finally { fs.writeFileSync(path.join(out,'result.json'), j(evidence)); if (c) c.close(); if (hub) await gracefulQuit(hub); console.log(out); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
