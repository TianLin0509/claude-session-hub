'use strict';

// 背景（2026-08-28 对真实 fork 产物实测）：
//   codex fork  → 新 rollout 里父历史 0 条 → 卡片视图只剩分支后的内容
//   claude fork → 新 jsonl 整份复制父历史 → 跑同一条合并路径必须不产生重复
// 这两条正好是下面两组断言。

const assert = require('assert');
const {
  applyTailLimit,
  earliestTurnTs,
  mergeInheritedTurns,
  resolveForkTimestamp,
  turnSignature,
} = require('../core/branch-transcript-inheritance.js');

const t = (role, text, ts) => ({ id: `${role}-${ts}`, role, text, ts });

// --- Codex 形态：子会话完全没有父历史 ---
const parentTurns = [
  t('user', '父会话第一问', 1000),
  t('assistant', '父会话第一答', 1100),
  t('user', '父会话第二问', 1200),
  t('assistant', '父会话第二答', 1300),
  // fork 之后父会话自己又跑了一轮，不属于这条分支
  t('user', '分支之后父会话又问的', 5000),
  t('assistant', '分支之后父会话的回答', 5100),
];
const codexChild = [t('user', '分支后第一问', 2100), t('assistant', '分支后第一答', 2200)];
const merged = mergeInheritedTurns(parentTurns, codexChild, { forkAt: 2000, sourceSessionId: 'parent-1' });
assert.strictEqual(merged.length, 6, '4 条分支前 + 2 条分支后');
assert.deepStrictEqual(merged.map(x => x.text), [
  '父会话第一问', '父会话第一答', '父会话第二问', '父会话第二答',
  '分支后第一问', '分支后第一答',
]);
assert.ok(merged.slice(0, 4).every(x => x.inherited === true), '前置的必须打上 inherited');
assert.ok(merged.slice(4).every(x => !x.inherited), '子会话自己的不打标');
assert.ok(merged.every(x => x.inheritedFrom === 'parent-1' || !x.inherited));
// id 必须换成独立命名空间，否则会和子会话自己的卡片撞 id 被去重掉。
assert.ok(merged.slice(0, 4).every(x => x.id.startsWith('branch-inherited:')));
assert.strictEqual(new Set(merged.map(x => x.id)).size, merged.length, 'id 不得重复');

// --- Claude 形态：子会话已经复制了父历史，合并后不得出现双份 ---
const claudeChild = [
  t('user', '父会话第一问', 1000),
  t('assistant', '父会话第一答', 1100),
  t('user', '分支后第一问', 2100),
];
const claudeMerged = mergeInheritedTurns(parentTurns, claudeChild, { forkAt: 2000, sourceSessionId: 'p' });
assert.deepStrictEqual(claudeMerged.map(x => x.text), [
  '父会话第二问', '父会话第二答', '父会话第一问', '父会话第一答', '分支后第一问',
]);
assert.strictEqual(
  claudeMerged.filter(x => x.text === '父会话第一问').length, 1,
  '同一条消息不得出现两次',
);

// 空白 turn 不占位
assert.strictEqual(mergeInheritedTurns([t('user', '   ', 1)], [], {}).length, 0);
// forkAt=0 表示无法确定切点 → 不切，宁可多显示也别丢历史
assert.strictEqual(mergeInheritedTurns(parentTurns, [], { forkAt: 0 }).length, 6);

// --- 签名只看 role + 正文，不看 id（父子两侧 id 体系不同） ---
assert.strictEqual(
  turnSignature({ id: 'a', role: 'user', text: '你  好\n世界' }),
  turnSignature({ id: 'b', role: 'user', text: '你 好 世界' }),
);
assert.notStrictEqual(
  turnSignature({ role: 'user', text: 'x' }),
  turnSignature({ role: 'assistant', text: 'x' }),
);

// --- fork 时刻推断 ---
assert.strictEqual(earliestTurnTs([t('a', 'x', 900), t('b', 'y', 300)]), 300);
assert.strictEqual(earliestTurnTs([]), 0);
// 活会话有 createdAt 时用它；落盘记录没有这个字段，所以后面两档不是可选项。
assert.strictEqual(
  resolveForkTimestamp({ session: { createdAt: 500 }, childTurns: [t('u', 'x', 900)], providerForkAt: 700 }),
  500,
);
assert.strictEqual(
  resolveForkTimestamp({ session: {}, childTurns: [t('u', 'x', 900)], providerForkAt: 700 }),
  700,
);
assert.strictEqual(resolveForkTimestamp({ session: {}, childTurns: [t('u', 'x', 900)] }), 900);
assert.strictEqual(resolveForkTimestamp({ session: {}, childTurns: [] }), 0);

// --- 合并后重新收口窗口 ---
const ten = Array.from({ length: 10 }, (_, i) => t('user', `m${i}`, i + 1));
assert.deepStrictEqual(applyTailLimit(ten, 3, true).map(x => x.text), ['m7', 'm8', 'm9']);
assert.deepStrictEqual(applyTailLimit(ten, 3, false).map(x => x.text), ['m0', 'm1', 'm2']);
assert.strictEqual(applyTailLimit(ten, 50, true).length, 10);
assert.strictEqual(applyTailLimit(ten, undefined, true).length, 10);

console.log('unit-branch-transcript-inheritance: OK');
