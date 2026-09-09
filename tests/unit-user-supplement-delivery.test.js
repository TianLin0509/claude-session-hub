'use strict';
/**
 * 用户补充（群聊插话）的逐成员增量投递。
 *
 * 复现的缺陷（2026-09-08）：
 *   循环运行中在群聊输入框发一句话 → renderer 走 loop:start → 主进程以 already_running 拒绝，
 *   消息被退回输入框，根本没落盘。就算落了盘，buildDelta 明确过滤 role==='user'，
 *   所以**待命的那位永远不会在它下一次运行时看到这句话**。
 *
 * 这里守的是补上之后的行为：每条真实用户补充对每位成员单独记账，
 * 送达确认之后才算已读，没送达的下次运行时补原文，已读的不再重复注入。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groupchat = require('../core/group-chat-orchestrator.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

function freshRoot() {
  groupchat._private.resetCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gc-supp-'));
}

console.log('user-supplement-delivery');

test('内部派工存成 user 消息，但不是用户补充 —— 不能靠 role 判身份', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'origin');
  // 循环引擎派工作位：这条 u1 的 role 是 user，内容却是 Hub 自己生成的阶段指令。
  orch.beginTurn('## 角色：执行者\n本轮任务：实现目标', {
    dispatchMode: 'serial',
    origin: 'hub',
    dispatch: { kind: 'loop', stepIndex: 0, attempt: 1, runId: 'r1' },
  });
  assert.deepStrictEqual(orch.listUserSupplements(), [], 'Hub 的阶段指令不得混进用户补充账本');
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('sid-r'), [], '历史 Hub 指令不能伪装成用户的新要求');
});

test('插话对每位成员分别记账：当前执行者已收到不代表全群已收到', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'per-member');
  orch.beginTurn('阶段指令', { origin: 'hub', dispatchMode: 'serial' });
  const added = orch.appendUserSupplement('U12 顺便把日志级别调成 debug', {
    recipientSids: ['sid-builder', 'sid-reviewer'],
  });
  assert.ok(added && added.message && Number.isInteger(added.seq), '补充必须先落盘再谈投递');
  assert.strictEqual(added.message.origin, 'user');
  assert.strictEqual(orch.pendingUserSupplementsFor('sid-builder').length, 1);
  assert.strictEqual(orch.pendingUserSupplementsFor('sid-reviewer').length, 1);

  // 当前执行者即时收到并确认
  orch.markUserSupplementsDelivered('sid-builder', [added.seq]);
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('sid-builder'), []);
  assert.strictEqual(orch.pendingUserSupplementsFor('sid-reviewer').length, 1,
    '待命的那位没收到，账本不能因为另一位收到了就清零');
});

test('已确认收到的不再自动重发；新的补充照常进入', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'once');
  const first = orch.appendUserSupplement('U12 第一条', { recipientSids: ['s1'] });
  orch.markUserSupplementsDelivered('s1', [first.seq]);
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('s1'), []);
  orch.markUserSupplementsDelivered('s1', [first.seq]);  // 重复确认是幂等的
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('s1'), []);
  const second = orch.appendUserSupplement('U13 第二条', { recipientSids: ['s1'] });
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('s1').map(x => x.text), ['U13 第二条']);
  assert.notStrictEqual(second.seq, first.seq);
});

test('发送失败不标已读：没调 mark 就一直挂着待确认', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'no-false-ack');
  const added = orch.appendUserSupplement('U12', { recipientSids: ['s1'] });
  // 模拟 sendToPty 抛错：调用方什么都不做
  assert.strictEqual(orch.pendingUserSupplementsFor('s1').length, 1);
  assert.strictEqual(added.message.content, 'U12');
});

test('注入块保留原文：多行、中文、路径、emoji 不被拆开也不被截断', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'verbatim');
  const raw = ['第一行 ✅', '- 列表项', 'C:\\Users\\lintian\\claude-session-hub\\artifacts', '结尾'].join('\n');
  orch.appendUserSupplement(raw, { recipientSids: ['s1'] });
  const block = orch.buildUserSupplementBlock('s1');
  assert.ok(block.includes(raw), '同一条补充必须整段进 prompt，不能拆成多条命令');
  assert.ok(/维护者补充/.test(block), '要让 agent 一眼看出这是维护者说的话，不是 Hub 的阶段指令');
  assert.strictEqual(orch.buildUserSupplementBlock('s-none'), '', '没有待送达就不加任何块');
});

test('补充不动 assistant 增量游标：待送达的成员发言不会被顺手跳过', () => {
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'cursor');
  const begin = orch.beginTurn('阶段指令', { origin: 'hub', dispatchMode: 'serial' });
  orch.patchTurnResult(begin.turnNum, 'sid-a', {
    text: '工作位的正式答复', status: 'completed', memberId: 'ma', speaker: '工作位',
  });
  const before = orch.getState().lastDeliveredSeq['sid-b'];
  orch.appendUserSupplement('U12', { recipientSids: ['sid-a', 'sid-b'] });
  orch.markUserSupplementsDelivered('sid-a', [orch.listUserSupplements()[0].seq]);
  assert.strictEqual(orch.getState().lastDeliveredSeq['sid-b'], before,
    '即时投递一条补充，不能顺手推进「全部消息」的游标');
  assert.ok(orch.buildDelta('sid-b', '下一步指令').includes('工作位的正式答复'),
    '待命成员下次运行时仍要看到它没读过的队友发言');
});

test('重启后账本还在：待送达的补充不会因为 Hub 重启而蒸发', () => {
  const root = freshRoot();
  const orch = groupchat.getOrchestrator(root, 'persist');
  const added = orch.appendUserSupplement('U12 重启也要还在', { recipientSids: ['s1', 's2'] });
  orch.markUserSupplementsDelivered('s1', [added.seq]);
  groupchat._private.resetCache();
  const reloaded = groupchat.getOrchestrator(root, 'persist');
  assert.deepStrictEqual(reloaded.pendingUserSupplementsFor('s1'), []);
  assert.deepStrictEqual(reloaded.pendingUserSupplementsFor('s2').map(x => x.text), ['U12 重启也要还在']);
});

test('任务结束后成员不再运行：消息继续保存，不伪称全员已接收', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'after-done');
  const added = orch.appendUserSupplement('收工之后又想起一句', { recipientSids: ['s1', 's2'] });
  assert.strictEqual(orch.pendingUserSupplementsFor('s2').length, 1);
  assert.strictEqual(orch.listUserSupplements().length, 1);
  assert.ok(added.seq > 0);
});

test('阻断4 很长的补充也要整段进 prompt：截断了却记成已送达等于丢消息', () => {
  const orch = groupchat.getOrchestrator(freshRoot(), 'long');
  // 维护者贴一大段需求（几万字的任务书片段并不罕见）
  const head = '开头标记-U12';
  const tail = '结尾标记-U12';
  const raw = [head, '中间正文'.repeat(6000), tail].join('|');
  const added = orch.appendUserSupplement(raw, { recipientSids: ['s1'] });
  const block = orch.buildUserSupplementBlock('s1');
  assert(block.includes(head), '开头要在');
  assert(block.includes(tail), '结尾也必须在 —— 尾巴被吃掉却标成已送达，等于悄悄丢了半条消息');
  assert(block.includes(raw), '同一条消息的原文整段保留，不拆不截');
  // 送达确认之后这条就不再自动重发，所以「送出去的必须是全文」是硬条件
  orch.markUserSupplementsDelivered('s1', [added.seq]);
  assert.deepStrictEqual(orch.pendingUserSupplementsFor('s1'), []);
});

console.log(`\n${pass} passed`);
