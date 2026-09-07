'use strict';
// 循环两步的外层预算：合并位那一步要跑两遍全量测试，Hub 不许把它砍掉。
//
// 冲突原本长这样（2026-09-06）：合同要求「dry-run 一次 + 正式合并再一次」，每次都是
// 全量单测（本机闲机 117 秒，机器忙时更长，还可能在总入口锁前排队）。而外层给这一步的
// 是一个死墙钟，到点 markTimedOut('response_timeout') 强制 skip —— 一次「正在跑第二遍
// 测试」被记成「评审没给裁决」，白烧一轮返工。当时的解法是把墙钟调大 + 允许有界延期。
//
// 2026-09-07 改成了更根本的解法：**工作流不再给自己装墙钟**。
// 普通群聊本来就不设（dispatcher: `disableHardTimeout: !(turnTimeoutMs > 0)`），
// 是工作流自己传了 turnTimeoutMs 才装上的。墙钟到点产出的 failed + hard_timeout
// 是一条假终态 —— 台账终态，但那只是 Hub 不等了，CLI 那边很可能还在跑；随后这条假终态
// 又会让恢复入口把同一个成员重新问一遍（维护者实测）。
//
// 所以这个文件守的东西没变（评审步不许被 Hub 单方面砍掉），只是判据从
// 「预算够不够大 / 延期开没开」升级成「压根没有墙钟，也就没有可调错的参数」。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'loop-engine.js'), 'utf8');
const dispatcherSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'dispatcher.js'), 'utf8');

test('工作流的每一次派发都不带 turnTimeoutMs（不给自己装墙钟）', () => {
  const dispatchCount = (src.match(/dispatchGroupChatTurn\(meetingId,\s*\{/g) || []).length;
  assert.ok(dispatchCount >= 3,
    `应当能找到串行 / builder / reviewer 三处派发，实际 ${dispatchCount} 处`);
  // 整个引擎里一处都不许出现：只要有一条派发带上它，dispatcher 就给那一步装上墙钟。
  assert.doesNotMatch(src, /turnTimeoutMs/,
    '传 turnTimeoutMs 就等于让 dispatcher 装上死墙钟；到点强杀产出的 failed + hard_timeout '
    + '只是「Hub 不等了」，CLI 那边很可能还在跑，而这条假终态正是恢复入口重复派发的燃料');
});

test('续命判断随墙钟一起去掉，不留半套机制', () => {
  assert.doesNotMatch(src, /allowActiveExtend/,
    'allowActiveExtend 是给墙钟打的补丁（PTY 最近有输出就再延一会儿）；墙拆了它就没有意义，'
    + '留着只会让人以为还有一层保护');
  assert.doesNotMatch(src, /reviewerTimeoutMs|builderTimeoutMs/,
    '不再需要为「够不够跑两遍全量」调参数 —— 这个问题是墙钟自己制造的');
});

test('dispatcher 保留参数入口：默认不传即不设墙，回退成本为零', () => {
  assert.match(dispatcherSrc, /disableHardTimeout: !\(Number\(turnTimeoutMs\) > 0\)/,
    '墙钟必须仍然是「谁传谁装」，这样万一要回退，把参数传回去就行，不用改 dispatcher');
});

console.log('unit-loop-step-budget OK');
