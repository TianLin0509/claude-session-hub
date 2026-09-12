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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'header-backstage');

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



async function main(){
  for(const dir of [DATA_DIR,WORKSPACE_ROOT,ARTIFACT_DIR])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const workspace=path.join(WORKSPACE_ROOT,'demo');fs.mkdirSync(workspace);
  let hub,client;const result={checks:[],layouts:{}};
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  const invoke=(channel,payload)=>client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');
  const size=async width=>{await client.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:0,mobile:false});await _waitMs(220);};
  const prompt=async text=>{await clickPoint(client,'.floating-input-box');await client.send('Input.insertText',{text});await clickPoint(client,'.floating-input-send');};
  const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
  const view=()=>client.eval('currentView');
  try{
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'header-backstage',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);await size(1500);
    await waitFor('identity',()=>client.eval('!!document.querySelector("#hub-pid").textContent && !!window.LaunchCenter'));
    result.identity=await client.eval('({version:document.querySelector("#hub-version").textContent,pid:document.querySelector("#hub-pid").textContent,image:document.querySelector("#hub-identity img").naturalWidth})');
    assert.equal(result.identity.version,'v'+require('../package.json').version);assert(result.identity.image>0);
    result.hubPid=hub.pid;
    assert.equal(result.identity.pid,'PID: '+hub.pid);
    assert.equal(await client.eval('document.querySelectorAll(".view-toggle").length'),0);
    assert.equal(await client.eval('document.querySelector("#btn-backstage").hidden'),true);
    const session=await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace}});
    await waitFor('ordinary button',()=>client.eval('!document.querySelector("#btn-backstage").hidden && !!document.querySelector(".session-welcome")'));
    assert.equal(await view(),'card');
    for(const width of [1500,1000,760]){
      await size(width);
      result.layouts[width]=await client.eval(`(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return {x:b.x,right:b.right,y:b.y,width:b.width}};return {brand:r('#hub-identity'),crumb:r('#toolbar-crumb'),actions:r('#toolbar-actions'),filter:r('.conversation-filter'),button:r('#btn-backstage'),controls:r('#toolbar-window-controls')}})()`);
      const l=result.layouts[width];assert(l.crumb.right<=l.brand.x+1);assert(l.brand.right<=l.actions.x+1);assert(l.filter.right<=l.button.x+1);assert(l.button.right<=l.controls.x+1);assert(l.controls.right<=width+1);
      await shot('header-'+width);
    }
    await size(1500);await clickPoint(client,'#btn-backstage');assert.equal(await view(),'pty');assert.equal(await client.eval('document.querySelector("#btn-backstage").getAttribute("aria-pressed")'),'true');
    await clickPoint(client,'#btn-backstage');assert.equal(await view(),'card');
    result.checks.push('标题图标加载、版本/PID 与真实主进程一致；1500/1000/760px 无遮挡；后台按钮双向切换');
    await prompt('/help');
    await waitFor('help feedback',()=>client.eval('document.querySelector(".codex-command-feedback:not([hidden]) pre")?.textContent.includes("codex logout") === true'));
    assert.equal(await view(),'card');assert.equal(await client.eval('document.querySelectorAll(".turn-card").length'),0);
    await shot('help');
    await prompt('/logout');
    await waitFor('logout explained',()=>client.eval('document.querySelector(".codex-command-feedback.failed pre")?.textContent.includes("CODEX_HOME") === true'));
    assert.equal(await client.eval('document.querySelectorAll(".fi-stuck-row").length'),0);
    assert.equal(await client.eval('sessions.get('+JSON.stringify(session.id)+').nativeRuntime.turnId'),null);
    await shot('logout');
    await prompt('/status');await waitFor('status result',()=>client.eval('document.querySelector(".codex-command-feedback pre")?.textContent.includes("connected") === true'));
    await clickPoint(client,'#btn-backstage');await prompt('/help');await waitFor('background help',()=>client.eval('document.querySelector(".codex-command-feedback pre")?.textContent.includes("codex logout") === true'));
    await clickPoint(client,'#btn-backstage');await prompt('fixture:terminal-design');await waitFor('normal answer',()=>client.eval('document.querySelectorAll(".turn-card").length>1'));
    assert.equal(await client.eval('document.querySelector(".codex-command-feedback").hidden'),true);
    result.checks.push('卡片/后台均能显示命令结果；logout 明确未执行且无模型轮次；命令不留假消息卡片，后续正常回答');
    await waitFor('ordinary turn complete',()=>client.eval('sessions.get('+JSON.stringify(session.id)+').nativeRuntime.state==="completed"'));
    await prompt('fixture:hold');await waitFor('held turn running',()=>client.eval('sessions.get('+JSON.stringify(session.id)+').nativeRuntime.state==="running"'));
    await client.eval('window.__receiptBeforeCommand=floatingPromptDeliveries.get('+JSON.stringify(session.id)+')');
    await clickPoint(client,'.floating-input-box');await client.send('Input.insertText',{text:'/status'});
    await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13});
    await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13});
    await waitFor('running status feedback',()=>client.eval('document.querySelector(".codex-command-feedback pre")?.textContent.includes("running") === true'));
    assert.equal(await client.eval('floatingPromptDeliveries.get('+JSON.stringify(session.id)+')===window.__receiptBeforeCommand'),true);
    assert.equal(await client.eval('sessions.get('+JSON.stringify(session.id)+').nativeRuntime.state'),'running');
    await invoke('codex:native-action',{sessionId:session.id,action:'interrupt'});
    await waitFor('held turn stopped',()=>client.eval('sessions.get('+JSON.stringify(session.id)+').nativeRuntime.state==="interrupted"'));
    result.checks.push('运行中 /status 不覆盖原消息回执，也不改变正在运行状态');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');await shot('light');
    const group=await invoke('create-meeting',{title:'群聊无后台按钮',scene:'general',workspace,slots:[model]});
    await client.eval('selectMeeting('+JSON.stringify(group.id)+')');
    await waitFor('group hides button',()=>client.eval('document.querySelector("#btn-backstage").hidden && document.querySelector("#toolbar-crumb").textContent.includes("群聊")'));
    await shot('group');
    await client.eval('selectSession('+JSON.stringify(session.id)+')');await waitFor('session restores',()=>client.eval('!document.querySelector("#btn-backstage").hidden'));
    result.checks.push('群聊不显示后台切换；回到普通会话恢复入口；浅色主题通过');
    result.passed=true;
  } finally {
    if(client){if(!result.passed){result.debug=await client.eval('({view:currentView,pid:document.querySelector("#hub-pid")?.textContent,feedback:document.querySelector(".codex-command-feedback")?.outerHTML})');await shot('failure');}await client.close();}if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
