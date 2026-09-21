'use strict';
// Functional review: real isolated Hub, real index and preview files. Clipboard
// writes alone use a recorder so this check never replaces the user's clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=path.resolve(__dirname,'..'),TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'yesterday-review-'));
const DATA=path.join(TEMP,'data'),HOME=path.join(TEMP,'home'),WORK=path.join(TEMP,'work');
const CLAUDE=path.join(HOME,'.claude','projects'),EMPTY=path.join(HOME,'empty');
const OUT=path.join(ROOT,'output','playwright','yesterday-review');
const SID='019e4444-4444-7444-8444-444444444444',FILE=path.join(CLAUDE,'project',SID+'.jsonl');
const ARTIFACT=path.join(WORK,'output','review.html');
const report={ok:false,dataDir:DATA,checks:[]};
async function until(c,expression,label) {
  console.log('Check:',label);const end=Date.now()+30000;
  while(Date.now()<end) {const value=await c.eval(expression);if(value)return value;await _waitMs(80);}
  throw Error('Timeout: '+label);
}
async function click(c,selector) {
  const point=await c.eval(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(r));const b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('obscured '+${JSON.stringify(selector)});return{x,y};})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
}
async function key(c,key,code,modifiers=0) {for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key,windowsVirtualKeyCode:code,modifiers});}
async function query(c,text) {
  await click(c,'#search-query');await key(c,'a',65,2);await key(c,'Backspace',8);
  if(text)await c.send('Input.insertText',{text});
  await until(c,`window.__hubE2E.globalSessionSearch.state().state==='complete' && window.__hubE2E.globalSessionSearch.state().query===${JSON.stringify(text)}`,'query '+text);
}
async function choice(c,id,value) {
  await c.eval(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
function fixture() {
  for(const dir of [DATA,HOME,WORK,EMPTY,OUT,path.dirname(FILE),path.dirname(ARTIFACT)])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(ARTIFACT,'<!doctype html><meta charset="utf-8"><h1>REVIEW_ARTIFACT_OK</h1>');
  const now=Date.now(),rows=[];
  for(let i=0;i<23;i++) {
    const text=i===0?'REVIEW_BODY\n\n**复制验证**\n\n'+ '🙂界'.repeat(7000)+'\nUNICODE_END\n\n绝对路径：'+ARTIFACT:'ROUND_'+i+' answer';
    rows.push({type:'user',uuid:'u'+i,sessionId:SID,cwd:WORK,timestamp:new Date(now+i*100).toISOString(),message:{role:'user',content:'ROUND_'+i+' question'}});
    rows.push({type:'assistant',uuid:'a'+i,sessionId:SID,timestamp:new Date(now+i*100+1).toISOString(),message:{role:'assistant',model:'claude',stop_reason:'end_turn',content:[{type:'text',text}]}});
  }
  fs.writeFileSync(FILE,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const sessions=[{schemaVersion:1,hubId:'review-main',kind:'claude',title:'REVIEW_MAIN',cwd:WORK,ccSessionId:SID,transcriptPath:FILE,pinned:true,createdAt:now,lastMessageTime:now},
    ...Array.from({length:60},(_,i)=>({schemaVersion:1,hubId:'review-'+i,kind:'qwen',title:'REVIEW_PAGED_'+String(i).padStart(2,'0'),cwd:WORK,createdAt:now-i*100,lastMessageTime:now-i*100,lastOutputPreview:'REVIEW_PAGED content'}))];
  fs.writeFileSync(path.join(DATA,'state.json'),JSON.stringify({version:1,cleanShutdown:true,sessions,meetings:[],immersiveByMeeting:{}}));
}
(async()=>{
  fixture();let hub,c;
  try {
    const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
    hub=await launchIsolatedHub({dataDir:DATA,port,windowMode:'hidden',extraEnv:{CLAUDE_HUB_E2E:'1',CLAUDE_HUB_HOME_DIR:HOME,USERPROFILE:HOME,HOME,
      CLAUDE_CONFIG_DIR:path.join(HOME,'.claude'),AI_HUB_WORKSPACE_ROOT:WORK,HUB_SESSION_SEARCH_CLAUDE_ROOTS:CLAUDE,
      HUB_SESSION_SEARCH_CODEX_ROOTS:EMPTY,HUB_SESSION_SEARCH_KIMI_ROOTS:EMPTY,HUB_SESSION_SEARCH_GEMINI_ROOTS:EMPTY}});
    c=await connectFirstPage(hub);report.pid=hub.pid;
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await until(c,'!!window.__hubE2E?.globalSessionSearch && sessions.size===61','catalogue');
    await c.eval(`window.__reviewErrors=[];addEventListener('error',e=>__reviewErrors.push(e.message));addEventListener('unhandledrejection',e=>__reviewErrors.push(String(e.reason)));require('electron').clipboard.writeText=text=>{window.__reviewCopied=text;};`);
    await c.eval(`require('electron').ipcRenderer.invoke('refresh-session-search',{force:true})`);
    await click(c,'#btn-global-search');await query(c,'REVIEW_PAGED');
    await until(c,"document.querySelectorAll('.session-search-result').length===50",'first result page');
    await click(c,'.session-search-load-more');await until(c,"document.querySelectorAll('.session-search-result').length===60",'second result page');
    assert.equal(await c.eval(`new Set([...document.querySelectorAll('.session-search-result-title')].map(e=>e.textContent)).size`),60);report.checks.push('result pagination 50 -> 60 without duplicates');
    await click(c,'#session-search-filter-toggle');await choice(c,'session-search-sort','title');
    await until(c,`document.querySelector('.session-search-result-title')?.textContent==='REVIEW_PAGED_00'`,'ascending sort');
    await choice(c,'session-search-direction','desc');await until(c,`document.querySelector('.session-search-result-title')?.textContent==='REVIEW_PAGED_59'`,'descending sort');report.checks.push('title sorting both directions');
    await click(c,'[data-scope="pinned"]');await query(c,'');
    await until(c,`window.__hubE2E.globalSessionSearch.state().totalSessions===1 && document.querySelector('.session-search-result-title')?.textContent==='REVIEW_MAIN'`,'pinned filter');report.checks.push('pinned catalogue');
    await click(c,'[data-scope="dialogue"]');await query(c,'REVIEW_BODY');await key(c,'Enter',13);
    await until(c,`!!document.querySelector('.session-search-preview-context .turn-body')`,'read-only markdown');
    await c.eval(`document.querySelector('.session-search-preview-actions button').click()`);
    assert.ok((await c.eval('window.__reviewCopied')).includes('REVIEW_BODY'));report.checks.push('copy reference (clipboard recorder)');
    await c.eval(`document.querySelectorAll('.session-search-preview-context button').forEach(b=>{if(b.textContent.startsWith('展开这条原文'))b.dataset.reviewExpand='1';})`);
    await click(c,'[data-review-expand]');await until(c,`document.querySelector('.session-search-preview-context').textContent.includes('UNICODE_END')`,'full long Unicode text');report.checks.push('long text expansion');
    await click(c,'[data-preview-mode="hits"]');await until(c,`document.querySelector('[data-preview-mode="hits"]').classList.contains('active')`,'hit tab');
    assert.equal(await c.eval(`document.querySelectorAll('[data-search-match]').length`),1);report.checks.push('hit locations');
    await click(c,'[data-preview-mode="conversation"]');await until(c,`document.querySelector('[data-preview-mode="conversation"]').classList.contains('active')`,'conversation tab');
    await c.eval(`document.querySelectorAll('.session-search-preview-context button').forEach(b=>{if(b.textContent==='加载后面的原文')b.dataset.reviewNext='1';})`);
    await click(c,'[data-review-next]');await until(c,`document.querySelector('.session-search-preview-context').textContent.includes('ROUND_15')`,'conversation next page');
    await c.eval(`document.querySelectorAll('.session-search-preview-context button').forEach(b=>{if(b.textContent==='加载前面的原文')b.dataset.reviewBefore='1';})`);
    await click(c,'[data-review-before]');await until(c,`document.querySelector('.session-search-preview-context').textContent.includes('REVIEW_BODY')`,'conversation previous page');report.checks.push('original conversation next/previous');
    await click(c,'[data-preview-mode="artifacts"]');await until(c,`!!document.querySelector('.session-search-artifact')`,'artifact detected');
    await click(c,'.session-search-artifact');
    await until(c,`!window.__hubE2E.globalSessionSearch.state().open && document.getElementById('preview-panel').style.display!=='none'`,'artifact actually visible above search');report.checks.push('open artifact into visible Hub preview');
    await until(c,`(async()=>{const view=document.querySelector('#preview-body webview');if(!view)return false;try{return (await view.executeJavaScript('document.body.textContent')).includes('REVIEW_ARTIFACT_OK');}catch{return false;}})()`,'artifact HTML content rendered');
    await click(c,'#btn-global-search');await query(c,'REVIEW_BODY');await key(c,'Enter',13);
    await until(c,`!!document.querySelector('.session-search-preview-context .turn-body')`,'reader reopened after artifact');
    fs.renameSync(FILE,FILE+'.moved');
    await click(c,'[data-preview-mode="hits"]');await until(c,`document.querySelector('.session-search-notice')?.textContent.includes('原始文件已移动')`,'missing source warning');report.checks.push('missing source remains readable with explicit warning');
    fs.renameSync(FILE+'.moved',FILE);
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,'review-reader.png'),Buffer.from(shot.data,'base64'));
    assert.deepEqual(await c.eval('window.__reviewErrors'),[]);report.ok=true;
  } catch(e) {report.error=e.stack;if(hub)report.log=hub.log().slice(-45);throw e;}
  finally {if(c)await c.close();if(hub)report.shutdown=await gracefulQuit(hub);fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
