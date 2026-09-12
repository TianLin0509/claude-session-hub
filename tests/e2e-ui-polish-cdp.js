'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, seedUsageData, waitFor, click } = require('./helpers/usage-refresh-fixture');
const { setStaticSidebarLayout } = require('./helpers/sidebar-quota-geometry');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output/playwright/20260910-ui-polish-codex1');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ui-polish-'));
const evidence = { dataDir: DATA, cases: [], fixture: 'Real isolated Hub, native CDP pointer actions, real PTYs running controlled CLI processes; no model inference. Quota observations come from disk and controlled app-server.' };
let hub, cdp;
async function shot(name) {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
}
async function rightClick(selector) {
  const p = await cdp.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing '+${JSON.stringify(selector)});
    const r=e.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
    if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y))) throw Error('Covered target'); return {x,y}; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, ...p });
  await waitFor(cdp, `document.querySelector('#context-menu').style.display==='block'`);
}
const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = seedUsageData(DATA, 'empty');
  const old = Date.now() - 600000;
  fs.writeFileSync(path.join(DATA, 'usage-cache.json'), JSON.stringify({
    claude: { usage5h: { pct: 20 }, usage7d: { pct: 94 }, observedAt: old },
    codex: { usage5h: null, usage7d: { pct: 28, resetsAt: old + 1 }, source: 'app-server', observedAt: old },
    deepseek: { totalBalance: 58.69, currency: 'CNY', observedAt: old },
  }));
  const npmDir = path.join(fixture.fakeAppData, 'npm');
  const dispatcher = path.join(npmDir, 'quota-and-session.js');
  fs.writeFileSync(dispatcher, `if(process.argv.includes('app-server')) require('./fake-codex-app-server.js'); else {
    require('fs').appendFileSync(${JSON.stringify(path.join(DATA, 'cli-starts.log'))}, process.env.CLAUDE_HUB_SESSION_ID+'\\n');
    process.stdout.write('Controlled Codex session ready\\r\\n'); setInterval(()=>{},1000);
  }`);
  fs.writeFileSync(path.join(npmDir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${dispatcher}" %*\r\n`);
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const extraEnv = { CLAUDE_HUB_E2E: '1', APPDATA: fixture.fakeAppData, CODEX_HOME: fixture.codexHome, CLAUDE_CONFIG_DIR: path.join(DATA, 'claude-config'),
    HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'default', [pathKey]: npmDir + path.delimiter + process.env[pathKey] };
  async function start(visible = false) {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await getFreePort(), windowMode: visible ? 'visible' : 'hidden', label: 'ui-polish', extraEnv });
    evidence.cases.push({ launchPid: hub.pid, port: hub.port });
    cdp = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `document.querySelectorAll('.sidebar-quota-value').length===4`);
  }
  async function quota() {
    return cdp.eval(`({values:[...document.querySelectorAll('.sidebar-quota-value')].map(e=>e.textContent),
      codex:accountUsageController.getSnapshot().codex,
      colors:[...document.querySelectorAll('.sidebar-quota-track i')].map(e=>getComputedStyle(e).backgroundColor),
      footer:!!document.querySelector('.sidebar-quota-footer'),height:document.querySelector('#rail-usage').getBoundingClientRect().height})`);
  }
  try {
    await start();
    await _waitMs(6500); // Real 5-second background scan must have run.
    const first = await quota(); evidence.cases.push({ retainedAfterPoll: first });
    assert.deepEqual(first.values, ['80%', '6%', '72%', '¥58.69']);
    assert.equal(first.codex.lastSeen, old); assert.equal(first.footer, false);
    assert.ok(hub.log().some(l => l.includes('hook server listening')));
    for (const zoom of [1, 1.25]) for (const width of [280, 340, 440]) {
      const geometry = await setStaticSidebarLayout(cdp, width, zoom);
      assert.deepEqual(geometry.overlaps, []); assert.deepEqual(geometry.overflow, []);
      evidence.cases.push({ width, zoom, geometry });
    }
    await setStaticSidebarLayout(cdp, 340, 1);
    await shot('quota-persistent');
    await click(cdp, '.sidebar-quota-provider[data-provider="codex"]');
    await waitFor(cdp, `!!accountUsageController.getSnapshot().refresh.providers.codex.error`);
    assert.equal((await quota()).values[2], '72%');
    await cdp.close(); cdp = null;
    fs.writeFileSync(path.join(OUT, 'first-hub.log'), hub.log().join('\n'));
    evidence.firstTeardown = await gracefulQuit(hub); hub = null;
    await start(true); await _waitMs(6000);
    const restarted = await quota(); evidence.cases.push({ afterRestart: restarted });
    assert.equal(restarted.values[2], '72%'); assert.equal(restarted.codex.lastSeen, old);
    const meeting = await invoke('create-meeting', { title: 'UI 验证会议室', workspace: DATA, scene: 'general' });
    const memberIds = [];
    for (const [i, title] of ['成员一', '成员二'].entries()) {
      const member = await invoke('add-meeting-sub', { meetingId: meeting.id, kind: 'codex-resume', opts: {
        title, cwd: DATA, useResume: true, codexSid: `11111111-1111-4111-8111-11111111111${i}`, codexProfile: 'default', userRenamed: true,
      } });
      memberIds.push(member.id || member.session?.id);
    }
    assert.ok(memberIds.every(Boolean));
    const outside = await invoke('create-session', { kind: 'codex-resume', opts: { title: '独立会话', cwd: DATA,
      useResume: true, codexSid: '22222222-2222-4222-8222-222222222222', codexProfile: 'default', userRenamed: true } });
    await waitFor(cdp, `document.querySelectorAll('[data-sub-id]').length>=2`);
    await _waitMs(2000);
    const memberSelector = `[data-sub-id="${memberIds[0]}"]`;
    await rightClick(memberSelector);
    const labels = await cdp.eval(`[...document.querySelectorAll('#context-menu button')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.textContent)`);
    assert.deepEqual(labels, ['置顶','重启','休眠','删除','置底']);
    await shot('member-context-menu');
    await click(cdp, '#context-menu [data-action="pin"]');
    await waitFor(cdp, `sessions.get(${JSON.stringify(memberIds[0])})?.pinned===true`);
    const nativeBefore = (await invoke('get-sessions')).find(s => s.id === memberIds[0]);
    await rightClick(memberSelector);
    await click(cdp, '#context-menu [data-action="close"]');
    await waitFor(cdp, `sessions.get(${JSON.stringify(memberIds[0])})?.status==='dormant'`);
    assert.ok((await invoke('get-sessions')).some(s => s.id === memberIds[1]));
    await rightClick(memberSelector);
    await click(cdp, '#context-menu [data-action="restart"]');
    await waitFor(cdp, `sessions.get(${JSON.stringify(memberIds[0])})?.status!=='dormant' && !sessions.get(${JSON.stringify(memberIds[0])})?._resumePending`);
    const nativeAfter = (await invoke('get-sessions')).find(s => s.id === memberIds[0]);
    assert.equal(nativeAfter.codexSid, nativeBefore.codexSid);
    // Controlled runtime frames exercise the real renderer's state parser and
    // CSS on real PTY-backed rows; this checks UI animation, not model activity.
    const animation = await cdp.eval(`(async () => {
      const ids=${JSON.stringify([outside.id, memberIds[0]])}, now=Date.now();
      const frame=['• Working (25s • esc to interrupt)','› Use /skills to list available skills','gpt-6-astra max · Context 92% left'];
      for(const id of ids) { window.__hubE2E.applyTerminalRuntimeFrame(id,frame,now); window.__hubE2E.applyTerminalRuntimeFrame(id,[frame[0].replace('25s','26s'),...frame.slice(1)],now+500); }
      await new Promise(r=>setTimeout(r,250));
      const selectors=[${JSON.stringify(`[data-session-id="${outside.id}"] .sl-dot`)},${JSON.stringify(`[data-meeting-id="${meeting.id}"] .sl-dot`)}];
      const samples=[];
      for(let i=0;i<5;i++) { samples.push(selectors.map(s=>{const e=document.querySelector(s),c=getComputedStyle(e);return {class:e.className,name:c.animationName,duration:c.animationDuration,opacity:Number(c.opacity)};})); await new Promise(r=>setTimeout(r,180)); }
      return samples;
    })()`);
    evidence.cases.push({ controlledFrameAnimation: animation });
    for (const sample of animation) for (const dot of sample) { assert.match(dot.class,/run/); assert.equal(dot.name,'mini-st-pulse'); assert.equal(dot.duration,'1.5s'); }
    for (const i of [0,1]) assert.ok(Math.max(...animation.map(a=>a[i].opacity))-Math.min(...animation.map(a=>a[i].opacity))>.15);
    await shot('active-dots');
    const roomSelector = `[data-meeting-id="${meeting.id}"] .sl-title`;
    await rightClick(roomSelector);
    const roomLabels = await cdp.eval(`[...document.querySelectorAll('#context-menu button')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.textContent)`);
    assert.deepEqual(roomLabels, ['置顶','休眠会议室','删除会议室','置底']);
    await shot('meeting-context-menu');
    await click(cdp, '#context-menu [data-action="close"]');
    await waitFor(cdp, `${JSON.stringify(memberIds)}.every(id=>sessions.get(id)?.status==='dormant')`);
    const rooms = await invoke('get-meetings');
    const room = rooms.find(r => r.id === meeting.id);
    assert.equal(room.status, 'dormant'); assert.deepEqual(room.subSessions, memberIds);
    assert.ok((await invoke('get-sessions')).some(s => s.id === outside.id), 'unrelated PTY remains live');
    evidence.cases.push({ memberLabels: labels, roomLabels, nativeBefore: nativeBefore.codexSid, nativeAfter: nativeAfter.codexSid, room, outsideLive: outside.id });
    await shot('meeting-sleep-complete');
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = error.stack;
    if (cdp) { await shot('failure'); evidence.snapshot = await cdp.eval(`({usage:accountUsageController.getSnapshot(),sessions:[...sessions.values()].map(s=>({id:s.id,status:s.status,title:s.title,codexSid:s.codexSid})),meetings})`); }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close();
    if (hub) evidence.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(evidence, null, 2));
  }
  console.log('PASS UI polish:', OUT);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
