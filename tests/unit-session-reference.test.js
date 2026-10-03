'use strict';

// 「引用会话」：会话清单筛选、插入文本、md 新鲜度判断、IPC 的刷新/超时/失败路径，以及界面接线契约。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildReferenceText, kindLabel, mergeReferenceRows, referenceableMeetingRows, referenceableRows,
} = require('../core/session-reference.js');
const { groupReferencePath, mdIsCurrent, registerSessionReferenceIpc } = require('../main/ipc/session-reference-handlers.js');

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

  // ── 引用群聊（2026-10-03）
  const meetingRows = referenceableMeetingRows([
    { id: 'g-self', title: '本群', subSessions: ['a'], lastMessageTime: 500 },
    { id: 'g1', title: '投委会', subSessions: ['a', 'b', 'c'], lastMessageTime: 40 },
    { id: 'g1', title: '重复', lastMessageTime: 41 },
    { id: 'g2', title: '', createdAt: 5 },
    null,
  ], { excludeMeetingId: 'g-self' });
  assert.deepStrictEqual(meetingRows.map(r => r.id), ['meeting:g1', 'meeting:g2']);
  assert.strictEqual(meetingRows[0].meetingId, 'g1');
  assert.strictEqual(meetingRows[0].kind, 'meeting');
  assert.strictEqual(meetingRows[0].memberCount, 3);
  assert.strictEqual(meetingRows[1].lastMessageTime, 5);
  assert.deepStrictEqual(mergeReferenceRows([{ id: 's', lastMessageTime: 30 }], meetingRows).map(r => r.id),
    ['meeting:g1', 's', 'meeting:g2']);
  const groupText = buildReferenceText({ title: ' 投委\n会 ', kind: 'meeting', path: MD_A });
  assert.ok(groupText.startsWith(`【引用群聊】群聊「投委 会」的聊天记录：${MD_A}\n`), groupText);
  assert.ok(groupText.includes('不要重新执行'));
  assert.ok(buildReferenceText({ title: '', kind: 'meeting', path: 'p' }).includes('「未命名群聊」'));
  assert.strictEqual(kindLabel('meeting'), '群聊');

  const groupTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-reference-unit-'));
  try {
    const dataDir = path.join(groupTmp, 'data');
    const transcriptDir = path.join(dataDir, 'transcripts');
    fs.mkdirSync(path.join(dataDir, 'arena-prompts'), { recursive: true });
    const writeState = (id, messages) => fs.writeFileSync(
      path.join(dataDir, 'arena-prompts', `${id}-groupchat.json`),
      JSON.stringify({ meetingId: id, nextMessageSeq: messages.length + 1, messages }), 'utf8');
    writeState('g1', [
      { seq: 1, role: 'user', origin: 'user', content: '比较两种调度算法', createdAt: 1 },
      { seq: 2, role: 'assistant', sid: 'm1', speaker: 'Codex 1', content: '进度：在读代码', status: 'progress_update', createdAt: 2 },
      { seq: 3, role: 'assistant', sid: 'm1', speaker: 'Codex 1', content: 'PF 更公平，RR 更简单。', createdAt: 3 },
    ]);
    writeState('g-empty', [{ seq: 1, role: 'user', origin: 'hub', dispatch: {}, content: '派工卡片', createdAt: 1 }]);
    const legacyMd = path.join(groupTmp, 'legacy.md');
    fs.writeFileSync(legacyMd, '# 老会议室\n', 'utf8');
    const lookups = [];
    const groupIpc = fakeIpc();
    registerSessionReferenceIpc(groupIpc, {
      searchService: {
        transcriptFor: async (req) => {
          lookups.push(req);
          return req.key === 'meeting:g-legacy' ? { path: legacyMd, title: '老会议室', exists: true } : null;
        },
      },
      getSearchSnapshot: () => ({
        sessions: [{ hubId: 'a', kind: 'codex', title: 'A', lastMessageTime: 10 }],
        meetings: [{ id: 'g1', title: '投委会', subSessions: ['a'], lastMessageTime: 20 }, { id: 'g-here', title: '本群' }],
      }),
      getMeeting: id => (id === 'g1' ? { title: '投委会' } : null),
      getHubDataDir: () => dataDir,
      getTranscriptDir: () => transcriptDir,
      mdIsCurrent: () => true,
      logger: quietLogger,
    });
    const groupList = await groupIpc.handlers.get('session-reference:list')(null, { excludeMeetingId: 'g-here' });
    assert.deepStrictEqual(groupList.map(r => r.id), ['meeting:g1', 'a']);
    const groupResolve = groupIpc.handlers.get('session-reference:resolve');

    // 有群聊状态：现场生成到 transcripts 目录（Claude 已对该目录 --add-dir），内容是正式发言
    const resolved = await groupResolve(null, { meetingId: 'g1' });
    assert.deepStrictEqual(resolved, { ok: true, path: groupReferencePath(transcriptDir, 'g1'), title: '投委会', fresh: true });
    assert.strictEqual(path.dirname(resolved.path), transcriptDir);
    const md = fs.readFileSync(resolved.path, 'utf8');
    assert.ok(md.includes('# 群聊记录：投委会'), md);
    assert.ok(md.includes('比较两种调度算法') && md.includes('PF 更公平，RR 更简单。'));
    assert.ok(!md.includes('进度：在读代码'), 'progress updates are not part of the record');
    assert.deepStrictEqual(lookups, [], 'group state is authoritative; search index is not consulted');

    // 状态更新后再次引用：拿到的是新内容
    writeState('g1', [
      { seq: 1, role: 'user', origin: 'user', content: '比较两种调度算法', createdAt: 1 },
      { seq: 2, role: 'assistant', sid: 'm1', speaker: 'Codex 1', content: '补充：PF 吞吐更高。', createdAt: 4 },
    ]);
    await groupResolve(null, { meetingId: 'g1' });
    assert.ok(fs.readFileSync(resolved.path, 'utf8').includes('补充：PF 吞吐更高。'));

    // 只有 Hub 派工、没有真正发言：如实拒绝
    const empty = await groupResolve(null, { meetingId: 'g-empty' });
    assert.strictEqual(empty.ok, false);
    assert.ok(empty.message.includes('还没有发言'), empty.message);

    // 没有群聊状态的老式会议室：退回搜索索引的会议记录
    const legacy = await groupResolve(null, { meetingId: 'g-legacy' });
    assert.deepStrictEqual(legacy, { ok: true, path: legacyMd, title: '老会议室', fresh: true });
    assert.deepStrictEqual(lookups.splice(0), [{ key: 'meeting:g-legacy' }]);

    const missing = await groupResolve(null, { meetingId: 'g-none' });
    assert.strictEqual(missing.error, 'transcript-missing');
    assert.strictEqual((await groupResolve(null, { meetingId: '../evil' })).error, 'bad-meeting');
  } finally {
    fs.rmSync(groupTmp, { recursive: true, force: true });
  }
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
  // 群聊行按 meetingId 解析；群聊输入框里打开时排除本群
  assert.match(fnBody, /row\.kind === 'meeting'\s*\n?\s*\? \{ meetingId: row\.meetingId \}/);
  assert.match(fnBody, /excludeMeetingId: options\.excludeMeetingId/);
  assert.match(readSource('renderer', 'group-composer-tools.js'), /excludeMeetingId: meeting\.id/);
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
  // 2026-09-25 起默认是 PTY：PTY 启动与 PTY 内重启（relaunchCli）也必须带上 --add-dir。
  assert.match(sessionManager, /const addDirFlag = claudeNativeAddDirs\(\[\]\)[\s\S]{0,200}\$\{addDirFlag\}/);
  const previousDataDir = process.env.CLAUDE_HUB_DATA_DIR;
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ref-pty-launch-'));
  process.env.CLAUDE_HUB_DATA_DIR = isolatedDataDir;
  try {
    const { _private } = require('../core/session-manager.js');
    const launch = _private.buildClaudePtyLaunch('hub-ref-unit', 'claude',
      { model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', addDirs: [path.join(isolatedDataDir, 'transcripts')] },
      isolatedDataDir, {}, {});
    const addDirs = launch.cmd.split(' --add-dir ').length - 1;
    assert.ok(launch.cmd.includes(`--add-dir ${path.join(isolatedDataDir, 'transcripts')}`), launch.cmd);
    assert.strictEqual(addDirs, 1, 'a persisted transcripts --add-dir must not be duplicated on resume');
  } finally {
    if (previousDataDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previousDataDir;
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }

  console.log('unit-session-reference: all passed');
}

main().catch(error => { console.error(error); process.exit(1); });
