'use strict';
// 2026-10-15 事故回归：中继拒收队首一条（409 同编号内容不同）后，电脑发往手机的消息全部堵住一天半。
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {credentials,seal}=require('../core/hub-phone/crypto'),{PhoneChannel}=require('../core/hub-phone/channel');
function harness(){
 const c=credentials(),s={credentials:c,enabled:true,cursor:0,created:1,inbox:[],outbox:[],notices:[]},sent=[];
 const assistant={overview:()=>({status:'idle'}),readLiveFinal:()=>({records:[]}),notifications:()=>({notifications:[]})};
 const channel=new PhoneChannel({assistant,journal:{state:s,change:fn=>fn(s)},renderHtml:async()=>[],transcribe:async()=>''});
 const refuse=new Map();
 channel.request=async(route,args)=>{if(route==='/poll')return{messages:[]};const id=args.body.id;if(refuse.has(id))throw Object.assign(Error('refused'),{status:refuse.get(id)});sent.push(id);return{ok:true}};
 const queue=id=>s.outbox.push({id,payload:seal(c.key,c.channel,id,'hub',{type:'answer',text:id}),sent:false});
 return{channel,assistant,s,sent,refuse,queue};
}
const wb=()=>'workbench-'+crypto.randomUUID();

test('a message the relay refuses is skipped with its reason and never blocks later messages',async()=>{
 for(const status of [400,409,413]){
  const h=harness();h.queue('notice-head');h.queue('profile-1');h.queue('memos-1');h.refuse.set('notice-head',status);
  await h.channel.flush();
  assert.deepEqual(h.sent,['profile-1','memos-1'],String(status));
  const head=h.s.outbox.find(r=>r.id==='notice-head');assert.equal(head.sent,true);assert.equal(head.skipped,status);
 }
});

test('network and server errors still stop the flush so the message is retried later',async()=>{
 for(const status of [429,500,undefined]){
  const h=harness();h.queue('answer-1');h.queue('answer-2');h.refuse.set('answer-1',status);
  await assert.rejects(h.channel.flush());assert.deepEqual(h.sent,[]);assert(h.s.outbox.every(r=>!r.sent),String(status));
 }
});

test('only the newest pending workbench snapshot is sent; workbench errors are kept',async()=>{
 const h=harness(),ids=[wb(),wb(),wb()];h.queue(ids[0]);h.queue('workbench-error-request-1');h.queue(ids[1]);h.queue(ids[2]);
 await h.channel.flush();
 assert.deepEqual(h.sent,['workbench-error-request-1',ids[2]]);
 for(const id of ids.slice(0,2))assert.equal(h.s.outbox.find(r=>r.id===id).skipped,'superseded');
});

test('a notice whose delivery fails part-way is not re-sent later under the same id',async()=>{
 const h=harness();let replies=0;
 h.assistant.notifications=()=>({notifications:[{id:'secretary:2026-10-13:summary:due',kind:'daily-summary',createdAt:2,title:'今日总结',text:'总结'}]});
 const reply=h.channel.reply.bind(h.channel);h.channel.reply=async(...a)=>{replies++;await reply(...a);if(replies===1)throw Error('card render failed');};
 await h.channel.tick();await h.channel.tick();
 assert.equal(replies,1);assert.deepEqual(h.s.notices,['secretary:2026-10-13:summary:due']);
 assert.equal(h.s.outbox.filter(r=>r.id.startsWith('notice-')).length,1);
});
