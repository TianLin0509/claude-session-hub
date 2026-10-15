'use strict';
// Hub 重启时新旧进程重叠：同一时间只能有一个进程收发手机消息、写 channel.bin（2026-10-15）。
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WriterLock}=require('../core/hub-phone/writer-lock'),{PhoneJournal}=require('../core/hub-phone/journal'),{PhoneChannel}=require('../core/hub-phone/channel');
const {credentials}=require('../core/hub-phone/crypto');
const safe={encryptString:s=>Buffer.from(s,'utf8'),decryptString:b=>b.toString('utf8')};
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'phone-lock-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('a live, fresh holder blocks; a dead or silent holder is taken over',t=>{
 const f=path.join(tmp(t),'channel.lock');let now=1000;const clock=()=>now;
 const old=new WriterLock(f,{pid:11,now:clock,isAlive:()=>true}),next=new WriterLock(f,{pid:22,now:clock,isAlive:()=>true});
 assert.equal(old.tryAcquire(),true);assert.equal(next.tryAcquire(),false);
 now+=20000;old.beat();now+=20000;assert.equal(next.tryAcquire(),false,'心跳仍新鲜');
 now+=31000;assert.equal(next.tryAcquire(),true,'超过 30 秒没心跳视为已死');
 const dead=new WriterLock(f,{pid:33,now:clock,isAlive:pid=>pid!==22});assert.equal(dead.tryAcquire(),true,'持有进程已退出');
});

test('release only removes our own lock',t=>{
 const f=path.join(tmp(t),'channel.lock'),a=new WriterLock(f,{pid:1,isAlive:()=>false}),b=new WriterLock(f,{pid:2,isAlive:pid=>pid!==1});
 a.tryAcquire();b.tryAcquire();a.release();assert.equal(JSON.parse(fs.readFileSync(f,'utf8')).pid,2);b.release();assert.equal(fs.existsSync(f),false);
});

test('a new Hub waits for the old one, never writes before taking over, then reloads its latest state',async t=>{
 const dir=tmp(t),lockFile=path.join(dir,'channel.lock'),c=credentials();
 const oldJournal=new PhoneJournal(dir,safe);oldJournal.change(s=>Object.assign(s,{enabled:true,credentials:c,cursor:5}));
 const oldLock=new WriterLock(lockFile,{pid:100,isAlive:()=>true});assert.equal(oldLock.tryAcquire(),true);
 const assistant={overview:()=>({status:'idle'}),readLiveFinal:()=>({records:[]}),notifications:()=>({notifications:[]})};
 const newJournal=new PhoneJournal(dir,safe,{claim:false}),requests=[];
 const channel=new PhoneChannel({assistant,journal:newJournal,lock:new WriterLock(lockFile,{pid:200,isAlive:()=>true}),transcribe:async()=>''});
 channel.request=async route=>{requests.push(route);return route==='/poll'?{messages:[]}:{ok:true};};
 channel.start();await channel.tick();
 assert.equal(channel.status().waitingForPreviousHub,true);assert.deepEqual(requests,[],'等待期间不收发');
 newJournal.change(s=>{s.cursor=999;});assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'channel.bin'),'utf8')).cursor,5,'接管前不写盘');
 oldJournal.change(s=>{s.cursor=7;});oldLock.release();
 assert.equal(channel.own(),true);assert.equal(newJournal.state.cursor,7,'接管时读到旧进程最后写下的状态');
 channel.close();assert.equal(fs.existsSync(lockFile),false,'关闭时释放');
});

test('pairing refuses while another Hub owns the channel instead of losing the new credentials',async t=>{
 const dir=tmp(t),lockFile=path.join(dir,'channel.lock');new WriterLock(lockFile,{pid:100,isAlive:()=>true}).tryAcquire();
 const channel=new PhoneChannel({assistant:{overview:()=>({status:'idle'})},journal:new PhoneJournal(dir,safe,{claim:false}),lock:new WriterLock(lockFile,{pid:200,isAlive:()=>true}),transcribe:async()=>''});
 await assert.rejects(channel.pair(),/另一个 Hub/);
});

test('delivery health reports waiting messages and how long the oldest has waited',()=>{
 const s={credentials:credentials(),enabled:true,cursor:0,inbox:[],outbox:[{id:'a',sent:false,at:Date.now()-11*60000},{id:'b',sent:false,at:Date.now()},{id:'c',sent:true}],notices:[]};
 const channel=new PhoneChannel({assistant:{overview:()=>({})},journal:{state:s,change:fn=>fn(s)},transcribe:async()=>''});
 const d=channel.status().delivery;assert.equal(d.pending,2);assert.equal(d.stuck,true);assert.equal(d.lastSentAt,null);
});
