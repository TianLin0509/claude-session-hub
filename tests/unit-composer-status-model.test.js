'use strict';
// Composer 状态行的展示模型（T1 冷杉 v2）。
//
// 守的是一件很具体的事：状态行说的话必须只从「渲染层算出的 runtime 结论」
// + respond-pill 的 needsRespond + 现有问题检测这三个既有信号推出来，且四档互斥。
// 这些判据在仓库里已经各有一个作者，composer 再抄一份就等于给用户两个会互相
// 矛盾的说法。runtime 由调用方传入，正是为了保证它和舞台头部读的是同一个对象。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPOSER_STATUS_DEAD,
  COMPOSER_STATUS_READY,
  COMPOSER_STATUS_WAITING,
  COMPOSER_STATUS_WORKING,
  buildComposerStatusModel,
  composerStateFor,
  formatRuntimeSeconds,
  parseQuickReplyOptions,
} = require('../core/session-status-summary.js');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status.js');

const NOW = 1757200000000;

function model(session, options = {}) {
  const runtime = deriveSessionRuntimeStatus(session, { now: NOW });
  return buildComposerStatusModel(session, { now: NOW, runtime, ...options });
}

test('就绪：报出上一轮完成多久，并给出回看入口', () => {
  const result = model({ kind: 'claude', status: 'idle', lastCompletedAt: NOW - 120_000 });
  assert.equal(result.state, COMPOSER_STATUS_READY);
  assert.equal(result.text, '已就绪 · 2 分钟前完成上一轮');
  assert.deepEqual(result.action, { kind: 'scroll-latest', label: '查看上一轮 ↑' });
  assert.equal(result.canStop, false);
});

test('就绪：从没跑过的会话不硬造一个「上一轮」', () => {
  const result = model({ kind: 'powershell', status: 'idle' });
  assert.equal(result.state, COMPOSER_STATUS_READY);
  assert.equal(result.text, '已就绪');
  assert.equal(result.action, null);
});

test('工作中：带 CLI 名、秒表与最近工具行，并允许停止', () => {
  const result = model({
    kind: 'claude',
    status: 'running',
    _runSource: 'semantic',
    runStartedAt: NOW - 38_000,
    currentCardActivity: { label: '正在读取 renderer.js' },
  });
  assert.equal(result.state, COMPOSER_STATUS_WORKING);
  assert.equal(result.text, 'Claude 正在工作 · 38s');
  assert.equal(result.detail, '正在读取 renderer.js');
  assert.equal(result.canStop, true);
  assert.equal(result.action, null);
});

test('工作中：秒表按会话真实起点走，不同 CLI 名字不串', () => {
  const result = model({
    kind: 'codex',
    status: 'running',
    _runSource: 'semantic',
    runStartedAt: NOW - 3_600_000,
  });
  assert.equal(result.text, 'Codex 正在工作 · 1h00m');
});

test('等你回答：问题摘要来自会话的等待文本，选项另起一行成为快捷答复', () => {
  const result = model({
    kind: 'codex',
    status: 'idle',
    needsUserInput: true,
    waitingText: '是否要我直接修改 index.html？\n1. 是，继续\n2. 先看 diff\n3. 换个方案',
  });
  assert.equal(result.state, COMPOSER_STATUS_WAITING);
  assert.equal(result.text, 'Codex 在等你回答：「是否要我直接修改 index.html？」');
  assert.deepEqual(result.quickReplies, ['是，继续', '先看 diff', '换个方案']);
  assert.equal(result.canStop, false);
});

test('等你回答：解析不出选项就不给 chip，宁可不给也不能给错的', () => {
  const result = model({
    kind: 'claude',
    status: 'idle',
    needsUserInput: true,
    waitingText: '要我继续跑完整套单测吗？',
  });
  assert.equal(result.state, COMPOSER_STATUS_WAITING);
  assert.equal(result.text, 'Claude 在等你回答：「要我继续跑完整套单测吗？」');
  assert.deepEqual(result.quickReplies, []);
});

// 2026-09-07 评审实测：Codex 真的问出「你选择 A 还是 B？」时，会话级 attention
// 仍是「已完成未读」（那条信号只有 Claude 的回合结束路径会点亮），composer 因此
// 显示「已就绪」。补上第二个证据来源：当前终端画面上的现有问题检测。
test('等你回答：会话状态没标记时，当前画面的问题检测也能把它顶成等待态', () => {
  const session = { kind: 'codex', status: 'idle', lastCompletedAt: NOW - 3_000 };
  const asReady = model(session);
  assert.equal(asReady.state, COMPOSER_STATUS_READY, '没有问题检测结果时仍是就绪');

  const withQuestion = model(session, {
    liveQuestion: { waiting: true, reason: 'question', text: '你选择 A 还是 B？' },
  });
  assert.equal(withQuestion.state, COMPOSER_STATUS_WAITING);
  assert.equal(withQuestion.text, 'Codex 在等你回答：「你选择 A 还是 B？」');
});

test('等你回答：只有检测器判定是选择题时才解析编号选项', () => {
  const session = { kind: 'codex', status: 'idle', lastCompletedAt: NOW - 3_000 };
  const choice = model(session, {
    liveQuestion: {
      waiting: true,
      reason: 'choice',
      text: '请选择一个方案',
      screen: '请选择一个方案\n1. 直接改\n2. 先看 diff',
    },
  });
  assert.deepEqual(choice.quickReplies, ['直接改', '先看 diff']);

  // 问号结尾那种情况下不给 screen，正文里的数字不该变成按钮。
  const plain = model(session, {
    liveQuestion: { waiting: true, reason: 'question', text: '要跑 1. 单测 还是别的？' },
  });
  assert.deepEqual(plain.quickReplies, []);
});

