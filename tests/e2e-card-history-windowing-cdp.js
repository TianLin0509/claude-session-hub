'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-windowed-cards-'));
const out = path.resolve('output/playwright/card-windowing-' + Date.now()); fs.mkdirSync(out, { recursive: true });
const work = path.join(root, 'work'), data = path.join(root, 'data'), claudeHome = path.join(root, 'claude');
fs.mkdirSync(path.join(work, '.git'), { recursive: true }); fs.mkdirSync(path.join(work, '.agents'));
fs.writeFileSync(path.join(work, '.agents/project.json'), JSON.stringify({ name: 'Windowed card fixture', trunk: 'master' }));
new (require('../core/prepared-project-registry').PreparedProjectRegistry)({ dataDir: data }).register(work);
const cases = ['claude', 'codex', 'codex'].map((kind, i) => ({ kind, name: kind + i, id: randomUUID(), rounds: 80 }));
const markdown = '## Complete content\n\n**Markdown** remains available.\n\n- First item\n- Second item\n\n```js\nconst ready = true;\n```\n\n';
const store = path.join(root, 'store.json');
fs.writeFileSync(store, JSON.stringify(cases.filter(c => c.kind === 'codex').map(c => [c.id, {
  id: c.id, cwd: work, status: { type: 'idle' }, model: 'gpt-6-astra', reasoningEffort: 'max',
  turns: Array.from({ length: c.rounds }, (_, i) => ({ id: 'turn-' + i, status: 'completed', startedAt: 1700000000 + i,
    items: [{ id: 'u-' + i, type: 'userMessage', content: [{ type: 'text', text: `QUESTION_${i}_${c.name}` }] },
      { id: 'a-' + i, type: 'agentMessage', phase: 'final_answer', text: `ANSWER_${i}_${c.name}\n` + markdown.repeat(12) }] })),
}])));
const claude = cases[0], dir = path.join(claudeHome, 'projects', path.resolve(work).replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, claude.id + '.jsonl'), Array.from({ length: 80 }, (_, i) => {
  const timestamp = new Date(1700000000000 + i * 1000).toISOString();
  return [JSON.stringify({ type: 'user', uuid: 'u-' + i, timestamp, sessionId: claude.id, message: { role: 'user', content: `QUESTION_${i}_${claude.name}` } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-' + i, timestamp, sessionId: claude.id, message: { id: 'a-' + i, role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `ANSWER_${i}_${claude.name}\n` + markdown.repeat(12) }] } })].join('\n');
}).join('\n') + '\n');
(async () => {
  let hub, cdp; const results = [];
  try {
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    let entryPath;
    if (process.env.HUB_CARD_UNTHROTTLED === '1') {
      // Measure a foreground scheduling budget while keeping the isolated
      // window hidden. Chromium otherwise blocks caret/layout commits for
      // ~1 s at a time (WaitForCommitCompletion), obscuring app work in traces.
      entryPath=path.join(root,'foreground-scheduling.cjs');
      fs.writeFileSync(entryPath,`const {app}=require('electron');app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));require(${JSON.stringify(path.resolve('main-bootstrap.js'))});`);
    }
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', ...(entryPath?{entryPath}:{}), extraEnv: {
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'), CLAUDE_HUB_NATIVE_FIXTURE_STORE: store,
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.resolve('tests/fixtures/claude-stream.js'), CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'hold',
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1450, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Performance.enable');
    async function until(expr) { const end = Date.now() + 40000; while (!await cdp.eval(expr)) { if (Date.now() > end) {
      const state = await cdp.eval(`({active:activeSessionId,view:currentView,loads:window.__loads,cache:cardHistoryViews.stats(),text:document.querySelector('#msg-overlay')?.textContent.slice(0,1000),errors:window.__errors,session:sessions.get(activeSessionId)?.nativeRuntime})`);
      fs.writeFileSync(path.join(out,'timeout.json'),JSON.stringify(state,null,2)); console.error(JSON.stringify(state));
      throw Error('Timed out: ' + expr);
    } await sleep(60); } }
    async function click(selector) {
      const point = await cdp.eval(`(async()=>{let e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing click target');e.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=r.x+Math.min(80,r.width/2),y=r.y+r.height/2;if(!r.height || !e.contains(document.elementFromPoint(x,y)))throw Error('obscured click target '+${JSON.stringify(selector)});return{x,y};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await until('typeof sessions !== "undefined" && typeof cardHistoryPager !== "undefined"');
    await cdp.eval(`window.__errors=[];for(const name of ['warn','error']){const original=console[name].bind(console);console[name]=(...args)=>{window.__errors.push(args.map(x=>String(x)));original(...args);};}`);
    await cdp.eval(`window.__loads=0;window.__long=[];window.__loadDurations=[];const original=loadSessionHistoryToOverlay;loadSessionHistoryToOverlay=async function(...args){window.__loads++;const t=performance.now();try{return await original(...args);}finally{window.__loads--;window.__loadDurations.push(performance.now()-t);}};new PerformanceObserver(list=>window.__long.push(...list.getEntries().map(x=>x.duration))).observe({type:'longtask'});`);
    for (const c of cases) {
      const opts = { cwd: work, mcpProfile: 'none', ...(c.kind === 'codex' ? { useResume: true, codexSid: c.id, model: 'gpt-6-astra', effort: 'max' } : { resumeCCSessionId: c.id, model: 'claude-opus-5', permissionMode: 'default' }) };
      const created = await cdp.eval(`ipcRenderer.invoke('create-session',{kind:${JSON.stringify(c.kind)},opts:${JSON.stringify(opts)}})`);
      assert(created.id, JSON.stringify(created)); c.sid = created.id;
      await until(`sessions.get(${JSON.stringify(c.sid)})?.nativeRuntime?.connection==='connected'`);
      await until(`!!document.querySelector('.session-item[data-session-id="${c.sid}"]')`);
      await click(`.session-item[data-session-id="${c.sid}"]`);
      if (await cdp.eval('currentView!=="card"')) await click('#btn-backstage');
      await until(`activeSessionId===${JSON.stringify(c.sid)} && cardHistoryViews.ready(sessions.get(${JSON.stringify(c.sid)})) && __loads===0`);
      assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay>.turn-card").length'), 8);
      assert(await cdp.eval(`document.querySelector('#msg-overlay').textContent.includes(${JSON.stringify('ANSWER_79_' + c.name)})`));
    }
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    if (process.env.HUB_CARD_PROFILE === '1') {
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
      await cdp.send('Tracing.start',{categories:'devtools.timeline,toplevel,blink,cc,v8',transferMode:'ReturnAsStream'});
    }
    for (const c of [...cases, cases[0]]) {
      await cdp.eval('window.__long=[];window.__loadDurations=[]'); const before = await metrics();
      await click(`.session-item[data-session-id="${c.sid}"]`);
      await until(`activeSessionId===${JSON.stringify(c.sid)} && cardHistoryViews.ready(sessions.get(${JSON.stringify(c.sid)})) && __loads===0`);
      const after = await metrics();
      results.push({ case: c.name, rendererTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        ...await cdp.eval('({cards:document.querySelectorAll("#msg-overlay>.turn-card").length,nodes:document.querySelectorAll("#msg-overlay *").length,longTasks:window.__long,loads:window.__loadDurations})') });
    }
    if (process.env.HUB_CARD_PROFILE === '1') {
      const profile = await cdp.send('Profiler.stop');
      fs.writeFileSync(path.join(out,'switch-profile.json'),JSON.stringify(profile));
      const complete=new Promise(resolve=>{const listener=data=>{const msg=JSON.parse(data);if(msg.method==='Tracing.tracingComplete'){cdp.ws.off('message',listener);resolve(msg.params.stream);}};cdp.ws.on('message',listener);});
      await cdp.send('Tracing.end'); const stream=await complete;let trace='';
      for(;;){const row=await cdp.send('IO.read',{handle:stream});trace+=row.data;if(row.eof)break;}
      await cdp.send('IO.close',{handle:stream});fs.writeFileSync(path.join(out,'switch-trace.json'),trace);
      fs.writeFileSync(path.join(out,'switch-metrics.json'),JSON.stringify(results,null,2));
      console.log('PROFILE_ONLY '+out); return;
    }
    // Real upward wheel pauses follow mode. Prepending history keeps the same
    // paragraph in place, and a draft survives both pagination and navigation.
    await cdp.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='KEEP_DRAFT_完整';box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const point = await cdp.eval(`(()=>{const e=document.querySelector('#msg-overlay');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -100000, deltaX: 0 });
    await until('document.querySelector("#msg-overlay").scrollTop<100');
    await cdp.eval(`window.__anchor=document.querySelector('#msg-overlay>.turn-card');window.__anchorBefore=__anchor.getBoundingClientRect().top;`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -24, deltaX: 0 });
    await until(`!cardHistoryPager.get(${JSON.stringify(claude.sid)}).busy && document.querySelectorAll('#msg-overlay>.turn-card').length>8`);
    const firstPage = await cdp.eval(`({cards:document.querySelectorAll('#msg-overlay>.turn-card').length,anchorShift:__anchor.getBoundingClientRect().top-__anchorBefore,following:cardFollowScroll.isFollowing(),draft:document.querySelector('.floating-input-box').textContent,owners:[...document.querySelectorAll('#msg-overlay>.turn-card')].every(e=>e.dataset.sessionId===activeSessionId)})`);
    assert.equal(firstPage.cards, 32); assert.equal(firstPage.draft, 'KEEP_DRAFT_完整'); assert(firstPage.owners);
    assert.equal(firstPage.following, false); assert(Math.abs(firstPage.anchorShift) < 3, JSON.stringify(firstPage));
    // Every older card remains reachable; paging must never silently truncate.
    for (let i = 0; i < 10 && await cdp.eval('!!document.querySelector(".card-history-more")'); i++) {
      await click('.card-history-more'); await until(`!cardHistoryPager.get(${JSON.stringify(claude.sid)}).busy`);
    }
    const complete = await cdp.eval(`({cards:document.querySelectorAll('#msg-overlay>.turn-card').length,text:document.querySelector('#msg-overlay').textContent,ids:[...document.querySelectorAll('#msg-overlay>.turn-card')].map(e=>e.dataset.turnId)})`);
    assert.equal(complete.cards, 160); assert.equal(new Set(complete.ids).size, 160);
    assert(complete.text.includes('QUESTION_0_claude0') && complete.text.includes('ANSWER_79_claude0'));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'history-complete.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ fixture: '3 sessions, 80 complete rounds each; real isolated hidden Hub; no cloud model', results, firstPage, completeCards: complete.cards }, null, 2));
    console.log(JSON.stringify({ results, firstPage, completeCards: complete.cards }));
    console.log('PASS latest cards, Claude/Codex parity, cached switches, older-page access, no duplicates, draft preservation');
    console.log('ARTIFACT_ROOT ' + out);
  } finally { if (hub) fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error); process.exitCode = 1; });
