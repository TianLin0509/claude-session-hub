'use strict';
const readline = require('readline');
const fs=require('fs'),{randomUUID}=require('crypto');
const store=process.env.CLAUDE_HUB_NATIVE_FIXTURE_STORE;
const trace=process.env.CLAUDE_HUB_NATIVE_FIXTURE_TRACE;
const threads = new Map(store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store,'utf8')) : []);
const save=()=>{if(store)fs.writeFileSync(store,JSON.stringify([...threads].filter(([,t])=>process.env.CLAUDE_HUB_NATIVE_FIXTURE_VOLATILE_EMPTY !== '1' || t.turns.length)));};
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
    if(a && a.resolveError){
      awaiting.delete(msg.id);a.thread.status={type:'systemError'};status(a.thread);save();
      event('serverRequest/resolved',{threadId:a.thread.id,requestId:msg.id});
      setTimeout(()=>event('serverRequest/resolved',{threadId:a.thread.id,requestId:msg.id}),100);
      return;
    }
    if(a){ awaiting.delete(msg.id);event('serverRequest/resolved',{threadId:a.thread.id,requestId:msg.id});
      const rest=[...awaiting.values()].some(r=>r.turn===a.turn);
      a.thread.status={type:'active',activeFlags:rest?['waitingOnUserInput']:[]};status(a.thread);if(!rest)finish(a.thread,a.turn); }
    return;
  }
  switch(msg.method){
    case 'initialize':answer(msg.id,{userAgent:'fixture-0.153.4'});break;
    case 'initialized':break;
    case 'config/read':answer(msg.id,{config:{features:{fast_mode:process.env.CLAUDE_HUB_NATIVE_FIXTURE_FAST_DISABLED!=='1'}}});break;
    case 'thread/start':case 'thread/fork': {
      const t={approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,id:randomUUID(),cwd:p.cwd,path:null,status:{type:'idle'},turns:msg.method==='thread/fork' && thread?structuredClone(thread.turns):[],model:p.model,reasoningEffort:p.config?.model_reasoning_effort || 'max'};
      threads.set(t.id,t);save();answer(msg.id,opened(t,p));break;
    }
    case 'thread/resume':
      if(!thread){out({id:msg.id,error:{code:-1,message:'no rollout found for thread id '+p.threadId}});break;}
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
      if(mode==='fixture:usage') {
        answer(msg.id,{turn});
        event('thread/tokenUsage/updated',{threadId:thread.id,turnId:turn.id,tokenUsage:{
          total:{inputTokens:240000,outputTokens:10000,totalTokens:250000,cachedInputTokens:100000,reasoningOutputTokens:4000},
          last:{inputTokens:8000,outputTokens:1000,totalTokens:9000,cachedInputTokens:6000,reasoningOutputTokens:400},modelContextWindow:100000}});
        finish(thread,turn);
      } else if(mode==='fixture:dev-progress') {
        answer(msg.id,{turn});
        for (const [id,text] of [['plan','PLAN: 已定位问题'],['update','UPDATE: 验证已通过']]) {
          const item={id:id+'-'+turn.id,type:'agentMessage',phase:'commentary',text};
          turn.items.push(item);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item});
        }
        setTimeout(()=>finish(thread,turn,'completed','受控验证已完成'),400);
      } else if(mode==='fixture:compact-progress') {
        answer(msg.id,{turn});
        const lines=[
          '我先核对最新代码，确认普通会话和群聊的消息入口。',
          '已找到重复标识的原因：每条进展都渲染了完整头像、名称和操作栏。',
          '开始接入分行记录：左侧显示时间，右侧保留完整正文。',
          '连续回复共用一次 Agent 标识；出现新提问后重新显示标识。',
          '进展中的 **重点文字** 和 `代码标识` 继续按原格式显示。',
          '消息下方重复的耗时已移除，结果区域仍保留验证信息。',
          '正在核对复制操作。\n\n第二段说明也必须完整保留，不能被挤成一行或省略。',
          '工具记录和长消息继续支持展开，更新时保留展开状态。',
          '已检查历史回放，刷新后仍按同一顺序显示进展和结果。',
          '开始检查窄屏布局，以及调整正文字号后的可读性。',
          '正在验证阅读旧内容时，新进展不会强制拉动视图。',
          '检查已完成，准备汇报普通会话与群聊的验证结果。',
        ];
        lines.forEach((text,i)=>setTimeout(()=>{
          if(turn.status!=='inProgress')return;
          const item={id:'compact-'+i+'-'+turn.id,type:'agentMessage',phase:'commentary',text};
          turn.items.push(item);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item});
          if(i===lines.length-1)finish(thread,turn,'completed','**分行记录布局已完成。**\n\n普通会话与群聊保留完整正文，最终答复单独突出。');
        },600*(i+1)));
      } else if(mode==='fixture:scroll') {
        answer(msg.id,{turn});
        for(let i=1;i<=40;i++)setTimeout(()=>{
          const item={id:'scroll-'+i+'-'+turn.id,type:'agentMessage',phase:'commentary',text:`第 ${i} 步：正在持续输出验证信息。\n\n本段用于检查新内容到来时阅读位置是否稳定，用户可以随时向上翻阅。`};
          turn.items.push(item);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item});
          if(i===40)finish(thread,turn,'completed','滚动验收结束。');
        },i*300);
      } else if(mode==='fixture:terminal-design') {
        answer(msg.id,{turn});
        const progress={id:'progress-'+turn.id,type:'agentMessage',phase:'commentary',text:'正在检查项目结构，确认本次改动的入口。'};
        turn.items.push(progress);event('item/started',{threadId:thread.id,turnId:turn.id,item:progress});
        const command={id:'command-'+turn.id,type:'commandExecution',command:'node --test tests/session.test.js',status:'inProgress',aggregatedOutput:''};
        turn.items.push(command);event('item/started',{threadId:thread.id,turnId:turn.id,item:command});
        command.aggregatedOutput='PASS  欢迎页与任务输入\nPASS  深色主题与窄屏布局\n';
        event('item/commandExecution/outputDelta',{threadId:thread.id,turnId:turn.id,itemId:command.id,delta:command.aggregatedOutput});
        command.status='completed';command.exitCode=0;save();
        event('item/completed',{threadId:thread.id,turnId:turn.id,item:command});
        const reply={id:'reply-'+turn.id,type:'agentMessage',phase:'final_answer',text:''};
        turn.items.push(reply);event('item/started',{threadId:thread.id,turnId:turn.id,item:reply});
        const chunks=['## 界面已更新\n\n','输出按问题、执行过程和回答分段，阅读时更容易找到重点。\n\n','```javascript\n','const theme = "midnight";\n','function welcome(name) {\n  return `Hello, ${name}`;\n}\n','```\n\n','- 原始输出仍可选择、复制和搜索。\n- 所有检查通过，接下来可以继续提交任务。'];
        chunks.forEach((delta,index)=>setTimeout(()=>{
          reply.text+=delta;save();event('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:reply.id,delta});
          if(index===chunks.length-1){event('item/completed',{threadId:thread.id,turnId:turn.id,item:reply});finish(thread,turn,'completed',null);}
        },250+index*160));
      } else if(mode==='fixture:card-details') {
        answer(msg.id,{turn});
        const emit=item=>{turn.items.push(item);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item});};
        emit({id:'progress-'+turn.id,type:'agentMessage',phase:'commentary',text:'已定位卡片信息缺失，正在验证工具输出与交付关联。'});
        setTimeout(()=>{
          emit({id:'change-'+turn.id,type:'fileChange',status:'completed',changes:[{path:'src/card-example.js',kind:{type:'update'},diff:'-old\n+new'}]});
          emit({id:'change-failed-'+turn.id,type:'fileChange',status:'failed',error:'controlled write failure',changes:[{path:'src/not-written.js',kind:{type:'update'},diff:'-old\n+new'}]});
          for(let i=0;i<25;i++)emit({id:'check-'+i+'-'+turn.id,type:'commandExecution',command:'node --test src/example-'+i+'.test.js',status:'completed',aggregatedOutput:'',exitCode:0,durationMs:12});
          emit({id:'failed-'+turn.id,type:'commandExecution',command:'node --test missing.test.js',status:'completed',aggregatedOutput:'Error: interrupted process',exitCode:-1,durationMs:1200});
          emit({id:'long-'+turn.id,type:'commandExecution',command:'node --test card-example.test.js',status:'completed',aggregatedOutput:'完整日志\n'+'验'.repeat(60001)+'\nEND-OF-FULL-OUTPUT',exitCode:0,durationMs:2300});
          emit({id:'mcp-'+turn.id,type:'mcpToolCall',server:'fixture',tool:'check',status:'completed',result:{content:[{type:'text',text:'结构化结果保留'}]}});
          finish(thread,turn,'completed','卡片细节已验证。\n\n- 修改文件：`src/card-example.js`\n- 成功命令 26 条，失败命令 1 条；失败没有被隐藏。\n- 交付：[验收说明](./card-delivery.html)');
        },500);
      } else if(mode==='fixture:collapsed-markdown') {
        answer(msg.id,{turn});
        setTimeout(()=>finish(thread,turn,'completed',require('./collapsed-markdown')),250);
      } else if(mode==='fixture:conversation') {
        answer(msg.id,{turn});
        const progress=(id,text)=>{const item={id:id+'-'+turn.id,type:'agentMessage',phase:'commentary',text};
          turn.items.push(item);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item});};
        const first={id:'progress-one-'+turn.id,type:'agentMessage',phase:'commentary',text:'已定位问题'};
        turn.items.push(first);event('item/started',{threadId:thread.id,turnId:turn.id,item:first});
        setTimeout(()=>{const delta='：同一轮中的进展和最终回答，需要保留各自的消息身份。';first.text+=delta;save();
          event('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:first.id,delta});
          event('item/completed',{threadId:thread.id,turnId:turn.id,item:first});},1200);
        setTimeout(()=>progress('progress-two','正在验证：重复回放只更新同一条消息，新的进展独立显示。'),1800);
        setTimeout(()=>{const tool={id:'verify-'+turn.id,type:'commandExecution',command:'node --test conversation.test.js',status:'completed',aggregatedOutput:'1 test passed',exitCode:0};
          turn.items.push(tool);save();event('item/completed',{threadId:thread.id,turnId:turn.id,item:tool});},2400);
        setTimeout(()=>finish(thread,turn,'completed','已完成：过程消息保持可见，最终回答独立展示。\n\n'+Array.from({length:36},(_,i)=>`${i+1}. 这是同一条长回答中的验证说明，展开后可阅读完整正文；它不会被伪造为多条消息。`).join('\n')),3800);
      } else if(mode==='fixture:empty') {
        const reply={turn:{...turn}};
        finish(thread,turn,'completed','');
        setTimeout(()=>answer(msg.id,reply),30);
      } else if(mode==='fixture:no-ack') { finish(thread,turn);
      } else if(['fixture:resolve-error','fixture:wait','fixture:multi','fixture:optional','fixture:approval','fixture:file-approval','fixture:permissions','fixture:mcp','fixture:orphan'].includes(mode)) {
        answer(msg.id,{turn});
        for(let index=0;index<(mode==='fixture:multi'?2:1);index++){
        const id=nextRequest++;
        awaiting.set(id,{thread,turn,resolveError:mode==='fixture:resolve-error'});
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
    case 'collaborationMode/list':answer(msg.id,{data:[{name:'Plan',mode:'plan',model:'do-not-copy',reasoning_effort:'low'},{name:'Default',mode:'default'}]});break;
    case 'model/list':answer(msg.id,{data:['fixture-model','fixture-model-2','gpt-6-astra'].map(model=>({id:model,model,displayName:model,additionalSpeedTiers:model==='fixture-model-2'?[]:['fast'],supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))}))});break;
    case 'thread/name/set':thread.name=p.name;answer(msg.id,{});break;
    default:out({id:msg.id,error:{code:-32601,message:'unsupported '+msg.method}});
  }
});