test('等你回答：waiting=false 的检测结果不算数', () => {
  const result = model(
    { kind: 'codex', status: 'idle', lastCompletedAt: NOW - 3_000 },
    { liveQuestion: { waiting: false, text: '随便什么' } },
  );
  assert.equal(result.state, COMPOSER_STATUS_READY);
});

test('断开：休眠与运行异常都归到同一档，并给出重连动作', () => {
  const dormant = model({ kind: 'claude', status: 'dormant' });
  assert.equal(dormant.state, COMPOSER_STATUS_DEAD);
  assert.equal(dormant.text, '会话已断开（会话已休眠）· 重连后可继续');
  assert.deepEqual(dormant.action, { kind: 'reconnect', label: '重连' });

  const failed = model({ kind: 'gemini', status: 'error', lastError: 'PTY 退出码 1' });
  assert.equal(failed.state, COMPOSER_STATUS_DEAD);
  assert.equal(failed.text, '会话已断开（PTY 退出码 1）· 重连后可继续');
});

// 2026-09-07 评审实测：真结束 PTY 后会话和输入框一起消失。现在会话会被留下来
// 并落成可唤醒，进程怎么没的单独记一笔 —— 不能被笼统的“会话已休眠”盖掉。
test('断开：进程自己死了要报出退出码，不能冒充休眠', () => {
  const lost = model({
    kind: 'codex',
    status: 'dormant',
    _processLost: { reason: 'CLI 进程退出码 1', at: NOW },
  });
  assert.equal(lost.state, COMPOSER_STATUS_DEAD);
  assert.equal(lost.text, '会话已断开（CLI 进程退出码 1）· 重连后可继续');
  assert.deepEqual(lost.action, { kind: 'reconnect', label: '重连' });

  // 没有进程丢失标记时仍然是普通休眠的说法
  const dormant = model({ kind: 'codex', status: 'dormant' });
  assert.equal(dormant.text, '会话已断开（会话已休眠）· 重连后可继续');
});

test('断开：断流也算断开，原因用 connectionIssue 的说法', () => {
  const result = model({
    kind: 'codex',
    status: 'idle',
    connectionIssue: { type: 'stream-disconnected', reason: 'API Error: stream disconnected' },
  });
  assert.equal(result.state, COMPOSER_STATUS_DEAD);
  assert.match(result.text, /^会话已断开（API Error: stream disconnected）/);
});

test('断开压过等你回答：休眠会话上残留的问题不得冒充「在等你」', () => {
  const result = model({
    kind: 'claude',
    status: 'dormant',
    needsUserInput: true,
    waitingText: '要不要继续？',
  });
  assert.equal(result.state, COMPOSER_STATUS_DEAD);
});

test('四档互斥且优先级固定：断开 > 等你回答 > 工作中 > 就绪', () => {
  assert.equal(composerStateFor('running', { disconnected: true }), COMPOSER_STATUS_DEAD);
  assert.equal(composerStateFor('running', { needsRespond: true }), COMPOSER_STATUS_WAITING);
  assert.equal(composerStateFor('starting', {}), COMPOSER_STATUS_WORKING);
  assert.equal(composerStateFor('running', {}), COMPOSER_STATUS_WORKING);
  assert.equal(composerStateFor('waiting', {}), COMPOSER_STATUS_WAITING);
  assert.equal(composerStateFor('failed', {}), COMPOSER_STATUS_DEAD);
  assert.equal(composerStateFor('dormant', {}), COMPOSER_STATUS_DEAD);
  for (const idle of ['idle', 'completed', 'unknown']) {
    assert.equal(composerStateFor(idle, {}), COMPOSER_STATUS_READY);
  }
});

test('秒表文案：秒 / 分秒 / 时分三段', () => {
  assert.equal(formatRuntimeSeconds(0), '0s');
  assert.equal(formatRuntimeSeconds(38_000), '38s');
  assert.equal(formatRuntimeSeconds(59_999), '59s');
  assert.equal(formatRuntimeSeconds(60_000), '1m');
  assert.equal(formatRuntimeSeconds(158_000), '2m38s');
  assert.equal(formatRuntimeSeconds(3_720_000), '1h02m');
});

test('快捷答复解析：只有一条候选不算选择题', () => {
  assert.deepEqual(parseQuickReplyOptions('1. 只有这一个'), []);
  assert.deepEqual(parseQuickReplyOptions('❯ 1. 是\n  2. 否'), ['是', '否']);
  assert.deepEqual(parseQuickReplyOptions('1) Yes\n2) No\n3) Yes'), ['Yes', 'No']);
  assert.deepEqual(
    parseQuickReplyOptions('1. 是\n2. 这一条特别长长到根本放不进一个二十四像素高的小圆角按钮里'),
    [],
  );
  assert.deepEqual(parseQuickReplyOptions(''), []);
});

test('runtime 是必填输入：不许自己再算一份', () => {
  assert.throws(
    () => buildComposerStatusModel({ kind: 'claude', status: 'idle' }, { now: NOW }),
    /requires the derived runtime status/,
  );
});

test('状态行与头部徽章共用同一个 runtime 结论对象', () => {
  const session = { kind: 'claude', status: 'running', _runSource: 'semantic', runStartedAt: NOW - 5_000 };
  const runtime = deriveSessionRuntimeStatus(session, { now: NOW });
  const result = buildComposerStatusModel(session, { now: NOW, runtime });
  assert.equal(result.runtime, runtime, 'composer 必须原样带回传进来的那个 runtime 对象');
  assert.equal(result.runtime.provider, 'Claude');
  assert.match(result.runtime.title, /判断依据/);
});
