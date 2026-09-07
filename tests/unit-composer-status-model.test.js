'use strict';
// Composer 状态行的展示模型（T1 冷杉 v2）。
//
// 守的是一件很具体的事：状态行说的话必须**只**从 runtime truth + respond-pill 的
// needsRespond 推出来，且四档互斥。这两个判据在仓库里已经各有一个作者，
// composer 再抄一份就等于给用户两个会互相矛盾的说法。

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
} = require('../renderer/session-runtime-status.js');

const NOW = 1757200000000;
const model = (session, options = {}) => buildComposerStatusModel(session, { now: NOW, ...options });

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
  // 等你回答时不该出现停止键：没有在跑的东西可以停。
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

test('断开：休眠与运行异常都归到同一档，并给出重连动作', () => {
  const dormant = model({ kind: 'claude', status: 'dormant' });
  assert.equal(dormant.state, COMPOSER_STATUS_DEAD);
  assert.equal(dormant.text, '会话已断开（会话已休眠）· 输入会在重连后发送');
  assert.deepEqual(dormant.action, { kind: 'reconnect', label: '重连' });

  const failed = model({ kind: 'gemini', status: 'error', lastError: 'PTY 退出码 1' });
  assert.equal(failed.state, COMPOSER_STATUS_DEAD);
  assert.equal(failed.text, '会话已断开（PTY 退出码 1）· 输入会在重连后发送');
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
  // 长句是正文不是选项，塞进 chip 里会被截断成看不懂的半句话。
  assert.deepEqual(
    parseQuickReplyOptions('1. 是\n2. 这一条特别长长到根本放不进一个二十四像素高的小圆角按钮里'),
    [],
  );
  assert.deepEqual(parseQuickReplyOptions(''), []);
});

test('状态行与头部徽章共用同一个 runtime 结论，不各算一份', () => {
  const session = { kind: 'claude', status: 'running', _runSource: 'semantic', runStartedAt: NOW - 5_000 };
  const result = model(session);
  assert.equal(result.runtime.state, 'running');
  assert.equal(result.runtime.provider, 'Claude');
  // runtime.title 就是头部徽章 hover 时那段判断依据，composer 原样复用。
  assert.match(result.runtime.title, /判断依据/);
});
