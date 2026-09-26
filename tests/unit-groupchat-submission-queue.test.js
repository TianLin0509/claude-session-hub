'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const watcher=require('../core/group-chat-watcher');
test('workflow and supplements serialize only acceptance, preserve per-member concurrency and recover from errors',async()=>{
 const sent=[],waits=[];watcher.init({sessionManager:{getNativeSession:sid=>({send:text=>{sent.push([sid,text]);return new Promise((resolve,reject)=>waits.push({resolve,reject}));}})}});
 const first=watcher.sendToPty('a','workflow','codex');const second=watcher.sendToPty('a','supplement','codex');const other=watcher.sendToPty('b','independent','claude');
 await new Promise(r=>setImmediate(r));assert.deepEqual(sent,[['a','workflow'],['b','independent']]);
 waits[0].resolve({ok:true});await first;await new Promise(r=>setImmediate(r));assert.deepEqual(sent.at(-1),['a','supplement']);
 const rejected=assert.rejects(second,/failure/);waits[2].reject(new Error('failure'));await rejected;
 const third=watcher.sendToPty('a','next','codex');await new Promise(r=>setImmediate(r));assert.deepEqual(sent.at(-1),['a','next']);
 waits[1].resolve({ok:true});waits[3].resolve({ok:true});await Promise.all([other,third]);
});
test('a workflow stopped while queued is never submitted after the previous prompt is accepted',async()=>{
 let release,enabled=true;const sent=[];watcher.init({sessionManager:{getNativeSession:()=>({send:text=>{sent.push(text);return new Promise(r=>release=r);}})}});
 const first=watcher.sendToPty('a','earlier','codex');const next=watcher.sendToPty('a','cancelled step','codex',{shouldSubmit:()=>enabled});
 await new Promise(r=>setImmediate(r));enabled=false;release({ok:true});await first;
 assert.deepEqual(await next,{ok:false,notSent:true,reason:'派工已暂停或取消，本条未发送'});assert.deepEqual(sent,['earlier']);
});
