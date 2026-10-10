'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {openCommandScreen}=require('../renderer/command-screen');
const {createModelUiController}=require('../renderer/model-ui');
test('command screen replays geometry and queued output once, then follows only its session',async()=>{
  const ipc=new EventEmitter();
  ipc.invoke=async()=>{
    ipc.emit('terminal-data',{}, {sessionId:'s',seq:4,data:'OLD'});
    ipc.emit('terminal-data',{}, {sessionId:'s',seq:6,data:'\x1b[2;1H› Ask Codex to do anything'});
    return {baseCols:40,baseRows:4,seq:5,text:'\x1b[2J',operations:[{type:'resize',cols:80,rows:6}]};
  };
  const reader=await openCommandScreen(ipc,'s');
  assert.match(reader.text(),/Ask Codex/);assert.doesNotMatch(reader.text(),/OLD/);
  ipc.emit('terminal-data',{}, {sessionId:'other',seq:9,data:'FOREIGN'});
  ipc.emit('terminal-data',{}, {sessionId:'s',seq:7,data:'\x1b[2;1H› Draft\x1b[K'});
  await new Promise(r=>setTimeout(r,25));
  assert.match(reader.text(),/› Draft/);assert.doesNotMatch(reader.text(),/FOREIGN|Ask Codex/);
  reader.dispose();assert.equal(ipc.listenerCount('terminal-data'),0);
});
test('snapshot failure removes the observer instead of falling back to stale UI',async()=>{
  const ipc=new EventEmitter();ipc.invoke=async()=>{throw Error('snapshot unavailable');};
  await assert.rejects(openCommandScreen(ipc,'s'),/snapshot unavailable/);
  assert.equal(ipc.listenerCount('terminal-data'),0);
});
for(const operation of ['model','effort'])test(`Codex ${operation} works with an empty renderer frame and disposes its observer`,async()=>{
  const session={id:'s',kind:'codex',status:'idle',currentModel:{id:'gpt-6-astra'},effort:'low'};
  let screen='› Ask Codex to do anything',disposed=0,sent=0;
  const ipc={
    invoke:async(channel,payload)=>{
      if(channel==='session:send-prompt'){assert.equal(payload.text,'/model');screen='Select Model and Effort\n› 1. gpt-6-astra';return {ok:true};}
      if(channel==='confirm-session-model-switch')return {ok:true,model:{id:'gpt-6-astra'}};
      throw Error(channel);
    },
    send(channel){assert.equal(channel,'terminal-input');screen=++sent===1?'Select Reasoning Level for gpt-6-astra\n› 1. Low\n  2. High':'Model changed to gpt-6-astra '+(operation==='effort'?'high':'low');},
  };
  const ui=createModelUiController({document:{},ipcRenderer:ipc,sessions:new Map([['s',session]]),terminalPanelEl:{},getActiveSessionId:()=> 's',escapeHtml:String,
    getTerminalScreenText:()=>'',openCommandScreen:async()=>({text:()=>screen,dispose(){disposed++;}}),sleep:async()=>{}});
  const result=operation==='model'?await ui.switchModel('s',{id:'gpt-6-astra',label:'Astra'}):await ui.switchEffort('s','high');
  assert.equal(result.ok,true);assert.equal(disposed,1);assert.equal(sent,2);assert.equal(session._modelSwitchPending,undefined);
});
