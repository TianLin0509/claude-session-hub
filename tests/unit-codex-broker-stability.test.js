'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { CodexRuntimeBroker } = require('../core/codex-runtime-broker');
const { Peer } = require('../main/codex-runtime-broker-process');
const { CodexSharedSession } = require('../core/codex-shared-session');
const { createNativeRuntime, acceptNativeSnapshot } = require('../core/codex-native-runtime');

class PausedSocket extends EventEmitter {
  constructor() { super(); this.writableLength=0; this.destroyed=false; this.lines=[]; }
  setEncoding() {}
  write(line) { this.lines.push(line); this.writableLength+=Buffer.byteLength(line); return false; }
  destroy(error) { this.destroyed=true; if(error)this.emit('error',error); this.emit('close'); }
  drain() { this.writableLength=0; this.emit('drain'); }
}
class NativeFixture extends EventEmitter {
  constructor() {
    super(); this.pid=4242; this.threadId='thread-1'; this.contentRevision=1;
    this.runtime={...createNativeRuntime(),connection:'connected',state:'running',threadId:this.threadId,turnId:'turn-1'};
    this.past={id:'past',displayTurnKey:'thread-1:old',role:'assistant',text:'历史'.repeat(500000)};
    this.current={id:'live',displayTurnKey:'thread-1:turn-1',providerTurnId:'turn-1',role:'assistant',text:'开始'};
    this.fullHistoryReads=0; this.reconnects=0; this.reconciles=0;
  }
  start() { return Promise.resolve(this.runtime); }
  reconnect() { this.reconnects++; return Promise.resolve(this.runtime); }
  reconcile() { this.reconciles++; return Promise.resolve(this.runtime); }
  readTranscript(options={}) { if(options.turnId)return [this.current]; this.fullHistoryReads++;return [this.past,this.current]; }
  blocks() { return [{type:'text',text:this.current.text}]; }
  finalText() { return this.current.text; }
  kill() { throw Error('observer must never kill native session'); }
}
test('long history and a paused Hub do not disconnect the native observer during a burst', async () => {
  const native=new NativeFixture(),broker=new CodexRuntimeBroker({sessionFactory:()=>native});
  const socket=new PausedSocket(),peer=new Peer(socket,broker,'token','service');
  const snapshot=await broker.handle(peer,'attach',{options:{id:'hub-1',resumeId:'thread-1'},
    view:{viewId:'view-1',sessionId:'hub-1',hubPid:10,contentMode:'turn'}});
  peer.send({id:1,result:snapshot});
  for(let i=0;i<200;i++) {
    native.current={...native.current,text:'输出 '+i}; native.contentRevision++;
    native.emit('items',native.blocks());
  }
  native.runtime={...native.runtime,revision:2,state:'completed',endedTurns:['turn-1']};
  native.emit('state',native.runtime);
  native.emit('lifecycle',{type:'turn-complete',turnId:'turn-1'});
  await new Promise(resolve=>setTimeout(resolve,100));
  for(let i=0;i<100;i++)socket.drain();
  assert.equal(socket.destroyed,false,'a brief display backlog must not close the connection');
  assert(native.fullHistoryReads<=2,'stream deltas must not repeatedly serialize every old turn');
  const data=socket.lines.map(line=>JSON.parse(line));
  assert(data.some(x=>x.method==='content'&&x.params.finalText==='输出 199'),'final content must be delivered');
  assert(data.some(x=>x.params?.event==='state'&&x.params.args[0].state==='completed'),'real terminal state must be delivered');
  assert.equal(native.reconnects,0);assert.equal(native.reconciles,0);
  peer.close();
});

function localClient(snapshot) {
  const client=new EventEmitter();client.closed=false;
  client.request=async method=>{if(method==='attach')return snapshot;return {ok:true};};
  client.close=()=>{client.closed=true;};return client;
}
function snapshot(epoch=9,revision=1,state='running') {
  return {key:'key',threadId:'thread-1',runtime:{...createNativeRuntime(epoch),revision,connection:'connected',state,threadId:'thread-1',turnId:'turn-1'},
    control:{shared:true,role:'controller',controllerEpoch:1,viewerCount:1},transcript:[],blocks:[],contentRevision:1,finalText:''};
}
test('reconnecting a Hub cannot poison the epoch used to accept later Codex states', async () => {
  const client=localClient(snapshot()),session=new CodexSharedSession({id:'hub-1',brokerConnector:async()=>client});
  await session.start();
  const ui={id:'hub-1',nativeRuntime:session.runtime};
  session.on('state',runtime=>acceptNativeSnapshot(ui,{id:'hub-1',nativeRuntime:runtime}));
  session.onDisconnect(new Error('display pipe closed'));
  const { nativeUnknownOutcome }=require('../core/native-groupchat-outcome');
  const waiting={status:'errored'};
  session.runtime.submission={id:'submission-1',turnId:'turn-1',status:'accepted'};
  assert.equal(nativeUnknownOutcome(waiting,{codex:session,submissionId:'submission-1',providerTurnId:'turn-1'}),waiting,
    'a lost observer pipe must not settle a running groupchat attempt as submission_unknown');
  session.applyRuntime({...snapshot(9,1).runtime});
  assert.equal(ui.nativeRuntime.connection,'connected','authoritative host snapshot must recover local disconnect even at the same host revision');
  session.applyRuntime({...snapshot(10,1,'completed').runtime});
  assert.equal(ui.nativeRuntime.state,'completed','a new native epoch must not be discarded by renderer');
  assert.equal(session.hostRuntimeEpoch,10);
  session.applyRuntime(snapshot(9,999,'running').runtime);
  assert.equal(ui.nativeRuntime.state,'completed','late events from an obsolete native connection are still rejected');
  session.kill();
});

test('single window attach produces no synthetic agent output', async () => {
  const client=localClient(snapshot()),session=new CodexSharedSession({id:'hub-1',brokerConnector:async()=>client});
  const output=[];session.on('data',text=>output.push(text));await session.start();
  assert.deepEqual(output,[],'shared status belongs to UI, never the agent output stream');session.kill();
});

test('completed event snapshots include final-only native items before lifecycle consumers read them', async () => {
  const native=new NativeFixture(),broker=new CodexRuntimeBroker({sessionFactory:()=>native});
  const messages=[],peer={views:new Map(),send:message=>messages.push(JSON.parse(JSON.stringify(message)))};
  await broker.handle(peer,'attach',{options:{id:'hub-1',resumeId:'thread-1'},view:{viewId:'v',sessionId:'hub-1'}});
  messages.length=0;
  native.current={...native.current,text:'only delivered in turn/completed'};native.contentRevision++;
  native.runtime={...native.runtime,state:'completed',revision:2};
  native.emit('state',native.runtime);native.emit('lifecycle',{type:'turn-complete'});
  const content=messages.findIndex(x=>x.method==='content'&&x.params.finalText===native.current.text);
  const lifecycle=messages.findIndex(x=>x.params?.event==='lifecycle');
  assert(content>=0&&content<lifecycle,'capture must see terminal-only items, not a stale partial answer');
});
