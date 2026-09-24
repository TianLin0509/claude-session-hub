'use strict';
// 连上之后自动核对上一轮 —— 这条路存在的理由是 2026-09-22 的实测：
// 一个 20.1 MB 的会话每次打开都在 2388 ms 内 initialize 完成，却因为 9/20 17:04
// 那一轮被打断、留下一条 status=running 的提交，永远停在 unknown，界面只念
// 「等待连接响应」，而且只有用户亲手发一条消息才会解开。
// Codex 有 thread/read 可以直接问 App Server，stream-json 没有，所以只能读原生
// transcript —— 那是 Hub 手上唯一的证据。这里守住它的四条边界：
//   1. 自动核对只登记「不重发」，绝不把旧任务改写成成功，也绝不重发旧消息；
//   2. 群聊 / 无人值守席位保留人工关卡，不自动核对；
//   3. 那些席位有一条手动出路（reconcileFromHistory），和自动走同一条代码；
//   4. 核对失败必须看得见：状态留在待核对，并且发出 action-error。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClaudeNativeSession, contentBlocks, digest } = require('../core/claude-native-session');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');

const fixture = path.join(__dirname, 'fixtures/claude-stream.js');
const SID = '11111111-2222-4333-8444-555555555555';
const UMID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

// 被打断的那一轮长什么样：日志里一条非终态、没有核对记录的提交。
function interrupted() {
  const content = contentBlocks('上一轮被打断的输入');
  return { content, record: { submissionId: 'old', userMessageId: UMID, providerSessionId: SID,
    promptFingerprint: digest(content), content, status: 'running', accepted: true } };
}

function restored(directory, extra = {}) {
  const { content, record } = interrupted();
  const session = new ClaudeNativeSession({ id: 'hub', kind: 'claude', cwd: __dirname,
    executable: process.execPath, commandArgs: [fixture, '--fixture=hold'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, homeDir: directory,
    sessionId: SID, resumeSessionId: SID,
    restoredRuntime: { state: 'running', connection: 'connected', epoch: 3, ownerPid: process.pid },
    restoredRecords: [record], ...extra });
  return { session, content };
}

// 原生历史里确实有这条输入 —— 这就是「不要重发」的全部证据。
function writeHistory(directory, content, body) {
  const bucket = path.join(directory, 'projects', 'fixture');
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, SID + '.jsonl');
  fs.writeFileSync(file, body !== undefined ? body
    : JSON.stringify({ type: 'user', uuid: UMID, sessionId: SID, message: { content } }) + '\n');
  return file;
}

test('连上就自动核对被打断的那一轮，不重发也不当成成功', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-'));
  const { session, content } = restored(directory);
  t.after(() => session.close());
  writeHistory(directory, content);
  const lifecycles = [];
  session.on('lifecycle', event => lifecycles.push(event.type));
  await session.start();

  assert.equal(session.unreconciled, false, '连上之后不该再挂着「待核对」');
  assert.equal(session.runtime.state, 'idle');
  assert.equal(session.runtime.reason, '已核对旧提交，不会自动重发');
  const record = session.records.get('old');
  // 只登记「不重发」，状态仍然是 unknown —— 读到历史不等于那一轮成功了。
  assert.equal(record.status, 'unknown');
  assert.equal(record.reconciliation.resolution, 'do-not-replay');
  assert.equal(record.reconciliation.source, 'hub');
  assert.equal(record.reconciliation.history, 'received');
  assert.equal(session.recoveryRecords().length, 0);
  // 绝不能替用户把旧消息再发一遍。
  assert.equal(session.active, null);
  assert.equal(lifecycles.includes('submission-accepted'), false);
  assert.equal(lifecycles.includes('agent-turn-complete'), false);
  assert.ok(lifecycles.includes('submission-reconciled'), JSON.stringify(lifecycles));
  // 核对完就能正常收新消息。
  assert.equal((await session.submit('新的一条', { submissionId: 'next' })).sendStatus, 'accepted');
});

test('历史里没有这条输入也照样解锁，但证据必须记成 not-found', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-miss-'));
  const { session, content } = restored(directory);
  t.after(() => session.close());
  // 同一个会话的历史存在，但里面没有那条 user 消息。
  writeHistory(directory, content, JSON.stringify({ type: 'summary', summary: 'x' }) + '\n');
  await session.start();
  assert.equal(session.unreconciled, false);
  assert.equal(session.records.get('old').reconciliation.history, 'not-found');
  assert.equal(session.records.get('old').status, 'unknown');
});

