'use strict';
// Real background Electron, isolated data and a synthetic Claude disk record.
// Restored CLI points to an unreachable proxy; no paid AI request is sent.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-runtime-e2e-'));
const data=path.join(root,'data'),work=path.join(root,'work'),claude=path.join(root,'claude');
const native=randomUUID(),sid='runtime-recap-'+Date.now(),now=Date.now();
const dir=path.join(claude,'projects',path.resolve(work).replace(/[^A-Za-z0-9]/g,'-'));
for(const d of [data,work,dir])fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(claude,'.claude.json'),j({hasCompletedOnboarding:true,projects:{}}));
const file=path.join(dir,native+'.jsonl');
function row(type,id,content,at,extra={}){return {type,uuid:id,sessionId:native,timestamp:new Date(now-300000+at*1000).toISOString(),
  message:{role:type,content:type==='assistant'?[{type:'text',text:content}]:content,...(type==='assistant'?{id,model:'claude-haiku-4-5-20251001',stop_reason:'end_turn'}:{})},...extra};}
const initial=[row('user','human-question','请交付完整说明',0),row('assistant','human-result','正式结果：正文和交付说明保持完整。',5)];
fs.writeFileSync(file,initial.map(j).join('\n')+'\n');
fs.writeFileSync(path.join(data,'state.json'),j({version:1,cleanShutdown:true,meetings:[],immersiveByMeeting:{},sessions:[{
  hubId:sid,title:'正式结果与定时通知',kind:'claude',cwd:work,ccSessionId:native,transcriptPath:file,
  currentModel:{id:'claude-haiku-4-5-20251001'},lastMessageTime:now,savedAt:now,schemaVersion:1}]}));
