'use strict';
// Real pointer/keyboard interactions in an isolated Hub. Data and AI runtime
// use fixtures; no production state, clipboard or cloud prompt is touched.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, click, key } = require('./helpers/usage-refresh-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reading-'));
const out = path.resolve('artifacts', '20261004-hub-reading-codex1-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const checks = [], sleep = ms => new Promise(r => setTimeout(r, ms));
let hub, c;
async function until(expression) {
  for (const end = Date.now() + 25000; Date.now() < end;) {
    if (await c.eval(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw Error('timeout ' + expression);
}
async function shot(name) {
  const result = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function immersive(surface) {
  await until(`!document.getElementById('btn-session-immersive').hidden && !document.getElementById('btn-session-immersive').disabled`);
  await click(c, '#btn-session-immersive');
  await until(`document.querySelector(${JSON.stringify(surface)}).classList.contains('session-immersive')`);
  const box = await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(surface)}).getBoundingClientRect();return [r.x,r.y,r.width,r.height,innerWidth,innerHeight]})()`);
  assert.ok(Math.abs(box[0]) < 1 && Math.abs(box[1]) < 1 && Math.abs(box[2] - box[4]) < 1 && Math.abs(box[3] - box[5]) < 1, JSON.stringify(box));
}
async function exit() {
  await key(c, 'Escape', 'Escape', 27);
  await until(`!document.body.classList.contains('session-immersive-active') && !document.getElementById('btn-session-immersive').disabled`);
}
async function fold(host, input) {
  const text = '保留未发送草稿：中文😀';
  await click(c, input);
  await c.send('Input.insertText', { text });
  await c.eval(`window.__readingDraft=document.querySelector(${JSON.stringify(input)})`);
  await click(c, host + ' .composer-collapse');
  await until(`document.querySelector(${JSON.stringify(host)}).classList.contains('composer-is-collapsed')`);
  assert.equal(await c.eval(`document.querySelector(${JSON.stringify(input)})===window.__readingDraft`), true);
  assert.equal(await c.eval(`document.querySelector(${JSON.stringify(input)}).getClientRects().length`), 0);
  assert.ok(await c.eval(`document.querySelector(${JSON.stringify(host)}).getBoundingClientRect().height < 2`), 'collapsed chat composer occupies no row');
  await click(c, host + ' > .composer-expand');
  await until(`!document.querySelector(${JSON.stringify(host)}).classList.contains('composer-is-collapsed')`);
  assert.equal(await c.eval(`window.__readingDraft.value ?? window.__readingDraft.textContent`), text);
  checks.push(host + ': pointer folds/expands in place and preserves unsent draft');
}
(async () => {
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await getFreePort(), label: 'hub-reading', extraEnv: {
      CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { const event = JSON.parse(String(raw)); if (event.method === 'Runtime.exceptionThrown') console.error('RENDERER', event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text); });
    await c.send('Runtime.enable');
    await until(`typeof sessionImmersive !== 'undefined' && !!sessionImmersive`);
    // Stub only assistant data; navigation and all controls remain real owners.
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(name,...args)=>{
      if(name==='assistant:dialog-log')return Promise.resolve({ok:true,entries:[{id:'answer',role:'assistant',text:'已完成的助理说明，用于沉浸阅读。',at:Date.now(),lane:'fast'}],desk:null});
      if(name.startsWith('assistant:'))return Promise.resolve({ok:true,current:{label:'快答',mode:'auto',modelLabel:'测试'},profile:null});
      if(name==='writing:article-list')return Promise.resolve({ok:true,articles:[{dir:'reading-article',title:'阅读中的文章',drafts:[],createdAt:Date.now(),meetingId:'reading-group'}]});
      if(name==='writing:article-view')return Promise.resolve({ok:true,view:{dir:'reading-article',title:'阅读中的文章',idea:'已发出的写作需求',steps:{idea:true},columns:[],questions:[],meetingId:'reading-group'}});
      return invoke(name,...args);
    }})()`);
    await immersive('#terminal-panel'); await exit(); checks.push('Home has immersive entry without a session');
    await click(c, '#btn-assistant');
    await until(`!!document.querySelector('#assistant-page:not([hidden]) .composer-collapse')`);
    await fold('.ap-composer', '.ap-composer textarea');
    await immersive('#assistant-page');
    await click(c, '.ap-composer .composer-collapse');
    await shot('assistant-reading');
    await exit();
    assert.equal(await c.eval(`document.getElementById('assistant-page').hidden`), false);
    await click(c, '.ap-composer > .composer-expand');
    checks.push('Assistant immersion retains its independent conversation and composer state');
    await click(c, '#btn-home');
    await c.eval(`window.__hubE2E.addFakeSessions([0,1].map(i=>({id:'reading-member-'+i,kind:'codex',title:'阅读成员'+i,meetingId:'reading-group',status:'idle',currentModel:{id:'gpt-6-astra',label:'GPT'},effort:'low'})));meetings['reading-group']={id:'reading-group',title:'群聊沉浸阅读',scene:'general',mode:'free',groupChat:true,status:'idle',subSessions:['reading-member-0','reading-member-1'],participants:[0,1],slotSpecs:[0,1].map(i=>({kind:'codex',memberId:'m'+i,title:'阅读成员'+i})),turns:[],log:[],lastMessageTime:Date.now()};renderSessionList()`);
    await click(c, '.session-item[data-meeting-id="reading-group"]');
    await until(`document.querySelector('#mr-input-row').classList.contains('mr-group-composer')`);
    await fold('#mr-input-row', '#mr-input-box');
    await immersive('#meeting-room-panel');
    await click(c, '#mr-input-row .composer-collapse'); await shot('group-reading');
    await exit(); await click(c, '#mr-input-row > .composer-expand');
    checks.push('Group immersion and editor folding retain model controls and the draft');
    const session = await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(root)},model:'gpt-6-astra',effort:'low',mcpProfile:'none'}})`);
    await until(`activeSessionId===${JSON.stringify(session.id)} && !!document.querySelector('#terminal-panel .composer-collapse')`);
    await fold('#terminal-panel .floating-input-bar', '#terminal-panel .floating-input-box');
    await immersive('#terminal-panel');
    await click(c, '#terminal-panel .composer-collapse');
    await until(`getComputedStyle(document.getElementById('terminal-panel')).getPropertyValue('--fi-bar-h').trim()==='0px'`);
    await shot('session-reading');
    await exit(); await click(c, '#terminal-panel .composer-expand');
    checks.push('Session immersion plus folding releases all editor height; draft survives exit');
    for (const [button, surface] of [['#btn-writing','#writing-panel'],['#btn-study','#study-panel'],['#btn-ran','#ran-panel'],['#btn-research','#chuxin-panel'],['#btn-rail-accounts','#account-page'],['#btn-rail-memo','#hub-workspace'],['#btn-rail-capabilities','#hub-workspace']]) {
      await click(c, button);
      await until(`document.querySelector(${JSON.stringify(surface)}).getBoundingClientRect().height>0 && !document.querySelector(${JSON.stringify(surface)}).hidden`);
      await immersive(surface); await shot(button.slice(1)); await exit();
      if(button==='#btn-writing') {
        await until(`!!document.querySelector('.wb-basket .composer-collapse')`);
        await fold('.wb-basket', '.wb-basket textarea');
        await immersive('#writing-panel');
        await click(c, '.wb-basket .composer-collapse'); await sleep(3400);
        await click(c, '.wb-basket > .composer-expand'); await exit();
        checks.push('Writing comments remain folded across polling; draft and restore entry survive');
      }
      checks.push(button + ': mounted main interface fills viewport and Esc restores layout');
    }
    // Phone preset: the entry and expand button remain pointer-reachable.
    await click(c, '#btn-assistant');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: false });
    await click(c, '[data-display-mode="phone"]');
    await immersive('#assistant-page');
    await click(c, '.ap-composer .composer-collapse');
    await click(c, '.ap-composer > .composer-expand');
    await shot('phone-reading'); await exit();
    checks.push('430px phone preset: immersion and editor restoration are reachable');
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ ok: true, version: require('../package.json').version, checks,
      boundary: 'Isolated real Hub UI; synthetic assistant data and Codex protocol fixture; native fullscreen suppressed by desktop protection.' }, null, 2));
    console.log(JSON.stringify({ ok: true, out, checks }, null, 2));
  } catch (error) { if (c) { await shot('failure'); console.error(await c.eval(`({view:currentAppToolbarView(),surface:getReadingSurface()?.id,active:document.body.className,session:activeSessionId,meeting:activeMeetingId,group:!!meetings['reading-group'],room:document.getElementById('meeting-room-panel').style.display})`)); } throw error; }
  finally { await c?.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error); process.exitCode = 1; });
