'use strict';
// Real isolated Hub / renderer / IPC / subprocess protocol fixture. No cloud AI calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-memory-gui-'));
  const data=path.join(root,'data'),home=path.join(root,'home'),cwd=path.join(root,'project');
  const codexHome=path.join(home,'.codex'),native=path.join(codexHome,'sessions'),empty=path.join(root,'empty');
  const out=path.resolve('artifacts/memory-mvp-implementation/gui-'+Date.now());
  for(const p of [data,cwd,home,native,empty,out,path.join(cwd,'.git'),path.join(codexHome,'memories')])fs.mkdirSync(p,{recursive:true});
  const rule='# 项目规则\n原生文件保持原位，不覆盖。\n';
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),rule,'utf8');
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="medium"\n[features]\nmemories=true\n');
  fs.writeFileSync(path.join(codexHome,'memories','MEMORY.md'),'# Codex 原生记忆\n这是原生维护的内容。\n','utf8');
  fs.writeFileSync(path.join(cwd,'散落的项目知识.md'),'# 文档\n需要时可浏览，不自动改动。','utf8');
  const timestamp=new Date().toISOString(),raw=path.join(native,'rollout-2026-09-17T01-00-00-0198aa00-1111-7000-8000-000000000001.jsonl');
  fs.writeFileSync(raw,[{type:'session_meta',timestamp,payload:{id:'0198aa00-1111-7000-8000-000000000001',cwd}},
    {type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:'记忆页面不需要会话列表，当前上下文直接对应当前 session。'}]}},
    {type:'response_item',timestamp,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'已确认：保留最左功能栏，使用独立 DREAM_INDEX.md。'}]}}].map(JSON.stringify).join('\n')+'\n','utf8');
  const result={root,out,fixture:true,boundary:'实际隔离 Hub 和原生协议子进程，模型回答为确定性夹具；未调用云端模型。',checks:[],passed:false};let hub,cdp;
  const until=async(expr,label)=>{const end=Date.now()+35000;while(Date.now()<end){if(await cdp.eval('Boolean('+expr+')'))return;await sleep(100);}throw Error('timeout: '+label);};
  const click=async selector=>{await until('!!document.querySelector('+JSON.stringify(selector)+')','exists '+selector);await cdp.eval('document.querySelector('+JSON.stringify(selector)+').click()');};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try {
    hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'hidden',label:'memory-mvp',extraEnv:{
      CLAUDE_HUB_HOME_DIR:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),AI_HUB_WORKSPACE_ROOT:root,
      HUB_SESSION_SEARCH_CODEX_ROOTS:native,HUB_SESSION_SEARCH_CLAUDE_ROOTS:empty,HUB_SESSION_SEARCH_KIMI_ROOTS:empty,HUB_SESSION_SEARCH_GEMINI_ROOTS:empty,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_DREAM:'1',
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl')}});
    result.pid=hub.pid;result.port=hub.port;cdp=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"','renderer');
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'medium',mcpProfile:'none'}})+')');
    assert.ok(s.id,JSON.stringify(s));const sid=JSON.stringify(s.id);
    await until('sessions.get('+sid+')?.nativeRuntime?.state==="idle"','native ready');
    await click('.session-item[data-session-id="'+s.id+'"]');
    result.historyStatus=await cdp.eval('ipcRenderer.invoke("refresh-session-search",{immediate:true,force:true})');
    await click('#btn-rail-memory');
    await until('document.querySelector("#memory-page .mp-pagehead h2")','context content');
    assert.equal(await cdp.eval('document.querySelectorAll("#memory-page [role=tab]").length'),3);
    assert.equal(await cdp.eval('[...document.querySelectorAll("#scene-rail > .btn-shell-nav")].indexOf(document.getElementById("btn-rail-memory"))'),5);
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector("#session-sidebar")).visibility'),'hidden');
    assert.equal(await cdp.eval('Math.abs(document.querySelector("#memory-page").getBoundingClientRect().left-document.querySelector("#scene-rail").getBoundingClientRect().right)<1'),true);
    assert.equal(await cdp.eval('document.querySelectorAll(\'[data-action="open-memory"]\').length'),1);
    await until('document.querySelector("#memory-page").innerText.includes("AGENTS.md")','native context');
    await snap('01-current-context');result.checks.push('第六个统一入口、三个 tab、无会话列表、当前 session 原生规则预览');
    await click('[data-tab="library"]');await click('[data-action-mp="scan"]');
    await until('document.querySelector("#memory-page").innerText.includes("散落的项目知识.md")','scan');
    await snap('02-memory-library');result.checks.push('原生 MEMORY.md 原位浏览、扫描项目 Markdown');
    await click('[data-tab="dream"]');
    await until('document.querySelectorAll("#memory-page [data-source]").length>0','history sources');
    const count=await cdp.eval('document.querySelectorAll("#memory-page [data-source]:checked").length');assert.ok(count>0);
    assert.equal(await cdp.eval('document.querySelector("#mp-kind").value'),'codex');
    assert.equal(await cdp.eval('document.querySelector("#mp-effort").value'),'medium');
    await click('[data-source-preview]');await until('document.querySelector(".mp-source-preview")?.textContent.includes("会话列表")','source preview');
    assert.equal(await cdp.eval('document.querySelector("[data-tab=dream]").getAttribute("aria-selected")'),'true');
    await snap('03-dream-selection');await click('[data-action-mp="start"]');
    await until('document.querySelector(".mp-job h3")?.textContent.includes("造梦完成")','dream published');
    const snapshot=await cdp.eval('ipcRenderer.invoke("memory:snapshot",{sessionId:'+sid+'})');assert.equal(snapshot.ok,true,JSON.stringify(snapshot));
    const job=snapshot.data.jobs[0];assert.equal(job.status,'done');assert.notEqual(job.sessionId,s.id);assert.equal(snapshot.data.session.id,s.id);
    assert.equal(snapshot.data.pending,true);assert.equal(job.sources.length,count);
    assert.equal(fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8'),rule);
    assert.match(fs.readFileSync(snapshot.data.indexPath,'utf8'),/topics\/preferences.md/);
    assert.equal((await cdp.eval('ipcRenderer.invoke("memory:candidates",{sessionId:'+sid+'})')).data.every(x=>x.processed),true);
    await snap('04-dream-completed');result.checks.push('真实按钮 → 已有历史索引完整导出 → 实体 Codex session → 原生协议回执 → 索引及主题入库；原生规则不变');
    await click('[data-job-session]');await until('document.getElementById("memory-page").hidden && getFocusedSessionId()==='+JSON.stringify(job.sessionId),'open dream session');
    await snap('05-real-dream-session');result.checks.push('打开造梦 session 返回普通会话，可用既有继续/停止/模型功能');
    await click('.session-item[data-session-id="'+s.id+'"]');await until('!!document.querySelector(".floating-input-box")','composer');
    await cdp.eval('(()=>{const input=document.querySelector(".floating-input-box");input.textContent="下一次设计记忆页，请参考项目偏好";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('.floating-input-send');await until('sessions.get('+sid+')?.nativeRuntime?.state==="completed"','normal task complete');
    await click('#btn-rail-memory');await until('document.querySelector("#memory-page").innerText.includes("已发送")','confirmed index');
    const after=(await cdp.eval('ipcRenderer.invoke("memory:snapshot",{sessionId:'+sid+'})')).data;
    assert.equal(after.receipts[0].status,'sent');assert.equal(after.pending,false);
    const trace=fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(trace.some(x=>x.method==='turn/start'&&x.params.input.some(i=>i.text?.includes('<ai-hub-dream-index ref='))));
    await click('[data-receipt="0"]');await snap('06-confirmed-context');result.checks.push('下一条实际任务附短索引，原生提交证据落盘显示已发送；未冒充正文已读取');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    assert.equal(await cdp.eval('document.querySelector("#memory-page").hidden'),true);
    assert.notEqual(await cdp.eval('getComputedStyle(document.querySelector("#session-sidebar")).visibility'),'hidden');
    result.checks.push('Escape 恢复普通会话与侧栏');
    const claude=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'claude',opts:{cwd,model:'claude-opus-5[1m]',effort:'max',mcpProfile:'none'}})+')');
    assert.ok(claude.id,JSON.stringify(claude));const cid=JSON.stringify(claude.id);
    await until('sessions.get('+cid+')?.nativeRuntime?.connection==="connected"','Claude ready');
    await click('.session-item[data-session-id="'+claude.id+'"]');await click('#btn-rail-memory');
    await until('document.querySelector(".mp-pagehead p")?.textContent.includes("claude")','context follows Claude');
    assert.equal((await cdp.eval('ipcRenderer.invoke("memory:snapshot",{sessionId:'+cid+'})')).data.pending,true);
    await click('[data-action-mp="close"]');
    await cdp.eval('(()=>{const input=document.querySelector(".floating-input-box");input.textContent="Claude 请参考记忆";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('.floating-input-send');await until('sessions.get('+cid+')?.nativeRuntime?.state==="completed"','Claude complete');
    assert.equal((await cdp.eval('ipcRenderer.invoke("memory:snapshot",{sessionId:'+cid+'})')).data.receipts[0].status,'sent');
    result.checks.push('切换到 Claude 后当前上下文跟随 session；Claude 原生协议也确认索引发送');
    const slot={kind:'codex',model:'gpt-6-astra',effort:'medium',mcpProfile:'none'};
    const meeting=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'记忆群聊验证',scene:'general',workspace:cwd,slots:[slot,slot]})+')');
    assert.equal(meeting.subSessions.length,2,JSON.stringify(meeting));
    await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(meeting.id)+','+JSON.stringify(meeting)+')');
    await until('!!document.querySelector("#mr-input-box") && !!window.MeetingRoom.getActiveMeetingId()','group view');
    await click('#btn-rail-memory');await until('document.querySelector("#memory-page").innerText.includes("群聊可点击成员头像")','group has no false current session');
    await click('[data-action-mp="close"]');
    await cdp.eval('(()=>{const input=document.querySelector("#mr-input-box");input.textContent="请确认记忆页偏好";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('#mr-send-btn');
    const groupStarts=()=>fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(x=>x.method==='turn/start'&&x.params.input.some(i=>i.text?.includes('请确认记忆页偏好')));
    for(const end=Date.now()+35000;!groupStarts().length&&Date.now()<end;)await sleep(200);
    assert.ok(groupStarts().length>0,'group dispatch reached a member');
    assert.equal(groupStarts().some(x=>x.params.input.some(i=>i.text?.includes('ai-hub-dream-index'))),false);
    result.checks.push('群聊自动派发的 prompt 不附带梦境索引');
    await click('[data-gc-open-session="'+meeting.subSessions[0]+'"]');
    await until('getFocusedSessionId()==='+JSON.stringify(meeting.subSessions[0])+' && !window.MeetingRoom.getActiveMeetingId()','member opened');
    await click('#btn-rail-memory');await until('!!document.querySelector(".mp-pagehead h2")','member context');
    assert.equal((await cdp.eval('ipcRenderer.invoke("memory:snapshot",{sessionId:'+JSON.stringify(meeting.subSessions[0])+'})')).data.session.id,meeting.subSessions[0]);
    await snap('07-group-member-context');result.checks.push('群聊不误用上一会话上下文；点击成员头像后显示该成员 session 的上下文');
    result.passed=true;
  }catch(error){result.error=error.stack;if(cdp){try{result.dom=await cdp.eval('document.querySelector("#memory-page")?.innerText');await snap('failure');}catch{}}throw error;
  }finally{if(cdp)await cdp.close();try{if(hub){result.log=hub.log();result.exit=await gracefulQuit(hub);}}catch(error){result.passed=false;result.teardownError=error.stack;process.exitCode=1;}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,error:result.error}));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
