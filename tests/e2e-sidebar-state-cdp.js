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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'sidebar-state');

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

function seedProject(dir, cfg, { linked = false, gitTime = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (linked) {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../prepared-jia/.git/worktrees/x\n', 'utf-8');
  } else {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n', 'utf-8');
    if (gitTime) fs.utimesSync(path.join(dir, '.git', 'HEAD'), gitTime, gitTime);
  }
  if (cfg) {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify(cfg), 'utf-8');
  }
}



async function main() {
  for (const dir of [DATA_DIR, WORKSPACE_ROOT, ARTIFACT_DIR]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, '.aiwork-root'), '');
  const workspace = path.join(WORKSPACE_ROOT, 'demo'); fs.mkdirSync(workspace);
  let hub, client; const result = { checks: [] };
  const invoke = (channel, payload) => client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');
  const shot = name => screenshot(client, path.join(ARTIFACT_DIR, name+'.png'));
  const row = id => `[data-session-id="${id}"]`;
  const groupRow = id => `[data-meeting-id="${id}"]`;
  const section = selector => client.eval(`(() => {let n=document.querySelector(${JSON.stringify(selector)});while(n && n.parentElement.id!=='session-list')n=n.parentElement;while(n && !n.classList.contains('session-sec-header'))n=n.previousElementSibling;return n?.className || '';})()`);
  const model = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' };
  const send = (sessionId, text) => invoke('session:send-prompt', {sessionId, text});
  try {
    hub = await launchIsolatedHub({dataDir:DATA_DIR, port:await reservePort(), label:'sidebar-state', windowMode:'hidden', extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT, CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client = await connectFirstPage(hub);
    await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await client.send('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:0,mobile:false});
    await waitFor('renderer', () => client.eval('!!window.LaunchCenter'));
    const ready = await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace,title:'就绪会话'}});
    const sleeper = await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace,title:'休眠会话'}});
    await waitFor('native ready',()=>client.eval(`!!sessions.get(${JSON.stringify(sleeper.id)})?.nativeRuntime?.threadId`));
    assert.equal((await invoke('suspend-session',{sessionId:sleeper.id})).ok,true);
    await waitFor('suspended',()=>client.eval(`sessions.get(${JSON.stringify(sleeper.id)})?.status==='dormant'`));
    await clickPoint(client,row(ready.id));
    await waitFor('ready dot',()=>client.eval(`!!document.querySelector(${JSON.stringify(row(ready.id)+' .sl-dot.idle')})`));
    result.colors = await client.eval(`(${JSON.stringify([ready.id,sleeper.id])}).map(id=>{const dot=document.querySelector('[data-session-id="'+id+'"] .sl-dot');return {label:dot.getAttribute('aria-label'),color:getComputedStyle(dot).backgroundColor};})`);
    assert.equal(result.colors[0].label,'就绪'); assert.equal(result.colors[1].label,'休眠');
    assert.notEqual(result.colors[0].color,result.colors[1].color);
    assert.deepEqual(await client.eval("[...document.querySelectorAll('#session-list > .session-sec-header')].map(x=>x.className.split(' ').at(-1))"),['sec-pinned','sec-unread','sec-active','sec-today','sec-dormant']);
    result.checks.push('真实就绪蓝点、休眠灰点；五组顺序正确');
    const group = await invoke('create-meeting',{title:'未读与自动唤醒验证',scene:'general',workspace,slots:[model,model]});
    const [a,b] = group.subSessions;
    await waitFor('members ready',()=>client.eval(`${JSON.stringify([a,b])}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
    await clickPoint(client,row(ready.id));
    assert.equal((await send(a,'fixture:hold')).ok,true);
    await waitFor('group running',()=>client.eval(`!!document.querySelector(${JSON.stringify(groupRow(group.id)+' .sl-group-icon.run')})`));
    result.pulse = await client.eval(`getComputedStyle(document.querySelector(${JSON.stringify(groupRow(group.id)+' .sl-group-icon')})).animationName`);
    assert.equal(result.pulse,'sidebar-group-pulse');
    assert.equal((await send(b,'fixture:normal')).ok,true);
    await waitFor('member completed',()=>client.eval(`sessions.get(${JSON.stringify(b)}).nativeRuntime.state==='completed'`));
    // Member attention is a fixture: group delivery normally owns its own unread
    // events. Seed the independent child-unread case explicitly; do not claim a
    // direct native turn creates group attention end-to-end. Real clicks/IPC below
    // must clear it, and the native running/resume lifecycle stays unmodified.
    await client.eval(`Object.assign(sessions.get(${JSON.stringify(b)}),{unreadCount:1,replyReady:true});scheduleSessionListRender()`);
    await waitFor('member unread group',async()=>/sec-unread/.test(await section(groupRow(group.id))));
    // Group placement uses member attention; pulse uses the real native running state.
    assert.equal(await client.eval(`!!document.querySelector(${JSON.stringify(groupRow(group.id)+' .sl-group-icon.run')})`),true);
    result.checks.push('成员未读状态夹具令群聊进入未读；另一成员真实原生运行状态仍闪烁');
    await shot('dark-unread');
    await clickPoint(client,groupRow(group.id)+' .sl-title');
    assert.equal(await client.eval(`sessions.get(${JSON.stringify(b)}).unreadCount`),1,'opening the room does not read every member');
    await clickPoint(client,groupRow(group.id)+` .sl-unread-member[data-sub-id="${b}"]`);
    await waitFor('read acknowledged',()=>client.eval(`sessions.get(${JSON.stringify(b)}).unreadCount===0 && !sessions.get(${JSON.stringify(b)}).replyReady`));
    const mainMembers=await invoke('get-sessions');
    assert.equal(mainMembers.find(s=>s.id===b).unreadCount || 0,0);
    await clickPoint(client,row(ready.id));
    await waitFor('read group active',async()=>/sec-active/.test(await section(groupRow(group.id))));
    await invoke('codex:native-action',{sessionId:a,action:'interrupt'});
    await waitFor('interrupt',()=>client.eval(`sessions.get(${JSON.stringify(a)}).nativeRuntime.state==='interrupted'`));
    // Parent remains idle. Both members are dormant, including an unselected member.
    for(const id of [a,b])assert.equal((await invoke('suspend-session',{sessionId:id})).ok,true);
    await waitFor('both dormant',()=>client.eval(`${JSON.stringify([a,b])}.every(id=>sessions.get(id)?.status==='dormant')`));
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{status:'idle',participants:[0]}});
    await waitFor('parent idle',()=>client.eval(`meetings[${JSON.stringify(group.id)}].status==='idle'`));
    await clickPoint(client,groupRow(group.id)+' .sl-title');
    await clickPoint(client,groupRow(group.id)+' .sl-title');
    await waitFor('all members auto resumed',()=>client.eval(`${JSON.stringify([a,b])}.every(id=>sessions.get(id)?.status!=='dormant' && !sessions.get(id)?._resumePending)`));
    assert.equal(await client.eval('activeMeetingId'),group.id); assert.equal(await client.eval('activeSessionId'),null);
    assert.equal(await client.eval(`getComputedStyle(document.querySelector('#meeting-room-panel')).display!=='none'`),true);
    const resumed=await invoke('get-sessions');
    assert.equal(resumed.filter(s=>[a,b].includes(s.id)).length,2);
    result.checks.push('打开就绪群聊自动唤醒全部休眠成员（含未选成员）；重复点击不重复创建，停留群聊');
    await shot('dark-ready');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');
    await waitFor('light blue ready',()=>client.eval(`getComputedStyle(document.querySelector(${JSON.stringify(row(ready.id)+' .sl-dot')})).backgroundColor==='rgb(59, 130, 246)'`));
    result.lightReady=await client.eval(`document.querySelector(${JSON.stringify(row(ready.id)+' .sl-dot')}).outerHTML`);
    await shot('light-ready');
    await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await send(a,'fixture:hold');
    await waitFor('running again',()=>client.eval(`!!document.querySelector(${JSON.stringify(groupRow(group.id)+' .sl-group-icon.run')})`));
    assert.equal(await client.eval(`getComputedStyle(document.querySelector(${JSON.stringify(groupRow(group.id)+' .sl-group-icon')})).animationName`),'none');
    result.checks.push('浅色主题截图；减少动态效果偏好关闭图标闪烁');
    result.passed=true;
  } finally {
    if(client){if(!result.passed){result.debug=await client.eval('({activeSessionId,activeMeetingId,sessions:[...sessions.values()].map(s=>({id:s.id,status:s.status,cc:s.ccSessionId,unread:s.unreadCount,reply:s.replyReady,native:s.nativeRuntime})),groups:Object.values(meetings).map(m=>({id:m.id,status:m.status,subSessions:m.subSessions}))})');await shot('failure');}await client.close();}
    if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
