'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
async function until(label,read){const end=Date.now()+45000;while(Date.now()<end){const v=await read();if(v)return v;await wait(120)}throw Error('Timeout: '+label)}
async function click(c,selector){const point=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Control not clickable');return {x,y}})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})}
async function query(c,text){await click(c,'#search-query');for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await c.send('Input.insertText',{text})}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-search-meta-ui-')),data=path.join(root,'data'),home=path.join(root,'home'),out=path.resolve('artifacts','search-meta-cache',path.basename(root));
 fs.mkdirSync(data,{recursive:true});fs.mkdirSync(home,{recursive:true});fs.mkdirSync(out,{recursive:true});
 const roots=['profile-a','profile-b'].map(name=>path.join(home,name,'sessions')),native='019d2222-2222-7222-8222-222222222222',files=[],sessions=[];
 for(let i=0;i<2;i++){
  const dir=path.join(roots[i],'2026','10','05');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'rollout-'+native+'.jsonl');files.push(file);
  const rows=[{type:'session_meta',timestamp:new Date().toISOString(),payload:{id:native,cwd:root,source:'cli',base_instructions:{text:'x'.repeat(65536)}}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'user_message',message:'ROI_SHARED 用户问题'}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',last_agent_message:'ROI_SHARED 回答来自配置 '+(i?'B':'A')}}];
  fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  sessions.push({schemaVersion:1,hubId:'roi-'+i,kind:'codex',title:'配置 '+(i?'B':'A')+' 会话',status:'dormant',cwd:root,codexSid:native,codexSessionsRoot:roots[i],transcriptPath:file,createdAt:Date.now(),lastMessageTime:Date.now()});
 }
 fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({version:1,cleanShutdown:true,sessions,meetings:[]}));
 let hub,c;const result={passed:false,checks:[],root,out,scope:'actual isolated Hub and mouse/keyboard search; synthetic Codex files; no model calls'};
 const state=()=>c.eval('window.__hubE2E.globalSessionSearch.state()');
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'search-meta-cache',extraEnv:{CLAUDE_HUB_E2E:'1',HUB_SESSION_SEARCH_PREWARM:'1',HUB_SESSION_SEARCH_PREWARM_DELAY_MS:'250',CLAUDE_HUB_HOME_DIR:home,HOME:home,USERPROFILE:home,HUB_SESSION_SEARCH_CODEX_ROOTS:roots.join(path.delimiter),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(home,'claude'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(home,'kimi'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(home,'gemini')}});
  c=await connectFirstPage(hub,t=>t.type==='page'&&/renderer[\\/]index\.html/.test(t.url));await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Emulation.setDeviceMetricsOverride',{width:1500,height:960,deviceScaleFactor:1,mobile:false});
  await until('catalogue',()=>c.eval('typeof sessions!=="undefined"&&sessions.size===2&&!!window.__hubE2E?.globalSessionSearch'));
  const refresh=()=>c.eval("ipcRenderer.invoke('refresh-session-search',{immediate:true})");
  const index=await c.eval("ipcRenderer.invoke('refresh-session-search',{force:true})");assert.equal(index.index.sessions,2);result.checks.push('copied native SID remains two profile-scoped search identities');
  await click(c,'#btn-global-search');await query(c,'ROI_SHARED');await until('two search results',async()=>{const s=await state();return s.state==='complete'&&s.totalSessions===2});
  await click(c,'.session-search-result');await until('reader',()=>c.eval("!!document.querySelector('#session-search-preview .session-search-native-card')"));assert.match(await c.eval("document.getElementById('session-search-preview').textContent"),/ROI_SHARED/);result.checks.push('actual search input, result click and authoritative reader work');
  for(let i=0;i<4;i++)assert.equal((await refresh()).index.sessions,2);
  for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until('return to search',async()=>!(await state()).reading);await query(c,'ROI_SHARED');await until('results after stable refresh',async()=>{const s=await state();return s.state==='complete'&&s.totalSessions===2});result.checks.push('four warm-cache refreshes preserve both search results');
  const previous=await c.eval("ipcRenderer.invoke('get-session-search-status')");fs.appendFileSync(files[0],JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',last_agent_message:'ROI_NEW_CONTENT_MARKER 最新完整回答'}})+'\n');
  await until('watcher indexing',async()=>{const s=await c.eval("ipcRenderer.invoke('get-session-search-status')");return s.contentUpdatedAt>previous.contentUpdatedAt&&!s.refreshing});
  await query(c,'ROI_NEW_CONTENT_MARKER');await until('new content searchable',async()=>{const s=await state();return s.state==='complete'&&s.totalSessions===1});await click(c,'.session-search-result');await until('updated reader',()=>c.eval("document.getElementById('session-search-preview').textContent.includes('ROI_NEW_CONTENT_MARKER')"));result.checks.push('Codex file watcher refreshes appended content through the cache without force');
  assert.match(await c.eval("document.getElementById('session-search-preview').textContent"),/最新完整回答/);result.checks.push('only the changed profile matches the new answer and its reader shows complete content');
  assert.equal((await c.eval("ipcRenderer.invoke('refresh-session-search',{force:true})")).index.sessions,2);result.checks.push('manual forced refresh still reconciles both identities');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'search-updated.png'),Buffer.from(shot.data,'base64'));result.passed=true;
 }finally{if(c)result.diagnostics=await c.eval('({ready:document.readyState,url:location.href,sessions:typeof sessions==="undefined"?null:[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,codexSid:s.codexSid}))})').catch(()=>null);if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));await c?.close();if(hub)await gracefulQuit(hub)}
 console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1});
