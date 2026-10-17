'use strict';
// 家里 ⇄ 公司通道送进会话的消息不是人提的问题（2026-10-16 田哥截图：问题目录 Q4–Q9 全是 <pasted_content> 包着的公司回执）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bridgeMessageKind, bridgeText } = require('../core/bridge-message-kind');
const { normalizeQuestionSummary } = require('../renderer/card-question-navigator.js');

test('认出 Hub 送进会话的通道消息：回执、家里回复、提问、改写请求（含粘贴外壳与剪贴板占位符）', () => {
  const pasted = '<pasted_content id="0f80">\n【公司回执 Q-1016-05 · 第 2 轮】\n\n📌 结论\n</pasted_content id="0f80">';
  assert.deepEqual(bridgeMessageKind(pasted), { kind: 'company-receipt', thread: 'Q-1016-05', round: 2 });
  assert.equal(bridgeMessageKind('【公司回执 Q-1016-02 · 第 5 轮 · 没答上】\n\n会话停下了').kind, 'company-receipt');
  assert.deepEqual(bridgeMessageKind('【家里回复 H-1015-01 · 第 1 轮 · Claude】\n\n正文'), { kind: 'home-reply', thread: 'H-1015-01', round: 1 });
  assert.deepEqual(bridgeMessageKind('你是公司电脑上的助手……\n\n代码位置：\n- C:/AirView\n\n## 成员请求（编号 Q-1016-19）\n\n问题'), { kind: 'channel-request', thread: 'Q-1016-19', round: 1 });
  assert.deepEqual(bridgeMessageKind('[Image #0]## 成员追问（编号 Q-1016-01，第 4 轮）\n\n问题'), { kind: 'channel-request', thread: 'Q-1016-01', round: 4 });
  assert.equal(bridgeMessageKind('## 公司 CodeAgent 的追问（编号 H-1015-01，第 2 轮）\n\n问题').kind, 'channel-request');
  assert.deepEqual(bridgeMessageKind('（编号 Q-1016-01，第 2 轮）你上一条回答里有成段的源码。按规则……'), { kind: 'channel-rewrite', thread: 'Q-1016-01', round: 2 });
});

test('人自己写的消息不误认：提到「公司回执」字样、普通粘贴', () => {
  assert.equal(bridgeMessageKind('帮我看看【公司回执】这个格式怎么改'), null);
  assert.equal(bridgeMessageKind('问一下公司：Q-1016-05 的结论可信吗？'), null);
  assert.equal(bridgeMessageKind('<pasted_content id="ab12">\n普通粘贴内容\n</pasted_content id="ab12">'), null);
});

test('问题目录：长粘贴只显示正文，不显示 <pasted_content> 外壳；通道消息不进目录', () => {
  assert.equal(normalizeQuestionSummary('<pasted_content id="ab12">\n请帮我看这段日志\n</pasted_content id="ab12">'), '请帮我看这段日志');
  assert.equal(bridgeText('<pasted_content id="ab12">\n正文\n</pasted_content id="ab12">'), '正文');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'card-question-navigator.js'), 'utf8');
  assert.match(src, /:scope > \.turn-card\.user'\)\)\.filter\(card => \(\s*\(!card\.dataset\.sessionId \|\| card\.dataset\.sessionId === sessionId\) && !bridgeMessageKind\(questionTextForCard\(card\)\)/);
});
