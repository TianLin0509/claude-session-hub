'use strict';

// 本地 pending 提问被权威历史「认领」的判据（2026-09-07）。
//
// 这套判据存在的唯一理由是一个真实损失：用户在群聊里按下发送，本地气泡已经出来了，
// 服务端历史一读回来气泡就凭空消失。它被推翻过两次，每次都是拿「像不像」当「是不是」：
//   ① 按轮号 —— 首次打开房间时 afterTurn 只能算成 0，昨天第 7 轮的老提问满足「7 > 0」。
//   ② 按内容 + 5 秒时间窗 —— 缓存里已有一条一秒前的同文提问时，它照样落在窗口内。
// 现在按真身份：本次发送的 clientId 随权威消息回来，只认 id 相等。
//
// 下面每条测试都对应一种「不该认领却认领了」或「该认领却没认领」的具体形态。
// 端到端的 id 往返（orchestrator 真的把它写进权威消息）在
// tests/unit-group-chat-orchestrator.test.js 里验，真跑的 UI 回归在
// tests/e2e-groupchat-first-send-card-cdp.js。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authoritativeUserMessageClaims,
  unclaimedPendingUserMessages,
} = require('../core/groupchat-pending-claim.js');

const NOW = 1_757_000_000_000;
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

const pending = (content, clientId = 'send-1', createdAt = NOW) =>
  ({ content, createdAt, clientId, afterTurn: 0 });
const userMsg = (content, createdAt, turnNum, clientMessageId) => {
  const message = { role: 'user', content, createdAt, turnNum };
  if (clientMessageId !== undefined) message.clientMessageId = clientMessageId;
  return message;
};

test('评审复现场景一：昨天第 7 轮的老提问不得认领今天刚发的这条', () => {
  const history = [
    userMsg('昨天问的第一个问题', YESTERDAY, 1),
    userMsg('昨天问的第七个问题', YESTERDAY + 1000, 7),
  ];
  const left = unclaimedPendingUserMessages(history, [pending('今天刚发的新问题')]);
  assert.equal(left.length, 1, '老历史把新卡片挤掉了');
  assert.equal(left[0].content, '今天刚发的新问题');
});

test('评审复现场景二：一秒前的同文老消息也不得认领本次发送', () => {
  // 5 秒时间窗版本就是死在这里：老消息落在窗口内，用户再发一次同样的话就没有新卡片。
  const oneSecondAgo = [userMsg('继续', NOW - 1000, 7)];
  assert.equal(unclaimedPendingUserMessages(oneSecondAgo, [pending('继续')]).length, 1);
  // 六秒前的那条当年碰巧能过，说明判据本身是运气，不是身份 —— 现在两者一视同仁。
  const sixSecondsAgo = [userMsg('继续', NOW - 6000, 7)];
  assert.equal(unclaimedPendingUserMessages(sixSecondsAgo, [pending('继续')]).length, 1);
});

test('本次发送的正式消息回来了，本地那条就该撤掉', () => {
  const history = [
    userMsg('继续', NOW - 1000, 7),
    userMsg('继续', NOW + 120, 8, 'send-1'),
  ];
  assert.deepEqual(unclaimedPendingUserMessages(history, [pending('继续', 'send-1')]), []);
});

test('id 不同就不认领：别人那次发送的正式消息管不着我这条', () => {
  const history = [userMsg('继续', NOW + 120, 8, 'send-other')];
  assert.equal(unclaimedPendingUserMessages(history, [pending('继续', 'send-1')]).length, 1);
});

test('内容一致但没有 id 的权威消息不认领 —— 内容从来不是身份', () => {
  const history = [userMsg('继续', NOW + 120, 8)];
  assert.equal(unclaimedPendingUserMessages(history, [pending('继续', 'send-1')]).length, 1);
});

test('去重：连发两遍，落盘一条只消掉对应那一条', () => {
  const history = [userMsg('继续', NOW + 60, 5, 'send-1')];
  const left = unclaimedPendingUserMessages(history, [
    pending('继续', 'send-1'),
    pending('继续', 'send-2', NOW + 10),
  ]);
  assert.equal(left.length, 1);
  assert.equal(left[0].clientId, 'send-2');

  const both = [userMsg('继续', NOW + 60, 5, 'send-1'), userMsg('继续', NOW + 90, 6, 'send-2')];
  assert.deepEqual(unclaimedPendingUserMessages(both, [
    pending('继续', 'send-1'),
    pending('继续', 'send-2', NOW + 10),
  ]), []);
});

test('同一条权威消息不会把两条 pending 一起抹掉（万一 id 撞了）', () => {
  const history = [userMsg('继续', NOW + 60, 5, 'dup')];
  const left = unclaimedPendingUserMessages(history, [
    pending('继续', 'dup'),
    pending('继续', 'dup', NOW + 10),
  ]);
  assert.equal(left.length, 1, '一条权威消息只能认领一条');
});

test('空 id / 非 user 消息 / 空输入都不认领，且不抛异常', () => {
  for (const emptyId of ['', '   ', null, undefined, 42]) {
    const history = [userMsg('继续', NOW + 60, 5, emptyId)];
    assert.equal(unclaimedPendingUserMessages(history, [pending('继续', 'send-1')]).length, 1,
      'clientMessageId 为 ' + String(emptyId) + ' 时不该认领');
  }
  const aiEcho = [{ role: 'assistant', content: '继续', createdAt: NOW + 60, clientMessageId: 'send-1' }];
  assert.equal(unclaimedPendingUserMessages(aiEcho, [pending('继续', 'send-1')]).length, 1);
  assert.deepEqual(unclaimedPendingUserMessages(null, null), []);
  assert.deepEqual(unclaimedPendingUserMessages([], []), []);
  assert.equal(unclaimedPendingUserMessages(null, [pending('x')]).length, 1);
  assert.equal(authoritativeUserMessageClaims(null, pending('x')), false);
  assert.equal(authoritativeUserMessageClaims(userMsg('x', NOW, 1, 'send-1'), null), false);
});

console.log('unit-groupchat-pending-claim OK');
