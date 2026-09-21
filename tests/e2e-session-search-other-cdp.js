'use strict';
// Isolated Hub: real transcript -> index -> IPC -> physical clicks and typing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-other-'));
const DATA = path.join(TEMP, 'data'), HOME = path.join(TEMP, 'home');
const OUT = path.join(ROOT, 'output', 'playwright', 'yesterday-d');
const roots = Object.fromEntries(['claude','codex','kimi','gemini'].map(p => [p, path.join(HOME, p)]));
const result = { ok: false, dataDir: DATA };

async function waitFor(label, fn) {
  console.log(`Waiting: ${label}`);
  const end = Date.now() + 45000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(100); }
  throw new Error(`Timeout: ${label}`);
}
async function port() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
async function click(c, selector) {
  console.log(`Click: ${selector}`);
  const p = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await c.send('Input.dispatchMouseEvent', { type:'mousePressed', ...p, button:'left', buttons:1, clickCount:1 });
  await c.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...p, button:'left', buttons:0, clickCount:1 });
}
async function query(c, text) {
  await click(c, '#search-query');
  await c.send('Input.dispatchKeyEvent', {type:'keyDown', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2});
  await c.send('Input.dispatchKeyEvent', {type:'keyUp', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2});
  await c.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8});
  await c.send('Input.dispatchKeyEvent', {type:'keyUp', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8});
  if (text) await c.send('Input.insertText', { text });
}
async function key(c, name, code) {
  for(const type of ['keyDown','keyUp']) await c.send('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code});
}
function fixtures() {
  for (const d of [DATA, OUT, ...Object.values(roots)]) fs.mkdirSync(d, {recursive:true});
  fs.mkdirSync(path.join(TEMP,'.git'),{recursive:true});
  fs.mkdirSync(path.join(TEMP,'.agents'),{recursive:true});
  fs.writeFileSync(path.join(TEMP,'.agents','project.json'),JSON.stringify({name:'界面设计',trunk:'master'}));
  new (require('../core/prepared-project-registry').PreparedProjectRegistry)({dataDir:DATA}).register(TEMP);
  const now = Date.now(), sid = '11111111-2222-4333-8444-555555555555';
  const wire = path.join(roots.kimi, 'workspace', `session_${sid}`, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wire), {recursive:true});
  const rows = [
    {type:'metadata', protocol_version:1, created_at:now},
    {type:'turn.prompt', input:[{type:'text', text:'检索样本：昨天讨论的界面设计，怎样让搜索结果更容易阅读？'}], time:now},
    {type:'context.append_loop_event', event:{type:'step.begin', step:1}, time:now+1},
    {type:'context.append_loop_event', event:{type:'content.part', part:{type:'text', text:'正文探针\n\n## 让内容回到视觉中心\n\n保留项目、结果和阅读三栏。弱化边框与底色，用清晰的字号、留白和选中状态建立层次。\n\n- 搜索：输入后直接检索对话\n- 结果：先看标题，再看相关问答\n- 阅读：保留 Markdown、公式和原文\n\n下一步先核对信息密度，再检查窄窗口和键盘操作。'}}, time:now+2},
    {type:'context.append_loop_event', event:{type:'step.end', step:1}, time:now+3},
  ];
  fs.writeFileSync(wire, rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const titles = {claude:'检索样本 · 项目规则整理',codex:'检索样本 · 会话恢复方案',kimi:'检索样本 · 搜索界面设计',gemini:'检索样本 · 技术图示配色',deepseek:'检索样本 · 报告结构优化',qwen:'检索样本 · 组件交互规范',glm:'检索样本 · 信息层次梳理','deepseek-acp':'检索样本 · 原生会话摘要'};
  const sessions = Object.entries(titles).map(([kind,title],i)=>({schemaVersion:1,hubId:`sample-${kind}`,kind,title,cwd:TEMP,
    createdAt:now-i*1000,updatedAt:now-i*1000,lastMessageTime:now-i*1000,status:'dormant',purpose:'study-companion',
    ...(kind==='kimi'?{kimiSid:`session_${sid}`,transcriptPath:wire}:{}),
    lastOutputPreview:'检索样本：保留核心信息，让标题、摘要和操作各有明确位置。'}));
  fs.writeFileSync(path.join(DATA,'state.json'),JSON.stringify({version:1,cleanShutdown:true,sessions,meetings:[],immersiveByMeeting:{}}));
}
async function main() {
  fixtures(); let hub,c;
  try {
    hub = await launchIsolatedHub({dataDir:DATA,port:await port(),windowMode:'hidden',label:'yesterday-other',extraEnv:{
      CLAUDE_HUB_E2E:'1',CLAUDE_HUB_HOME_DIR:HOME,USERPROFILE:HOME,HOME,
      AI_HUB_WORKSPACE_ROOT:path.join(TEMP,'workspaces'),
      HUB_SESSION_SEARCH_CLAUDE_ROOTS:roots.claude,HUB_SESSION_SEARCH_CODEX_ROOTS:roots.codex,
      HUB_SESSION_SEARCH_KIMI_ROOTS:roots.kimi,HUB_SESSION_SEARCH_GEMINI_ROOTS:roots.gemini,
    }});
    result.pid=hub.pid; result.port=hub.port;
    c=await connectFirstPage(hub,t=>t.type==='page' && /renderer[\\/]index\.html/.test(t.url));
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await c.send('Emulation.setDeviceMetricsOverride',{width:1500,height:960,deviceScaleFactor:1,mobile:false});
    await waitFor('restored catalogue',()=>c.eval('!!window.__hubE2E?.globalSessionSearch && sessions.size===8'));
    assert.equal(await c.eval('process.env.CLAUDE_HUB_DATA_DIR'),DATA);
    await c.eval(`window.__searchErrors=[]; window.addEventListener('error',e=>window.__searchErrors.push(e.message)); window.addEventListener('unhandledrejection',e=>window.__searchErrors.push(String(e.reason)));`);
    result.index=await c.eval(`require('electron').ipcRenderer.invoke('refresh-session-search',{force:true})`);
    assert.equal(result.index.index.sessions,8);
    await click(c,'#btn-global-search');
    await query(c,'检索样本');
    await waitFor('all results',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().state==='complete' && window.__hubE2E.globalSessionSearch.state().totalSessions===8`));
    assert.equal(await c.eval('window.__hubE2E.globalSessionSearch.state().reading'),false);
    assert.equal(await c.eval(`document.querySelector('#session-search-preview h3')`),null,'search must not auto-load a reader');
    const initialIndex=await c.eval('window.__hubE2E.globalSessionSearch.state().activeIndex');
    await key(c,'ArrowDown',40);
    await waitFor('keyboard selection without reading',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().activeIndex===${(initialIndex+1)%8} && !window.__hubE2E.globalSessionSearch.state().reading`));
    await key(c,'Enter',13);
    await waitFor('Enter opens reader',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().reading && !!document.querySelector('#session-search-preview h3')`));
    assert.equal(await c.eval(`document.getElementById('session-search-home').inert`),true);
    await key(c,'Escape',27);
    assert.equal(await c.eval(`window.__hubE2E.globalSessionSearch.state().open && !window.__hubE2E.globalSessionSearch.state().reading && document.activeElement.id==='search-query'`),true);
    await click(c,'[data-provider="other"]');
    result.other=await waitFor('other results',()=>c.eval(`(() => {const s=window.__hubE2E.globalSessionSearch.state();return s.activeProvider==='other' && s.state==='complete' && s.totalSessions===6 ? s : null;})()`));
    assert.equal(await c.eval(`document.querySelector('[data-provider="other"] b').textContent`),'6');
    assert.deepEqual(new Set(await c.eval(`[...document.querySelectorAll('.session-search-result-provider')].map(e=>e.textContent.trim())`)),new Set(['Kimi','Gemini','DeepSeek','千问','智谱']));
    await query(c,'正文探针');
    await waitFor('Kimi body search result',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().state==='complete' && window.__hubE2E.globalSessionSearch.state().totalSessions===1`));
    await key(c,'Enter',13);
    result.body=await waitFor('real Kimi body and preview',()=>c.eval(`(() => {const s=window.__hubE2E.globalSessionSearch.state();return s.query==='正文探针' && s.state==='complete' && s.totalSessions===1 && document.querySelector('.session-search-preview-context')?.textContent.includes('视觉中心') ? s : null;})()`));
    await key(c,'Escape',27);
    await click(c,'#session-search-filter-toggle');
    await click(c,'[data-scope="dormant"]');
    await click(c,'[data-agent="study"]');
    result.archive=await waitFor('archive and agent intersection',()=>c.eval(`(() => {const s=window.__hubE2E.globalSessionSearch.state();return s.activeScope==='dormant' && s.activeAgent==='study' && s.state==='complete' && s.totalSessions===1 ? s : null;})()`));
    await query(c,'不存在的内容');
    await waitFor('empty results',()=>c.eval(`(() => {const s=window.__hubE2E.globalSessionSearch.state();return s.query==='不存在的内容' && s.state==='complete' && s.totalSessions===0;})()`));
    assert.equal(await c.eval(`document.querySelector('[data-provider="other"]').hidden`),false);
    await query(c,'检索样本');
    await waitFor('restored results',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().totalSessions===6`));
    result.persisted=await c.eval(`JSON.parse(localStorage.getItem('hub.search.facets'))`);
    assert.equal(result.persisted.provider,'other');
    await waitFor('six rows',()=>c.eval(`document.querySelectorAll('.session-search-result').length===6`));
    await click(c,'#session-search-filter-toggle');
    const homeShot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(OUT,'yesterday-d-search.png'),Buffer.from(homeShot.data,'base64'));
    const kimiSelector=await c.eval(`(() => {const a=[...document.querySelectorAll('.session-search-result')];return '.session-search-result:nth-child('+(a.findIndex(e=>e.textContent.includes('Kimi'))+1)+')';})()`);
    await click(c,kimiSelector);
    await waitFor('preview settled',()=>c.eval(`document.querySelector('.session-search-preview-context')?.textContent.includes('视觉中心')`));
    result.layouts=[];
    for (const [width,height,theme] of [[1500,960,'dark'],[1024,820,'hub'],[760,820,'dark'],[375,812,'hub']]) {
      await c.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await c.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const metrics=await c.eval(`(() => {const d=document.querySelector('.session-search-dialog'),h=document.querySelector('.session-search-header'),r=document.querySelector('.session-search-workspace-panes');return {width:innerWidth,dialogWidth:d.getBoundingClientRect().width,dialogClient:d.clientWidth,dialogScroll:d.scrollWidth,headerClient:h.clientWidth,headerScroll:h.scrollWidth,contentHeight:r.getBoundingClientRect().height,bodyWidth:document.body.scrollWidth};})()`);
      assert.ok(metrics.dialogWidth<=width+1,JSON.stringify(metrics)); // Chromium can round by a fractional CSS pixel under Hub zoom.
      assert.ok(metrics.dialogScroll<=metrics.dialogClient+1,JSON.stringify(metrics));
      assert.ok(metrics.headerScroll<=metrics.headerClient+1,JSON.stringify(metrics));
      assert.ok(metrics.contentHeight>=180,JSON.stringify(metrics));
      result.layouts.push({...metrics,theme});
      const readerMetrics=await c.eval(`(() => {const d=document.querySelector('.session-search-reader-sheet');return {client:d.clientWidth,scroll:d.scrollWidth,rect:d.getBoundingClientRect().toJSON()};})()`);
      assert.ok(readerMetrics.scroll<=readerMetrics.client+1,JSON.stringify(readerMetrics));
      assert.ok(readerMetrics.rect.x>=0 && readerMetrics.rect.right<=width,JSON.stringify(readerMetrics));
      const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(OUT,`yesterday-${width}.png`),Buffer.from(shot.data,'base64'));
      await key(c,'Escape',27);
      const searchShot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(OUT,`yesterday-search-${width}.png`),Buffer.from(searchShot.data,'base64'));
      await key(c,'Enter',13);
      await waitFor('reader reopened',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().reading && !!document.querySelector('#session-search-preview h3')`));
    }
    await key(c,'Escape',27);
    await key(c,'Escape',27);
    assert.equal(await c.eval('window.__hubE2E.globalSessionSearch.state().open'),false);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1500,height:960,deviceScaleFactor:1,mobile:false});
    await click(c,'#btn-global-search');
    await waitFor('recent search suggestions',()=>c.eval(`!document.getElementById('session-search-suggestions').hidden`));
    await query(c,'正文探针');
    await waitFor('reopen can search',()=>c.eval(`window.__hubE2E.globalSessionSearch.state().state==='complete' && window.__hubE2E.globalSessionSearch.state().totalSessions===1`));
    result.keyboardAndReopen=true;
    result.errors=await c.eval('window.__searchErrors');assert.deepEqual(result.errors,[]);
    result.ok=true;
  } catch(e) {result.error=e.stack;if(hub) result.log=hub.log().slice(-60);throw e;}
  finally {
    try {if(c) await c.close();}
    finally {
      try {if(hub) result.shutdown=await gracefulQuit(hub);}
      catch(e) {result.ok=false;result.shutdownError=e.stack;if(!result.error) throw e;}
      finally {fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(result,null,2));}
    }
  }
  console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
