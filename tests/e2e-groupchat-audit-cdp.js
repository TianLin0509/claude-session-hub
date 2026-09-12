'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-projlib-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'AIWork');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'groupchat-audit');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function clickPoint(client, selector) {
  await client.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, visible: rect.width > 0 && rect.height > 0, topmost: hit === el || el.contains(hit), hit: hit && (hit.tagName + '.' + hit.className) };
  })()`);
  assert.equal(point.found, true, `${selector} should exist`);
  assert.equal(point.visible, true, `${selector} should be visible`);
  assert.equal(point.topmost, true, `${selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function main() {
  for(const dir of [DATA_DIR,WORKSPACE_ROOT,ARTIFACT_DIR])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const workspace=path.join(WORKSPACE_ROOT,'demo');fs.mkdirSync(workspace);
  let hub,client;const result={checks:[]};
  const invoke=(channel,payload)=>client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  try {
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'groupchat-audit',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);await client.send('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:0,mobile:false});
    await waitFor('renderer',()=>client.eval('!!window.MeetingRoom && !!window.LaunchCenter'));
    const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
    const ordinary=await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace}});
    const group=await invoke('create-meeting',{title:'群聊后台未读核对',scene:'general',workspace,slots:[model]});
    await waitFor('native ready',()=>client.eval(`${JSON.stringify(group.subSessions)}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
    const groupRow='[data-meeting-id="'+group.id+'"]';
    await clickPoint(client,groupRow);await waitFor('composer',()=>client.eval('!!document.querySelector("#mr-input-box") && !!document.querySelector(".mr-gc-shell")'));
    await clickPoint(client,'#mr-input-box');await client.send('Input.insertText',{text:'fixture:conversation 群聊未读保留测试'});await clickPoint(client,'#mr-send-btn');
    await clickPoint(client,'[data-session-id="'+ordinary.id+'"]');
    await waitFor('reply complete',async()=>{const s=await invoke('groupchat:get-state',{meetingId:group.id});return s?.currentMode==='idle' && s.messages?.some(m=>m.role==='assistant' && m.content?.includes('已完成'));});
    await waitFor('completion metadata',()=>client.eval(`!!meetings[${JSON.stringify(group.id)}].lastCompletedAt`));
    // Drain the real metadata update round trip, which must not acknowledge the reply.
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{title:'群聊后台未读核对（更新标题）'}});
    await waitFor('title updated',()=>client.eval(`meetings[${JSON.stringify(group.id)}].title.includes('更新标题')`));
    result.unreadAfterUpdate=await client.eval(`meetings[${JSON.stringify(group.id)}].unreadAnswered?.size || 0`);
    if(process.env.HUB_GROUP_AUDIT_BASELINE==='1') {
      assert.equal(result.unreadAfterUpdate,0);await shot('baseline-unread');result.baseline=true;return;
    }
    assert.equal(result.unreadAfterUpdate,1,'background reply must stay unread after unrelated meeting updates');
    await waitFor('unread row',()=>client.eval(`document.querySelector(${JSON.stringify(groupRow)}).classList.contains('need-unread')`));
    await shot('unread');
    await clickPoint(client,groupRow);
    assert.equal(await client.eval(`meetings[${JSON.stringify(group.id)}].unreadAnswered.size`),0);
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{title:'打开后保持已读'}});
    await clickPoint(client,'[data-session-id="'+ordinary.id+'"]');
    assert.equal(await client.eval(`meetings[${JSON.stringify(group.id)}].unreadAnswered.size`),0);
    result.checks.push('真实群聊发送及 App Server 夹具回复完成后保持未读；标题等元数据更新不误清除；打开后保持已读');
    await clickPoint(client,groupRow);
    await clickPoint(client,'#mr-input-box');await client.send('Input.insertText',{text:'配置更新期间保留这段草稿'});
    const workflow=await client.eval(`window.WorkflowTemplates.createTemplateConfig('dev-task',[{memberId:'m1',kind:'codex'}],{devPhase:'discuss'})`);
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{scene:'dev',serialWorkflow:workflow}});
    await waitFor('dev controls',()=>client.eval('!!document.querySelector("[data-file-independent]")'));
    assert.equal(await client.eval('document.querySelector("#mr-input-box").innerText'),'配置更新期间保留这段草稿');
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{serialWorkflow:null}});
    await waitFor('workflow controls removed',()=>client.eval('!document.querySelector("[data-file-independent]")'));
    assert.equal(await client.eval('document.querySelector("#mr-input-box").innerText'),'配置更新期间保留这段草稿');
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{serialWorkflow:workflow}});
    await waitFor('workflow-only update controls',()=>client.eval('!!document.querySelector("[data-file-independent]")'));
    assert.equal(await client.eval('document.querySelector("#mr-input-box").innerText'),'配置更新期间保留这段草稿');
    result.checks.push('群聊配置更新立即刷新输入区/操作栏，单独启停工作流也生效，草稿保留');
    await shot('workflow');
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{scene:'general',serialWorkflow:null}});
    await waitFor('ordinary composer',()=>client.eval('!document.querySelector("[data-file-independent]")'));
    await clickPoint(client,'#mr-input-box');
    await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await client.send('Input.insertText',{text:'fixture:hold 运行中切换验证'});await clickPoint(client,'#mr-send-btn');
    await waitFor('group running',()=>client.eval(`sessions.get(${JSON.stringify(group.subSessions[0])}).nativeRuntime.state==='running' && !!document.querySelector('[data-gc-stop-turn]')`));
    await clickPoint(client,'#mr-input-box');await client.send('Input.insertText',{text:'运行期间保留草稿'});
    await clickPoint(client,'.mr-free-avatar-chk');
    await waitFor('participant deselected',()=>client.eval(`meetings[${JSON.stringify(group.id)}].participants.length===0`));
    assert.equal(await client.eval('document.querySelector("#mr-input-box").innerText'),'运行期间保留草稿');
    await clickPoint(client,'.mr-free-avatar-chk');
    await waitFor('participant selected',()=>client.eval(`meetings[${JSON.stringify(group.id)}].participants.length===1`));
    await clickPoint(client,'.mr-gc-avatar[data-gc-open-session]');
    await waitFor('avatar opens member cards',()=>client.eval(`activeSessionId===${JSON.stringify(group.subSessions[0])} && currentView==='card' && !document.querySelector('#btn-backstage').hidden`));
    await clickPoint(client,groupRow);
    await waitFor('draft restored',()=>client.eval('document.querySelector("#mr-input-box").innerText==="运行期间保留草稿"'));
    await waitFor('stop visible',()=>client.eval('document.querySelector("[data-gc-stop-turn]")?.getBoundingClientRect().height > 0'));
    await clickPoint(client,'[data-gc-stop-turn]');
    await waitFor('group stopped',async()=>{const st=await invoke('groupchat:get-state',{meetingId:group.id});return st.currentMode==='idle';});
    await waitFor('no stuck pending',()=>client.eval('document.querySelectorAll(".mr-gc-msg.pending").length===0 && !document.querySelector("[data-gc-stop-turn]")'));
    assert.equal(await client.eval('document.querySelector("#mr-input-box").innerText'),'运行期间保留草稿');
    result.checks.push('真实群聊运行中切换成员勾选、头像打开成员卡片、返回后草稿保留；停止后状态收敛且无卡住的等待卡片');
    await shot('stopped');result.passed=true;
  } finally {
    if(client){if(!result.passed&&!result.baseline){result.backend=await invoke('get-meetings');result.states=await Promise.all(result.backend.map(m=>invoke('groupchat:get-state',{meetingId:m.id})));result.debug=await client.eval('({activeSessionId,activeMeetingId,groups:Object.values(meetings).map(m=>({id:m.id,unread:m.unreadAnswered?.size,workflow:m.serialWorkflow}))})');await shot('failure');}await client.close();}if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,result.baseline?'baseline.json':'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
