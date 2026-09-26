'use strict';
// 返工 R4：Stop 与 transcript 终态的到达顺序、Stop hook 运行帧、就绪帧，逐一在真实 renderer
// 与真实 xterm 里重放，验证「结束了的一轮不会被旧画面重新打开」「Stop hook 暂留的运行
// 一定能自己收尾」。不启动 CLI、不调用模型；画面取自 2026-09-25 审查现场。
// 用法：node tests/e2e-claude-stop-hook-order-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const HEADER = ['❯ 用 Bash 工具运行 powershell -NoProfile -Command "Start-Sleep 5; echo PERM_OK"，然后只回复 PERM_DONE。', '', '  Ran 1 shell command', '', '● PERM_DONE', ''];
const STOP_HOOK_FRAME = [...HEADER, '✶ Inferring… (running Stop hook · 18s · ↓ 594 tokens · thinking)', '', '──────────', '❯ ', '──────────', '  ⏸ manual mode on · ← for agents'];
const READY_FRAME = [...HEADER, '✻ Cooked for 18s · done 3:45 PM', '', '──────────', '❯ ', '──────────', '  ⏸ manual mode on · ← for agents'];

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-stop-order-'));
  const out = path.resolve('artifacts/cli-pty-core/stop-hook-order-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { out, checks: [], passed: false };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'stop-hook order',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    const until = async (expr, label, ms = 15000) => { const end = Date.now() + ms;
      while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
    await until('!!window.__hubE2E && typeof getSessionRuntimeTruth==="function"', 'renderer');
    await c.eval(`window.__hubE2E.clearSessions()`);

    // 一个 PTY Claude 假会话 + 它自己的真实 xterm。
    const setup = async id => {
      await c.eval(`window.__hubE2E.addFakeSession(${j({ id, kind: 'claude', agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null, status: 'idle', title: id })})`);
      await c.eval(`window.__hubE2E.selectSession(${j(id)})`);
      await until(`!!terminalCache.get(${j(id)})?.terminal`, 'xterm for ' + id);
    };
    const paint = (id, lines) => c.eval(`new Promise(r=>terminalCache.get(${j(id)}).terminal.write('\\x1b[2J\\x1b[H'+${j(lines.join('\r\n'))},r))`);
    const truth = id => c.eval(`(()=>{const s=sessions.get(${j(id)});const t=getSessionRuntimeTruth(s);return {state:t.state,source:t.source,confidence:t.confidence,unread:s.unreadCount||0,hold:!!s._claudeStopHookHold};})()`);
    const away = () => c.eval(`window.__hubE2E.addFakeSession({id:'r4-other',kind:'powershell',status:'idle'}); window.__hubE2E.selectSession('r4-other')`);
    // 在一段时间里每 150ms 采样一次，返回出现过的所有状态。
    const watch = async (id, ms) => { const seen = new Set(); const end = Date.now() + ms;
      while (Date.now() < end) { seen.add((await truth(id)).state); await sleep(150); } return [...seen]; };

    // A. transcript 先结束，Stop 后到、此时画面还在跑 Stop hook（审查两个现场都是这个顺序）。
    await setup('r4-a');
    await c.eval(`onPromptSubmittedFromHook('r4-a', Date.now())`);
    await paint('r4-a', STOP_HOOK_FRAME);
    await away();
    await c.eval(`onReplyCompleteFromTranscriptEvent({hubSessionId:'r4-a',kind:'claude',text:'PERM_DONE',completedAt:Date.now(),turnId:null})`);
    const stopA = await c.eval(`onReplyCompleteFromHook('r4-a', Date.now(), {lastAssistantMessage:'PERM_DONE'})`);
    assert.equal(stopA.stopHooksActive, false, 'a turn already closed by the transcript is not reopened by the Stop-hook frame');
    // 监视器照常读到运行帧，也不能把它拉回运行。
    await c.eval(`terminalActivityMonitor.observeRuntimeState('r4-a', Date.now())`);
    const seenA = await watch('r4-a', 5000);
    assert.deepEqual(seenA, ['completed'], 'stays completed for 5s: ' + seenA);
    assert.equal((await truth('r4-a')).unread, 1, 'exactly one unread for the unseen completion');
    report.checks.push('A transcript→Stop with a Stop-hook frame: never flips back to running; unread exactly 1');

    // B. Stop 先到、Stop hook 真在跑；随后画面回到就绪（新版 manual mode 底栏），之后再无任何输出。
    await setup('r4-b');
    await c.eval(`onPromptSubmittedFromHook('r4-b', Date.now())`);
    await paint('r4-b', STOP_HOOK_FRAME);
    await away();
    const stopB = await c.eval(`onReplyCompleteFromHook('r4-b', Date.now(), {lastAssistantMessage:'PERM_DONE'})`);
    assert.equal(stopB.stopHooksActive, true, 'Stop before the transcript while hooks run: kept running');
    assert.equal((await truth('r4-b')).state, 'running');
    await paint('r4-b', READY_FRAME);
    const t0 = Date.now();
    await until(`getSessionRuntimeTruth(sessions.get('r4-b')).state==='completed'`, 'B resolves without output or reopening', 8000);
    report.bResolveMs = Date.now() - t0;
    const b = await truth('r4-b');
    assert.equal(b.source, 'claude-stop-hooks-finished');
    assert.equal(b.unread, 1);
    assert.deepEqual(await watch('r4-b', 3000), ['completed']);
    report.checks.push(`B Stop→ready frame, no further output, session not focused: completes in ${report.bResolveMs}ms by itself; unread 1`);

    // C. Stop 先到、画面停在运行帧、之后没有任何输出：那是停住的旧帧，30s 后收尾。
    await setup('r4-c');
    await c.eval(`onPromptSubmittedFromHook('r4-c', Date.now())`);
    await paint('r4-c', STOP_HOOK_FRAME);
    await away();
    await c.eval(`sessions.get('r4-c')._lastOutputTs = Date.now()`);
    const stopC = await c.eval(`onReplyCompleteFromHook('r4-c', Date.now(), {lastAssistantMessage:'PERM_DONE'})`);
    assert.equal(stopC.stopHooksActive, true);
    const cStart = Date.now();
    assert.deepEqual(await watch('r4-c', 10000), ['running'], 'a hook that might still run is not cut short');
    await until(`getSessionRuntimeTruth(sessions.get('r4-c')).state==='completed'`, 'C stale frame resolves', 30000)
      .catch(async error => {
        report.cDebug = await c.eval(`(()=>{const s=sessions.get('r4-c');const t=getSessionRuntimeTruth(s);return {truth:t,hold:s._claudeStopHookHold,timer:!!s._claudeStopHookTimer,lastOutputTs:s._lastOutputTs,now:Date.now(),seq:s._ptyTurnSeq,frame:classifySessionRuntimeFrame(s,terminalActivityMonitor.extractLiveScreenLines('r4-c'))};})()`);
        throw error;
      });
    report.cResolveMs = Date.now() - cStart;
    assert.equal((await truth('r4-c')).source, 'claude-stop-hooks-stale-frame');
    report.checks.push(`C Stop→frame frozen on "running Stop hook", no output: completes after ${report.cResolveMs}ms (stale-frame bound)`);

    // E. Stop hook 真的一直在跑（状态行秒数每秒在变）超过 30 秒：不能被当成旧帧收掉；
    //    画面回到就绪后才收尾。
    await setup('r4-e');
    await c.eval(`onPromptSubmittedFromHook('r4-e', Date.now())`);
    const hookFrame = s => [...HEADER, `✶ Inferring… (running Stop hook · ${s}s · ↓ 594 tokens · thinking)`, '', '──────────', '❯ ', '──────────', '  ⏸ manual mode on · ← for agents'];
    await paint('r4-e', hookFrame(1));
    await away();
    assert.equal((await c.eval(`onReplyCompleteFromHook('r4-e', Date.now(), {})`)).stopHooksActive, true);
    const eSeen = new Set();
    for (let s = 2; s <= 36; s += 1) { await paint('r4-e', hookFrame(s)); eSeen.add((await truth('r4-e')).state); await sleep(1000); }
    assert.deepEqual([...eSeen], ['running'], 'a Stop hook that keeps running for 35s stays running: ' + [...eSeen]);
    await paint('r4-e', READY_FRAME);
    await until(`getSessionRuntimeTruth(sessions.get('r4-e')).state==='completed'`, 'E resolves after the hook finishes', 8000);
    assert.equal((await truth('r4-e')).source, 'claude-stop-hooks-finished');
    report.checks.push('E a Stop hook genuinely running for 35s (ticking status) stays running, then completes once the frame is ready');

    // D. 暂留期间用户开始新一轮：检查器立刻退场，不能把新一轮收掉。
    await setup('r4-d');
    await c.eval(`onPromptSubmittedFromHook('r4-d', Date.now())`);
    await paint('r4-d', STOP_HOOK_FRAME);
    await away();
    assert.equal((await c.eval(`onReplyCompleteFromHook('r4-d', Date.now(), {})`)).stopHooksActive, true);
    await sleep(600);
    await c.eval(`onPromptSubmittedFromHook('r4-d', Date.now())`);
    // 新一轮刚开始、还没画出运行标记的中间帧（没有底栏，分类为 ambiguous）。旧检查器若还在，
    // 两次「非运行」就会把它收掉；就绪出口不会被这种帧触发，所以这里只检验检查器本身。
    await paint('r4-d', ['❯ 下一个问题', '', '● 我先看一下']);
    const d = await truth('r4-d');
    assert.equal(d.hold, false, 'a new turn boundary releases the hold');
    const seenD = await watch('r4-d', 4000);
    report.dSeen = seenD;
    assert.ok(seenD.length && seenD.every(s => s === 'starting' || s === 'running'),
      'the new turn stays active (starting/running), never closed by the old hold: ' + seenD);
    report.checks.push('D a new prompt during the hold releases it; the new turn keeps running');

    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'sidebar.png'), Buffer.from(shot.data, 'base64'));
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error).slice(0, 2000);
    process.exitCode = 1;
  } finally {
    try { if (hub) await gracefulQuit(hub, { timeoutMs: 60000 }); } catch (e) { report.quitError = e.message; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main();
