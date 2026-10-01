'use strict';
// JSON-RPC over stdio. Authentication belongs in inherited environment and never
// appears in tool responses or stdout. No shell execution is exposed by this bridge.
const readline=require('node:readline');
const fs=require('node:fs');
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const tools=[
  {name:'list_sessions',description:'读取当前 Hub 的会话身份与状态。关闭的历史会话不自动恢复。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({})},
  {name:'history_context',description:'提供 requestToken 时读取本轮冻结完整资料及哈希回执，必须与短请求目录的 packetHash 一致。query/hours 用于额外动态检索，不替代本轮冻结资料。没有命中不等于不存在。',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:schema({requestToken:string,query:string,hours:{type:'number'}})},
  {name:'session_evidence',description:'读取精确原会话绑定记录中的最新最终答复原文，优先用于当前进展；原文属于目标助手自述，是否业务验收另行核实。',annotations:{readOnlyHint:true},inputSchema:schema({sessionId:string},['sessionId'])},
  {name:'watch_session',description:'用户明确要求该目标有新回复后提醒时订阅 Hub 内通知；只看新最终答复，重启保留进度。',inputSchema:schema({sessionId:string,requestToken:string},['sessionId','requestToken'])},
  {name:'send_session',description:'将用户本轮明确委托的任务转交精确原会话；关闭的原会话通过共享入口恢复，身份不符不发送。用户同时要求回复后提醒时自动订阅。重复 operationKey 不重复发送。',inputSchema:schema({sessionId:string,text:string,operationKey:string,requestToken:string},['sessionId','text','operationKey','requestToken'])},
  {name:'create_session',description:'按用户本轮明确委托创建一个 Codex 会话并提交任务；首版每轮最多新建一个，继承 Hub 默认配置，使用本轮 requestToken。',inputSchema:schema({title:string,text:string,operationKey:string,requestToken:string},['title','text','operationKey','requestToken'])},
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
