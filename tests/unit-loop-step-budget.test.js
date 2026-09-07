'use strict';
// 2026-09-06：循环两步的外层预算，必须扛得住内层要跑两遍全量测试这件事。
//
// 冲突长这样：合并位那一步的合同要求「dry-run 一次 + 正式合并再一次」，
// 每次都是全量单测（本机闲机 117 秒，机器忙时更长，还可能在总入口锁前排队）。
// 而外层给这一步的是一个死墙钟，到点就 markTimedOut('response_timeout') 强制 skip ——
// 于是一次「正在跑第二遍测试」会被记成「评审没给裁决」，白烧一轮返工。
//
// 两条锁：
//   1. 缺配时的回落预算不能是 5 分钟（连一遍全量都不够，更别说两遍）
//   2. 循环的派发必须允许「PTY 还在输出就有界延期」——这正是 dispatcher 已经实现、
//      却被循环显式关掉的那条兜底（allowActiveExtend）。延期本身有上限（+8 分钟）
//      且只在最近 150 秒内有输出时生效，不会把真死的会话拖成永久等待。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'loop-engine.js'), 'utf8');

test('评审步缺配 timeoutMs 时的回落预算够跑两遍全量', () => {
  const m = /reviewerTimeoutMs = Math\.max\([\s\S]{0,200}?\|\|\s*([\d_]+)\s*\*\s*60_000\)\)/.exec(src);
  assert.ok(m, '找不到评审步的预算回落值');
  const minutes = Number(m[1].replace(/_/g, ''));
  assert.ok(minutes >= 20,
    `评审步回落预算只有 ${minutes} 分钟：合同要求它跑两遍全量单测（本机闲机一遍就 117 秒，`
    + '忙时更长，还可能在总入口锁前排队），至少要 20 分钟');
});

test('循环派发允许有界的活跃延期，不再一刀切关掉', () => {
  const dispatches = src.match(/dispatchGroupChatTurn\(meetingId,\s*\{[\s\S]*?\}\)/g) || [];
  // 只管开发群聊这条循环（kind: 'loop'）。通用串行工作流 kind: 'serial' 是另一条链路，
  // 同样写死了 allowActiveExtend: false —— 已记给维护者，不在本任务里顺手改。
  const loopDispatches = dispatches.filter(d => /kind:\s*'loop'/.test(d) && /allowActiveExtend/.test(d));
  assert.equal(loopDispatches.length, 2, '工作位与评审两步都应当显式表态 allowActiveExtend');
  for (const d of loopDispatches) {
    assert.match(d, /allowActiveExtend:\s*true/,
      'PTY 还在输出就说明 agent 还在干活（多半正在跑测试），这时到点强杀会把「在验证」'
      + '误判成「没给裁决」。延期上限由 dispatcher 封顶，这里必须放开。');
  }
});

console.log('unit-loop-step-budget OK');
