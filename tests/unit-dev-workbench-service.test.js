'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Feed=require('../core/dev-workbench-feed');
const {createDevWorkbench}=require('../main/groupchat/dev-workbench');
const {getOrchestrator}=require('../core/group-chat-orchestrator');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dev-workbench-unit-'));
const clone=value=>JSON.parse(JSON.stringify(value));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const make=(id,status='paused')=>({id,title:'任务 '+id,scene:'dev',groupChat:true,workspace:directory,workspaceLabel:'测试项目',subSessions:['s1','s2'],
  serialWorkflow:{enabled:true,steps:[['m1'],['m2']],loop:{enabled:true,maxRounds:3},loopState:{runId:'run-'+id,goal:'只修当前问题',status,round:1,currentStep:'reviewer',history:[]}}});
function setup(items=[make('one')],extra={}){
  const meetings=new Map(items.map(m=>[m.id,clone(m)])),live=new Set(),events=[],logs=[],runCalls=[];
  const manager={getMeeting:id=>meetings.has(id)?clone(meetings.get(id)):null,getAllMeetings:()=>[...meetings.values()].map(clone),
    updateMeeting:(id,fields)=>{const current=meetings.get(id);if(!current)return null;Object.assign(current,clone(fields));return clone(current);}};
  const engine={getStatus:id=>({running:live.has(id),loopState:meetings.get(id)?.serialWorkflow?.loopState}),isRunning:id=>live.has(id),
    stopLoop:id=>{live.delete(id);const m=meetings.get(id);if(m)m.serialWorkflow.loopState.status='stopped_user';return true;},
    validateLoop:()=>({ok:true}),runLoop:(id,input,persisted)=>{runCalls.push({id,input,persisted});live.add(id);return Promise.resolve();}};
  const board=createDevWorkbench({meetingManager:manager,loopEngine:engine,getHubDataDir:()=>directory,
    sendToRenderer:(channel,data)=>events.push({channel,data}),logger:{warn:(...x)=>logs.push(x)},
    readSummary:async()=>({missing:true}),...extra});
  const row=id=>board.snapshot().rows.find(r=>r.id===id);
  const act=(id,action,overrides={})=>board.action({meetingId:id,action,controlToken:row(id).controlToken,...overrides});
  return {board,meetings,live,events,logs,runCalls,engine,row,act};
}
let checks=0;const check=(condition,message)=>{assert.ok(condition,message);checks++;};
async function main(){
  // Read-only metadata must not copy bulky/unrelated chat timeline fields.
  const {MeetingRoomManager}=require('../core/meeting-room');
  const realManager=new MeetingRoomManager();
  realManager.meetings.set('damaged-history',{...make('damaged-history'),_timeline:null});
  realManager.meetings.set('good-history',{...make('good-history'),_timeline:[],_cursors:{}});
  const realBoard=createDevWorkbench({meetingManager:realManager,loopEngine:{getStatus:()=>({running:false})},getHubDataDir:()=>directory,sendToRenderer(){},readSummary:async()=>({missing:true})});
  try{check(realBoard.snapshot().rows.length===2,'A damaged unrelated timeline cannot hide every task');}finally{realBoard.dispose();}
  let s=setup([make('one'),{...make('normal'),scene:'general'}]);
  try{
    check(s.board.snapshot().rows.length===1,'Only dev group chats are included');
    const orch=getOrchestrator(directory,'one');
    orch.state.messages=[{id:'a1',role:'assistant',sid:'s1',speaker:'工作席',turnNum:1,createdAt:Date.now(),content:'UPDATE: 已定位故障入口'}];
    orch._saveState();s.board.flush();
    check(s.row('one').progress==='已定位故障入口','Actual durable group write pushes into service');
    check(JSON.parse(fs.readFileSync(orch._stateFilePath(),'utf8')).devWorkbench.update.text==='已定位故障入口','Projection and original message persist together');
    check(s.events.some(e=>e.channel==='dev-workbench:changed'&&e.data.rows.some(r=>r.progress==='已定位故障入口')),'Push carries the authored progress');
    const source=s.row('one').progressSource;
    check(source.messageId==='a1'&&source.sid==='s1','Progress preserves its source message and author');
    const before=s.events.length;
    Feed.publishSaved(directory,'normal',Feed.summarizeGroupState({messages:[{role:'assistant',content:'UPDATE: 普通群聊'}]}));s.board.flush();
    check(s.events.length===before,'Ordinary group update does not leak to development board');
    const takeover=await s.act('one','takeover');check(takeover.ok,'Manual takeover succeeds on a stopped task');
    check(s.meetings.get('one').serialWorkflow.loop.enabled===false&&s.row('one').stage.key==='manual','Takeover disables both automatic dispatch switches');
    check(s.meetings.get('one').serialWorkflow.loopState.goal==='只修当前问题','Takeover keeps original task and history');
    check(!(await s.act('one','resume')).ok,'Manual mode does not accidentally resume automation');
    check((await s.act('one','restore')).ok&&s.runCalls.length===0,'Restoring configuration does not dispatch a prompt');
    const stale=s.row('one').controlToken;s.meetings.get('one').serialWorkflow.loopState.runId='new-run';
    check((await s.act('one','resume',{controlToken:stale})).stale,'A decision on an old run is rejected');
    check((await s.act('one','resume')).ok,'Explicit resume starts the original run');
    check(s.runCalls[0].persisted.round===1&&s.runCalls[0].persisted.goal==='只修当前问题','Resume keeps round budget and target');
    check(!(await s.act('one','resume')).ok&&s.runCalls.length===1,'Double resume cannot dispatch twice');
    check((await s.act('one','stop')).ok&&!s.live.has('one'),'Stop waits for the actual runtime to stop');
    check(!(await s.board.action({meetingId:'../bad',action:'stop'})).ok,'Malformed ID is rejected');
    check(!(await s.board.action({meetingId:'normal',action:'takeover'})).ok,'Non-development group cannot be controlled through this board');
  }finally{s.board.dispose();}

  s=setup([make('missing'),make('rejected')]);
  try{
    s.meetings.get('missing').subSessions=[];
    check(!s.row('missing').actions.resume&&s.row('missing').lastError.includes('席位缺失'),'Missing members explain why resume is unavailable');
    check((await s.act('missing','takeover')).ok,'Missing members cannot block manual takeover');
    s.engine.runLoop=()=>Promise.reject(new Error('fixture engine rejected before starting'));
    check(!(await s.act('rejected','resume')).ok,'An immediately rejected resume does not claim to have started');
    await wait(0);
    check(s.logs.some(entry=>JSON.stringify(entry).includes('fixture engine rejected')),'Rejected background run is observed and reported');
  }finally{s.board.dispose();}

  const cold=deferred();s=setup([make('race')],{readSummary:()=>cold.promise});
  try{
    s.board.snapshot();await wait(0);
    s.board.ingest({hubDataDir:directory,meetingId:'race',summary:Feed.summarizeGroupState({messages:[{role:'assistant',content:'UPDATE: 最新推送'}]})});
    cold.resolve({summary:Feed.summarizeGroupState({messages:[{role:'assistant',content:'UPDATE: 旧磁盘数据'}]})});await wait(10);
    check(s.row('race').progress==='最新推送','Late cold read cannot overwrite a newer pushed update');
  }finally{s.board.dispose();}
  s=setup([make('broken'),make('healthy')],{readSummary:async id=>{if(id==='broken')throw new Error('corrupt fixture');return {summary:Feed.summarizeGroupState({messages:[{role:'assistant',content:'UPDATE: 正常任务'}]})};}});
  try{
    s.board.snapshot();await wait(20);
    check(s.row('broken').feedError.includes('corrupt'),'Corrupt record surfaces its error');
    check(s.row('healthy').progress==='正常任务','A corrupt task does not hide other tasks');
    const until=s.row('healthy').controlToken;s.meetings.get('healthy').serialWorkflow.loopState.deadlineTs=Date.now()-10;
    check(!s.row('healthy').actions.resume,'An expired run is not silently given a new deadline');
    check((await s.board.action({meetingId:'healthy',action:'takeover',controlToken:until})).stale,'A changed deadline invalidates the previous confirmation');
    check((await s.act('healthy','takeover')).ok,'Expired run can still be taken over manually');
  }finally{s.board.dispose();}
  s=setup([make('busy','running'),make('other')]);
  try{
    s.live.add('busy');s.engine.stopLoop=()=>true;
    const pending=s.act('busy','takeover');await wait(0);
    check(!(await s.act('busy','takeover')).ok,'Per-task operation lock rejects concurrent duplicate controls');
    check((await s.act('other','takeover')).ok,'One stuck task does not block a different task');
    const result=await pending;
    check(result.pending&&!s.meetings.get('busy').serialWorkflow.devWorkbenchManual,'Unacknowledged stop is not mislabeled as successful manual takeover');
  }finally{s.board.dispose();}

  // Real read worker: damaged JSON is isolated; valid persisted reports survive restart.
  fs.mkdirSync(path.join(directory,'arena-prompts'),{recursive:true});
  fs.writeFileSync(path.join(directory,'arena-prompts','disk-bad-groupchat.json'),'{bad','utf8');
  fs.writeFileSync(path.join(directory,'arena-prompts','disk-ok-groupchat.json'),JSON.stringify({messages:[{role:'assistant',content:'PROGRESS: 重启后仍有汇报\nVERIFIED: 已保存'}]}),'utf8');
  const largeFile=path.join(directory,'arena-prompts','disk-large-groupchat.json');
  fs.writeFileSync(largeFile,'');fs.truncateSync(largeFile,65*1024*1024);
  s=setup([make('disk-bad'),make('disk-ok'),make('disk-large')],{readSummary:undefined});
  try{
    s.board.snapshot();for(let i=0;i<100&&s.row('disk-ok').loading;i++)await wait(20);
    check(s.row('disk-ok').progress==='重启后仍有汇报','Actual worker hydrates legacy saved group messages');
    check(!!s.row('disk-bad').feedError,'Actual worker reports damaged JSON per task');
    for(let i=0;i<100&&s.row('disk-large').loading;i++)await wait(20);
    check(s.row('disk-large').feedError.includes('64 MB'),'Oversized history is explicitly identified, never silently omitted');
    s.board.ingest({hubDataDir:directory,meetingId:'disk-large',summary:Feed.summarizeGroupState({messages:[{role:'assistant',content:'UPDATE: 新汇报仍可呈现'}]})});
    check(s.row('disk-large').progress==='新汇报仍可呈现'&&!s.row('disk-large').feedError,'A fresh authored update restores an oversized-history task');
  }finally{s.board.dispose();}

  // Burst pressure: 1,000 independent groups, 20,000 write notifications, compact bounded batches.
  s=setup(Array.from({length:1000},(_,i)=>make('stress-'+i)));
  try{
    const start=performance.now();
    for(let i=0;i<20000;i++)s.board.ingest({hubDataDir:directory,meetingId:'stress-'+(i%1000),summary:Feed.summarizeGroupState({messages:[{id:'a'+i,role:'assistant',content:'UPDATE: 第 '+i+' 次更新'}]})});
    const snap=s.board.snapshot();s.board.flush();
    check(snap.rows.length===1000,'All 1,000 tasks remain available under pressure');
    check(snap.rows.every(r=>r.progress===`第 ${19000+Number(r.id.slice(7))} 次更新`),'20,000 notifications preserve each task latest update');
    check(s.events.filter(e=>e.channel==='dev-workbench:changed').every(e=>e.data.rows.length<=100),'Push batches are bounded to 100 rows');
    check(performance.now()-start<10000,'Burst processing remains within a ten second budget');
    console.log(JSON.stringify({stress:{tasks:1000,notifications:20000,elapsedMs:Math.round(performance.now()-start),snapshotBytes:Buffer.byteLength(JSON.stringify(snap))}}));
  }finally{s.board.dispose();}
  console.log('dev-workbench service: PASS ('+checks+' checks)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
