'use strict';
// Real isolated Electron, local native transcript and SQLite fixtures. No cloud
// models or company communication; mouse events exercise the actual controls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-progress-'));
const data=path.join(temp,'data'),cwd=path.join(temp,'work');
const out=path.resolve('artifacts/20261023-agent-progress-'+Date.now());
for(const dir of [data,cwd,out,path.join(data,'company-bridge')])fs.mkdirSync(dir,{recursive:true});
const nativeId=randomUUID(),sid='progress-antigravity',at=Date.now()-300000;
const transcript=path.join(temp,'.gemini','antigravity-cli','brain',nativeId,'.system_generated','logs','transcript.jsonl');
fs.mkdirSync(path.dirname(transcript),{recursive:true});
const rows=[{type:'USER_INPUT',source:'USER_EXPLICIT',content:'请核对历史加载，并说明验证过程。'},
  {type:'PLANNER_RESPONSE',source:'MODEL',thinking:'先核对原生记录与会话归属，保留每条中文进展。',content:'已找到历史文件，正在逐轮验证。'},
  {type:'GENERIC',source:'MODEL',content:'TOOL_ONLY_OUTPUT'},
  {type:'PLANNER_RESPONSE',source:'MODEL',thinking:'历史记录齐全，接下来检查增量更新是否重复。',content:'验证完成：历史与增量更新正常。'}];
fs.writeFileSync(transcript,rows.map((r,i)=>j({...r,step_index:i,status:'DONE',created_at:new Date(at+i*60000).toISOString()})).join('\n')+'\n');
const kinds=['claude','codex','deepseek-acp','kimi','qwen','glm','codeagent'];
fs.writeFileSync(path.join(data,'state.json'),j({version:1,cleanShutdown:true,meetings:[],sessions:[
  {hubId:sid,title:'Antigravity · 历史与进展验收',kind:'gemini',cwd,geminiProjectHash:'antigravity',geminiChatId:nativeId,transcriptPath:transcript,savedAt:Date.now(),schemaVersion:1},
  ...kinds.map(kind=>({hubId:'fixture-'+kind,title:kind+' · 筛选验收',kind,cwd,savedAt:Date.now(),schemaVersion:1}))]}));
const db=new DatabaseSync(path.join(data,'company-bridge','assistant.sqlite'));
db.exec('CREATE TABLE bridge_threads(id TEXT PRIMARY KEY,session TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)');
const history={id:'Q-1023-01',sessionId:sid,createdAt:at,updatedAt:at,state:'replied',rounds:[
  {round:1,question:'请核对公司侧的历史加载行为。',sentAt:at,ackAt:at+5000,startedAt:at+10000,replyAt:at+60000,reply:'已核对：**历史记录完整**，逐轮加载正常。',status:'replied'},
  {round:2,question:'进一步检查跨会话切换后是否保留历史。',sentAt:at+65000,ackAt:at+66000,startedAt:at+70000,replyAt:at+120000,reply:'切换并返回后，历史卡片仍然完整，没有重复。',status:'replied'}]};
