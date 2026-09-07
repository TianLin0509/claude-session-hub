'use strict';

// 本地 pending 提问被权威历史「认领」的判据（2026-09-07）。
//
// 这套判据存在的唯一理由是一个真实损失：用户在群聊里按下发送，本地气泡已经出来了，
// 服务端历史一读回来气泡就凭空消失。根因是旧判据按轮号顺序认领 ——
// 首次打开房间时 afterTurn 只能算成 0，昨天第 7 轮的老提问满足「7 > 0」，
// 于是替今天这条做了确认。下面每条测试都对应一种「不该认领却认领了」的具体形态。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PENDING_CLAIM_SKEW_MS,
  authoritativeUserMessageClaims,
  unclaimedPendingUserMessages,
} = require('../core/groupchat-pending-claim.js');

const NOW = 1_757_000_000_000;
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

const pending = (content, createdAt = NOW, clientId = 'c1') => ({ content, createdAt, clientId, afterTurn: 0 });
const userMsg = (content, createdAt, turnNum = 1) => ({ role: 'user', content, createdAt, turnNum });

test('评审复现场景：昨天第 7 轮的老提问不得认领今天刚发的这条', () => {
  const history = [
    userMsg('昨天问的第一个问题', YESTERDAY, 1),
    userMsg('昨天问的第七个问题', YESTERDAY + 1000, 7),
  ];
  const left = unclaimedPendingUserMessages(history, [pending('今天刚发的新问题')]);
  assert.equal(left.length, 1, '老历史把新卡片挤掉了——这正是被打回的那个 bug');
  assert.equal(left[0].content, '今天刚发的新问题');
});

test('服务端把同一条写进历史后，本地那条就该撤掉', () => {
  const history = [
    userMsg('昨天问的第七个问题', YESTERDAY, 7),
    userMsg('今天刚发的新问题', NOW + 120, 8),
  ];
  assert.deepEqual(unclaimedPendingUserMessages(history, [pending('今天刚发的新问题')]), []);
});

test('内容两边都 trim 再比：本地存 trim 过的，服务端存原串', () => {
  const history = [userMsg('  带空白的提问\n', NOW + 50, 3)];
  assert.deepEqual(unclaimedPendingUserMessages(history, [pending('带空白的提问')]), []);
});

test('同样内容的老提问不算数：口头禅不能换个花样重演同一个 bug', () => {
  // 「继续」在历史里出现过，今天又发了一次 —— 只比内容就会被老的认领掉。
  const history = [userMsg('继续', YESTERDAY, 4)];
  const left = unclaimedPendingUserMessages(history, [pending('继续')]);
  assert.equal(left.length, 1);
});

test('去重：一条权威消息只能认领一条 pending', () => {
  const history = [userMsg('继续', NOW + 60, 5)];
  const left = unclaimedPendingUserMessages(history, [
    pending('继续', NOW, 'c1'),
    pending('继续', NOW + 10, 'c2'),
  ]);
  assert.equal(left.length, 1, '连发两遍同样的话，只落盘一条时应当还剩一条本地气泡');
  assert.equal(left[0].clientId, 'c2');

  const both = [userMsg('继续', NOW + 60, 5), userMsg('继续', NOW + 90, 6)];
  assert.deepEqual(unclaimedPendingUserMessages(both, [
    pending('继续', NOW, 'c1'),
    pending('继续', NOW + 10, 'c2'),
  ]), []);
});

test('时钟抖动余量之内算认领，之外不算', () => {
  const justInside = [userMsg('提问', NOW - PENDING_CLAIM_SKEW_MS + 1, 2)];
  assert.deepEqual(unclaimedPendingUserMessages(justInside, [pending('提问')]), []);
  const tooOld = [userMsg('提问', NOW - PENDING_CLAIM_SKEW_MS - 1000, 2)];
  assert.equal(unclaimedPendingUserMessages(tooOld, [pending('提问')]).length, 1);
});

test('没有可信时间戳就不认领：宁可多留一会儿，也不能让气泡凭空消失', () => {
  for (const badTime of [undefined, null, 0, -1, NaN, 'abc']) {
    const history = [{ role: 'user', content: '提问', createdAt: badTime, turnNum: 9 }];
    assert.equal(unclaimedPendingUserMessages(history, [pending('提问')]).length, 1,
      '时间戳为 ' + String(badTime) + ' 时不该认领');
  }
});

test('非 user 消息不参与认领；空输入安全', () => {
  const aiEcho = [{ role: 'assistant', content: '今天刚发的新问题', createdAt: NOW + 100, turnNum: 8 }];
  assert.equal(unclaimedPendingUserMessages(aiEcho, [pending('今天刚发的新问题')]).length, 1);
  assert.deepEqual(unclaimedPendingUserMessages(null, null), []);
  assert.deepEqual(unclaimedPendingUserMessages([], []), []);
  assert.deepEqual(unclaimedPendingUserMessages(null, [pending('x')]).length, 1);
  assert.equal(authoritativeUserMessageClaims(null, pending('x')), false);
  assert.equal(authoritativeUserMessageClaims(userMsg('x', NOW), null), false);
});

console.log('unit-groupchat-pending-claim OK');
