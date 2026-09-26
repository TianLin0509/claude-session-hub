'use strict';

// 「引用会话」：会话清单筛选、插入文本、md 新鲜度判断、IPC 的刷新/超时/失败路径，以及界面接线契约。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReferenceText, kindLabel, referenceableRows } = require('../core/session-reference.js');
const { mdIsCurrent, registerSessionReferenceIpc } = require('../main/ipc/session-reference-handlers.js');

function fakeIpc() {
  return { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
}
const quietLogger = { warn() {} };
const MD_A = path.join('C:', 'hub', 'transcripts', 'a.md');
const MD_NEW = path.join('C:', 'hub', 'transcripts', 'new.md');

async function main() {
  // ── 清单：排除自己、shell、隐藏会话；休眠会话保留；去重；按时间倒序；带群聊名
  const rows = referenceableRows([
    { hubId: 'self', kind: 'claude', title: '当前', lastMessageTime: 999 },
    { hubId: 'old', kind: 'codex', title: '旧的', lastMessageTime: 10, status: 'dormant' },
    { id: 'new', kind: 'claude', title: '新的', lastMessageTime: 50, meetingId: 'm1' },
    { hubId: 'new', kind: 'claude', title: '重复', lastMessageTime: 60 },
    { hubId: 'ps', kind: 'powershell', title: 'PowerShell', lastMessageTime: 70 },
    { hubId: 'hidden', kind: 'codex', hiddenFromSidebar: true, lastMessageTime: 80 },
    { hubId: 'research', kind: 'codex', purpose: 'chuxin-research', lastMessageTime: 90 },
    null,
  ], { excludeId: 'self', meetingTitleOf: id => (id === 'm1' ? '投委会' : null) });
  assert.deepStrictEqual(rows.map(r => r.id), ['new', 'old']);
  assert.strictEqual(rows[0].meetingTitle, '投委会');
  assert.strictEqual(rows[1].meetingTitle, null);
  assert.deepStrictEqual(referenceableRows(undefined), []);

  // ── 插入文本：带来源 CLI、标题、路径，并声明旧指令不重新执行
  const text = buildReferenceText({ title: '  调度\n算法  ', kind: 'codex-resume', path: MD_A });
  assert.ok(text.startsWith(`【引用会话】Codex 会话「调度 算法」的聊天记录：${MD_A}\n`), text);
  assert.ok(text.includes('不要重新执行'));
  assert.ok(buildReferenceText({ title: '', kind: 'x', path: 'p' }).includes('「未命名会话」'));
  assert.strictEqual(kindLabel('claude-resume'), 'Claude');
  assert.strictEqual(kindLabel(''), 'AI');

  // ── mdIsCurrent：按 md 头部「原始记录」比较修改时间
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-reference-unit-'));
  try {
    const native = path.join(tmp, 'native.jsonl');
    const md = path.join(tmp, 'a.md');
    fs.writeFileSync(native, '{}\n');
    fs.writeFileSync(md, ['# t', '', '- 来源：codex', `- 原始记录：${native}`, '', '## 我', '', 'hi', ''].join('\n'));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(native, past, past);
    assert.strictEqual(mdIsCurrent(md), true, 'md newer than native record is current');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(native, future, future);
    assert.strictEqual(mdIsCurrent(md), false, 'native record written after md means stale');
    const noHeader = path.join(tmp, 'b.md');
    fs.writeFileSync(noHeader, ['# 群聊', '', '## 我', '', 'hi', ''].join('\n'));
    assert.strictEqual(mdIsCurrent(noHeader), false, 'unknown source is never assumed current');
    assert.strictEqual(mdIsCurrent(path.join(tmp, 'missing.md')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── IPC
  const calls = [];
  const snapshot = { sessions: [{ hubId: 'a', kind: 'codex', title: 'A' }, { hubId: 'b', kind: 'claude', title: 'B' }] };
  let transcript = { path: MD_A, title: 'A', exists: true };
  let current = true;
  let refreshImpl = async () => ({ phase: 'ready' });
  const service = {
    refresh: (snap, opts) => { calls.push(['refresh', snap === snapshot, opts.immediate]); return refreshImpl(); },
    transcriptFor: async (req) => { calls.push(['transcriptFor', req.hubSessionId]); return transcript; },
  };
  const ipc = fakeIpc();
  registerSessionReferenceIpc(ipc, {
    searchService: service,
    getSearchSnapshot: () => snapshot,
    getMeeting: () => null,
    mdIsCurrent: () => current,
    refreshTimeoutMs: 50,
    logger: quietLogger,
  });
  const list = ipc.handlers.get('session-reference:list');
  const resolve = ipc.handlers.get('session-reference:resolve');
  assert.deepStrictEqual((await list(null, { excludeSessionId: 'b' })).map(r => r.id), ['a']);

  // md 已是最新：不刷新，零等待
  let result = await resolve(null, { sessionId: 'a' });
  assert.deepStrictEqual(result, { ok: true, path: MD_A, title: 'A', fresh: true });
  assert.deepStrictEqual(calls.splice(0), [['transcriptFor', 'a']]);

  // md 落后于原始记录：刷新一次再取
  current = false;
  result = await resolve(null, { sessionId: 'a' });
  assert.strictEqual(result.fresh, true);
  assert.deepStrictEqual(calls.splice(0), [['transcriptFor', 'a'], ['refresh', true, true], ['transcriptFor', 'a']]);

  // 刷新超时：仍给出已有 md，但 fresh=false 让界面如实提示
  refreshImpl = () => new Promise(() => {});
  const startedAt = Date.now();
  result = await resolve(null, { sessionId: 'a' });
  assert.ok(Date.now() - startedAt < 1000, 'timeout must bound the wait');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.fresh, false);

  // 刷新报错（含同步抛出）：同样降为 fresh=false，不吞掉已有 md
  refreshImpl = () => { throw new Error('boom'); };
  result = await resolve(null, { sessionId: 'a' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.fresh, false);

  // md 起初不存在、刷新后生成：成功
  refreshImpl = async () => { transcript = { path: MD_NEW, title: 'A', exists: true }; return {}; };
  transcript = null;
  result = await resolve(null, { sessionId: 'a' });
  assert.deepStrictEqual(result, { ok: true, path: MD_NEW, title: 'A', fresh: true });

  // 刷新后仍没有 md：失败必须带可读原因
  refreshImpl = async () => ({ phase: 'ready' });
  transcript = { path: MD_A, exists: false };
  result = await resolve(null, { sessionId: 'a' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'transcript-missing');
  assert.ok(result.message.includes('至少要完成一轮对话'));

  // 查询本身失败：如实报错
  service.transcriptFor = async () => { throw new Error('child down'); };
  result = await resolve(null, { sessionId: 'a' });
  assert.strictEqual(result.error, 'transcript-lookup-failed');
  assert.ok(result.message.includes('child down'));

  assert.strictEqual((await resolve(null, {})).error, 'missing-session');
  const bare = fakeIpc();
  registerSessionReferenceIpc(bare, { logger: quietLogger });
  assert.strictEqual((await bare.handlers.get('session-reference:resolve')(null, { sessionId: 'a' })).error, 'search-unavailable');

  // ── 界面接线契约：按钮在「分支」之后、只填输入框不发送、失败可见
  // 生产检出是 CRLF（autocrlf），worktree 是 LF：源码统一成 LF 再做文本断言。
  const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
  const renderer = readSource('renderer', 'renderer.js');
  assert.match(renderer, /referenceBtn\.className = 'fi-bridge-reference'/);
  assert.match(renderer, /referenceBtn\.textContent = '引用会话'/);
  assert.ok(renderer.indexOf('bridgeToolbar.appendChild(referenceBtn)') > renderer.indexOf('bridgeToolbar.appendChild(branchBtn)'));
  const fnStart = renderer.indexOf('async function referenceSessionIntoInput(');
  assert.ok(fnStart > 0, 'referenceSessionIntoInput must exist');
  const fnEnd = renderer.indexOf('\n}\n', fnStart);
  assert.ok(fnEnd > fnStart, 'referenceSessionIntoInput body end not found');
  const fnBody = renderer.slice(fnStart, fnEnd);
  assert.ok(!/send-prompt|terminal-input|sendBtn\.click/.test(fnBody), 'reference must never auto-send');
  assert.ok(!/showToast\(/.test(fnBody), 'showToast is not defined in renderer; failures must use showHubAlert');
  assert.match(fnBody, /showHubAlert/);
  const mainSource = readSource('main.js');
  assert.match(mainSource, /registerSessionReferenceIpc\(ipcMain, \{/);
  // 被引用的 md 在工作目录之外：Claude 默认权限模式下必须把它加进 --add-dir，否则每次引用都弹 Read 审批
  // （2026-09-26 真实 haiku 实测，见 tests/e2e-session-reference-real-cli-cdp.js）。索引写的目录与加进去的必须是同一个。
  assert.match(mainSource, /transcriptDir: require\('\.\/core\/data-dir'\)\.getHubTranscriptDir\(\)/);
  const sessionManager = readSource('core', 'session-manager.js');
  assert.match(sessionManager, /addDirs: claudeNativeAddDirs\(opts\.addDirs\)/);
  assert.match(sessionManager, /function claudeNativeAddDirs[\s\S]{0,400}getHubTranscriptDir\(\)/);
  const { getHubTranscriptDir, getHubDataDir } = require('../core/data-dir.js');
  assert.strictEqual(getHubTranscriptDir(), path.join(getHubDataDir(), 'transcripts'));

  console.log('unit-session-reference: all passed');
}

main().catch(error => { console.error(error); process.exit(1); });
