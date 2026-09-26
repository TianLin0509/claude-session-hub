'use strict';
// 返工 R5：hook 子进程乱序完成。一轮被中断 / 结束之后迟到的 PreToolUse、SubagentStart、
// 提问工具 PostToolUse、PermissionRequest 不能把它重新打开；真正的新一轮（UserPromptSubmit）
// 之后的同类事件照常生效。事件直接交给 renderer 自己的 IPC 监听器（ipcRenderer.emit），
// 走的是生产处理路径。不启动 CLI、不调用模型。
// 用法：node tests/e2e-pty-late-hook-events-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-late-hooks-'));
  const out = path.resolve('artifacts/cli-pty-core/late-hook-events-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { out, checks: [], passed: false };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'late hook events',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    const until = async (expr, label, ms = 15000) => { const end = Date.now() + ms;
      while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
    await until('!!window.__hubE2E && typeof getSessionRuntimeTruth==="function"', 'renderer');
    await c.eval(`window.__hubE2E.clearSessions()`);
    const add = (id, kind) => c.eval(`window.__hubE2E.addFakeSession(${j({ id, kind, agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null, status: 'idle', title: id })})`);
    const hook = (sid, event, extra = {}) => c.eval(`ipcRenderer.emit('hook-event', {}, Object.assign(${j({ sessionId: sid, event, ...extra })}, {eventAt: Date.now()}))`);
    const abort = (sid, kind) => c.eval(`ipcRenderer.emit('turn-aborted-event', {}, {hubSessionId:${j(sid)},kind:${j(kind)},abortedAt:Date.now(),turnId:'turn-1'})`);
    const truth = sid => c.eval(`(()=>{const s=sessions.get(${j(sid)});const t=getSessionRuntimeTruth(s);return {state:t.state,source:t.source,confidence:t.confidence,detail:t.evidence||null};})()`);
    const watch = async (sid, ms) => { const seen = new Set(); const end = Date.now() + ms;
      while (Date.now() < end) { seen.add((await truth(sid)).state); await sleep(150); } return [...seen]; };
    const bash = { toolName: 'Bash', toolInput: { command: 'powershell -NoProfile -Command Start-Sleep 60' } };

    // F. 审查现场：Codex 在长工具里被 Esc 中断，之后迟到的 tool-start、旧工具的 tool-complete 依次到达。
    await add('late-codex', 'codex');
    await hook('late-codex', 'prompt', { provider: 'codex', latestUserMessage: '跑一个 60 秒的命令' });
    await hook('late-codex', 'tool-start', { provider: 'codex', toolCallId: 'call-1', ...bash });
    assert.equal((await truth('late-codex')).state, 'running');
    await abort('late-codex', 'codex');
    assert.equal((await truth('late-codex')).state, 'idle', 'abort closes the turn');
    await hook('late-codex', 'tool-start', { provider: 'codex', toolCallId: 'call-1', ...bash });
    await hook('late-codex', 'tool-complete', { provider: 'codex', toolCallId: 'call-1', toolName: 'Bash', toolResult: 'exit 0' });
    const seenF = await watch('late-codex', 5000);
    assert.deepEqual(seenF, ['idle'], 'late tool events never reopen an interrupted Codex turn: ' + seenF);
    report.checks.push('F Codex abort → late tool-start + old tool-complete: stays idle (interrupted) for 5s');
    // 新一轮：UserPromptSubmit 之后的同类事件照常生效。
    await hook('late-codex', 'prompt', { provider: 'codex', latestUserMessage: '再来一次' });
    await hook('late-codex', 'tool-start', { provider: 'codex', toolCallId: 'call-2', toolName: 'Bash', toolInput: { command: 'echo NEXT' } });
    const nextF = await truth('late-codex');
    assert.equal(nextF.state, 'running', 'a real new turn is not blocked');
    assert.equal(nextF.source, 'claude-tool-start');
    report.checks.push('F′ after a new UserPromptSubmit, tool-start drives running again');

    // G. Claude 中断：迟到的子代理开始、权限请求、提问工具答完，全都不能改动关闭态。
    await add('late-claude', 'claude');
    await hook('late-claude', 'prompt', { latestUserMessage: '问我一个问题' });
    await hook('late-claude', 'tool-start', { toolCallId: 't1', ...bash });
    await abort('late-claude', 'claude');
    assert.equal((await truth('late-claude')).state, 'idle');
    await hook('late-claude', 'subagent-start', { agentId: 'sub-1', agentType: 'Explore' });
    await hook('late-claude', 'permission-request', { toolName: 'Bash' });
    await hook('late-claude', 'tool-complete', { toolCallId: 'q1', toolName: 'AskUserQuestion', toolResult: 'A' });
    const seenG = await watch('late-claude', 4000);
    assert.deepEqual(seenG, ['idle'], 'late subagent-start / permission-request / question answer keep the interrupted turn closed: ' + seenG);
    report.checks.push('G Claude interrupt → late subagent-start, permission-request, AskUserQuestion complete: stays idle');
    // 新一轮里的权限请求照常显示等待。
    await hook('late-claude', 'prompt', { latestUserMessage: '运行命令' });
    await hook('late-claude', 'tool-start', { toolCallId: 't2', ...bash });
    await hook('late-claude', 'permission-request', { toolName: 'Bash' });
    assert.equal((await truth('late-claude')).state, 'waiting', 'a real permission request in a new turn still shows waiting');
    report.checks.push('G′ a permission request in a new turn still shows waiting');

    // H. 已完成的一轮（回归既有保护）：迟到的 tool-start 不复活。
    await add('late-done', 'claude');
    await hook('late-done', 'prompt', { latestUserMessage: 'hi' });
    await hook('late-done', 'stop', { lastAssistantMessage: 'DONE' });
    assert.equal((await truth('late-done')).state, 'completed');
    await hook('late-done', 'tool-start', { toolCallId: 'late', ...bash });
    assert.deepEqual(await watch('late-done', 3000), ['completed']);
    report.checks.push('H completed turn → late tool-start: stays completed');

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
