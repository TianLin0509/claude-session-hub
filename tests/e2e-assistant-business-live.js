'use strict';
// Real subscription and real isolated PTYs; the business data is a labelled
// test fixture. No production prompt, state, or business file is changed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {SqliteSessionSearchIndex}=require('../core/session-search-sqlite-index');
const {readFinals}=require('../core/hub-assistant/live-history');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
  const out=path.resolve('artifacts/assistant-business-live',new Date().toISOString().replace(/[:.]/g,'-'));
  const root=path.join(out,'private-run'),data=path.join(root,'data'),home=path.join(root,'home'),codexHome=path.join(home,'codex'),workspace=path.join(root,'workspaces'),business=path.join(workspace,'orders');
  for(const dir of [out,data,codexHome,business])fs.mkdirSync(dir,{recursive:true});
  const production=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
  const profile=production.providers?.codex?.subscription_profiles?.find(p=>p.id==='second'&&p.label==='主账号');
  assert(profile,'明确的主账号配置应存在');
  const auth=path.join(profile.home,'auth.json'),before=fileHash(auth),historyFile=path.join(data,'empty-history.sqlite');
  new SqliteSessionSearchIndex(historyFile).close();
  fs.writeFileSync(path.join(business,'status.json'),j({fixture:true,project:'订单同步',completed:7,total:8,retentionDays:null,state:'等待用户确认保留天数'}),'utf8');
  fs.writeFileSync(path.join(business,'README.md'),'# 隔离验收业务\n这是一项测试订单同步任务。状态以 status.json 为准。用户确认保留天数后，更新 retentionDays、completed=8、state=已生成归档方案，并写 delivery.md 说明方案。不要操作此目录之外的文件。\n','utf8');
  let hub,cdp,assistantId,targetId;
  const result={passed:false,profile:'second',model:'gpt-6-astra',effort:'high',scope:'真实订阅+真实Hub/CLI；业务内容为隔离测试夹具；搜索索引故意为空以验证原生最新记录补读',out,steps:[]};
  const until=async(label,read,timeout=180000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const value=await read();if(value)return value;await wait(350);}throw Error('timeout: '+label);};
  const click=async selector=>{await until('clickable '+selector,()=>cdp.eval(`!!document.querySelector(${j(selector)}) && !document.querySelector(${j(selector)}).disabled`),30000);const point=await cdp.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});};
  const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
  const session=async id=>cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${j(id)}) || null))`);
  const finals=async id=>{const s=await session(id);return s?readFinals(s,{tailBytes:8*1024*1024}).records:[];};
  const idle=async id=>until('session idle '+id,async()=>{const s=await session(id);return s&&!require('../core/session-runtime-truth').sessionRuntimeIsActive(s)&&s.status!=='running';},60000);
  const sendAssistant=async text=>{await click('.floating-input-box');await cdp.send('Input.insertText',{text});await click('.floating-input-send');};
  const answer=async (count,label)=>until(label,async()=>{const rows=await finals(assistantId);return rows.length>count?rows.at(-1):null;});
  try{
    fs.copyFileSync(auth,path.join(codexHome,'auth.json'));
    fs.writeFileSync(path.join(codexHome,'AGENTS.md'),`# 真实隔离验收\n旅游攻略产物仅写该会话当前目录的 artifacts/ 或 output/，不得写用户桌面或生产目录。旅游攻略正常联网查询、完成可离线阅读HTML；这是实际生成质量验收，不要仅回复占位标记。其他隔离业务按其 README.md 指定路径完成交付。\n`,'utf8');
    fs.writeFileSync(path.join(codexHome,'config.toml'),`model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n[projects.'${path.resolve(workspace).toLowerCase()}']\ntrust_level = "trusted"\n[projects.'${path.resolve(business).toLowerCase()}']\ntrust_level = "trusted"\n`,'utf8');
    fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{codex:'gpt-6-astra'}},providers:{codex:{backend:'subscription',subscription_profile:'second',subscription_profiles:[{id:'second',label:'主账号',home:codexHome}]}}}),'utf8');
    hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'assistant-business-live',windowMode:'background',allowExternalState:true,extraEnv:{
      CLAUDE_HUB_E2E:'1',CLAUDE_HUB_ASSISTANT_HISTORY_DB:historyFile,CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:path.join(home,'claude'),CODEX_HOME:codexHome,CODEX_SQLITE_HOME:'',HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',CLAUDE_HUB_AGENT_RUNTIME:'pty',HUB_CODEX_EDITOR_INPUT:'1',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:'',CLAUDE_HUB_NATIVE_FIXTURE_STORE:'',CLAUDE_HUB_NATIVE_FIXTURE_TRACE:'',OPENAI_API_KEY:'',CODEX_API_KEY:'',DEEPSEEK_API_KEY:'',AI_HUB_WORKSPACE_ROOT:workspace,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty'),
    }});result.pid=hub.pid;cdp=await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
    // Test setup uses the real factory; all user-assistant interactions below
    // are actual mouse/keyboard input in the A conversation view.
    const title='订单同步隔离验收-'+Date.now();
    const target=await cdp.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:${j({title,cwd:business,codexProfile:'second',model:'gpt-6-astra',effort:'high',mcpProfile:'none'})}})`);
    targetId=target.id;result.targetId=targetId;
    const seedText='这是隔离验收任务。请读取当前目录 status.json 和 README.md，只汇报当前订单同步进展及需要用户确认什么，限80字，保持文件原样。';
    result.setupReceipt=await cdp.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${j(targetId)},text:${j(seedText)},clientSubmissionId:${j(crypto.randomUUID())},waitForCliReady:true})`);
    const initial=await until('target initial answer',async()=>{const r=await finals(targetId);return r.length?r.at(-1):null;});result.initialTarget=initial;await idle(targetId);
    assert.match(initial.text,/7|七/);assert.match(initial.text,/保留|天数/);result.targetNativeId=(await session(targetId)).codexSid;
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:90});
    await until('rail pin visible',()=>cdp.eval('(()=>{const e=document.querySelector("#rail-pin"),r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)})()'),30000);
    await click('#rail-pin');await until('rail pinned',()=>cdp.eval('document.getElementById("app-container").classList.contains("rail-pinned")'),10000);
    await until('assistant navigation visible',()=>cdp.eval('(()=>{const e=document.querySelector("#btn-assistant"),r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)})()'),10000);
    await click('#btn-assistant');await until('ordinary assistant composer',()=>cdp.eval('document.body.classList.contains("assistant-session-active") && !!document.querySelector(".floating-input-box")'));await sendAssistant('现在订单同步的最新进展是什么？还需要我决定什么？只依据实际记录，限120字。');
    assistantId=await until('assistant identity',()=>cdp.eval('ipcRenderer.invoke("assistant:get-overview").then(r=>r.sessionId)'));result.assistantId=assistantId;
    const first=await answer(0,'first progress answer');result.firstAnswer=first;
    assert.match(first.text,/7|七/);assert.match(first.text,/保留|天数/);assert.match(first.text,/\[E[a-zA-Z0-9_-]+\]/);
    await until('first answer in normal cards',()=>cdp.eval(`document.querySelector('#msg-overlay')?.textContent.includes(${j(first.text.slice(0,18))})`),30000);
    assert.equal(await cdp.eval('activeSessionId'),assistantId);
    await shot('01-accurate-progress');result.steps.push('空历史索引下，助理页真实问答读到原会话7/8进展与待确认事项');
    await idle(assistantId);const count=(await finals(assistantId)).length;
    await sendAssistant('请推进「订单同步」业务：我确认保留30天。请让原会话按它的 README.md 完成剩余工作，更新 status.json 并写 delivery.md，告诉我实际结果。原会话有新回复后第一时间提醒我。');
    const delegated=await answer(count,'delegation assistant answer');result.delegationAnswer=delegated;
    const delivered=await until('target changed real artifact',async()=>{const s=JSON.parse(fs.readFileSync(path.join(business,'status.json'),'utf8'));return s.completed===8&&s.retentionDays===30&&fs.existsSync(path.join(business,'delivery.md'))?s:null;});result.businessAfter=delivered;
    assert.equal((await session(targetId)).codexSid,result.targetNativeId,'必须推进同一个原生会话');
    const notice=await until('real reply notification',async()=>{const r=await cdp.eval('ipcRenderer.invoke("assistant:notifications")');return r.notifications?.find(n=>n.sessionId===targetId)||null;});result.notification=notice;
    await click('.assistant-notifications summary');
    await until('notification visible',()=>cdp.eval(`document.querySelector('.assistant-notice-list')?.textContent.includes(${j(notice.text.slice(0,18))})`),30000);
    assert.equal(await cdp.eval('activeSessionId'),assistantId,'派工后不应抢走助理会话');
    const actions=await until('dispatch ledger acknowledged',async()=>{const r=await cdp.eval('ipcRenderer.invoke("assistant:actions")');return r.actions?.some(a=>a.state==='acknowledged'&&a.result?.sessionId===targetId)?r.actions:null;});result.actions=actions;
    assert.equal(actions.filter(a=>a.result?.sessionId===targetId).length,1);
    await shot('02-original-session-progress-and-notice');await click('.assistant-notifications summary');result.steps.push('按业务简称定位原会话，代发确认30天，真实文件更新至8/8，原生新回复触发提醒且未抢页');
    await idle(assistantId);const beforeThird=(await finals(assistantId)).length;
    await sendAssistant('现在再查订单同步最新结果。刚才需要我确认的事情是否已经解决？限120字，引用原会话最新答复，业务是否验收请分清。');
    const latest=await answer(beforeThird,'updated progress answer');result.latestAnswer=latest;
    assert.match(latest.text,/30|三十/);assert.match(latest.text,/8|八|完成|归档/);
    assert.match(latest.text,/\[E[a-zA-Z0-9_-]+\]/);
    await until('latest reply visible',()=>cdp.eval(`document.querySelector('#msg-overlay')?.textContent.includes(${j(latest.text.slice(0,18))})`),30000);
    const allNotices=await cdp.eval('ipcRenderer.invoke("assistant:notifications")');assert.equal(allNotices.notifications.filter(n=>n.id===notice.id).length,1);
    await shot('03-latest-progress');result.steps.push('不依赖搜索索引刷新，追问读到刚产生的30天/归档新结果；提醒无重复');
    result.workbenchPath=path.join(data,'assistant/workbench/CURRENT.md');assert(fs.readFileSync(result.workbenchPath,'utf8').includes(targetId));
    await idle(assistantId);
    const beforeCreate=await cdp.eval('[...sessions.keys()]');
    const originalUserText='在想新开一个codex session，然后因为我明天去南通旅游，对你帮我通过那个codex session让他帮我制作一个南通旅游的攻略。';
    result.spokenRequest=originalUserText;
    await sendAssistant(originalUserText);
    const created=await until('spoken request creates target through model tool',()=>cdp.eval(`([...sessions.values()].find(s=>!${j(beforeCreate)}.includes(s.id))) || null`));
    result.createdTargetId=created.id;
    const createdActions=await until('created task confirmed',async()=>{const r=await cdp.eval('ipcRenderer.invoke("assistant:actions")');return r.actions?.find(a=>a.state==='acknowledged'&&a.result?.sessionId===created.id)||null;});
    result.createdAction=createdActions;
    const trip=await until('created tourism session actually answers',async()=>{const rows=await finals(created.id);return rows.length?rows.at(-1):null;},360000);
    result.createdTargetAnswer=trip;
    assert.match(trip.text,/南通/);assert.match(trip.text,/HTML|html/);
    const s=await session(created.id);result.createdNativeId=s.codexSid;
    assert.equal(s.codexProfile,'second');assert.equal(s.model,'gpt-6-astra');
    const files=fs.readdirSync(s.cwd,{recursive:true}).filter(f=>f.endsWith('.html')).map(f=>path.join(s.cwd,f));
    assert(files.length>0,'目标必须实际生成攻略HTML');
    result.createdArtifacts=files.map(file=>({file,sha256:fileHash(file),bytes:fs.statSync(file).size}));
    assert(files.some(file=>fs.readFileSync(file,'utf8').includes('南通')));
    assert.equal(await cdp.eval(`[...sessions.keys()].filter(id=>!${j(beforeCreate)}.includes(id)).length`),1);
    assert.equal(await cdp.eval('activeSessionId'),assistantId,'新建业务不抢助理页');
    await shot('04-spoken-create-real-trip');result.steps.push('逐字原口语经普通输入→真实模型create_session→唯一新目标→原生confirmed→目标真实南通攻略及HTML');
    result.passed=true;
  }catch(error){result.error=error.stack;process.exitCode=1;if(cdp)await shot('failure').catch(()=>{});}
  finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'),'utf8');result.exit=await gracefulQuit(hub,{timeoutMs:60000});}fs.rmSync(path.join(codexHome,'auth.json'),{force:true});result.authUnchanged=fileHash(auth)===before;if(!result.authUnchanged){result.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify({passed:result.passed,out,steps:result.steps,error:result.error}));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
