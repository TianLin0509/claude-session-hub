'use strict';
// 2026-10-07：Claude 答完一段话后，后台还有 Shell / Monitor 在跑，会话应留在「活跃」；
// 新回复照常算未读、点开就清。真实 renderer + 真实侧栏，经 hook-event 与
// turn-complete-event 两条真实入口重放 Claude Code 2.1.292 实测到的事件顺序
// （Stop 带 background_tasks、注入的 <task-notification> 也发 UserPromptSubmit）。
// 不启动 CLI、不调用模型。用法：node tests/e2e-claude-background-active-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const SHELL = { id: 'bx1', type: 'shell', status: 'running', description: 'build watcher', command: 'npm run watch' };
const MONITOR = { id: 'bm2', type: 'shell', status: 'running', description: 'tick watcher', command: 'for i in 1 2 3; do echo tick; done' };
const NOTICE = '<task-notification>\n<task-id>bm2</task-id>\n<summary>Monitor event: "tick watcher"</summary>\n<event>tick 1</event>\n</task-notification>';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bg-active-'));
  const out = path.resolve('artifacts/cli-pty-core/background-active-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { out, checks: [], passed: false };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'background active',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    const until = async (expr, label, ms = 15000) => { const end = Date.now() + ms;
      while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
    await until('!!window.__hubE2E && typeof getSessionRuntimeTruth==="function"', 'renderer');
    await c.eval(`window.__hubE2E.clearSessions()`);
    await c.eval(`window.__hubE2E.addFakeSession({id:'bg-other',kind:'powershell',status:'idle',title:'other'})`);

    const setup = async id => {
      await c.eval(`window.__hubE2E.addFakeSession(${j({ id, kind: 'claude', agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null, status: 'idle', title: id })})`);
      await c.eval(`window.__hubE2E.selectSession('bg-other')`);
    };
    const hook = (id, body) => c.eval(`ipcRenderer.emit('hook-event', {}, ${j({ sessionId: id, eventAt: Date.now(), ...body })})`);
    const prompt = (id, text) => hook(id, { event: 'prompt', latestUserMessage: text });
    const injected = id => hook(id, { event: 'prompt', injectedContinuation: true });
    const stop = (id, message, tasks) => hook(id, { event: 'stop', lastAssistantMessage: message, backgroundTasks: tasks, sessionCrons: [] });
    const transcriptDone = (id, text) => c.eval(`ipcRenderer.emit('turn-complete-event', {}, ${j({ hubSessionId: id, kind: 'claude', text, completedAt: Date.now() })})`);
    // 侧栏真实 DOM：会话行所在分组、是否带未读与运行样式。
    const view = id => c.eval(`(()=>{renderSessionList();
      const s=sessions.get(${j(id)}); const t=getSessionRuntimeTruth(s);
      const row=document.querySelector('.session-item[data-session-id=${j(id)}]');
      let h=row&&row.previousElementSibling; while(h&&!h.classList.contains('session-sec-header')) h=h.previousElementSibling;
      return {state:t.state,source:t.source,unread:s.unreadCount||0,
        section:h?[...h.classList].find(x=>x.startsWith('sec-'))||'':'',
        rowUnread:!!row&&row.classList.contains('need-unread'), rowRunning:!!row&&row.classList.contains('running'),
        preview:s.lastOutputPreview||''};})()`);
    const settle = () => sleep(700); // turn-complete-event 的异步卡片补全与侧栏防抖

    // A. 实测顺序：Stop（带后台任务）→ transcript 终态。必须留在活跃，且算一条未读。
    await setup('bg-a');
    await prompt('bg-a', '开个后台 watcher 然后告诉我');
    await stop('bg-a', '已开始监听，有变化我再说', [SHELL]);
    await transcriptDone('bg-a', '已开始监听，有变化我再说');
    await settle();
    let a = await view('bg-a');
    report.a = a;
    assert.equal(a.state, 'running', 'transcript completion must not close a turn with live background tasks: ' + j(a));
    assert.equal(a.section, 'sec-active', 'row sits in 活跃');
    assert.equal(a.unread, 1, 'the reply is unread');
    assert.ok(a.rowUnread && a.rowRunning, 'row shows both unread and running');
    report.checks.push('A Stop(bg)→transcript: stays 活跃 + 1 unread');

    // B. 用户点开：未读清掉，仍是活跃。
    await c.eval(`window.__hubE2E.selectSession('bg-a')`);
    await settle();
    const b = await view('bg-a');
    report.b = b;
    assert.equal(b.unread, 0, 'opening clears unread');
    assert.equal(b.state, 'running', 'opening does not end background activity');
    assert.equal(b.section, 'sec-active');
    await c.eval(`window.__hubE2E.selectSession('bg-other')`);
    report.checks.push('B open → unread cleared, still 活跃');

    // C. 顺序反过来：transcript 终态先到，Stop 随后带来后台任务清单。
    await setup('bg-c');
    await prompt('bg-c', '另一个任务');
    await transcriptDone('bg-c', '前台说完了');
    await settle();
    await stop('bg-c', '前台说完了', [SHELL]);
    await settle();
    const cView = await view('bg-c');
    report.c = cView;
    assert.equal(cView.state, 'running', 'a later Stop with live tasks reopens activity: ' + j(cView));
    assert.equal(cView.section, 'sec-active');
    report.checks.push('C transcript→Stop(bg): back to 活跃');

    // D. Monitor 事件续跑：注入的 UserPromptSubmit 不是用户发言，不清未读、不改预览。
    await setup('bg-d');
    await prompt('bg-d', '盯着日志');
    await stop('bg-d', 'Monitor 已启动', [SHELL, MONITOR]);
    await transcriptDone('bg-d', 'Monitor 已启动');
    await settle();
    assert.equal((await view('bg-d')).unread, 1);
    await injected('bg-d');
    await settle();
    let d = await view('bg-d');
    report.dAfterInjected = d;
    assert.equal(d.unread, 1, 'injected continuation keeps the unread reply unread');
    assert.ok(['starting', 'running'].includes(d.state), 'continuation is active: ' + d.state);
    assert.ok(!/task-notification/.test(d.preview), 'preview never shows the injected notification');
    await stop('bg-d', 'Monitor event: tick 1', [SHELL, MONITOR]);
    await transcriptDone('bg-d', 'Monitor event: tick 1');
    await settle();
    d = await view('bg-d');
    report.dAfterTick = d;
    assert.equal(d.state, 'running');
    assert.equal(d.section, 'sec-active');
    assert.equal(d.unread, 2, 'the new card is another unread');
    report.checks.push('D Monitor continuation: unread kept and incremented, still 活跃');

    // E. 后台全部结束：最后一次 Stop 清单为空 → 离开活跃，未读保留。
    await injected('bg-d');
    await stop('bg-d', '全部完成', []);
    await transcriptDone('bg-d', '全部完成');
    await settle();
    const e = await view('bg-d');
    report.e = e;
    assert.equal(e.state, 'completed', 'no shells/monitors left → completed: ' + j(e));
    assert.notEqual(e.section, 'sec-active');
    assert.equal(e.unread, 3);
    assert.ok(e.rowUnread);
    report.checks.push('E all background work done → leaves 活跃, unread kept');

    // F. 真实用户发言仍会确认之前的未读（回归）；没有后台任务的普通一轮照常完成。
    await prompt('bg-d', '好的，下一步');
    await settle();
    assert.equal((await view('bg-d')).unread, 0, 'a real user prompt acknowledges unread');
    await stop('bg-d', '下一步完成', []);
    await transcriptDone('bg-d', '下一步完成');
    await settle();
    const f = await view('bg-d');
    report.f = f;
    assert.equal(f.state, 'completed');
    assert.equal(f.unread, 1);
    report.checks.push('F real prompt clears unread; plain turn completes as before');

    await c.eval(`renderSessionList()`);
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
