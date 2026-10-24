'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {MeetingCompanion}=require('../core/company-assistant/meeting');
const {MeetingCapture}=require('../renderer/meeting-capture');
const {MeetingRecorder}=require('../renderer/meeting-recorder');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-recording-unit-'));
 const a={dir:root,workspace:path.join(root,'workspace'),changed(){},sessionBusy:()=>false,lastFinal:()=>null};
 const m=new MeetingCompanion(a,{meetingAsr:{status:()=>({ready:false}),close(){}}});
 try{
  const one=m.create({title:'one'}),key=randomUUID(),b=Buffer.from([0x1a,0x45,0xdf,0xa3,1,2,3]);
  const send=r=>m.capture(one.id,r);
  send({kind:'recording-start',key,at:0,mime:'video/webm;codecs=vp8,opus'});
  send({kind:'recording-chunk',key,at:1000,offset:0,data:b.toString('base64')});
  send({kind:'recording-chunk',key,at:1000,offset:0,data:b.toString('base64')});
  assert.equal(m.load(one.id).recording.bytes,b.length,'lost ack retry must not duplicate bytes');
  fs.appendFileSync(m.recording.file(one.id,m.load(one.id).recording.segments[0]),Buffer.from([9,8]));
  send({kind:'recording-chunk',key,at:1200,offset:b.length,data:Buffer.from([9,8,7]).toString('base64')});
  assert.equal(m.load(one.id).recording.bytes,b.length+3,'partial ENOSPC write resumes after matching prefix');
  assert.throws(()=>send({kind:'recording-chunk',key,at:1500,offset:b.length+10,data:'AQ=='}),/不连续/);
  assert.throws(()=>send({kind:'recording-chunk',key,at:1500,offset:0,data:'AQ=='}),/不一致/);
  assert.throws(()=>m.recording.locate(one.id,500),/没有已完成/);
  send({kind:'recording-finish',key,at:2000});assert.equal(m.recording.locate(one.id,1000).offsetMs,1000);
  send({kind:'recording-gap',at:2000,end:3000,reason:'用户暂停'});assert.throws(()=>m.recording.locate(one.id,2500),/缺口/);
  const live=m.load(one.id);live.sessionId=randomUUID();live.autoUnderstand=false;m.save(live);await m.tools.start();m.tools.bind(live);
  const endpoint=JSON.parse(fs.readFileSync(m.tools.endpoint(one.id),'utf8'));
  const call=(token,body,header)=>fetch(endpoint.url,{method:'POST',headers:{Authorization:token,'Content-Type':'application/json','x-hub-assistant-session':header||''},body:JSON.stringify(body)});
  assert.equal((await call('Bearer wrong',{name:'meeting_index',callerSessionId:live.sessionId},live.sessionId)).status,403);
  const response=await call('Bearer '+endpoint.token,{name:'meeting_index',callerSessionId:'spoof'},'spoof');assert.equal(response.status,200);assert.equal((await response.json()).result.content[0].type,'text');
  live.state='ended';m.save(live);const two=m.create({title:'two'});two.sessionId=randomUUID();two.autoUnderstand=false;m.save(two);m.tools.bind(two);
  const scoped=await (await call('Bearer '+endpoint.token,{name:'meeting_index',arguments:{meetingId:two.id},callerSessionId:two.sessionId},two.sessionId)).json();assert.equal(JSON.parse(scoped.result.content[0].text).title,'one');
  m.frames.extract=async()=>[{at:1000,data:'jpeg-base64',width:20,height:10}];
  const frame=await m.tools.invoke({callerSessionId:live.sessionId,name:'meeting_frames',arguments:{timesMs:[1000]}});assert.equal(frame.content[1].type,'image');assert.equal(frame.content[1].mimeType,'image/jpeg');
  await assert.rejects(()=>m.tools.invoke({callerSessionId:live.sessionId,name:'meeting_read',arguments:{startMs:0,endMs:16*60000}}),/15分钟/);
  const k2=randomUUID();m.capture(two.id,{kind:'recording-start',key:k2,at:0,mime:'video/webm'});m.recording.recover(m.load(two.id));
  const recovered=m.load(two.id);m.recording.recover(recovered);assert.equal(recovered.recording.segments[0].status,'interrupted');assert.ok(recovered.recording.gaps.length);
  const repaired={id:one.id,capturedMs:90000,recording:{segments:[{...m.load(one.id).recording.segments[0],at:30000,end:30000,status:'writing'},{...m.load(one.id).recording.segments[0],key:randomUUID(),at:40000,end:70000,status:'ready'}],gaps:[],bytes:0,savedThrough:70000}};m.recording.recover(repaired);assert.equal(repaired.recording.gaps[0].end,40000,'failed old segment must not hide later ready recordings');
  assert.throws(()=>m.recording.file(one.id,{key:'../escape',file:'bad'}),/无效/);
  let failed=true,pauses=0,starts=0;
  const capture=new MeetingCapture({document:{},window:{performance:{now:()=>1000}},save:async()=>{if(failed)throw Error('disk');},status(){}});capture.started=0;capture.running=true;capture.recorder={pause:async()=>{pauses++;},retry:async()=>{},start:()=>{starts++;},queue:[]};
  capture.enqueue({kind:'slide'});await new Promise(r=>setImmediate(r));assert.equal(capture.paused,true);assert.equal(pauses,1);assert.equal(capture.gapAt,1000);
  failed=false;await capture.retry();capture.resume();assert.equal(starts,1);assert.equal(capture.gapAt,null);
  const recorder=new MeetingRecorder({window:{},streams:[],elapsed:()=>0,save:async()=>{},onError(){}});let parts=0;recorder.part=()=>{parts++;};recorder.schedule=()=>{};recorder.start();recorder.start();assert.equal(parts,1,'start is idempotent');
  console.log('meeting recording: durable idempotent append, ordering, gaps, recovery, token isolation, MCP images PASS');
 }finally{m.close();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