function save(record){db.prepare('INSERT OR REPLACE INTO bridge_threads VALUES(?,?,?,?,?,?)').run(record.id,record.sessionId,j(record),record.state,0,record.updatedAt);}
save(history);
for(let i=0;i<65;i++)save({...history,id:'Q-noise-'+i,sessionId:'unrelated-'+i,updatedAt:at+1000+i});
(async()=>{
  let hub,c;const result={passed:false,out,checks:[],boundary:'真实隔离 Electron + 原生转录和本地数据库夹具；未请求模型或公司'};
  const check=(ok,label)=>{assert(ok,label);result.checks.push(label);};
  const until=async expr=>{for(const end=Date.now()+45000;Date.now()<end;){if(await c.eval(expr))return;await sleep(150);}throw Error('timeout '+expr);};
  const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
  const shot=async name=>fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  try{
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    hub=await launchIsolatedHub({dataDir:data,port,extraEnv:{CLAUDE_HUB_BRIDGE_ROLE:'home'}});c=await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`);await sleep(550);
    await click(`.session-item[data-session-id="${sid}"]`);await c.eval(`applyViewMode('card')`);
    await until(`!!document.querySelector('#msg-overlay .chat-progress-timeline')`);
    check(await c.eval(`[...document.querySelectorAll('#msg-overlay .conversation-progress-row')].every(e=>!e.closest('details')&&e.querySelector('time')?.textContent)`),'中文进展默认可见，每条有时间戳');
    check(await c.eval(`document.querySelector('#msg-overlay .chat-progress-timeline').textContent.includes('增量更新是否重复')`),'Antigravity 每一步思考保留');
    check(await c.eval(`!document.querySelector('#msg-overlay .chat-progress-timeline').textContent.includes('TOOL_ONLY_OUTPUT')`),'工具结果不混入进展正文');
    const options=await c.eval(`[...document.querySelector('#session-model-filter').options].map(o=>[o.value,o.text])`);
    result.options=options;check(['claude','codex','deepseek','gemini','kimi','qwen','glm','codeagent'].every(k=>options.some(o=>o[0]===k)),'所有 Agent 在模型筛选中单列');
    const key=async(name,code)=>{for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code});};
    for(const [index,[family]] of options.entries()) {
      if(['all','other'].includes(family))continue;
      await click('#session-model-filter');await key('Home',36);
      for(let i=0;i<index;i++)await key('ArrowDown',40);
      await key('Enter',13);
      await until(`document.querySelector('#session-model-filter').value===${j(family)}`);
      const expected=family==='gemini'?sid:'fixture-'+(family==='deepseek'?'deepseek-acp':family);
      await until(`!!document.querySelector('.session-item[data-session-id="${expected}"]')`);
      check(await c.eval(`[...document.querySelectorAll('#session-list .session-item[data-session-id]')].every(e=>e.dataset.sessionId===${j(expected)})`),family+' 筛选只保留对应会话');
    }
    await click('#session-model-filter');await key('Home',36);await key('Enter',13);
    await until(`!!document.querySelector('.crumb-bridge')`);
    check(await c.eval(`document.querySelector('.crumb-bridge').dataset.state==='done'`),'第 60 条之外的旧通信仍有常驻标识');
    await c.eval(`document.querySelector('#msg-overlay').scrollTop=0`);await shot('01-progress');
    await click('.crumb-bridge');await until(`!!document.querySelector('.bridge-history-dialog[open] .bt-round')`);
    check(await c.eval(`document.querySelectorAll('.bridge-history-dialog .bt-round').length===4`),'弹窗显示两轮完整提问与回答');
    await click('.bridge-history-dialog .bt-round:last-of-type > summary');
    check(await c.eval(`document.querySelector('.bridge-history-dialog').innerText.includes('历史卡片仍然完整')`),'点击真实展开全文');
    check(await c.eval(`!document.querySelector('.bridge-history-dialog [data-bridge-action]')`),'历史窗口没有发送或重试通信副作用');
    await shot('02-company-history');
    history.rounds.push({round:3,question:'验证进行中状态',sentAt:Date.now()-20000,startedAt:Date.now()-10000,status:'running'});history.updatedAt=Date.now();save(history);
    await c.eval(`window._bridgeThreads.load()`);
    await until(`document.querySelector('.crumb-bridge').dataset.state==='running'`);
    check(await c.eval(`document.querySelectorAll('.bridge-history-dialog .bt-round').length===5`),'状态变化同步到常驻标识及已打开弹窗');
    history.rounds.at(-1).error='测试夹具：对端暂未回复';history.rounds.at(-1).errorAt=Date.now();save(history);
    await c.eval(`window._bridgeThreads.load()`);await until(`document.querySelector('.crumb-bridge').dataset.state==='failed'`);
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(`!document.querySelector('.bridge-history-dialog').open`);
    await c.send('Page.reload');await sleep(1000);await c.close();c=await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`);await sleep(550);
    await click(`.session-item[data-session-id="${sid}"]`);
    await until(`!!document.querySelector('.crumb-bridge')`);
    check(await c.eval(`document.querySelector('.crumb-bridge').dataset.state==='failed'`),'刷新后仍从数据库恢复标识与最新状态');
    // Native provider projections use the real shared renderer, without launching providers.
    await c.eval(`(()=>{const display=require('./simple-chat-display').displayChatTurns;const root=document.createElement('div');root.id='provider-progress-check';document.body.appendChild(root);
      for(const kind of ${j(kinds)}){const t=display([{id:'test-'+kind,role:'assistant',kind,text:'最终回答',thinking:'中文长进展。'.repeat(600),ts:${at}}])[0];window._mountSessionTurnCard('${sid}',t,{container:root});}})()`);
    check(await c.eval(`document.querySelectorAll('#provider-progress-check .chat-progress-timeline').length===${kinds.length} && [...document.querySelectorAll('#provider-progress-check .chat-progress-timeline')].every(e=>!e.querySelector('details')&&!e.closest('details')&&e.textContent.includes('中文长进展'))`),'各 Agent 共用显示链路：长中文进展不折叠、不丢失');
    result.passed=true;
  }catch(error){result.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
  finally{db.close();if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'evidence.json'),j(result,null,2));console.log(j(result,null,2));}
})();
