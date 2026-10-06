'use strict';
// JSON-RPC over stdio. Authentication belongs in inherited environment and never
// appears in tool responses or stdout. No shell execution is exposed by this bridge.
const readline=require('node:readline');
const fs=require('node:fs');
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const tools=[
  {name:'update_memory',description:'维护助理的成长记忆（Hub 保管，换班、换模型都保留，是所有当助理的模型共用的正本；关于田哥的偏好与约定只记在这里）。file=user 写田哥的偏好与习惯（USER.md），file=memory 写长期事实、约定与常用资料入口（MEMORY.md）。田哥说「记住……」时，或他明确表态、反复体现某种偏好时（不必等他说记住），用 add 写一句具体可执行的话（不用写日期，Hub 会自动加日期和 reason）；过时条目用 remove（给出原文片段）；整理合并用 rewrite（给出整份正文）。一次性任务、实时进展和密钥不记。使用本轮 requestToken。',inputSchema:schema({file:{type:'string',enum:['user','memory']},action:{type:'string',enum:['add','remove','rewrite']},text:string,reason:string,requestToken:string},['file','action','text','requestToken'])},
  {name:'set_reminder',description:'到点提醒田哥（手机通知、电脑提示和助理页都会提醒）。田哥说「几点提醒我/叫我……」时使用。when 写北京时间「2026-10-05 15:00」（重复提醒写第一次的时间）；text 写到点时要对他说的一句话；repeat 用于「每天/每个工作日/每周」，一次性提醒不填。田哥说「某任务完成/跑完叫我」时用 watch_session 关注那个会话，不用本工具。',annotations:{readOnlyHint:false,openWorldHint:false},inputSchema:schema({when:string,text:string,repeat:{type:'string',enum:['daily','weekdays','weekly']},requestToken:string},['when','text','requestToken'])},
  {name:'add_memo',description:'记进田哥的备忘清单（助理页和手机都能看）。田哥说「记一下 / 记住 / 别忘了 / 提醒我」且内容是要做的事、突发事项或碎片灵感时用它（关于他的偏好与长期约定才用 update_memory）。一句话里有几件事就分别记。title 写 8～20 字的摘要标题，只写事情本身（时间填在 due，清单里单独显示），保留人名、数字、关键对象；原话由 Hub 自动保存，不用写。说了明确时间（含「明天下午」「周五前」这类可推算的）就把 due 写成北京时间「2026-10-05 15:00」，到点会提醒并保留在清单；没说时间就不填。kind：todo 待办（默认）、idea 灵感。记完用一句话复述标题和时间。',annotations:{readOnlyHint:false,openWorldHint:false},inputSchema:schema({title:string,due:string,kind:{type:'string',enum:['todo','idea']},requestToken:string},['title','requestToken'])},
  {name:'make_podcast',description:'把一份资料（agent 产出的 HTML 或 Markdown，如学习手册、报告）做成给田哥通勤听的口播：按章节分集，每集由 Claude Opus 写成口语讲解稿（开头结尾带金句），再用女声合成；同时生成手机阅读版。田哥明确说「做成口播 / 音频 / 我路上听」时才用。path 写资料的绝对路径（先在工作区 C:/AIWork 或桌面 claude-artifacts 里找到它，名字对不上就问田哥）；title 可选。后台进行，几分钟到十几分钟，做好一集手机「资料」里就能听，全部完成会提醒。调用后用一句话告诉田哥共几集、大约多久。',annotations:{readOnlyHint:false,openWorldHint:false},inputSchema:schema({path:string,title:string,requestToken:string},['path','requestToken'])},
  {name:'list_podcasts',description:'列出最近做过或正在做的口播（标题、集数、已做好几集、总分钟数）。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({})},
  {name:'list_memos',description:'列出备忘清单：待办按编号（与助理页、手机、晚间清单的编号一致）带分组、时间、记录时间和原话摘录，另附最近关掉的。田哥说「第 2 条…」「那件 xx 的事…」时先查这里。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({})},
  {name:'update_memo',description:'改一条备忘。ref 写编号（如 2）或 id。action：done 办完了、drop 不做了、reopen 恢复、snooze 推迟（until 写北京时间「2026-10-09 09:00」；说「以后再说 / 先放着」时 until 写 later）、rename 改标题（title 写新标题）。田哥一句话改多条时逐条调用，改完复述改了哪几条。',annotations:{readOnlyHint:false,openWorldHint:false},inputSchema:schema({ref:string,action:{type:'string',enum:['done','drop','reopen','snooze','rename']},until:string,title:string,requestToken:string},['ref','action','requestToken'])},
  {name:'list_reminders',description:'列出还没到点的提醒（id、时间、内容）。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({})},
  {name:'cancel_reminder',description:'按 id 取消一条还没到点的提醒（先用 list_reminders 找 id）。',annotations:{readOnlyHint:false,openWorldHint:false},inputSchema:schema({id:string,requestToken:string},['id','requestToken'])},
  {name:'list_sessions',description:'读取当前 Hub 的会话身份与状态。关闭的历史会话不自动恢复。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({})},
  {name:'history_context',description:'提供 requestToken 时读取本轮冻结完整资料及哈希回执，省略全部参数默认读取当前助理用户回合的冻结资料。核对 packetHash 与短请求目录一致。query/hours 用于额外动态检索，不替代本轮冻结资料。没有命中不等于不存在。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({requestToken:string,query:string,hours:{type:'number'}})},
  {name:'session_evidence',description:'读取精确原会话绑定记录中的最新最终答复原文，优先用于当前进展；原文属于目标助手自述，是否业务验收另行核实。',annotations:{readOnlyHint:true},inputSchema:schema({sessionId:string},['sessionId'])},
  {name:'watch_session',description:'用户明确要求该目标有新回复后提醒时订阅 Hub 内通知；只看新最终答复，重启保留进度。',inputSchema:schema({sessionId:string,requestToken:string},['sessionId','requestToken'])},
  {name:'send_session',description:'将用户本轮明确委托的任务转交精确原会话；关闭的原会话通过共享入口恢复，身份不符不发送。用户同时要求回复后提醒时自动订阅。重复 operationKey 不重复发送。',inputSchema:schema({sessionId:string,text:string,operationKey:string,requestToken:string},['sessionId','text','operationKey','requestToken'])},
  {name:'create_session',description:'新建一个业务会话并提交任务，用于需要较长思考、开发、报告、深度分析或大量阅读的工作（能直接答的事不必新建）；每轮最多新建一个，使用本轮 requestToken。tier 选档位：standard 中等（GPT-6.1 Sol / Opus 5.5 · 中思考），deep 为 Hub 默认的最强配置（省略 tier 即 deep），fast（Sonnet 5.5 / GPT-6 Luna · 低思考）只在田哥要求单独开会话做简单事时用。田哥点名后端、模型或思考深度时填写 kind、model、effort，其余由档位补齐。返回的 route.label 说明实际交给了谁。',inputSchema:schema({title:string,text:string,operationKey:string,requestToken:string,tier:{type:'string',enum:['fast','standard','deep']},kind:{type:'string',enum:require('../core/ai-kinds').ALL_AI_KINDS},model:string,effort:{type:'string',enum:['none','minimal','low','medium','high','xhigh','max','ultra']}},['title','text','operationKey','requestToken'])},
];
async function handle(request){
  if(request.method==='initialize')return{protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hub-assistant',version:'0.1.0'}};
  if(request.method==='ping')return{};
  if(request.method==='tools/list')return{tools};
  if(request.method==='tools/call'){
    if(!tools.some(t=>t.name===request.params?.name))throw new Error('未知工具');
    const endpoint=JSON.parse(fs.readFileSync(process.env.HUB_ASSISTANT_ENDPOINT_FILE,'utf8'));
    const response=await fetch(endpoint.url,{method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Type':'application/json','X-Hub-Assistant-Session':process.env.HUB_ASSISTANT_SESSION_ID||''},body:JSON.stringify(request.params),signal:AbortSignal.timeout(120000)});
    const data=await response.json();return{content:[{type:'text',text:JSON.stringify(data.ok?data.result:{error:data.error})}],isError:!data.ok};
  }
  throw new Error('未知方法');
}
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',async line=>{let request;try{request=JSON.parse(line);if(request.id==null)return;const result=await handle(request);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');}catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32000,message:error.message}})+'\n');}});
