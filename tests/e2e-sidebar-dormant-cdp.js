'use strict';
// Real isolated Hub. State/colour fixtures are labelled separately from IPC/PTY checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', '20260907-frost-v2');
const TEMP = path.join(os.tmpdir(), `hub-t3-sidebar-${Date.now()}-${process.pid}`);
const DATA = path.join(TEMP, 'data');
const BIN = path.join(TEMP, 'bin');
const CODEX = path.join(TEMP, 'codex');
const NATIVE_ID = '44444444-4444-4444-8444-444444444444';
const invocationLog = path.join(TEMP, 'native-invocations.jsonl');
const copyPath = process.env.HUB_T3_STATE_COPY;
const mode = copyPath ? 'production-copy' : 'fixtures';
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(e => e ? reject(e) : resolve(port)); });
  });
}
async function waitFor(client, expression, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await client.eval(`Boolean(${expression})`)) return;
    await _waitMs(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function click(client, selector) {
  const p = await client.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...p, ...(type === 'mouseMoved' ? {} : {button:'left',buttons:type === 'mousePressed'?1:0,clickCount:1}) });
}
async function key(client, key, code) {
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', key, code:key, windowsVirtualKeyCode:code });
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', key, code:key, windowsVirtualKeyCode:code });
}
async function shot(client, name) {
  const result = await client.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data,'base64'));
}
async function main() {
  for (const dir of [OUT, DATA, BIN, CODEX]) fs.mkdirSync(dir,{recursive:true});
  const result = {mode, dataDir:DATA, checks:[], screenshots:[], ok:false};
  if (copyPath) {
    const bytes = fs.readFileSync(copyPath); // source is read only, never passed to the app
    fs.writeFileSync(path.join(DATA,'state.json'),bytes);
    result.sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const source = JSON.parse(bytes);
    result.sourceCounts = {sessions:source.sessions.length,meetings:source.meetings.length};
    assert.ok(source.sessions.length >= 700);
  }
  const fixture = path.join(BIN, 'codex-fixture.js');
  fs.writeFileSync(fixture, `require('fs').appendFileSync(${JSON.stringify(invocationLog)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('T3 NATIVE READY\\r\\n');setInterval(()=>{},1000);`, 'utf8');
  fs.writeFileSync(path.join(BIN, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({providers:{codex:{backend:'subscription',subscription_profile:'e2e',subscription_profiles:[{id:'e2e',label:'E2E',home:CODEX}]}}}), 'utf8');
  const pathKey = Object.keys(process.env).find(k=>k.toLowerCase()==='path') || 'Path';
  let hub, client;
  try {
    hub = await launchIsolatedHub({dataDir:DATA,port:await freePort(),label:'T3-sidebar',windowMode:'hidden',extraEnv:{CLAUDE_HUB_E2E:'1',CODEX_HOME:CODEX,HUB_CODEX_BACKEND:'subscription',HUB_CODEX_PROFILE:'e2e',[pathKey]:BIN+path.delimiter+(process.env[pathKey]||'')}});
    client = await connectFirstPage(hub,t=>t.type==='page'&&/renderer[\\/]index\.html/.test(t.url));
    await client.send('Runtime.enable'); await client.send('Page.enable');
    await client.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await client.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
    await waitFor(client,'window.__hubE2E?.addFakeSessions && window.__hubE2E?.globalSessionSearch');
    result.pid=hub.pid; result.port=hub.port;
    assert.equal(await client.eval('process.env.CLAUDE_HUB_DATA_DIR'),DATA);
    const meetingsAtStart=await client.eval("require('electron').ipcRenderer.invoke('get-meetings')");
    result.runtimeMeetingCount=meetingsAtStart.length;
    if (!copyPath) assert.equal(meetingsAtStart.length,0);
    result.checks.push('isolated data directory and runtime meeting inventory verified');
    if (!copyPath) {
      await client.eval(`(() => {
        const now=Date.now(); window.__hubE2E.clearSessions();
        for(const id of Object.keys(meetings)) delete meetings[id];
        const base={kind:'codex',status:'dormant',lastMessageTime:now-10*86400000,createdAt:now-10*86400000,cwd:${JSON.stringify(ROOT)}};
        window.__hubE2E.addFakeSessions([
          ...Array.from({length:712},(_,i)=>({...base,id:'history-'+i,title:'归档历史 '+i})),
          {...base,id:'study-archive',purpose:'study-companion',title:'学习 · 信道与概率'},
          {...base,id:'league-archive',purpose:'agent-league',title:'投研 · 周期与估值'},
          {...base,id:'pin',pinned:true,title:'置顶 · 研发工作记录'},
          {...base,id:'waiting',status:'idle',attentionState:'needs-input',title:'等待确认 · 方案取舍',lastMessageTime:now},
          {...base,id:'failed',status:'failed',title:'异常 · 连接中断',lastMessageTime:now},
          {...base,id:'running',status:'running',title:'运行 · 汇总实验结果',lastMessageTime:now},
          {...base,id:'unread',unreadCount:1,title:'未读 · 评审已完成',lastMessageTime:now},
          {...base,id:'today',status:'idle',title:'今天 · 侧栏布局整理',lastMessageTime:now},
          {...base,id:'member-a',kind:'claude',meetingId:'group'},
          {...base,id:'member-b',meetingId:'group'}
        ]);
        meetings.group={id:'group',title:'群聊 · 协作开发验收',groupChat:true,status:'idle',subSessions:['member-a','member-b'],participants:[0,1],lastMessageTime:now,unreadAnswered:new Set(['member-a'])};
        renderSessionList();
      })()`);
    }
    result.layout = await client.eval(`(() => {
      const list=document.querySelector('#session-list'), archive=list.querySelector('.session-archive-entry');
      const rows=[...list.querySelectorAll('.session-item')];
      const parts=require('./session-list-renderer').getSidebarSearchEntries(document);
      const headers=[...list.querySelectorAll('.session-sec-header')].map(e=>e.querySelector('span').textContent);
      return {sessions:sessions.size, catalogue:parts.length, rows:rows.length,headers,
        archiveCount:Number(archive.querySelector('.archive-count').textContent), expectedArchive:parts.filter(s=>s.archived).length,
        clientHeight:list.clientHeight,scrollHeight:list.scrollHeight, noScroll:list.scrollHeight<=list.clientHeight,
        archiveVisible:archive.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom,
        rowHeights:[...new Set(rows.map(e=>e.getBoundingClientRect().height))],
        oldFilters:!!document.querySelector('#session-filter-tabs,#session-agent-groups')};
    })()`);
    assert.deepEqual(result.layout.headers,['置顶','活跃','今天']);
    assert.equal(result.layout.archiveCount,result.layout.expectedArchive);
    assert.equal(result.layout.oldFilters,false);
    assert.ok(result.layout.rowHeights.every(h=>h===27));
    // Measure honestly: do not hide overflow or truncate live rows for the AC.
    assert.ok(result.layout.noScroll && result.layout.archiveVisible, JSON.stringify(result.layout));
    result.checks.push('700+ catalogue: all three sections and archive fit without vertical scrolling at 1440x1080');
    const sideName=copyPath?'T3-sidebar-production-copy.png':'T3-sidebar-three-sections.png';
    await shot(client,sideName);result.screenshots.push(sideName);
    if (!copyPath) {
      result.rowStates=await client.eval(`(() => {
        const list=document.querySelector('#session-list'), header=list.querySelector('.sec-active');
        const active=[];let row=header.nextElementSibling;while(row&&!row.classList.contains('session-sec-header')&&!row.classList.contains('session-archive-entry')){active.push(row.dataset.sessionId||row.dataset.meetingId);row=row.nextElementSibling;}
        const dot=list.querySelector('[data-session-id=waiting] .sl-dot');
        return {active,waitColor:getComputedStyle(dot).backgroundColor,waitGlow:getComputedStyle(dot).boxShadow};
      })()`);
      assert.deepEqual(result.rowStates.active.slice(0,3),['waiting','failed','running']);
      assert.equal(result.rowStates.waitColor,'rgb(251, 191, 36)');assert.notEqual(result.rowStates.waitGlow,'none');
      await client.eval("document.querySelector('[data-session-id=waiting]').focus()");
      await key(client,'ArrowDown',40);
      assert.equal(await client.eval('document.activeElement.dataset.sessionId'),'failed');
      await client.eval('renderSessionList()');assert.equal(await client.eval('document.activeElement.dataset.sessionId'),'failed');
      await key(client,'ArrowUp',38);assert.equal(await client.eval('document.activeElement.dataset.sessionId'),'waiting');
      await shot(client,'T3-row-states.png');result.screenshots.push('T3-row-states.png');
      result.checks.push('amber glow and active ordering; Arrow keys and focus retention after rebuild');
    }
    await click(client,'.session-archive-entry');
    await waitFor(client,"window.__hubE2E.globalSessionSearch.state().activeScope==='dormant' && window.__hubE2E.globalSessionSearch.state().resultCount>0");
    result.archive=await client.eval('window.__hubE2E.globalSessionSearch.state()');
    assert.equal(result.archive.resultCount,result.layout.archiveCount);
    result.checks.push('physical archive click opens dormant scope with exact catalogue count');
    if (!copyPath) {
      for(const [facet,title] of [['study','学习 · 信道与概率'],['league','投研 · 周期与估值']]) {
        await click(client,'[data-agent="'+facet+'"]');
        await waitFor(client,'window.__hubE2E.globalSessionSearch.state().resultCount===1');
        assert.equal(await client.eval("document.querySelector('.session-search-result-title').textContent"),title);
        assert.equal(JSON.parse(await client.eval("localStorage.getItem('hub.search.facets')")).agent,facet);
      }
      await click(client,'[data-agent="all"]');
      await shot(client,'T3-archive-search.png');result.screenshots.push('T3-archive-search.png');
      result.checks.push('learning and research facet filter actual UI results and persist selection');
      await key(client,'Escape',27);
      // A real PowerShell process exercises keyboard opening; no fake select callback.
      const real=await client.eval(`require('electron').ipcRenderer.invoke('create-session',{kind:'powershell',opts:{cwd:${JSON.stringify(TEMP)},title:'T3 键盘真实会话'}})`);
      await waitFor(client,`document.querySelector('[data-session-id="${real.id}"]')`);
      await client.eval(`activeSessionId=null;renderSessionList();document.querySelector('[data-session-id="${real.id}"]').focus()`);
      await key(client,'Enter',13);
      await waitFor(client,`activeSessionId==='${real.id}' && document.querySelector('#terminal-panel').style.display!=='none'`);
      result.checks.push('Enter opens real PowerShell session via existing renderer navigation');
      await client.eval(`require('electron').ipcRenderer.invoke('close-session',${JSON.stringify(real.id)})`);
      // Archive search -> real resume IPC/PTY, then the Today archive action.
      // Only the external CLI is a deterministic local fixture; Hub navigation is real.
      await client.eval(`(() => {
        window.__hubE2E.clearSessions();for(const id of Object.keys(meetings)) delete meetings[id];
        window.__hubE2E.addFakeSessions([{id:'wake-native',title:'T3 原生恢复与再归档',kind:'codex',status:'dormant',lastMessageTime:Date.now()-2*86400000,
          cwd:${JSON.stringify(TEMP)},codexSid:${JSON.stringify(NATIVE_ID)},codexProfile:'e2e',mcpProfile:'none'}]);renderSessionList();
      })()`);
      await click(client,'.session-archive-entry');
      await waitFor(client,`document.querySelector('[data-search-action="open"]')`);
      await click(client,'[data-search-action="open"]');
      const nativeDeadline=Date.now()+20000;
      while(!fs.existsSync(invocationLog) && Date.now()<nativeDeadline) await _waitMs(100);
      assert.ok(fs.existsSync(invocationLog),'native CLI invocation');
      const args=JSON.parse(fs.readFileSync(invocationLog,'utf8').trim().split(/\r?\n/)[0]);
      assert.ok(args.includes('resume')&&args.includes(NATIVE_ID),JSON.stringify(args));
      await waitFor(client,"activeSessionId==='wake-native' && sessions.get('wake-native').status!=='dormant'");
      result.nativeResumeArgs=args;
      result.checks.push('archive preview opens exact native ID through real resume IPC and PTY (local CLI fixture)');
      await client.eval(`(() => {const s=sessions.get('wake-native');s.status='idle';s.runtimeTruth=null;s.attentionState='idle';s.unreadCount=0;s.lastMessageTime=Date.now();renderSessionList();})()`);
      await click(client,'.sec-today .sec-action');
      await waitFor(client,"sessions.get('wake-native')?.status==='dormant' && !document.querySelector('[data-session-id=wake-native]')");
      assert.equal(await client.eval("document.querySelector('.archive-count').textContent"),'1');
      result.checks.push('Today archive action suspends the real fixture PTY and moves it to archive');

    }
    result.ok=true;
  } catch(error) { result.error=error.stack||String(error);process.exitCode=1; }
  finally {
    if(client) await client.close();
    if(hub) { result.hubLog=hub.log().slice(-40); try{result.exit=await gracefulQuit(hub);}catch(e){result.ok=false;result.teardownError=e.stack;process.exitCode=1;} }
    fs.writeFileSync(path.join(OUT,'T3-'+mode+'-verification.json'),JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result,null,2));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});