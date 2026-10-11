'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PhoneChannel}=require('../core/hub-phone/channel'),{credentials,seal,open}=require('../core/hub-phone/crypto');
async function idle(channel){for(const deadline=Date.now()+1000;channel.working&&Date.now()<deadline;)await new Promise(r=>setTimeout(r,1));assert(!channel.working);}
function harness(){
 const c=credentials(),state={credentials:c,enabled:true,cursor:0,inbox:[],outbox:[],notices:[]},calls=[],logs=[];
 const assistant={overview:()=>({status:'idle'}),notifications:()=>({notifications:[]}),readLiveFinal:()=>({records:[]}),logDialog:r=>logs.push(r),
 photo:{overview:()=>({status:'running'}),ensureSession:async()=>({ok:true,sessionId:'photo'}),send:async r=>{calls.push(r);return{receipt:{receipt:{status:'confirmed'}}}}}};
 const channel=new PhoneChannel({assistant,journal:{state,change:fn=>fn(state)}});channel.request=async()=>({messages:[]});channel.saveAttachment=a=>'120000-'+a.name;
 const row=(state='queued')=>{const id=crypto.randomUUID();return{id,type:'text',text:'question',state,sessionId:'photo',shared:'120000-capture-'+id+'.jpg'};};
 const packets=()=>state.outbox.map(r=>({id:r.id,...open(c.key,c.channel,r.id,'hub',r.payload)}));
 return{channel,assistant,state,calls,c,row,packets,logs};
}
test('500 photos with duplicate envelopes pass stale waiting/unknown tasks while AI stays busy',async()=>{
 const h=harness(),old=['waiting','unknown','dispatching'].map(s=>h.row(s));h.state.inbox.push(...old);
 const ids=Array.from({length:500},()=>crypto.randomUUID()),incoming=[];let seq=0;
 for(const id of ids){const payload=seal(h.c.key,h.c.channel,id,'phone',{type:'text',text:'question',attachment:{name:'capture-'+id+'.jpg',data:'AA=='}});incoming.push({seq:++seq,id,payload},{seq:++seq,id,payload});}
 await h.channel.ingest(incoming);await h.channel.tick();await h.channel.photoWork;
 assert.equal(h.calls.length,500);assert.equal(new Set(h.calls.map(r=>r.requestId)).size,500);assert(old.every(r=>!h.calls.some(c=>c.requestId===r.id)));
 assert.equal(h.packets().filter(x=>x.id.startsWith('desktop-receipt-')).length,500);
 const finals=[];for(let i=0;i<ids.length;i+=5)finals.push({clientSubmissionId:ids[i],clientSubmissionIds:ids.slice(i,i+5),text:'batch '+i});
 let reads=0;h.assistant.readLiveFinal=()=>{reads++;return{records:finals};};
 for(const deadline=Date.now()+1000;Date.now()<deadline&&h.state.inbox.filter(r=>r.state==='answered').length<500;){await h.channel.tick();await new Promise(r=>setTimeout(r,1));}
 assert.equal(h.state.inbox.filter(r=>r.state==='answered').length,500);assert.equal(h.packets().filter(x=>x.type==='answer').length,100,'combined answers produce one playback each');
 assert(reads<50,'batch replies should not reread native history for each of 500 photos: '+reads);assert.equal(h.calls.length,500);
});
test('native write waiting cannot block desktop receipts, speech requests, or ingest; writes stay serial',async()=>{
 const h=harness();let resolve,concurrent=0,max=0;const gate=new Promise(r=>resolve=r);
 h.assistant.photo.send=async r=>{h.calls.push(r);max=Math.max(max,++concurrent);if(h.calls.length===1)await gate;concurrent--;return{receipt:{receipt:{status:'confirmed'}}};};
 h.state.inbox.push(h.row(),h.row());await h.channel.tick();assert.equal(h.calls.length,1);
 const more=h.row();await h.channel.ingest([{seq:1,id:more.id,payload:seal(h.c.key,h.c.channel,more.id,'phone',{type:'text',text:'new',attachment:{name:'capture-'+more.id+'.jpg',data:'AA=='}})}]);
 h.channel.speak=async()=>({url:'https://example.invalid/audio',chars:1,tokens:1,ms:1});h.state.inbox.push({id:'speech-request-123456',type:'speak',state:'queued',text:'answer',answerId:'answer-id'});
 await h.channel.tick();assert(h.packets().some(x=>x.type==='audio'));assert(h.packets().some(x=>x.id==='desktop-receipt-'+more.id));assert.equal(h.calls.length,1);
 resolve();await h.channel.photoWork;assert.equal(h.calls.length,3);assert.equal(max,1);
});
test('lost submit receipts and unreadable old answers do not block new photos or retry old ones',async()=>{
 const h=harness();h.assistant.photo.send=async r=>{h.calls.push(r);if(h.calls.length===1)throw Error('receipt disconnected');return{receipt:{receipt:{status:'confirmed'}}};};
 h.assistant.readLiveFinal=()=>{throw Error('temporarily unreadable')};h.state.inbox.push(h.row(),h.row(),h.row());await h.channel.tick();await h.channel.photoWork;await h.channel.tick();
 assert.equal(h.calls.length,3);assert.equal(h.state.inbox[0].state,'unknown');assert.equal(h.state.inbox[2].state,'waiting');
});
test('restarting channel continues only unsent photos and emits one batch reply after a relay outage',async()=>{
 const h=harness(),old=h.row('waiting'),next=h.row();h.state.inbox.push(old,next);await h.channel.tick();await h.channel.photoWork;
 await idle(h.channel);assert.deepEqual(h.calls.map(r=>r.requestId),[next.id]);h.assistant.readLiveFinal=()=>({records:[{clientSubmissionId:old.id,clientSubmissionIds:[old.id,next.id],text:'both answers'}]});
 h.channel.request=async route=>{if(route==='/send')throw Error('offline');return{messages:[]};};await h.channel.tick();assert(h.state.inbox.every(r=>r.state==='answered'));
 const restored=JSON.parse(JSON.stringify(h.state)),channel=new PhoneChannel({assistant:h.assistant,journal:{state:restored,change:fn=>fn(restored)}}),sent=[];
 channel.request=async(route,args)=>{if(route==='/send')sent.push(args.body.id);return{messages:[]};};await channel.tick();await channel.tick();
 assert.equal(sent.filter(id=>id.startsWith('answer-')).length,1);assert.equal(h.calls.length,1);
});
test('pausing while a native write is pending preserves remaining unsent photos',async()=>{
 const h=harness();let resolve;h.assistant.photo.send=async r=>{h.calls.push(r);await new Promise(r=>resolve=r);return{receipt:{receipt:{status:'confirmed'}}};};h.state.inbox.push(h.row(),h.row());await h.channel.tick();h.channel.pause();resolve();await h.channel.photoWork;
 assert.equal(h.calls.length,1);assert.equal(h.state.inbox[1].state,'queued');
});