const out=path.resolve('artifacts','20261003-runtime-overhead-codex1-'+Date.now());fs.mkdirSync(out,{recursive:true});
(async()=>{let hub,c;const result={boundary:'Isolated Electron + actual local Claude CLI restore, synthetic disk records, no AI prompt; sidebar has 1501 synthetic sessions and 11 recent ones.',checks:[]};try{
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,windowMode:'background',label:'runtime-overhead',extraEnv:{CLAUDE_HUB_E2E:'1',CLAUDE_CONFIG_DIR:claude,CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_PROXY:'http://127.0.0.1:9'}});
  c=await connectFirstPage(hub,t=>t.type==='page'&&t.url.includes('index.html'));
  async function until(expr,label,ms=40000){const end=Date.now()+ms;while(!await c.eval(expr)){if(Date.now()>end)throw Error('timeout '+label);await sleep(100);}}
  await until('!!window.__hubE2E','bridge');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
  await c.eval(`window.__hubE2E.addFakeSessions(Array.from({length:1500},(_,i)=>({id:'bench-'+i,kind:'codex',title:'性能测试 '+i,status:i<3?'running':i<10?'idle':'dormant',createdAt:Date.now()-10*86400000,lastMessageTime:Date.now()-(i<10?10000:10*86400000)})))`);
  const noChange=await c.eval(`(async()=>{const list=document.getElementById('session-list'),first=list.querySelector('[data-session-id="bench-0"]');first.focus();let changes=0;const observer=new MutationObserver(rs=>changes+=rs.length);observer.observe(list,{childList:true,subtree:true});const before=performance.now();for(let i=0;i<20;i++){renderSessionList();await new Promise(r=>requestAnimationFrame(r));}observer.disconnect();return {changes,elapsedMs:performance.now()-before,sameNode:first===list.querySelector('[data-session-id="bench-0"]'),focusRetained:document.activeElement===first,rows:list.querySelectorAll('.session-item').length};})()`);
  assert.equal(noChange.changes,0);assert(noChange.sameNode&&noChange.focusRetained);result.noChange=noChange;result.checks.push('unchanged refresh retains row nodes, focus and zero card-list mutations');
  const updated=await c.eval(`(()=>{const a=document.querySelector('[data-session-id="bench-0"]'),b=document.querySelector('[data-session-id="bench-1"]');sessions.get('bench-0').title='更新后的标题';renderSessionList();return {sameA:a===document.querySelector('[data-session-id="bench-0"]'),sameB:b===document.querySelector('[data-session-id="bench-1"]'),newTitle:a.textContent.includes('更新后的标题')};})()`);
  assert(updated.sameA&&updated.sameB&&updated.newTitle);result.checks.push('a title change patches one retained row');
  await c.eval(`meetings['bench-group']={id:'bench-group',title:'测试群聊',groupChat:true,subSessions:['bench-0','bench-1'],participants:['bench-0','bench-1'],status:'idle',lastMessageTime:Date.now(),unreadAnswered:new Set(),answeredThisTurn:new Set()};renderSessionList();`);
  const grouped=await c.eval(`(()=>{const g=document.querySelector('[data-sidebar-group="bench-group"]'),child=g.querySelector('[data-session-id="bench-1"]');sessions.get('bench-1').title='群聊成员的新标题';renderSessionList();return {sameGroup:g===document.querySelector('[data-sidebar-group="bench-group"]'),sameChild:child===g.querySelector('[data-session-id="bench-1"]'),updated:child.textContent.includes('群聊成员的新标题')};})()`);
  assert(grouped.sameGroup&&grouped.sameChild&&grouped.updated);result.checks.push('a group member update retains the group and member row');
  await c.eval(`document.getElementById('session-model-filter').focus()`);
  const key=async name=>{for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:name,code:name});};
  await key('Home');await key('ArrowDown');
  await until(`document.getElementById('session-model-filter').value==='claude'`,'Claude filter');
  assert.equal(await c.eval(`document.querySelectorAll('#session-list [data-session-id^="bench-"]').length`),0);
  assert(await c.eval(`!!document.querySelector('[data-session-id="${sid}"]')`));
  await key('Home');await until(`document.getElementById('session-model-filter').value==='all'`,'all filter');
  assert(await c.eval(`!!document.querySelector('[data-sidebar-group="bench-group"]')`));
  result.checks.push('real keyboard changes model filtering and restores group rows');
  await c.eval(`window.__hubE2E.selectSession(${j(sid)})`);
  await until(`currentView==='card'&&document.querySelector('#msg-overlay')?.textContent.includes('正式结果：')`,'human result');
  const before=await c.eval(`[...document.querySelectorAll('#msg-overlay>.turn-card')].map(n=>({id:n.dataset.turnId,text:n.textContent}))`);
  const userReply=before.find(x=>x.text.includes('正式结果：'));assert(userReply);
  for(let n=0;n<2;n++){
    const rows=[{type:'system',subtype:'scheduled_task_fire',uuid:'wake-'+n,sessionId:native,timestamp:new Date(now+n*1000).toISOString()},
      row('user','scheduled-'+n,'内部检查任务',30+n*5,{isMeta:true,parentUuid:'wake-'+n}),row('assistant','recap-'+n,'定时检查通知 '+n,31+n*5)];
    fs.appendFileSync(file,rows.map(j).join('\n')+'\n');
    await c.eval(`requestCardIncrementalRefresh(${j(sid)},{force:true,reason:'runtime-recap-e2e'})`);
    await until(`document.querySelector('#msg-overlay')?.textContent.includes(${j('定时检查通知 '+n)})`,'recap '+n);
    assert(await c.eval(`document.querySelector('[data-turn-id=${j(userReply.id)}]')?.textContent.includes('正式结果：')`));
  }
  const cards=await c.eval(`[...document.querySelectorAll('#msg-overlay>.turn-card')].map(n=>({id:n.dataset.turnId,text:n.textContent}))`);
  assert.equal(cards.filter(x=>x.text.includes('定时检查通知')).length,2);assert(!cards.some(x=>x.text.includes('内部检查任务')));assert.equal(new Set(cards.map(x=>x.id)).size,cards.length);
  result.cards=cards;result.checks.push('two appended scheduled wakeups leave the original final result intact, with no internal-prompt cards or duplicate IDs');
  const clock=await c.eval(`(()=>{const bar=document.querySelector('.floating-input-bar'),chip=bar.querySelector('.composer-speed-chip')||bar.querySelector('[aria-label^="速度"]');window.__clockMutations=0;const observer=new MutationObserver(rs=>window.__clockMutations+=rs.length);observer.observe(bar.querySelector('.composer-rail')||bar,{childList:true,subtree:true});const s=sessions.get(${j(sid)});bar._paintComposer(s,Date.now());observer.takeRecords();for(let i=0;i<5;i++)bar._paintComposerClock(s,Date.now()+i*1000);const count=observer.takeRecords().length;observer.disconnect();return {count,composer:bar.querySelector('.composer-status-text')?.textContent};})()`);
  assert.equal(clock.count,0);result.clock=clock;result.checks.push('stable clock ticks do not reconstruct composer controls');
  const attention=await c.eval(`(()=>{const bar=document.querySelector('.floating-input-bar'),s=sessions.get(${j(sid)}),attention=require('../core/session-attention-state');attention.markSessionNeedsUserInput(s,{reason:'permission',text:'允许读取文件吗？'});bar._paintComposerClock(s,Date.now());const control=bar.querySelector('.pty-attention-controls');const first=!control.hidden&&control.textContent.includes('允许读取文件吗？');attention.markSessionNeedsUserInput(s,{reason:'permission',text:'允许写入文件吗？'});bar._paintComposerClock(s,Date.now()+1000);const second=!control.hidden&&control.textContent.includes('允许写入文件吗？');attention.clearSessionAttention(s);bar._paintComposerClock(s,Date.now()+2000);return {first,second,cleared:control.hidden};})()`);
  assert(attention.first&&attention.second&&attention.cleared);result.checks.push('clock ticks retain permission prompts, changed prompt details and clearing');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'recap-preserved.png'),Buffer.from(shot.data,'base64'));
  result.ok=true;console.log(JSON.stringify({ok:true,out,noChange,checks:result.checks},null,2));
}catch(e){result.error=e.stack;throw e;}finally{
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2),'utf8');await c?.close();if(hub)await gracefulQuit(hub);
}})().catch(e=>{console.error(e);process.exitCode=1;});