test('群聊与无人值守席位保留人工关卡，但有一条手动出路', async t => {
  for (const seat of [{ meetingId: 'm1' }, { autonomous: true }]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-seat-'));
    const { session, content } = restored(directory, seat);
    t.after(() => session.close());
    writeHistory(directory, content);
    await session.start();
    // 自动核对会把「停下来等人看一眼」变成「自动继续派发」，那是另一件事。
    assert.equal(session.unreconciled, true, JSON.stringify(seat));
    assert.equal(session.runtime.state, 'unknown');
    // 手点「核对上次任务」走同一条代码，只是 source 记成 user。
    const result = await session.reconcileFromHistory({ source: 'user' });
    assert.equal(result.reconciled, 1);
    assert.equal(session.unreconciled, false);
    assert.equal(session.records.get('old').reconciliation.source, 'user');
    assert.equal(session.records.get('old').reconciliation.history, 'received');
  }
});

test('自动核对失败不许静默：状态留在待核对并且报出来', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-fail-'));
  const { session, content } = restored(directory);
  t.after(() => session.close());
  writeHistory(directory, content, '{broken\n');
  const errors = [];
  session.on('action-error', message => errors.push(message));
  await session.start();
  assert.equal(session.runtime.connection, 'connected', '核对失败不该把连接一起拖下水');
  assert.equal(session.unreconciled, true);
  assert.equal(session.runtime.state, 'unknown');
  assert.ok(errors.some(m => /自动核对未完成/.test(m)), JSON.stringify(errors));
  // 仍然拒绝发送，不会悄悄放行。
  await assert.rejects(session.submit('不许发出去'), /reconciliation|核对/);
});

test('历史里是别人的消息就拒绝核对，绝不当成同一条', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-mismatch-'));
  const { session } = restored(directory);
  t.after(() => session.close());
  writeHistory(directory, null, JSON.stringify({ type: 'user', uuid: UMID, sessionId: SID,
    message: { content: contentBlocks('这不是当初那条输入') } }) + '\n');
  const errors = [];
  session.on('action-error', message => errors.push(message));
  await session.start();
  assert.equal(session.unreconciled, true);
  assert.ok(errors.some(m => /身份不一致/.test(m)), JSON.stringify(errors));
});

test('找不到原生历史时也自动登记不重发，不再停下来等人点按钮', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-nohistory-'));
  const { session } = restored(directory);
  t.after(() => session.close());
  // 一个字节的历史都没有。2026-09-24 以前这里停在「待核对」等人点按钮，但按钮能做的
  // 也只是同一个登记；用户决定不要再弹这个提示。旧 writer 已确认退出，旧提交不可能还在跑。
  await session.start();
  assert.equal(session.unreconciled, false);
  assert.equal(session.runtime.state, 'idle');
  const old = session.records.get('old');
  assert.equal(old.status, 'unknown', '不追认成功');
  assert.equal(old.reconciliation.history, 'history-missing', '零证据如实记下');
  assert.equal(old.reconciliation.source, 'hub');
});

test('日志里没有待核对记录、只有一个持久化的运行态时，连上就回到空闲', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-empty-'));
  const session = new ClaudeNativeSession({ id: 'hub', kind: 'claude', cwd: __dirname,
    executable: process.execPath, commandArgs: [fixture, '--fixture=hold'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, homeDir: directory,
    sessionId: SID, resumeSessionId: SID,
    restoredRuntime: { state: 'running', connection: 'connected', epoch: 2, ownerPid: process.pid } });
  t.after(() => session.close());
  assert.equal(session.unreconciled, true, '持久化的非终态状态本身就算待核对');
  await session.start();
  // 没有任何一条记录可核对：没有东西要人看，直接空闲。
  assert.equal(session.unreconciled, false);
  assert.equal(session.runtime.state, 'idle');
});

