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
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'member-card');

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
  for(const dir of [DATA_DIR,WORKSPACE_ROOT,ARTIFACT_DIR])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');
  const workspace=path.join(WORKSPACE_ROOT,'demo');fs.mkdirSync(workspace);
  let hub,client;const result={checks:[]};
  const invoke=(channel,payload)=>client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');
  const state=()=>client.eval('({view:currentView,hidden:document.querySelector("#btn-backstage").hidden,session:activeSessionId,meeting:activeMeetingId})');
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  try {
    hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'member-card',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:0,mobile:false});
    await waitFor('renderer',()=>client.eval('!!window.LaunchCenter'));
    const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
    const group=await invoke('create-meeting',{title:'成员会话卡片与后台',scene:'general',workspace,slots:[model,model]});
    const [a,b]=group.subSessions;
    await waitFor('members ready',()=>client.eval(`${JSON.stringify([a,b])}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
    await clickPoint(client,'[data-meeting-id="'+group.id+'"]');
    await waitFor('group selected',()=>client.eval('activeMeetingId==='+JSON.stringify(group.id)));
    await waitFor('group button hidden',()=>client.eval('document.querySelector("#btn-backstage").hidden'));
    await clickPoint(client,'#btn-session-details');
    await clickPoint(client,'[data-session-id="'+a+'"]');
    await waitFor('member selected',()=>client.eval('activeSessionId==='+JSON.stringify(a)));
    await _waitMs(300);result.first=await state();
    if(process.env.HUB_MEMBER_CARD_BASELINE==='1') {
      assert.equal(result.first.view,'pty');assert.equal(result.first.hidden,true);await shot('baseline');result.baseline=true;return;
    }
    assert.equal(result.first.view,'card');assert.equal(result.first.hidden,false);
    assert.equal(await client.eval('document.querySelector("#msg-overlay").classList.contains("hidden")'),false);
    await shot('card');result.checks.push('侧栏首次打开群聊成员默认卡片，后台按钮可见');
    await clickPoint(client,'#btn-backstage');assert.equal((await state()).view,'pty');await shot('backstage');
    await clickPoint(client,'[data-session-id="'+b+'"]');assert.equal((await state()).view,'card');
    await clickPoint(client,'[data-session-id="'+a+'"]');assert.equal((await state()).view,'pty');
    await clickPoint(client,'#btn-backstage');assert.equal((await state()).view,'card');
    result.checks.push('后台往返正常；成员视图各自记忆，不影响其他成员默认卡片');
    await clickPoint(client,'[data-meeting-id="'+group.id+'"]');
    await waitFor('group hides button again',()=>client.eval('document.querySelector("#btn-backstage").hidden'));
    await shot('group');
    await clickPoint(client,'[data-session-id="'+b+'"]');await clickPoint(client,'#btn-backstage');
    await client.send('Page.reload');await waitFor('reload sidebar',()=>client.eval(`!!document.querySelector('[data-session-id="${b}"]')`));
    await clickPoint(client,'[data-session-id="'+b+'"]');
    await waitFor('reload selected',()=>client.eval('activeSessionId==='+JSON.stringify(b)));
    assert.equal((await state()).view,'pty');assert.equal((await state()).hidden,false);
    await clickPoint(client,'#btn-backstage');
    result.checks.push('返回群聊隐藏后台；页面刷新后保留成员手动选择');
    await clickPoint(client,'[data-session-id="'+a+'"]');
    assert.equal((await invoke('suspend-session',{sessionId:b})).ok,true);
    await waitFor('member dormant',()=>client.eval('sessions.get('+JSON.stringify(b)+').status==="dormant"'));
    await clickPoint(client,'[data-session-id="'+b+'"]');
    await waitFor('member resumed',()=>client.eval('sessions.get('+JSON.stringify(b)+').status!=="dormant" && !sessions.get('+JSON.stringify(b)+')._resumePending'));
    await waitFor('resumed surface',()=>client.eval('!document.querySelector(".session-resume-pending") && !document.querySelector("#btn-backstage").hidden && !document.querySelector("#msg-overlay").classList.contains("hidden")'));
    assert.equal((await state()).view,'card');assert.equal((await state()).hidden,false);
    await clickPoint(client,'#btn-backstage');assert.equal((await state()).view,'pty');await clickPoint(client,'#btn-backstage');
    const ordinary=await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace}});
    await waitFor('ordinary selected',()=>client.eval('activeSessionId==='+JSON.stringify(ordinary.id)));
    assert.equal((await state()).view,'card');assert.equal((await state()).hidden,false);
    result.checks.push('休眠成员打开后卡片与后台正常；普通会话默认卡片和后台无回归');
    result.passed=true;
  } finally {
    if(client){if(!result.passed&&!result.baseline){result.failure=await state();await shot('failure');}await client.close();}if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,result.baseline?'baseline.json':'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
