'use strict';
// A real model authors the draft and atomic delivery. Test code only answers
// actual protocol requests and inspects the real Hub file/dispatch state.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client'),{realAcpConfig}=require('./helpers/acp-real-env');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-dev-')),dataDir=path.join(root,'data'),cwd=path.join(root,'workspace'),home=path.join(root,'codex');
  for(const p of [dataDir,cwd,home,path.join(cwd,'.agents')])fs.mkdirSync(p,{recursive:true});
  const nonce=crypto.randomUUID();fs.writeFileSync(path.join(cwd,'acceptance.txt'),nonce);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'# ACP 文件流程验收沙盒\n只读 acceptance.txt，只写当前隔离 Hub 指定的任务文件。遵守用户补充的等待交付口令约束。禁止提交、推送或操作任何生产目录。');
  fs.writeFileSync(path.join(cwd,'.agents/AUTHOR.md'),'# 工作入口\n本测试只验证开题文件交付。实现阶段必须调用提问工具，等待用户明确指令；不得自行创建实现手册。');
  fs.writeFileSync(path.join(cwd,'.agents/project.json'),JSON.stringify({name:'ACP验收沙盒',trunk:'master',test:[],versionFiles:[],contracts:{author:'.agents/AUTHOR.md'}}));
  const config=realAcpConfig();fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify(config));
  const source=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const raw=fs.readFileSync(path.join(source,'config.toml'),'utf8'),read=k=>raw.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=read('model'),effort=read('model_reasoning_effort');assert(model&&effort);
  fs.copyFileSync(path.join(source,'auth.json'),path.join(home,'auth.json'));
  fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n');
  const out=path.resolve('artifacts/acp/dev-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const result={root,out,passed:false,checks:[]};let hub,cdp,meeting;
  const invoke=(name,args)=>cdp.eval('ipcRenderer.invoke('+JSON.stringify(name)+','+JSON.stringify(args)+')');
  const permissions=new Set();
  async function allowTools(){
    if(!meeting)return;
    const rows=await cdp.eval('[...sessions.values()]');
    for(const s of rows)for(const q of s.nativeRuntime?.requests || []){
      if(q.method!=='session/request_permission' || q.params.toolCall?._meta?.qwenQuestions)continue;
      const key=s.id+':'+s.nativeRuntime.epoch+':'+q.id;if(permissions.has(key))continue;permissions.add(key);
      const option=q.params.options.find(o=>o.kind==='allow_once');assert(option);
      assert((await invoke('codex:native-action',{sessionId:s.id,action:'reply',requestId:q.id,epoch:s.nativeRuntime.epoch,result:{outcome:{outcome:'selected',optionId:option.optionId}}})).ok);
    }
  }
  const until=async(fn,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){await allowTools();if(await fn())return;await sleep(200);}throw Error('timeout: '+label);};
  const snap=async name=>{const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  try{
    hub=await launchIsolatedHub({dataDir,port:await port(),label:'acp-dev',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
    cdp=await connectFirstPage(hub);await until(()=>cdp.eval('typeof sessions!=="undefined" && !!window.WorkflowTemplates'),'renderer');
    const slots=[...Object.entries(config.acp.providers).map(([kind,p])=>({kind,model:p.model})),{kind:'codex',model,effort,mcpProfile:'none',codexSpeedTier:'inherit'}];
    meeting=await invoke('create-meeting',{title:'真实原生 ACP 文件流程验收',mode:'dev',scene:'dev',workspace:cwd,slots});assert.equal(meeting.subSessions.length,4);
    await until(()=>cdp.eval(JSON.stringify(meeting.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="idle")'),'all native sessions');
    const workflow=await cdp.eval('window.WorkflowTemplates.createTemplateConfig("dev-task",'+JSON.stringify(slots.map((s,i)=>({memberId:'m'+(i+1),kind:s.kind})))+')');
    await invoke('update-meeting-sync',{meetingId:meeting.id,fields:{serialWorkflow:workflow}});
    await cdp.eval('selectMeeting('+JSON.stringify(meeting.id)+')');
    await until(()=>cdp.eval('!!document.querySelector("[data-file-kickoff]")'),'first-open file kickoff control');
    const input='这是 ACP 文件流程验收。本次只写开题，不做任何业务代码修改。报告包含必需章节，每章只写一句，总计不超过400字；不要表格或HTML。读取 acceptance.txt 的随机标记并在开题报告中原样记录。保存并回读开题草稿后，必须调用你原生的 ask_user_question 工具，询问交付口令（选项 GO / WAIT），等待回答；只有收到 GO 才能原子改名交付。交付后 Hub 自动派发实现阶段时，必须再次调用提问工具等待用户指令，不创建实现手册。这是用户的额外审批约束，优先于自动施工。';
    await cdp.eval('document.getElementById("mr-input-box").textContent='+JSON.stringify(input)+';document.querySelector("[data-file-kickoff]").click()');
    await until(()=>cdp.eval('document.getElementById("mr-input-box").innerText.includes("开题提示词结束")'),'real kickoff prompt');
    await cdp.eval('document.getElementById("mr-send-btn").click()');
    const sid=meeting.subSessions[0],state=()=>invoke('groupchat:get-state',{meetingId:meeting.id}),snapshot=()=>cdp.eval('sessions.get('+JSON.stringify(sid)+')');
    const docs=path.join(dataDir,'task-docs',meeting.id),draft=path.join(docs,'开题报告.md'),done=path.join(docs,'已完成-开题报告.md');
    await until(async()=>fs.existsSync(draft)&&(await snapshot()).nativeRuntime.requests.some(q=>q.params.toolCall?._meta?.qwenQuestions),'native-authored draft and question');
    assert(fs.readFileSync(draft,'utf8').includes(nonce));assert(!fs.existsSync(done));assert.equal(Object.keys((await state()).attempts).length,1);await snap('draft-waiting');
    result.checks.push('real Qwen writes correct nonce into draft; draft and waiting question do not advance file workflow');
    const s=await snapshot(),q=s.nativeRuntime.requests.find(q=>q.params.toolCall?._meta?.qwenQuestions),o=q.params.options.find(o=>o.kind==='allow_once');
    const answer={outcome:{outcome:'selected',optionId:o.optionId},answers:Object.fromEntries(q.params.toolCall._meta.qwenQuestions.map((_,i)=>[String(i),'GO']))};
    assert((await invoke('codex:native-action',{sessionId:sid,action:'reply',requestId:q.id,epoch:s.nativeRuntime.epoch,result:answer})).ok);
    await until(async()=>fs.existsSync(done)&&Object.keys((await state()).attempts).length>=2,'native atomic delivery and automatic next stage');
    assert(!fs.existsSync(draft));assert(fs.readFileSync(done,'utf8').includes(nonce));
    await until(async()=>(await snapshot()).nativeRuntime.requests.some(q=>q.params.toolCall?._meta?.qwenQuestions),'next stage respects user hold');
    result.checks.push('native atomic rename advances actual Hub stage; subsequent implementation remains held on real user question');
    await invoke('groupchat:interrupt',{meetingId:meeting.id});
    // Read-only verification uses the other three real engines in the same dev group.
    const verify='本条只做只读验收发言，不接管开题/实现/合并，不更改任何文件。读取 '+done+'，回复其中随机 UUID 标记，前缀 DEV_ACP_OK。';
    const promise=invoke('groupchat:turn',{meetingId:meeting.id,userInput:verify,targetMemberIds:['m2','m3','m4']});
    promise.catch(()=>{});
    await until(async()=>{const g=await state();return g.messages.filter(m=>m.role==='assistant'&&m.content?.includes('DEV_ACP_OK')&&m.content.includes(nonce)).length===3;},'DeepSeek GLM Codex native file verification',180000);
    await promise;result.group=await state();result.file=await invoke('dev-file:status',{meetingId:meeting.id});await snap('verified');
    result.checks.push('DeepSeek, GLM and real Codex read the native-delivered file with correct member ownership in development group');result.passed=true;
  }catch(e){result.error=e.message;throw e;}finally{
    if(cdp){try{if(meeting){result.group=await invoke('groupchat:get-state',{meetingId:meeting.id});await invoke('groupchat:interrupt',{meetingId:meeting.id});}await snap('final');}catch(e){result.captureError=e.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n').split(config.acp.apiKey).join('[REDACTED]'));result.exit=await gracefulQuit(hub);}
    fs.rmSync(path.join(home,'auth.json'),{force:true});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2).split(config.acp.apiKey).join('[REDACTED]'));
    console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,error:result.error}));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
