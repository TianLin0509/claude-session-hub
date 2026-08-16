'use strict';

const assert = require('node:assert/strict');
const {
  assistantSender,
  collectCompleteConversationRounds,
  formatRecentConversation,
  normalizeRoundCount,
} = require('../renderer/recent-turn-copy.js');

const entries = [
  { role: 'user', text: '问题一' },
  { role: 'assistant', text: '回答一', kind: 'claude', model: 'claude-opus-4-7' },
  { role: 'user', text: '问题二' },
  { role: 'assistant', text: '回答二', kind: 'codex', model: 'gpt-5.6-sol' },
  { role: 'user', text: '问题三' },
  { role: 'assistant', text: '回答三-A', kind: 'kimi' },
  { role: 'assistant', text: '回答三-B', kind: 'kimi' },
  { role: 'user', text: '问题四' },
  { role: 'assistant', text: '回答四', kind: 'gemini', model: 'gemini-3-pro' },
  { role: 'user', text: '尚未回答的问题五' },
];

// 轮数上限不再是写死的 {1,2,3}：第二个参数就是"当前对话的完整轮数"。
assert.equal(normalizeRoundCount('3'), 3);
assert.equal(normalizeRoundCount('9'), 9, '9 轮不再被打回 1 —— 上限跟着实际轮数走');
assert.equal(normalizeRoundCount('9', 4), 4, '超出实际轮数时贴着上限，不是回落 1');
assert.equal(normalizeRoundCount('0', 4), 1);
assert.equal(normalizeRoundCount('-3', 4), 1);
assert.equal(normalizeRoundCount('abc', 4), 1);
assert.equal(normalizeRoundCount('', 4), 1);
assert.equal(normalizeRoundCount('999999'), 200, '防呆天花板 MAX_COPY_ROUND_COUNT');
assert.equal(assistantSender({ kind: 'codex-resume', model: 'gpt-5.6-sol' }), 'AI（Codex · gpt-5.6-sol）');

const rounds = collectCompleteConversationRounds(entries);
assert.equal(rounds.length, 4, 'incomplete trailing question must not count as a round');
assert.equal(rounds[2].assistants.length, 2, 'all assistant cards before the next question belong to one round');

const latestThree = formatRecentConversation(entries, 3);
assert.equal(latestThree.copiedRounds, 3);
assert.equal(latestThree.availableRounds, 4);
assert.doesNotMatch(latestThree.text, /问题一|回答一|问题五/);
assert.match(latestThree.text, /===== 第 1 轮 =====\n我：\n问题二/);
assert.match(latestThree.text, /AI（Codex · gpt-5\.6-sol）：\n回答二/);
assert.match(latestThree.text, /AI（Kimi）：\n回答三-A[\s\S]*AI（Kimi）：\n回答三-B/);
assert.match(latestThree.text, /===== 第 3 轮 =====[\s\S]*问题四[\s\S]*回答四/);

const latestOne = formatRecentConversation(entries, 1);
assert.equal(latestOne.copiedRounds, 1);
assert.match(latestOne.text, /问题四/);
assert.doesNotMatch(latestOne.text, /问题二|问题三/);

// 任意轮数：4 轮就该拿到全部 4 轮（老实现在这里会被打回 1 轮）。
const everything = formatRecentConversation(entries, 4);
assert.equal(everything.copiedRounds, 4);
assert.equal(everything.requestedRounds, 4);
assert.match(everything.text, /问题一/);
assert.match(everything.text, /===== 第 4 轮 =====[\s\S]*问题四/);
assert.doesNotMatch(everything.text, /问题五/, '结尾没回答的问题仍然不算一轮');

// 请求超过实际轮数（比如切到更短的会话）时给全部，而不是失败或回落 1。
const overshoot = formatRecentConversation(entries, 99);
assert.equal(overshoot.copiedRounds, 4);
assert.equal(overshoot.requestedRounds, 4);

// 一轮都没有时不能崩，availableRounds 要如实报 0。
const empty = formatRecentConversation([{ role: 'user', text: '只有问题' }], 5);
assert.equal(empty.copiedRounds, 0);
assert.equal(empty.availableRounds, 0);
assert.equal(empty.text, '');

console.log('recent turn copy unit tests ok');
