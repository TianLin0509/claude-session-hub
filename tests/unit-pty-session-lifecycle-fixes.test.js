'use strict';
// 2026-09-26 PTY 深潜在隔离 Hub + 真实 CLI 上逼出的三个生命周期缺陷的回归。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ① 原生时代的会话在 PTY 里恢复后，落盘仍是 codex-app-server / claude-stream-json + 原生快照。
test('PTY sessions do not inherit native backend or snapshot from their native-era record', () => {
  const { mergeResumeMetaFields } = require('../main/ipc/persistence-handlers');
  const old = { hubId: 'h', runtimeBackend: 'codex-app-server', nativeRuntime: { state: 'completed', reason: 'Hub 已重新启动，等待核对 Codex 会话' },
    nativeConfig: { a: 1 }, codexSid: 'sid-1', transcriptPath: 'C:/r.jsonl' };
  const [pty] = mergeResumeMetaFields([{ hubId: 'h', agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null, codexSid: null }], [old]);
  assert.equal(pty.runtimeBackend, null);
  assert.equal(pty.nativeRuntime, null);
  assert.equal(pty.nativeConfig, undefined);
  assert.equal(pty.codexSid, 'sid-1', 'ordinary resume identity is still inherited');
  assert.equal(pty.transcriptPath, 'C:/r.jsonl');
  const [nat] = mergeResumeMetaFields([{ hubId: 'h', runtimeBackend: null, nativeRuntime: null }], [old]);
  assert.equal(nat.runtimeBackend, 'codex-app-server', 'non-PTY records keep the old inheritance');
});

test('session files keep the PTY marker so a dormant record is never mistaken for native', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-marker-'));
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; fs.rmSync(dir, { recursive: true, force: true }); });
  const store = require('../core/session-store');
  store.saveSessionFile('pty-1', { kind: 'codex', agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null });
  store.saveSessionFile('nat-1', { kind: 'codex', runtimeBackend: 'codex-app-server' });
  assert.equal(store.loadSessionFile('pty-1').agentRuntime, 'pty');
  assert.equal(store.loadSessionFile('nat-1').agentRuntime, null);
  const { isCodexSession } = require('../core/codex-native-runtime');
  assert.equal(isCodexSession(store.loadSessionFile('pty-1')), false);
  // 渲染层的持久化白名单必须带上这个标记，否则主进程拿不到它。
  assert.match(read('renderer/renderer.js'), /agentRuntime: s\.agentRuntime === 'pty' \? 'pty' : null,/);
});

// ② PTY 会话「重启」：以前 close 后立刻 resume，撞上归属检查失败，旧进程退出后会话连卡片带记录被抹掉。
test('waitForSessionGone resolves once the old PTY has been reaped, or reports a timeout', async () => {
  const { waitForSessionGone } = require('../main/ipc/session-handlers');
  let live = true;
  setTimeout(() => { live = false; }, 60);
  assert.equal(await waitForSessionGone({ getSession: () => (live ? {} : null) }, 's', { timeoutMs: 1000, intervalMs: 10 }), true);
  assert.equal(await waitForSessionGone({ getSession: () => ({}) }, 's', { timeoutMs: 60, intervalMs: 10 }), false);
});

test('restart of a recoverable session suspends and waits for reaping before resuming', () => {
  const src = read('main/ipc/session-handlers.js');
  const start = src.indexOf("ipcMain.handle('restart-session'");
  const block = src.slice(start, src.indexOf('// PowerShell has no provider-native thread.', start));
  const suspendAt = block.indexOf("sessionManager.suspendSession(sessionId, { reason: 'restart' })");
  const waitAt = block.indexOf('waitForSessionGone(sessionManager, sessionId)');
  const resumeAt = block.indexOf('resumeSession(resumeMeta)');
  assert.ok(suspendAt > 0 && waitAt > suspendAt && resumeAt > waitAt, 'suspend → wait → resume');
  assert.doesNotMatch(block.slice(block.indexOf('if (supportsRecoverableSession(old))')), /sessionManager\.closeSession\(sessionId\)/,
    'a close would emit a requested session-closed and erase the card');
});

// ③ Codex「分支」：分支会话预先带上源会话的记录路径，被绑到源 rollout、登记源线程 id，
// 新线程的 hook 全被当成外来会话丢弃，提交一直「未确认」。
test('PTY Codex fork does not start out bound to the source rollout', () => {
  const src = read('core/session-manager.js');
  assert.match(src, /const ptyCodexForkLaunch = !!opts\.codexForkSid && !isNativeCodex;/);
  assert.match(src, /\.\.\.\(opts\.resumeTranscriptPath && !ptyCodexForkLaunch \? \{ transcriptPath: opts\.resumeTranscriptPath \} : \{\}\),/);
  // 原生 thread/fork 仍然拿到源路径作为参数。
  assert.match(src, /resumePath:opts\.resumeTranscriptPath \|\| null,/);
});
