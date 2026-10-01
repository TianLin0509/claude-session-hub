'use strict';
// Real isolated Electron UI + backend. Model output is explicitly a native fixture.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-assistant-ui-'));
  const dataDir = path.join(root, 'data'), home = path.join(root, 'home');
  const out = path.resolve('artifacts/assistant-tab-cdp', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const watchId='cfd103a2-2a54-4d49-83a4-f02d03812212', watchNative='9be593b1-f627-4bb1-92e5-9da931d367de';
  const watchFile=path.join(root,'rollout-watch-'+watchNative+'.jsonl');
  const appendWatch=(text,turn)=>fs.appendFileSync(watchFile,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:turn}})+'\n'+JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}})+'\n','utf8');
  fs.writeFileSync(watchFile,JSON.stringify({type:'session_meta',payload:{id:watchNative,source:'cli',cwd:root}})+'\n','utf8');appendWatch('关注前的旧回复，不应提醒','baseline');
  fs.writeFileSync(path.join(root,'threads.json'),JSON.stringify([[watchNative,{id:watchNative,cwd:root,path:watchFile,status:{type:'idle'},turns:[],model:'gpt-6-astra',reasoningEffort:'medium'}]]),'utf8');
  fs.writeFileSync(path.join(dataDir,'state.json'),JSON.stringify({version:1,cleanShutdown:true,sessions:[{hubId:watchId,kind:'codex',title:'订单同步 · 关注验收',cwd:root,codexSid:watchNative,transcriptPath:watchFile,codexProfile:'second',agentRuntime:'pty',status:'dormant'}],meetings:[]}),'utf8');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ providers: { codex: { backend: 'subscription', subscription_profile: 'second', subscription_profiles: [{ id: 'second', label: '主账号（隔离验证）', home: path.join(home, '.codex') }] } } }), 'utf8');
  const navigationOnly = process.argv.includes('--navigation-only');
  const result = { passed: false, mode: navigationOnly ? 'navigation-only' : 'native-fixture-flow', boundary: '真实隔离 Hub 界面与服务；模型回答为显式原生协议夹具，不代表真实模型质量', checks: [], root, out };
  let hub, cdp;
  const until = async (label, expression, timeout = 35000) => { for (const end = Date.now() + timeout; Date.now() < end;) { if (await cdp.eval(`Boolean(${expression})`)) return; await delay(120); } throw Error('timeout: ' + label); };
  const click = async selector => {
    await until('clickable ' + selector, `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await until('visible hit target ' + selector, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===el||el.contains(hit));})()`);
    const point = await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const shot = async name => { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), label: 'assistant-tab', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_HOME_DIR: home, CODEX_HOME: path.join(home, '.codex'), CODEX_SQLITE_HOME: '', CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AI_HUB_WORKSPACE_ROOT: root, CLAUDE_HUB_AGENT_RUNTIME: 'native',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'threads.json'),
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE: path.join(root, 'trace.jsonl'),
      CLAUDE_HUB_FIXTURE_CONFIG_DIR: path.join(root, 'launch-config'),
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'),
      HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty'), DEEPSEEK_API_KEY: '',
    } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer ready', 'typeof assistantPanel!=="undefined"');
    const before = await cdp.eval('sessions.size');
    const trace = () => fs.existsSync(path.join(root, 'trace.jsonl')) ? fs.readFileSync(path.join(root, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:5, y:90 });
    await click('#rail-pin');
    await until('navigation pinned', 'document.getElementById("app-container").classList.contains("rail-pinned")');
    await click('#btn-assistant');
    await until('A conversation visible', '!document.getElementById("assistant-page").hidden && !!document.querySelector("#assistant-input")');
    await until('penguin loaded', 'document.querySelector(".assistant-hero img").naturalWidth===512');
    assert.equal(await cdp.eval('sessions.size'), before);
    assert.equal(trace().length, 0);
    await shot('01-overview'); result.checks.push('A 样式聊天页与企鹅加载，打开页面不创建会话、不发模型请求');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:800,height:850,deviceScaleFactor:1,mobile:false });
    assert.equal(await cdp.eval('document.getElementById("assistant-page").scrollWidth>document.getElementById("assistant-page").clientWidth+1'), false);
    await shot('02-narrow'); result.checks.push('800px 窄窗口保持可输入且无横向溢出');
    await click('.assistant-rail-toggle');assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".assistant-right-rail")).display'), 'block');await click('.assistant-rail-toggle');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1440,height:1000,deviceScaleFactor:1,mobile:false });
    if (navigationOnly) { result.passed = true; return; }
    await click('[data-question="progress"]');
    assert.match(await cdp.eval('document.querySelector("#assistant-input").value'), /最近三小时/);
    assert.equal(trace().length,0);
    await click('[data-assistant-send]');
    await until('native assistant answer on assistant page', 'document.querySelector(".assistant-message.is-assistant")?.textContent.includes("原生回答")',60000);
    assert.equal(await cdp.eval('document.getElementById("assistant-page").hidden'),false);
    const sessionId = await cdp.eval('([...sessions.values()].find(s=>s.purpose==="hub-assistant")).id');result.sessionId=sessionId;
    assert.equal(trace().filter(row=>row.method==='thread/start').length,1);
    assert.equal(trace().filter(row=>row.method==='turn/start').length,1);
    const submitted=trace().find(row=>row.method==='turn/start'),submittedText=submitted.params.input.map(i=>i.text||'').join('');
    assert.match(submittedText,/AI_HUB_ASSISTANT_CONTEXT_V1/);
    const visibleUser=await cdp.eval('document.querySelector(".assistant-message.is-user .assistant-user-text").textContent');
    assert.match(visibleUser,/最近三小时/);assert.doesNotMatch(visibleUser,/requestToken/);
    assert.equal(await cdp.eval('document.querySelector("#assistant-input").value'),'');
    await shot('03-chat-answer');result.checks.push('页内真实点击发送走共享原生入口，同一会话返回气泡；原话与上下文分开展示');
    await click('.assistant-turn-context summary');
    assert.equal(await cdp.eval('document.querySelector(".assistant-turn-context pre").textContent'),submittedText);
    await shot('04-context-expanded');await click('.assistant-turn-context summary');
    result.checks.push('可展开本轮请求与资料目录，全文与真实提交一致');
    await click('#assistant-input');await cdp.send('Input.insertText',{text:'保留下一件事的草稿'});
    await click('#btn-home');await click('#btn-assistant');
    assert.equal(await cdp.eval('document.querySelector("#assistant-input").value'),'保留下一件事的草稿');
    assert.equal(trace().filter(row=>row.method==='thread/start').length,1);
    await click('[data-question="attention"]');
    assert.match(await cdp.eval('document.querySelector("#assistant-input").value'),/保留下一件事的草稿/);
    assert.equal(trace().filter(row=>row.method==='turn/start').length,1);
    result.checks.push('切换页面和建议问题保留草稿，不新增会话或自动发送');
    // Actual main create path represents background delegation; no renderer event is forged.
    const child=await cdp.eval('ipcRenderer.invoke("create-session",{kind:"codex",opts:{title:"隔离派工目标",name:"隔离派工目标"}})');
    result.createdTarget=child.id||child.session?.id;
    await delay(300);
    assert.equal(await cdp.eval('document.getElementById("assistant-page").hidden'),false);
    assert.match(await cdp.eval('document.querySelector("#assistant-input").value'),/保留下一件事的草稿/);
    result.checks.push('真实后台创建新实体不会抢走助理页，也不覆盖当前草稿');
    await click('[data-assistant-action="refresh"]');
    await until('persisted task selectable',`!!document.querySelector('.assistant-follow-controls option[value="${watchId}"]')`);
    await click('.assistant-follow-controls select');
    for(const key of ['Home','ArrowDown','Enter']){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});}
    assert.equal(await cdp.eval('document.querySelector(".assistant-follow-controls select").value'),watchId);
    await click('[data-assistant-action="follow"]');await until('followed task visible','document.querySelector(".assistant-followed").textContent.includes("订单同步")');
    await until('closed watch paused','document.querySelector(".assistant-followed").textContent.includes("已关闭，恢复后继续关注")');
    const watchedEntry=`.assistant-followed [data-assistant-action="session"][data-session-id="${watchId}"]`;
    await click(watchedEntry);
    await until('watched target opened with exact native identity',`sessions.get(${JSON.stringify(watchId)})?.nativeRuntime?.connection==='connected' && sessions.get(${JSON.stringify(watchId)})?.codexSid===${JSON.stringify(watchNative)}`);
    assert.ok((await cdp.eval('ipcRenderer.invoke("get-sessions")')).some(s=>s.id===watchId),'current Hub owns the resumed target');
    await click('#btn-assistant');
    await until('opened watch active','document.querySelector(".assistant-followed").textContent.includes("有新回复时提醒")');
    assert.doesNotMatch(await cdp.eval('document.querySelector(".assistant-changes").textContent'),/关注前的旧回复/);
    appendWatch('订单同步已推进到 8 项，新增结果已写入隔离交付记录。此消息是文件夹具原文。','new-final');
    await until('native file notice visible','document.querySelector(".assistant-changes").textContent.includes("订单同步已推进到 8 项")',15000);
    assert.equal(await cdp.eval('document.querySelectorAll(".assistant-evidence-card.is-unread").length'),1);
    assert.match(await cdp.eval('document.querySelector(".assistant-evidence-card small").textContent'),/^E/);
    await shot('05-followed-reply');
    await click('[data-assistant-action="read"]');await until('notification read','!document.querySelector(".assistant-evidence-card.is-unread")');
    assert.equal(await cdp.eval('document.querySelector("#assistant-input").value.includes("保留下一件事")'),true);
    const closeResult=await cdp.eval(`ipcRenderer.invoke('close-session',${JSON.stringify(watchId)})`);assert.equal(closeResult.ok,true);
    await until('closed target watch paused','document.querySelector(".assistant-followed").textContent.includes("已关闭，恢复后继续关注")');
    appendWatch('恢复关注后才可见的离线回复。','offline-final');
    await delay(2600);await click('[data-assistant-action="refresh"]');
    assert.doesNotMatch(await cdp.eval('document.querySelector(".assistant-changes").textContent'),/恢复关注后才可见/);
    await click(watchedEntry);
    await until('watched target reopened',`sessions.get(${JSON.stringify(watchId)})?.nativeRuntime?.connection==='connected'`);
    await click('#btn-assistant');
    await until('resumed watch discovers offline reply','document.querySelector(".assistant-changes").textContent.includes("恢复关注后才可见")',15000);
    await shot('05-watch-resumed');
    result.checks.push('真人打开原会话才关注新final；关闭后暂停且不读取离线回复，恢复同一实体后续读，有引用且草稿保留');
    await click('.assistant-cli summary');
    await until('same entity terminal mounted','!!document.querySelector(".assistant-cli-host .xterm")');
    await shot('05-native-terminal');await click('.assistant-cli summary');
    result.checks.push('页内展开复用同一实体原生终端，不新建运行时');
    await cdp.eval(`window.__assistantOriginalInvoke=ipcRenderer.invoke;window.__assistantFailures=0;ipcRenderer.invoke=function(channel,...args){if(channel==='assistant:get-overview'&&window.__assistantFailures++===0)return Promise.reject(new Error('界面验收：记录暂不可用'));return window.__assistantOriginalInvoke.call(this,channel,...args);};`);
    await click('[data-assistant-action="refresh"]');await until('read error visible','document.querySelector(".assistant-status").classList.contains("assistant-error")');
    assert.match(await cdp.eval('document.querySelector("#assistant-input").value'),/保留下一件事的草稿/);
    await click('[data-assistant-action="refresh"]');await until('read recovered','document.querySelector(".assistant-status").hidden');
    await cdp.eval('ipcRenderer.invoke=window.__assistantOriginalInvoke;delete window.__assistantOriginalInvoke');
    result.checks.push('记录读取失败可见且能重试，已有对话和草稿保持');
    await click('[data-assistant-action="original"]');
    await until('original session opened',`activeSessionId===${JSON.stringify(sessionId)} && document.getElementById('assistant-page').hidden`);
    await click('#btn-assistant');
    assert.match(await cdp.eval('document.querySelector("#assistant-input").value'),/保留下一件事的草稿/);
    await shot('06-final-chat');result.checks.push('原会话入口定位同一 session，回来仍保留聊天草稿');
    result.passed = true;
  } catch (error) { result.error = error.stack; if (cdp) await shot('failure').catch(() => {}); throw error; }
  finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    if (cdp) cdp.close(); if (hub) await gracefulQuit(hub);
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