test('后台活动的结局 transcript 证明不了：记为未知，但不再要人核对', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-activity-'));
  const { content, record } = interrupted();
  const activity = { userMessageId: '12341234-1234-4234-8234-123412341234', nativeActivity: true,
    origin: { kind: 'task-notification' }, status: 'running', content: '' };
  const session = new ClaudeNativeSession({ id: 'hub', kind: 'claude', cwd: __dirname,
    executable: process.execPath, commandArgs: [fixture, '--fixture=hold'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, homeDir: directory,
    sessionId: SID, resumeSessionId: SID,
    restoredRuntime: { state: 'running', connection: 'connected', epoch: 3, ownerPid: process.pid },
    restoredRecords: [record], restoredActivities: [activity] });
  t.after(() => session.close());
  writeHistory(directory, content);
  await session.start();
  // 提交按证据核对；后台活动是引擎自己的续跑，结局证明不了，但也不需要人核对：
  // 记 unknown + engine-internal，不编造成功，也不挡住会话。
  assert.equal(session.records.get('old').reconciliation.history, 'received');
  const saved = session.activities.records.get(activity.userMessageId);
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.reconciliation.history, 'engine-internal');
  assert.equal(session.unreconciled, false);
  assert.equal(session.runtime.state, 'idle');
  assert.equal(session.recoveryRecords().length, 0);
});

test('输入框上那个按钮真的走到核对，失败也如实报回去', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reconcile-ipc-'));
  const { session, content } = restored(directory, { meetingId: 'm1' });
  t.after(() => session.close());
  writeHistory(directory, content);
  await session.start();
  assert.equal(session.unreconciled, true, '群聊席位不自动核对，按钮才是它的出路');

  const ipc = new Map();
  registerPromptSubmitIpc({ handle: (key, fn) => ipc.set(key, fn) },
    { sessionManager: { getNativeClaude: id => (id === 'hub' ? session : null) } });
  const handler = ipc.get('claude-native:reconcile-history');
  assert.ok(handler, 'claude-native:reconcile-history 必须注册');

  const ok = await handler({}, { sessionId: 'hub' });
  assert.equal(ok.ok, true);
  assert.equal(ok.records.length, 0);
  assert.equal(session.records.get('old').reconciliation.source, 'user');
  assert.equal(session.unreconciled, false);

  // 会话不存在、以及核对本身抛错，都必须回一个 ok:false，不许静默成功。
  assert.equal((await handler({}, { sessionId: 'nope' })).ok, false);
  session.configurationChange = Promise.resolve();
  session.unreconciled = true;
  const failed = await handler({}, { sessionId: 'hub' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /设置/);
  session.configurationChange = null;
});

// 这个按钮的 kind 分别写在三处：状态模型发出它、renderer 认它、main 注册对应的
// IPC。三处对不上就是一个「点了没反应」的死按钮，而那正是这次要修掉的那种毛病，
// 所以拿源码把它们钉在一起（仓库既有做法，见 unit-prompt-submit-ui-contract）。
test('核对按钮的 kind 在状态模型、renderer 和 main 三处必须一致', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  // 判据全部用字面量包含，不拼动态正则：那既读不懂也容易被转义坑掉。
  const model = read('core/session-status-summary.js');
  const declared = /action: stalled(?: && !unconfirmedSend)? \? \{ kind: '([a-z-]+)', label: '([^']+)' \}/.exec(model);
  assert.ok(declared, '状态模型里找不到待核对时的按钮定义');
  const [, kind, label] = declared;
  assert.equal(kind, 'claude-reconcile');
  assert.equal(label, '核对上次任务');

  const renderer = read('renderer/renderer.js');
  assert.ok(renderer.includes(`kind === '${kind}'`), 'renderer 不认这个 kind，按钮会点不动');
  // 认出 kind 之后紧接着必须真的发出那条 IPC，而不是认完什么都不做。
  const branch = renderer.slice(renderer.indexOf(`kind === '${kind}'`));
  const channel = /invoke\('(claude-native:[a-z-]+)'/.exec(branch.slice(0, 400));
  assert.ok(channel, 'renderer 认了这个 kind 却没有发出任何 IPC');
  const action = channel[1].slice('claude-native:'.length);

  const main = read('main/ipc/prompt-submit-handlers.js');
  assert.ok(main.includes(`'${action}'`), `main 没有注册 claude-native:${action}`);
  const handler = main.slice(main.indexOf(`action === '${action}'`));
  assert.ok(handler.slice(0, 160).includes('reconcileFromHistory'),
    `claude-native:${action} 没有走到 reconcileFromHistory`);
});
