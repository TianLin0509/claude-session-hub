"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {sessionCards}=require('../core/hub-assistant/session-cards');
const {learningContext}=require('../core/hub-assistant/learning-context');
const {VideoStudio,validateStoryboard,CHUNK}=require('../core/hub-assistant/video-studio');
const storyboard={tag:'LOST IN THE MIDDLE',footer:'依据：Liu et al. 2024',screens:[
 {type:'hook',duration:9,big:'53%',headline:'资料放在中间，它就答不出来',notes:['20 篇文档里找答案']},
 {type:'number',duration:19,value:'75',unit:'%',headline:'只改答案所在的位置',bars:[{label:'第 1 篇',value:75},{label:'第 10 篇',value:53,gold:true}]},
 {type:'concept',duration:22,headline:'注意力不均匀',center:'注意力',nodes:['开头','结尾','中间被稀释']},
 {type:'compare',duration:24,headline:'两种记法',left:{title:'全塞进去',count:9,items:['越堆越长']},right:{title:'写到外面',count:3,items:['按需取回']},verdict:'记忆放窗口外'},
 {type:'flow',duration:22,headline:'越聊越笨',steps:[{label:'输出堆积'},{label:'约束沉底'},{label:'重复犯错'}]},
 {type:'quote',duration:13,quote:'窗口不是记忆，是注意力。',sub:'关键信息在哪个位置？'}]};
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
test('storyboard validation keeps the Vibe structure and text limits without dictating content',()=>{
 const v=validateStoryboard({...storyboard,title:'Agent 为什么越聊越笨'});assert.equal(v.screens.length,6);assert.equal(v.screens[0].type,'hook');
 assert.throws(()=>validateStoryboard({title:'x',screens:storyboard.screens.slice(0,3)}),/5–10/);
 assert.throws(()=>validateStoryboard({title:'x',screens:[storyboard.screens[1],...storyboard.screens.slice(1)]}),/钩子/);
 assert.throws(()=>validateStoryboard({title:'x',screens:[...storyboard.screens.slice(0,5),storyboard.screens[2]]}),/金句/);
 assert.throws(()=>validateStoryboard({title:'x',screens:storyboard.screens.map((s,i)=>i===2?{...s,type:'video'}:s)}),/类型无效/);
 assert.throws(()=>validateStoryboard({title:'x',screens:storyboard.screens.map((s,i)=>i===0?{...s,headline:'很长'.repeat(20)}:s)}),/headline/);
 assert.throws(()=>validateStoryboard({title:'x',screens:storyboard.screens.map((s,i)=>i===1?{...s,bars:[{label:'a',value:'多'}]}:s)}),/数值/);
 assert.throws(()=>validateStoryboard({title:'x',screens:storyboard.screens.map(s=>({...s,duration:6}))}),/90–300/);
});
test('template escapes storyboard text before it reaches innerHTML',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','core','hub-assistant','video','vibe-template.html'),'utf8');
 assert.match(html,/const esc=s=>String\(s\?\?''\)\.replace\(\/\[&<>"'\]\/g/);
 // 所有进入 HTML 的分镜文字都经过 esc()：模板里没有直接拼接 s.headline 等字段。
 assert.ok(!/\$\{s\.(headline|quote|sub|big|center|verdict)\}/.test(html));
});
test('studio renders from the storyboard alone, deduplicates and streams bounded verified chunks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-studio-test-'));let rendered=0,release;const gate=new Promise(r=>release=r),bytes=Buffer.alloc(CHUNK+79,81);
 const a={deps:{dataDir:root},workbench:{changed(){}}};
 const studio=new VideoStudio({assistant:a,tools:()=>({ffmpeg:'ffmpeg',ffprobe:'ffprobe'}),renderer:async opts=>{await gate;rendered++;assert.equal(opts.storyboard.screens.length,6);assert.equal(opts.storyboard.title,'技术');fs.writeFileSync(path.join(opts.dir,'video.mp4'),bytes);fs.writeFileSync(path.join(opts.dir,'cover.jpg'),Buffer.from([1,2,3]));return{seconds:110,bytes:bytes.length,chapters:[]}}});
 try{const r=studio.start({title:'技术',storyboard});assert.equal(studio.start({title:'技术',storyboard}).duplicate,true);assert.throws(()=>studio.chunk(r.id,0),/还没完成/);assert.equal(studio.summary()[0].storyboard,undefined);release();await studio.running.get(r.id);assert.equal(rendered,1);
 const one=studio.chunk(r.id,0),two=studio.chunk(r.id,1);assert.equal(Buffer.from(one.data,'base64').length,CHUNK);assert.equal(Buffer.from(two.data,'base64').length,79);assert.equal(two.total,2);assert.equal(one.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.throws(()=>studio.chunk(r.id,2),/编号/);
 assert.equal(studio.cover(r.id),Buffer.from([1,2,3]).toString('base64'));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('render errors are visible and a restart does not pretend an interrupted video finished',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-studio-test-'));const a={deps:{dataDir:root},workbench:{changed(){}}};const s=new VideoStudio({assistant:a,tools:()=>({}),renderer:()=>{throw Error('编码失败')}});
 try{const r=s.start({title:'课程',storyboard});await s.running.get(r.id);assert.equal(s.read(r.id).status,'failed');assert.match(s.read(r.id).phase,/编码失败/);assert.throws(()=>s.cover(r.id),/封面/);
 s.save({...s.read(r.id),status:'working'});const restored=new VideoStudio({assistant:a,renderer:()=>{}});assert.equal(restored.read(r.id).status,'interrupted');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('interest evidence drops agent-to-agent task prompts but keeps the user own questions',()=>{
 const {isDispatchedPrompt}=require('../core/hub-assistant/learning-context');
 for(const t of ['你是 SuperRAN 的独立审查员，第 5 轮只读复审','【本轮回答】把要发到群聊的完整回答写入','请审查 HEAD 18afe357d7023877c3d27a97ffcd72aa3dd5b8c9','在 worktree C:/Vibe 里实现','x'.repeat(2100)])assert.equal(isDispatchedPrompt(t),true,t.slice(0,20));
 for(const t of ['仿真结果说随机权优于 PMI 权，这个结论你怎么看？','Hub 群聊要不要加一个自动帮我挑成员的 router？','合入就行'])assert.equal(isDispatchedPrompt(t),false,t);
 const a={assistantIds:()=>[],sessionMetadata:()=>null,history:{context:()=>({available:true,coverage:'最近七天',sources:[{ref:'E1',role:'user',text:'你是独立审查员，复审这个分支'},{ref:'E2',role:'user',text:'推测解码为什么能不改变输出分布？'}]})}};
 const c=learningContext(a,1);assert.deepEqual(c.questions.map(q=>q.ref),['E2']);assert.match(c.coverage,/1 条是 Agent 之间的派活任务书/);
});
