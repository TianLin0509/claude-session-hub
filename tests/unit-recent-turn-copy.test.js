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

assert.equal(normalizeRoundCount('3'), 3);
assert.equal(normalizeRoundCount('9'), 1);
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

console.log('recent turn copy unit tests ok');
