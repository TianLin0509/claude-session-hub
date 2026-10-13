'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Dispatcher}=require('../core/ordinary-browser-dispatch');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('an action timeout keeps the shared transport and sibling lane alive',async()=>{
 const calls=[];
 const session={execute:async(lane)=>{if(lane==='slow')throw Error('Timeout 15000ms exceeded');return 'ready';},abortLane:async lane=>calls.push(lane)};
 const d=new Dispatcher(session);
 await assert.rejects(d.call('slow',['run-code'],100),/Timeout/);
 assert.equal(await d.call('healthy',['run-code'],100),'ready');
 assert.deepEqual(calls,[]);
});

test('a deadline cancels only its lane and a queued expired step cannot execute later',async()=>{
 const executed=[],aborted=[];let finish;
 const session={execute:async(lane,args)=>{executed.push(args[0]);if(args[0]==='hang')await new Promise(resolve=>{finish=resolve;});return args[0];},abortLane:async lane=>{aborted.push(lane);finish?.();}};
 const d=new Dispatcher(session);
 const first=d.call('one',['hang'],50);
 const queued=d.call('one',['must-not-run'],10);
 await assert.rejects(queued,/deadline/);
 assert.equal(await d.call('two',['healthy'],30),'healthy');
 await assert.rejects(first,/deadline/);
 await wait(5);
 assert.deepEqual(executed,['hang','healthy']);
 assert.deepEqual(aborted,['one']);
 assert.equal(await d.call('one',['recovered'],100),'recovered');
});

test('explicit transport release waits for all in-flight lanes',async()=>{
 let finish;
 const d=new Dispatcher({execute:async()=>new Promise(resolve=>{finish=resolve;}),abortLane:async()=>{}});
 const work=d.call('one',['run-code'],200);
 await wait(1);
 await assert.rejects(d.call('control',['transport-release'],100),/busy/);
 finish(true);await work;
});
