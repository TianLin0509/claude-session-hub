'use strict';
// Real isolated Hub UI. Provider and context samples are controlled fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ui-compact-'));
  const out = path.resolve('output/playwright/ui-compact-' + Date.now());
  const trace = path.join(root, 'native.jsonl');
  fs.mkdirSync(out, {recursive:true});
  fs.mkdirSync(path.join(root,'data'));
  fs.mkdirSync(path.join(root,'codex'));
  const work = path.join(root, 'project');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(root,'codex/models_cache.json'), JSON.stringify({models:[{slug:'gpt-6-astra',additional_speed_tiers:['fast'],supported_reasoning_levels:[{effort:'high'},{effort:'max'}]}]}));
  fs.writeFileSync(path.join(root,'data/prepared-projects.json'), JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
  let hub, cdp;
  const evidence = {passed:false, checks:[], fixture:'isolated Electron; controlled App Server and context samples'};
  const ok = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS '+label); };
  const wait = async expression => { for(let i=0;i<300;i++){if(await cdp.eval(expression))return;await sleep(100);}throw Error('Timeout '+expression); };
  const invoke = (channel, args) => cdp.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const click = async selector => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!e.contains(document.elementFromPoint(x,y)))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);
    for (const type of ['mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64')); };
  try {
    const port = await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
    hub = await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),AI_HUB_WORKSPACE_ROOT:root,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false});
    await wait('!!window.WorkspaceController && !!window.MeetingRoom');
    const session = await invoke('create-session',{kind:'codex',opts:{cwd:work,model:'gpt-6-astra',effort:'high',mcpProfile:'none'}});
    const sid = JSON.stringify(session.id);
    await wait(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`);
    await click(`#session-list [data-session-id="${session.id}"]`);
    await wait("!!document.querySelector('.composer-tuning-controls')");
    await cdp.eval(`sessions.get(${sid}).contextPct=19;updateFloatingBarState()`);
    ok('remaining percentage precedes ring', await cdp.eval(`(()=>{const p=document.querySelector('.composer-context-value'),r=document.querySelector('.composer-ctx');return p.textContent==='81%'&&p.getBoundingClientRect().right<=r.getBoundingClientRect().left;})()`));
    ok('duplicate status strip removed and footer shrunk', await cdp.eval(`!document.querySelector('#card-session-status')&&document.querySelector('.floating-input-bar').getBoundingClientRect().height===164`));
    ok('all three actions precede model on one row', await cdp.eval(`(()=>{const a=document.querySelector('.composer-secondary-actions').getBoundingClientRect(),m=document.querySelector('.composer-model').getBoundingClientRect();return a.right<=m.left+1&&Math.abs(a.y-m.y)<6&&!!document.querySelector('.composer-tuning-controls .fi-bridge-fork')&&!!document.querySelector('.composer-tuning-controls .composer-one-click-start');})()`));
    ok('all eight rail labels visible', await cdp.eval(`document.querySelectorAll('.rail-navigation .btn-label').length===8&&[...document.querySelectorAll('.rail-navigation .btn-label')].every(e=>e.getBoundingClientRect().height>0)`));
    await shot('ordinary-wide');
    await click('.floating-input-box');await cdp.send('Input.insertText',{text:'保留多行草稿\n第二行'});
    const stableHeight = await cdp.eval(`document.querySelector('.floating-input-bar').getBoundingClientRect().height`);
    await click('.composer-one-click-start');
    ok('one-click start preserves draft and fixed geometry', await cdp.eval(`document.querySelector('.floating-input-box').innerText.startsWith(${JSON.stringify('保留多行草稿\n第二行')})&&document.querySelector('.floating-input-box').innerText.includes('【一键开工】')&&document.querySelector('.floating-input-bar').getBoundingClientRect().height===${stableHeight}`));
    const turns = () => fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.method==='turn/start');
    ok('one-click start does not send a model turn', turns().length===0);
    for (const theme of ['dark','codex']) {
      await cdp.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:640,deviceScaleFactor:1,mobile:false});
      ok('send stays visible in narrow '+theme,await cdp.eval(`(()=>{const e=document.querySelector('.floating-input-send'),r=e.getBoundingClientRect();return r.width>0&&r.right<=innerWidth&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`));
      await shot('ordinary-narrow-'+theme);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false});
    const draft = await cdp.eval("document.querySelector('.floating-input-box').innerText");
    await click('.floating-input-send');
    await wait(`sessions.get(${sid})?.nativeRuntime?.state==='completed'`);
    ok('send submits the exact draft once with original effort', turns().length===1 && turns()[0].params.input.map(e=>e.text||'').join('')===draft && turns()[0].params.effort==='high');
    await cdp.eval("document.documentElement.dataset.theme='dark';openMeetingCreateModal('group')");
    await click('[data-mcm-workspace-mode="default"]');
    await click('[data-mcm-scene="general"]');
    await cdp.eval(`document.querySelectorAll('.mcm-ai-select').forEach(e=>{e.value='codex';e.dispatchEvent(new Event('change',{bubbles:true}));})`);
    await click('#meeting-create-modal .mcm-create');
    await wait("document.querySelectorAll('.mr-input-member-tuning').length===2");
    await cdp.eval(`(()=>{const ids=[...document.querySelectorAll('.mr-input-member-tuning')].map(e=>e.dataset.sid);ids.forEach((id,i)=>sessions.get(id).contextPct=i?92:19);ids.forEach(id=>window.MeetingRoom.refreshSessionMetrics(id));})()`);
    ok('group context belongs to each member', await cdp.eval(`JSON.stringify([...document.querySelectorAll('.mr-input-member-tuning .composer-context-value')].map(e=>e.textContent))===JSON.stringify(['81%','8%'])`));
    ok('group pull is first and composer shrunk', await cdp.eval(`document.querySelector('#mr-input-tuning').firstElementChild.classList.contains('fi-bridge-toolbar')&&document.querySelector('.mr-group-composer').getBoundingClientRect().height===164`));
    await shot('group-wide');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:640,deviceScaleFactor:1,mobile:false});
    await click('.mr-input-member-tuning:last-child .composer-model');
    await wait("!!document.querySelector('.model-picker-menu')");
    ok('last member model control remains reachable in narrow window', await cdp.eval(`!!document.querySelector('.model-picker-menu')`));
    await shot('group-narrow');
    evidence.passed = true;
  } finally {
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(cdp){if(!evidence.passed)await shot('failure');await cdp.close();}
    if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(evidence,null,2));
    console.log('ARTIFACT_ROOT '+out);
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
