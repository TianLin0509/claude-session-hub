"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {sessionCards}=require('../core/hub-assistant/session-cards');
const {learningContext}=require('../core/hub-assistant/learning-context');
const {VideoStudio,validateScenes,CHUNK}=require('../core/hub-assistant/video-studio');
const {svgFrame}=require('../core/hub-assistant/video-renderer');
const scenes=Array.from({length:4},(_,i)=>({title:'原理'+i,caption:'条件 & 因果',takeaway:'适用边界',nodes:['输入','结果'],weight:1}));
test('selected native cards paginate in reverse order and reject unknown cursor and other-session identity',()=>{
 const a={sessionMetadata:id=>id==='one'?{title:'会话',kind:'claude',ccSessionId:'native-one'}:null,deps:{readNativeTurns:()=>({identity:'native-one',turns:Array.from({length:15},(_,i)=>({id:'c'+i,role:i%2?'assistant':'user',text:'正文'+i,timestamp:1000+i}))})}};
 const first=sessionCards(a,{sessionId:'one',limit:6});assert.deepEqual(first.cards.map(c=>c.id),['c14','c13','c12','c11','c10','c9']);assert.equal(first.before,'c9');
 const next=sessionCards(a,{sessionId:'one',before:first.before,limit:6});assert.equal(next.cards[0].id,'c8');assert.equal(next.cards.at(-1).id,'c3');
 assert.throws(()=>sessionCards(a,{sessionId:'one',before:'foreign'}),/发生变化/);assert.throws(()=>sessionCards(a,{sessionId:'removed'}),/不存在/);
 a.deps.readNativeTurns=()=>({identity:'wrong',turns:[]});assert.throws(()=>sessionCards(a,{sessionId:'one'}),/身份/);
});
test('interest evidence uses user questions, excludes assistant own sessions and reports unavailable index',()=>{
 let args;const a={assistantIds:()=>['self'],sessionMetadata:()=>({kind:'claude',ccSessionId:'native-self'}),history:{context:o=>{args=o;return{available:true,coverage:'最近七天',sources:[{ref:'Euser',role:'user',text:'为什么记忆检索会失败'},{ref:'Ebot',role:'assistant',text:'随机诗词'}]}}}};
 const c=learningContext(a,100000);assert.equal(c.questions.length,1);assert.equal(c.questions[0].text,'为什么记忆检索会失败');assert.equal(args.hours,168);assert.deepEqual(args.excludeSessionIds,['self']);assert.equal(learningContext({}).available,false);
});
test('video validation requires mechanism scenes and SVG escapes private markup',()=>{
 assert.throws(()=>validateScenes([]),/4–16/);assert.throws(()=>validateScenes(scenes.map(s=>({...s,nodes:['one']}))),/机制图/);
 const svg=svgFrame({title:'X <script>'},scenes[0],0,4,.5);assert.ok(!svg.includes('<script>'));assert.match(svg,/&lt;script&gt;/);assert.match(svg,/&amp;/);
});
test('studio awaits existing sound, makes no second TTS call, deduplicates and streams bounded verified chunks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-studio-test-'));let release,rendered=0;const audioJob=new Promise(r=>release=r),bytes=Buffer.alloc(CHUNK+79,81);
 const a={deps:{dataDir:root},workbench:{changed(){}},podcasts:{running:new Map([['pod1',audioJob]]),read:()=>({status:'done',episodes:[{seconds:630}]}),file:()=>path.join(root,'audio.ogg')}};
 const studio=new VideoStudio({assistant:a,renderer:async opts=>{rendered++;assert.equal(opts.seconds,630);fs.writeFileSync(path.join(opts.dir,'video.mp4'),bytes);return{seconds:630,bytes:bytes.length,chapters:[]}}});
 try{const r=studio.start({title:'技术',scenes},'pod1');assert.equal(studio.start({title:'技术',scenes},'pod1').duplicate,true);assert.equal(rendered,0);assert.throws(()=>studio.chunk(r.id,0),/还没完成/);release();await studio.running.get(r.id);assert.equal(rendered,1);
 const one=studio.chunk(r.id,0),two=studio.chunk(r.id,1);assert.equal(Buffer.from(one.data,'base64').length,CHUNK);assert.equal(Buffer.from(two.data,'base64').length,79);assert.equal(two.total,2);assert.equal(one.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.throws(()=>studio.chunk(r.id,2),/编号/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('incomplete narration and render errors produce visible failures; restart does not pretend finished',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-studio-test-'));const a={deps:{dataDir:root},workbench:{changed(){}},podcasts:{running:new Map(),read:()=>({status:'failed',error:'声音中断'})}};const s=new VideoStudio({assistant:a,renderer:()=>{throw Error('must not render')}});
 try{const r=s.start({title:'课程',scenes},'pod2');await s.running.get(r.id);assert.equal(s.read(r.id).status,'failed');assert.match(s.read(r.id).phase,/声音中断/);s.save({...s.read(r.id),status:'working'});const restored=new VideoStudio({assistant:a});assert.equal(restored.read(r.id).status,'interrupted');}finally{fs.rmSync(root,{recursive:true,force:true})}
});
