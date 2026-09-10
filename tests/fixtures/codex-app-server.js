'use strict';
const readline = require('readline');
const fs=require('fs'),{randomUUID}=require('crypto');
const store=process.env.CLAUDE_HUB_NATIVE_FIXTURE_STORE;
const trace=process.env.CLAUDE_HUB_NATIVE_FIXTURE_TRACE;
const threads = new Map(store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store,'utf8')) : []);
const save=()=>{if(store)fs.writeFileSync(store,JSON.stringify([...threads]));};
let nextRequest=1000;
const awaiting = new Map();
const out = obj => process.stdout.write(JSON.stringify(obj)+'\n');
const event = (method,params) => out({method,params});
const answer = (id,result) => out({id,result});
const status = thread => event('thread/status/changed',{threadId:thread.id,status:thread.status});
const opened = (thread,p) => ({thread,model:thread.model,reasoningEffort:thread.reasoningEffort,
  approvalPolicy:thread.approvalPolicy || 'never',sandbox:{type:({'read-only':'readOnly','workspace-write':'workspaceWrite','danger-full-access':'dangerFullAccess'}[thread.sandbox]) || 'dangerFullAccess'}});
function finish(thread,turn,result='completed',text='原生回答 ✅') {
  if (!turn || turn.status !== 'inProgress') return;
  const item={id:'a-'+turn.id,type:'agentMessage',phase:'final_answer',text};
  if(text!==null)turn.items.push(item);turn.status=result;
  if(result==='failed')turn.error={message:'fixture turn failed',codexErrorInfo:'other'};
  thread.status={type:'idle'};
  save();
  if(text!==null)event('item/completed',{threadId:thread.id,turnId:turn.id,item});
  event('turn/completed',{threadId:thread.id,turn});
  status(thread);
}
const rl = readline.createInterface({input:process.stdin});
rl.on('line',line=>{
  const msg=JSON.parse(line);
  if(trace)fs.appendFileSync(trace,JSON.stringify(msg)+'\n');
  const p=msg.params || {};
  const thread=threads.get(p.threadId);
  if (!msg.method) {
    const a=awaiting.get(msg.id);
    if(a){ awaiting.delete(msg.id);event('serverRequest/resolved',{threadId:a.thread.id,requestId:msg.id});
      const rest=[...awaiting.values()].some(r=>r.turn===a.turn);
      a.thread.status={type:'active',activeFlags:rest?['waitingOnUserInput']:[]};status(a.thread);if(!rest)finish(a.thread,a.turn); }
    return;
  }
  switch(msg.method){
    case 'initialize':answer(msg.id,{userAgent:'fixture-0.153.4'});break;
    case 'initialized':break;
    case 'thread/start':case 'thread/fork': {
      const t={approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,id:randomUUID(),cwd:p.cwd,path:null,status:{type:'idle'},turns:msg.method==='thread/fork' && thread?structuredClone(thread.turns):[],model:p.model,reasoningEffort:p.config?.model_reasoning_effort || 'max'};
      threads.set(t.id,t);save();answer(msg.id,opened(t,p));break;
    }
    case 'thread/resume':
      if(!thread){out({id:msg.id,error:{code:-1,message:'missing thread'}});break;}
      // Like the native server, loaded resume does not update model/effort.
      if(p.approvalPolicy)thread.approvalPolicy=p.approvalPolicy;if(p.sandbox)thread.sandbox=p.sandbox;
      save();answer(msg.id,opened(thread,p));break;
    case 'thread/read':answer(msg.id,{thread});break;
    case 'thread/list':answer(msg.id,{data:[...threads.values()],nextCursor:null});break;
    case 'thread/unsubscribe':answer(msg.id,{status:'unsubscribed'});break;
    case 'turn/start': {
      if(p.model)thread.model=p.model;if(p.effort)thread.reasoningEffort=p.effort;
      const text=p.input.map(x=>x.text || '').join('');
      const mode=text.match(/fixture:[a-z-]+/)?.[0];
      if(mode==='fixture:crash-before'){process.exit(3);break;}
      const user={id:randomUUID(),type:'userMessage',clientId:p.clientUserMessageId,content:p.input};
      const turn={id:randomUUID(),status:'inProgress',items:[user]};
      thread.turns.push(turn);thread.status={type:'active',activeFlags:[]};save();
      event('turn/started',{threadId:thread.id,turn:{...turn}});status(thread);
      event('item/completed',{threadId:thread.id,turnId:turn.id,item:user});
      if(mode==='fixture:broken'){process.stdout.write('not JSON\n');break;}
      if(mode==='fixture:crash'){process.exit(3);break;}
      if(mode==='fixture:empty') {
        const reply={turn:{...turn}};
        finish(thread,turn,'completed','');
        setTimeout(()=>answer(msg.id,reply),30);
      } else if(mode==='fixture:no-ack') { finish(thread,turn);
      } else if(['fixture:wait','fixture:multi','fixture:optional','fixture:approval','fixture:file-approval','fixture:permissions','fixture:mcp','fixture:orphan'].includes(mode)) {
        answer(msg.id,{turn});
        for(let index=0;index<(mode==='fixture:multi'?2:1);index++){
        const id=nextRequest++;
        awaiting.set(id,{thread,turn});
        thread.status={type:'active',activeFlags:mode==='fixture:optional'?[]:['waitingOnUserInput']};status(thread);
        const methods={'fixture:approval':'item/commandExecution/requestApproval','fixture:file-approval':'item/fileChange/requestApproval','fixture:permissions':'item/permissions/requestApproval','fixture:mcp':'mcpServer/elicitation/request','fixture:orphan':'unknown/test'};
        const method=methods[mode] || 'item/tool/requestUserInput';
        if(mode==='fixture:file-approval')event('item/started',{threadId:thread.id,turnId:turn.id,item:{id:'request-item-'+id,type:'fileChange',changes:[{path:'sample.txt',kind:{type:'update'},diff:'-old\n+new'}]}});
        out({id,method,params:{threadId:mode==='fixture:orphan'?'unowned-thread':thread.id,turnId:turn.id,itemId:'request-item-'+id,
          isBlocking:mode!=='fixture:optional',startedAtMs:Date.now(),command:'Write-Output "test"',reason:'隔离请求测试',permissions:{network:{enabled:true}},
          serverName:'fixture',mode:'form',message:'填写颜色',requestedSchema:{type:'object',properties:{color:{type:'string'}},required:['color']},
          questions:[{id:index?'q2':'q',header:'方向',question:'选择一个方向 '+index,options:[{label:'A',description:'方向 A'},{label:'B',description:'方向 B'}]}]}});
        }
      } else if(mode==='fixture:cycle') {
        answer(msg.id,{turn}); let count=0;
        const timer=setInterval(()=>{
          if(turn.status!=='inProgress') {clearInterval(timer);return;}
          if(count++===200){clearInterval(timer);finish(thread,turn);return;}
          thread.status={type:'active',activeFlags:count%2?['waitingOnApproval']:[]};status(thread);
        },350);
      } else if(['fixture:hold','fixture:stop-delayed','fixture:stop-failed','fixture:stop-race'].includes(mode)) answer(msg.id,{turn});
      else if(mode==='fixture:tool-only') {answer(msg.id,{turn});const item={id:'tool-only',type:'commandExecution',status:'completed',exitCode:0};turn.items.push(item);event('item/completed',{threadId:thread.id,turnId:turn.id,item});finish(thread,turn,'completed',null);}
      else if(mode==='fixture:failed') {answer(msg.id,{turn});finish(thread,turn,'failed','');}
      else if(mode==='fixture:tool-error') {answer(msg.id,{turn});event('item/completed',{threadId:thread.id,turnId:turn.id,item:{id:'tool',type:'commandExecution',status:'failed',exitCode:1}});event('error',{threadId:thread.id,turnId:turn.id,error:{message:'tool failed, continuing'},willRetry:true});setTimeout(()=>finish(thread,turn),100);}
      else {
        answer(msg.id,{turn});
        const data=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{
          threadId:thread.id,turnId:turn.id,itemId:'a-'+turn.id,delta:'原生回答 ✅'}})+'\n');
        const at=data.indexOf(Buffer.from('✅'))+1;
        process.stdout.write(data.subarray(0,at));
        process.stdout.write(data.subarray(at));
        finish(thread,turn);
      }
      break;
    }
    case 'turn/steer': {
      const t=thread.turns.find(t=>t.id===p.expectedTurnId);
      if(!t || t.status!=='inProgress'){out({id:msg.id,error:{code:-1,message:'turn no longer running'}});break;}
      const item={id:randomUUID(),type:'userMessage',clientId:p.clientUserMessageId,content:p.input};t.items.push(item);save();
      event('item/completed',{threadId:thread.id,turnId:t.id,item});answer(msg.id,{turnId:t.id});break;
    }
    case 'turn/interrupt': {
      const t=thread.turns.find(t=>t.id===p.turnId),text=t?.items.find(i=>i.type==='userMessage')?.content[0]?.text;
      if(text==='fixture:stop-failed'){out({id:msg.id,error:{code:-1,message:'controlled interrupt failure'}});break;}
      if(text==='fixture:stop-delayed'){answer(msg.id,{});setTimeout(()=>finish(thread,t,'interrupted',''),200);break;}
      if(text==='fixture:stop-race'){finish(thread,t,'completed','');setTimeout(()=>answer(msg.id,{}),50);break;}
      answer(msg.id,{});finish(thread,t,'interrupted','');break;
    }
    case 'model/list':answer(msg.id,{data:['fixture-model','fixture-model-2','gpt-6-astra'].map(model=>({id:model,model,displayName:model,supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))}))});break;
    case 'thread/name/set':thread.name=p.name;answer(msg.id,{});break;
    default:out({id:msg.id,error:{code:-32601,message:'unsupported '+msg.method}});
  }
});
