'use strict';
// 2026-10-08 用户反馈「点某个 session 要卡一会才出现」。生产实测：点一次会话，Claude
// 磁盘历史最近 9 轮带着工具截图原图（base64）整份送进窗口，单次 12.7 MB。
// 隔离 Hub + 真实 Claude CLI（CLAUDE_PROXY 指向不可达端口，不调用模型）打开两条
// 带大量截图和长日志的记录，用真实鼠标事件来回切换，记录：
//   每次点击到卡片出齐的耗时、历史数据包大小、窗口主线程长任务；
//   截图工具行「复制」拿到的仍是原始全文（按需读取）。
// 用法：node tests/e2e-card-history-heavy-tools-cdp.js [label]
//   HUB_ENTRY=<Hub 目录>        对照旧代码（默认本工作区）
//   HUB_REAL_TRANSCRIPTS=a;b    用真实记录副本代替合成记录（只读复制）
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const label = process.argv[2] || 'run';

function syntheticTranscript(sid, cwd, tag) {
  const lines = []; let n = 0;
  const at = () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + (n++) * 1000).toISOString();
  const image = i => 'iVBORw0KGgo' + crypto.createHash('sha256').update(tag + i).digest('base64').repeat(12000);
  for (let turn = 0; turn < 12; turn++) {
    lines.push({ type: 'user', uuid: `${tag}-u${turn}`, timestamp: at(), sessionId: sid, cwd, message: { role: 'user', content: `${tag} 第 ${turn} 轮：截图检查界面` } });
    const tools = Array.from({ length: 4 }, (_, k) => ({ type: 'tool_use', id: `${tag}-shot-${turn}-${k}`, name: 'Read', input: { file_path: `C:\\shots\\${turn}-${k}.png` } }));
    tools.push({ type: 'tool_use', id: `${tag}-test-${turn}`, name: 'Bash', input: { command: 'npm test' } });
    lines.push({ type: 'assistant', uuid: `${tag}-a${turn}`, timestamp: at(), sessionId: sid, cwd, message: { id: `${tag}-m${turn}`, role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', content: tools } });
    tools.slice(0, 4).forEach((tool, k) => lines.push({ type: 'user', uuid: `${tag}-r${turn}-${k}`, timestamp: at(), sessionId: sid, cwd, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: tool.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image(turn * 10 + k) } }] }] } }));
    const log = Array.from({ length: 9000 }, (_, i) => `ok ${i} - case ${turn}`).join('\n') + `\n${turn + 40} passed, 0 failed\nall tests passed`;
    lines.push({ type: 'user', uuid: `${tag}-rt${turn}`, timestamp: at(), sessionId: sid, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${tag}-test-${turn}`, content: log }] } });
    lines.push({ type: 'assistant', uuid: `${tag}-f${turn}`, timestamp: at(), sessionId: sid, cwd, message: { id: `${tag}-mf${turn}`, role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `FINAL_${tag}_${turn} 截图看过了` }] } });
  }
  return lines.map(l => j(l)).join('\n') + '\n';
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-heavy-tools-'));
  const data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'work');
  const tdir = path.join(claudeDir, 'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  for (const d of [data, cwd, tdir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  const real = (process.env.HUB_REAL_TRANSCRIPTS || '').split(';').filter(Boolean);
  const cases = (real.length ? real : ['A', 'B']).map((source, i) => {
    const sid = real.length ? path.basename(source, '.jsonl') : crypto.randomUUID();
    const file = path.join(tdir, sid + '.jsonl');
    if (real.length) fs.copyFileSync(source, file); else fs.writeFileSync(file, syntheticTranscript(sid, cwd, source));
    return { hubId: `heavy-${i}-${Date.now()}`, sid, file, tag: real.length ? null : source, mb: +(fs.statSync(file).size / 1048576).toFixed(1) };
  });
  const now = Date.now();
  fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions: cases.map((c, i) => ({
    hubId: c.hubId, title: 'heavy ' + i, kind: 'claude', cwd, ccSessionId: c.sid, transcriptPath: c.file, currentModel: { id: 'claude-haiku-4-5-20251001' },
    lastMessageTime: now - i, updatedAt: now - i, savedAt: now, schemaVersion: 1 })) }));
  const report = { label, entry: process.env.HUB_ENTRY || 'worktree', transcripts: cases.map(c => ({ mb: c.mb })), clicks: [], checks: [] };
  // 后台窗口默认被 Chromium 节流（约 1 秒一帧提交），计时会失真；与卡片分页测试同法关闭节流。
  const entryPath = path.join(root, 'foreground-scheduling.cjs');
  fs.writeFileSync(entryPath, `const {app}=require('electron');app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));require(${j(path.join(process.env.HUB_ENTRY || path.resolve(__dirname, '..'), 'main-bootstrap.js'))});`);
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'heavy-tools-' + label, entryPath, extraEnv: {
      CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9', CLAUDE_HUB_AGENT_RUNTIME: 'pty' } });
  const c = await connectFirstPage(hub);
  const until = async (expr, what, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(25); } throw Error('timeout ' + what); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+Math.min(60,r.width/2),y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const settled = id => `activeSessionId===${j(id)} && currentView==='card' && !window._cardFullLoadBySid?.has(${j(id)}) && window.__inflight===0 && document.querySelectorAll('#msg-overlay > .turn-card').length>0`;
  try {
    await until(`typeof sessions!=="undefined" && ${cases.map(x => `!!document.querySelector('.session-item[data-session-id="${x.hubId}"]')`).join(' && ')}`, 'rows');
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;const orig=ipc.invoke.bind(ipc);window.__inflight=0;window.__payloads=[];
      ipc.invoke=async(ch,...a)=>{if(ch!=='parse-session-transcript')return orig(ch,...a);window.__inflight++;try{const r=await orig(ch,...a);try{window.__payloads.push(JSON.stringify(r).length);}catch{}return r;}finally{window.__inflight--;}};
      window.__long=[];new PerformanceObserver(l=>window.__long.push(...l.getEntries().map(e=>Math.round(e.duration)))).observe({type:'longtask'});})()`);
    // 首次打开会恢复 CLI（PTY）；两条都起来后再测纯切换。
    for (const x of cases) {
      await click(`.session-item[data-session-id="${x.hubId}"]`);
      await until(`activeSessionId===${j(x.hubId)}`, 'active');
      if (await c.eval(`currentView!=='card'`)) await c.eval(`applyViewMode('card')`);
      await until(`(sessions.get(${j(x.hubId)})?.status||'dormant')!=='dormant'`, 'pty started');
      await until(settled(x.hubId), 'first cards');
    }
    await sleep(4000);
    if (process.env.HUB_PROFILE === '1') { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 200 }); await c.send('Profiler.start'); }
    for (let round = 0; round < 6; round++) {
      const x = cases[round % cases.length];
      await c.eval(`window.__long=[];window.__payloads=[]`);
      const t0 = Date.now();
      await click(`.session-item[data-session-id="${x.hubId}"]`);
      await until(settled(x.hubId), 'switch ' + round);
      await c.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const ms = Date.now() - t0;
      const m = await c.eval(`({payloadKB:Math.round(Math.max(0,...window.__payloads)/1024),longTasks:window.__long.slice(),cards:document.querySelectorAll('#msg-overlay > .turn-card').length})`);
      report.clicks.push({ round, session: cases.indexOf(x), ms, ...m });
      await sleep(700);
    }
    if (process.env.HUB_PROFILE === '1') {
      const { profile } = await c.send('Profiler.stop');
      const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
      for (const n of profile.nodes) for (const k of n.children || []) parent.set(k, n.id);
      const key = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
      const self = new Map(), incl = new Map();
      profile.samples.forEach((s, i) => { const d = (profile.timeDeltas[i] || 0) / 1000; let n = byId.get(s); self.set(key(n), (self.get(key(n)) || 0) + d);
        const seen = new Set(); for (let x = n; x; x = byId.get(parent.get(x.id))) { const k = key(x); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + d); } } });
      const top = m => [...m].filter(([k]) => !/^\((idle|root|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${k}`);
      report.profile = { self: top(self), inclusive: top(incl) };
    }
    if (!real.length) {
      const x = cases[cases.length - 1];
      const text = await c.eval(`document.querySelector('#msg-overlay').innerText`);
      if (!text.includes(`FINAL_${x.tag}_11`)) throw Error('latest answer missing from cards');
      report.checks.push('latest answer is rendered');
      // 复制截图工具行的全文：走按需读取，结果必须与原始 tool_result 完全一致。
      const shotId = `${x.tag}-shot-11-0`;
      const raw = fs.readFileSync(x.file, 'utf8').split('\n').filter(l => l.includes(`"tool_use_id":"${shotId}"`)).map(l => JSON.parse(l))[0];
      const expected = JSON.stringify(raw.message.content[0].content, null, 2);
      await c.eval(`(()=>{for(const d of document.querySelectorAll('#msg-overlay details.tc-cluster'))d.open=true;
        const row=document.querySelector('#msg-overlay [data-activity-id=${j(shotId)}]');row.open=true;row.scrollIntoView({block:'center'});})()`);
      const shown = await c.eval(`document.querySelector('#msg-overlay [data-activity-id=${j(shotId)}] pre.tc-result').textContent`);
      report.checks.push(`image row preview ${shown.length} chars: ${/查看全文/.test(shown) ? 'placeholder' : 'raw base64'}`);
      await c.eval(`require('electron').clipboard.writeText('')`);
      // 行内按钮在可滚动卡片区里常被悬浮输入框挡住坐标，这里用 DOM click 触发同一委托处理。
      await c.eval(`document.querySelector('#msg-overlay [data-activity-id=${j(shotId)}] [data-action="tc-copy-result"]').click()`);
      const sel = `#msg-overlay [data-activity-id=${j(shotId)}] [data-action="tc-copy-result"]`;
      await until(`/已复制|失败/.test(document.querySelector(${j(sel)})?.textContent || '') || !!document.querySelector('#msg-overlay [data-activity-id=${j(shotId)}] .card-detail-error')`, 'copy finished', 20000);
      const status = await c.eval(`(document.querySelector(${j(sel)})?.textContent || '') + ' ' + (document.querySelector('#msg-overlay [data-activity-id=${j(shotId)}] .card-detail-error')?.textContent || '')`);
      if (!/已复制/.test(status)) throw Error('copy failed: ' + status);
      const copied = await c.eval(`require('electron').clipboard.readText()`);
      if (copied !== expected) throw Error(`copied result differs from the transcript (${copied.length} vs ${expected.length})`);
      report.checks.push(`copy returns the full original tool result (${copied.length} chars)`);
    }
    report.passed = true;
  } finally {
    const out = path.resolve('artifacts/card-history-heavy-tools'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 1));
    await c.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 60000 }).catch(e => console.warn('quit', String(e)));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
