'use strict';

// Real isolated Hub and pointer/keyboard input. Layout states are fixtures;
// native resume uses a local Codex CLI fixture through the real PTY + IPC path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'dormant-sidebar');
const TEMP = path.join(os.tmpdir(), `hub-dormant-sidebar-${Date.now()}-${process.pid}`);
const DATA = path.join(TEMP, 'data');
const BIN = path.join(TEMP, 'bin');
const WORK = path.join(TEMP, 'work');
const CODEX = path.join(TEMP, 'codex');
const NATIVE_ID = '44444444-4444-4444-8444-444444444444';
const invocationLog = path.join(TEMP, 'invocations.jsonl');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
async function waitFor(fn, label) {
  const end = Date.now() + 20000;
  let lastError;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (e) { lastError = e; }
    await _waitMs(150);
  }
  throw new Error(`Timed out: ${label}${lastError ? ': ' + lastError.message : ''}`);
}
async function point(client, selector) {
  const p = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({block:'nearest'});
    const r = el.getBoundingClientRect();
    return {x:r.x + r.width / 2, y:r.y + Math.min(r.height / 2, 12), width:r.width, height:r.height};
  })()`);
  assert.ok(p && p.width && p.height, `visible ${selector}`);
  return p;
}
async function mouse(client, selector, click = true) {
  const p = await point(client, selector);
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:p.x, y:p.y});
  if (!click) return;
  // Hover can expand a group. Resolve the hit again before pressing.
  const hit = await point(client, selector);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {type, x:hit.x, y:hit.y, button:'left', buttons:type === 'mousePressed' ? 1 : 0, clickCount:1});
  }
}
async function main() {
  for (const dir of [OUT, DATA, BIN, WORK, CODEX]) fs.mkdirSync(dir, {recursive:true});
  const fake = path.join(BIN, 'codex-fixture.js');
  fs.writeFileSync(fake, `require('fs').appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write('DORMANT-RESUME-READY\\r\\n'); setInterval(()=>{},1000);`, 'utf8');
  fs.writeFileSync(path.join(BIN, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`, 'utf8');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({providers:{codex:{backend:'subscription', subscription_profile:'e2e', subscription_profiles:[{id:'e2e',label:'E2E',home:CODEX}]}}}), 'utf8');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'Path';
  const result = {dataDir:DATA, layoutStates:'seeded fixtures', resume:'real Hub IPC and PTY, local Codex fixture', checks:[]};
  let hub, client;
  try {
    hub = await launchIsolatedHub({dataDir:DATA, port:await freePort(), label:'dormant-sidebar', windowMode:'hidden',
      extraEnv:{CLAUDE_HUB_E2E:'1', DEEPSEEK_API_KEY:'', HUB_CODEX_BACKEND:'subscription', HUB_CODEX_PROFILE:'e2e',
        CODEX_HOME:CODEX, [pathKey]:`${BIN}${path.delimiter}${process.env[pathKey] || ''}`}});
    result.pid = hub.pid; result.port = hub.port;
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
    await client.send('Runtime.enable'); await client.send('Page.enable');
    await client.send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await waitFor(() => client.eval('!!window.__hubE2E?.addFakeSessions'), 'renderer');
    await client.send('Emulation.setDeviceMetricsOverride', {width:1280,height:1050,deviceScaleFactor:1,mobile:false});
    await client.eval(`(() => {
      const now = Date.now(); window.__hubE2E.clearSessions();
      const base = {kind:'codex',status:'dormant',createdAt:now-3600000,lastMessageTime:now-3600000,cwd:${JSON.stringify(WORK)},codexSid:${JSON.stringify(NATIVE_ID)},codexProfile:'e2e',mcpProfile:'none'};
      window.__hubE2E.addFakeSessions([
        {...base,id:'wake',title:'普通休眠 · 点击恢复原生会话'},
        {...base,id:'old',title:'七天前的历史会话',createdAt:now-7*86400000,lastMessageTime:now-7*86400000},
        {...base,id:'unread',title:'休眠但有未读',unreadCount:2},
        {...base,id:'disconnected',title:'休眠但有连接异常',connectionIssue:{type:'stream-disconnected',message:'stream disconnected'}},
        {...base,id:'member-a',meetingId:'group',title:'Codex 1',contextPct:38},
        {...base,id:'member-b',meetingId:'group',title:'Codex 2',contextPct:22},
        {...base,id:'unread-member',meetingId:'unread-group',title:'Codex 3'}
      ]);
      meetings.group={id:'group',title:'搭建专属知识库的协同沉淀与长标题布局验证',groupChat:true,status:'dormant',scene:'general',subSessions:['member-a','member-b'],participants:[0,1],createdAt:now,lastMessageTime:now};
      meetings['unread-group']={id:'unread-group',title:'工作台优化版本交付，待验收',groupChat:true,status:'dormant',scene:'general',subSessions:['unread-member'],participants:[0],createdAt:now,lastMessageTime:now,unreadAnswered:new Set(['unread-member'])};
      renderSessionList();
    })()`);
    const group = '#session-list [data-meeting-id="group"]';
    const read = () => client.eval(`(() => {
      const row=document.querySelector('${group}'); const title=row.querySelector('.sl-title');
      const sub=row.querySelector('.session-mini-jumps');
      return {height:row.getBoundingClientRect().height,details:getComputedStyle(sub).display,
        sidebarWidth:document.querySelector('#session-sidebar').getBoundingClientRect().width,
        titleWidth:title.getBoundingClientRect().width,titleTruncated:title.scrollWidth>title.clientWidth,
        shadow:getComputedStyle(row).boxShadow,bg:getComputedStyle(row).backgroundColor,
        overflow:row.scrollWidth>row.clientWidth,moon:!!row.querySelector('.sl-moon'),
        percentVisible:[...row.querySelectorAll('.mini-jump-ctx')].some(el=>el.checkVisibility())};
    })()`);
    result.matrix = [];
    for (const width of [320,400,560]) {
      for (const zoom of [1,1.25,1.5]) {
        await client.eval(`require('electron').webFrame.setZoomFactor(${zoom}); document.querySelector('#session-sidebar').style.width='${width}px'`);
        await waitFor(async () => Math.abs((await read()).sidebarWidth - width) < 1, 'sidebar width settled');
        await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:1000,y:10});
        const state = await read();
        assert.equal(state.details, 'none'); assert.equal(state.shadow, 'none'); assert.ok(state.moon);
        assert.equal(state.overflow, false); assert.ok(state.titleWidth > 80);
        result.matrix.push({width,zoom,...state});
      }
    }
    result.checks.push('9 width/zoom combinations: compact row, moon, readable title, no overflow');
    await client.eval("require('electron').webFrame.setZoomFactor(1); document.querySelector('#session-sidebar').style.width='400px'");
    await waitFor(async () => Math.abs((await read()).sidebarWidth - 400) < 1, 'sidebar reset');
    await mouse(client, group, false);
    const hover = await read(); assert.equal(hover.details, 'flex'); assert.equal(hover.percentVisible, false);
    result.hover = hover;
    await client.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1000,y:10});
    await client.eval(`document.querySelector('${group}').focus()`);
    assert.equal((await read()).details, 'flex');
    result.checks.push('hover and keyboard focus reveal member links without percentages');
    await client.eval('document.activeElement.blur()');
    const initial = await client.eval(`({count:document.querySelector('.session-dormant-header .stg-count').textContent,
      unread:!!document.querySelector('[data-meeting-id="unread-group"].need-unread .sl-state.unread'),
      error:!!document.querySelector('[data-session-id="disconnected"].disconnected')})`);
    assert.equal(initial.count, '3'); assert.ok(initial.unread); assert.ok(initial.error);
    await mouse(client, '.session-dormant-header');
    assert.equal(await client.eval(`!!document.querySelector('${group}')`), false);
    assert.equal(await client.eval("!!document.querySelector('[data-session-id=unread]')"), true);
    assert.equal(await client.eval("!!document.querySelector('[data-session-id=disconnected]')"), true);
    await client.eval('renderSessionList()');
    assert.equal(await client.eval("localStorage.getItem('hubDormantGroupCollapsed')"), 'true');
    result.keyboardBefore = await client.eval(`(() => {
      window.__dormantKeys=[];
      for (const type of ['keydown','keyup','click']) document.addEventListener(type,e=>{
        window.__dormantKeys.push({type,key:e.key,target:e.target.className,prevented:e.defaultPrevented});
      });
      document.querySelector('.session-dormant-header').focus();
      return {active:document.activeElement.className,focus:document.hasFocus()};
    })()`);
    await client.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await client.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    result.keyboardAfter = await client.eval(`({events:window.__dormantKeys,active:document.activeElement.className,expanded:document.querySelector('.session-dormant-header').ariaExpanded})`);
    await waitFor(() => client.eval(`!!document.querySelector('${group}')`), 'keyboard expands dormant group');
    result.checks.push('collapse persists, Enter expands, unread/error stay visible');
    await client.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1000,y:10});
    const screenshot = await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(OUT,'sidebar.png'),Buffer.from(screenshot.data,'base64'));
    // Real pointer -> existing delegated navigation -> resume-session -> real PTY.
    await mouse(client, '#session-list [data-session-id="wake"]');
    await waitFor(() => fs.existsSync(invocationLog) && fs.readFileSync(invocationLog,'utf8').trim(), 'native CLI fixture invocation');
    const args = JSON.parse(fs.readFileSync(invocationLog,'utf8').trim().split(/\r?\n/)[0]);
    assert.ok(args.includes('resume') && args.includes(NATIVE_ID));
    await waitFor(() => client.eval("sessions.get('wake')?.status !== 'dormant' && activeSessionId === 'wake'"), 'wake completed');
    result.resumeArgs = args;
    result.checks.push('one physical row click resumes exact native ID through existing IPC/PTY');
    await mouse(client, group, false);
    await mouse(client, `${group} [data-sub-id="member-a"]`);
    await waitFor(() => client.eval("activeSessionId === 'member-a' && sessions.get('member-a')?.status !== 'dormant'"), 'member navigation');
    result.checks.push('expanded member link keeps existing native resume navigation');
    result.ok = true;
  } catch (e) {
    result.ok = false; result.error = e.stack || String(e); process.exitCode = 1;
  } finally {
    if (hub) result.hubLog = hub.log();
    if (client) await client.close();
    if (hub) {
      try { result.exit = await gracefulQuit(hub); }
      catch(e) { result.ok=false; result.teardownError=e.stack; process.exitCode=1; }
    }
    fs.writeFileSync(path.join(OUT,'cdp-result.json'),JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result,null,2));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
