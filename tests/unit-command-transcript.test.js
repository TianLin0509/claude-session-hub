'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {CommandTranscriptStore, mergeCommandTurns} = require('../core/command-transcript-store');
test('raw multiline commands survive reopen, failures and repeated text without duplicate submissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-transcript-'));
  let store = new CommandTranscriptStore(root);
  const raw = '/goal 修复功能\n— 保留英文 API\n1. 不重启生产';
  store.begin('session', 'one', raw);
  assert.equal(store.begin('session', 'one', raw).duplicate, true);
  assert.throws(() => store.begin('session', 'one', '/goal other'), /ID/);
  store.finish('session', 'one', {ok:false,message:'disconnected'});
  store.begin('session', 'two', raw);
  store.close(); store = new CommandTranscriptStore(root);
  try {
    const rows = store.read('session');
    assert.equal(rows.length, 2); assert.equal(rows[0].text, raw);
    assert.equal(rows[0].commandResult.ok, false);
    const merged = mergeCommandTurns([{role:'user',clientSubmissionId:'one',text:'provider rewritten'},
      {role:'assistant',text:'answer',ts:rows[1].ts+1}], rows, {limit:Infinity});
    assert.equal(merged.filter(x=>x.role==='user').length, 2);
    assert.equal(merged.at(-1).text,'answer');
    assert.deepEqual(store.read('another-session'), []);
    assert.deepEqual(mergeCommandTurns([], rows, {limit:0}), []);
    const legacy = mergeCommandTurns([{role:'user',text:raw,ts:rows[0].ts},
      {role:'user',text:raw,ts:rows[1].ts}], rows, {limit:Infinity});
    assert.equal(legacy.length,2,'each legacy echo replaces only its own command');
  } finally { store.close(); }
});

test('transcript IPC merges command-only history with a provider that has no model turns', async () => {
  const store = new CommandTranscriptStore(fs.mkdtempSync(path.join(os.tmpdir(), 'command-ipc-')));
  try {
    store.begin('sid','cmd','/goal 原文');
    const {parseSessionTranscript} = require('../main/ipc/transcript-handlers');
    const native = {start:async()=>{},readTranscript:()=>[],runtime:{state:'idle'},options:{}};
    const result = await parseSessionTranscript({hubSessionId:'sid'}, {
      defer:async()=>{},commandTranscriptStore:store,
      sessionManager:{getSession:()=>({}),getNativeSession:()=>native},
    });
    assert.equal(result.turns.length, 1); assert.equal(result.turns[0].text,'/goal 原文');
  } finally { store.close(); }
});

test('submit IPC keeps failed command input and never replays the same submission', async () => {
  const {EventEmitter}=require('events');
  const {registerPromptSubmitIpc}=require('../main/ipc/prompt-submit-handlers');
  const watcher=require('../core/group-chat-watcher');
  const store=new CommandTranscriptStore(fs.mkdtempSync(path.join(os.tmpdir(),'command-send-')));
  const handlers=new Map(), manager=new EventEmitter();let sends=0;
  const native={send:async()=>{sends++;return {ok:false,sendStatus:'stuck',mode:'native-command',message:'原生结果待核对'};}};
  manager.getSession=()=>({id:'sid',kind:'codex',runtimeBackend:'codex-app-server'});
  manager.getNativeSession=()=>native;
  watcher.init({sessionManager:manager});
  registerPromptSubmitIpc({handle:(name,fn)=>handlers.set(name,fn)},
    {sessionManager:manager,commandTranscriptStore:store,logger:{warn(){}}});
  try{
    const send=handlers.get('session:send-prompt');
    const request={sessionId:'sid',clientSubmissionId:'submission',text:'/goal 保留失败原文'};
    const result=await send(null,request);
    assert.equal(result.ok,false);assert.equal(result.message,'原生结果待核对');
    assert.deepEqual(await send(null,request),result);assert.equal(sends,1);
    assert.equal(store.read('sid')[0].text,request.text);
    const mismatch=await send(null,{...request,text:'/goal different'});
    assert.equal(mismatch.ok,false);assert.equal(sends,1);
  }finally{store.close();}
});
