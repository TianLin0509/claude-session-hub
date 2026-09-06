'use strict';
/**
 * 人话通道 —— 维护者不看代码，他能看到的只有这几个标签里的内容。
 *
 * 用户 2026-09-06 的原话：「我之前其实强调希望 agent 们能输出更多（我看得懂的人话）
 * 让我了解进展、一些实现方向等等 —— 但完全没看到，是不是我没找到？」
 *
 * 查下来不是他没找到，是根本没有通道：
 *   ① 合同只写了「主动写一行 UPDATE」，而且重心全在「别写多」；
 *   ② Hub 侧每个席位每轮只保留一条 UPDATE，新的原地覆盖旧的 ——
 *      agent 中途写了五次，群里也只剩最后一次；
 *   ③ 解析器只取标签所在那一行，合同允许的「再写三五句展开」全被丢掉。
 *
 * 这个文件守三件事：
 *   C1 UPDATE 是追加，不是覆盖（过程不会被吃掉）
 *   C2 人话标签能带多行正文，而四行机器协议**不许**被段落污染
 *   C3 合同、工作流预设、解析器三方对齐（谁漂移谁红）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Feed = require('../core/dev-workbench-feed');
const groupchat = require('../core/group-chat-orchestrator');

const REPO = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf-8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-language-channel-'));
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-plain-language-channel');

test('C1 · 一轮里写多条进展会全部保留，工作台仍取最新那条', () => {
  const orch = groupchat.getOrchestrator(root, 'gc-append');
  const { turnNum, runId } = orch.beginTurn('实现人话通道');
  orch.recordTurnPrompt(turnNum, 's1', '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  const t0 = Date.now();
  for (const [i, text] of ['已复现问题', '方案改了：走解析器不走前端', '开始跑单测'].entries()) {
    assert.equal(orch.recordProgressUpdate('s1', text, t0 + i + 1, 'Claude 1'), true, '第 ' + (i + 1) + ' 条进展应当被记录');
  }
  const updates = orch.state.messages.filter(m => m.status === 'progress_update');
  assert.equal(updates.length, 3, '三条进展只剩 ' + updates.length + ' 条 —— 过程被覆盖掉了');
  assert.deepEqual(updates.map(m => m.content), [
    'UPDATE: 已复现问题', 'UPDATE: 方案改了：走解析器不走前端', 'UPDATE: 开始跑单测']);
  // id 不许互相顶掉，否则 anchor 和消息定位会指到同一条
  assert.equal(new Set(updates.map(m => m.id)).size, 3);
  // 兼容：第一条仍用老 id（追加的才带 .2/.3 后缀），老状态里的那条不会突然换身份
  const base = updates[0].id;
  assert.ok(base.startsWith(`p${turnNum}-s1`), '第一条过程汇报换了 id 前缀：' + base);
  assert.deepEqual(updates.slice(1).map(m => m.id), [base + '.2', base + '.3']);

  // 重复内容仍然去重（transcript 会把同一段文本重复喂过来）
  assert.equal(orch.recordProgressUpdate('s1', '开始跑单测', t0 + 50, 'Claude 1'), false, '同一句重复不该再记一条');
  // 工作台任务行只要「现在在干什么」，取最新一条
  assert.equal(orch.state.devWorkbench.update.text, '开始跑单测');
  // 纪事按时间排开，三条都在
  const kinds = orch.state.devWorkbench.timeline.filter(e => e.kind === 'update').map(e => e.text);
  assert.deepEqual(kinds, ['已复现问题', '方案改了：走解析器不走前端', '开始跑单测']);
});

test('C1b · 上限只防失控：到顶之后退回原地改写，不让 state 被刷爆', () => {
  const orch = groupchat.getOrchestrator(root, 'gc-cap');
  const { turnNum, runId } = orch.beginTurn('压一下上限');
  orch.recordTurnPrompt(turnNum, 's1', '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  const base = Date.now();
  for (let i = 0; i < 60; i++) orch.recordProgressUpdate('s1', '进展 ' + i, base + i + 1, 'Claude 1');
  const updates = orch.state.messages.filter(m => m.status === 'progress_update');
  assert.ok(updates.length <= 40, '过程汇报没有上限，一个刷屏的席位能把 state 撑爆：' + updates.length);
  assert.equal(updates[updates.length - 1].content, 'UPDATE: 进展 59', '到顶之后最新一条仍必须是真的最新');
});

test('C2 · 人话标签带多行正文，四行机器协议不许被段落污染', () => {
  const message = [
    'PLAN: 我打算分两步',
    '先把解析器改成能吃多行，再让工作台把纪事排开。',
    '',
    '取舍是不动四行协议，循环引擎那边一个字都不改。',
    '',
    '',
    '这段和方案无关，不该被算进 PLAN。',
    'UPDATE: 解析器改完了，正在接工作台',
    'PROGRESS: 打通了人话通道',
    'VERIFIED: 单测 380 个全过',
    'RISK: 无',
    'REPORT: 无',
    'NOTES: 给维护者的说明',
    '把「说人话」从一句叮嘱变成了四个有位置的标签。',
    '没做工作台的手机推送，那一项独立，可以以后再说。',
  ].join('\n');
  const f = Feed.fields(message);
  assert.ok(f.PLAN.includes('先把解析器') && f.PLAN.includes('取舍是不动四行协议'), '方案段落被截断了');
  assert.ok(!f.PLAN.includes('这段和方案无关'), '连着两行空之后还在吃正文，会把不相干的内容算进方案');
  assert.equal(f.PROGRESS, '打通了人话通道');
  assert.equal(f.VERIFIED, '单测 380 个全过');
  // 这是最容易出事的一条：四行协议若吃掉后续段落，REPORT 会变成一大段话，
  // 而工作台把它当路径显示、循环引擎把它当结论解析。
  assert.equal(f.REPORT, '无', 'REPORT 吃掉了后面的说明段落：' + JSON.stringify(f.REPORT));
  assert.ok(f.NOTES.includes('没做工作台的手机推送'), '交付说明必须能写成段落');

  // UPDATE 的老用法（单行）必须一字不差地照旧
  assert.equal(Feed.processUpdate('UPDATE: 只有一行'), '只有一行');
  assert.equal(Feed.processUpdate('PROGRESS: 最终汇报'), '');
});

test('C2b · 摘要里能拿到方案、提问和交付说明，且纪事有序', () => {
  const now = Date.now();
  const state = {
    revision: 3, currentTurn: 1,
    messages: [
      { id: 'p1-s1', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now, content: 'PLAN: 先改解析器\n再接工作台。' },
      { id: 'p1-s1.2', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now + 1, content: 'UPDATE: 解析器改完了' },
      { id: 'a1-m1', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now + 2, content: 'PROGRESS: 做完了\nVERIFIED: 380 个单测全过\nRISK: 无\nREPORT: 无\nNOTES: 顺带说明\n没做手机推送。' },
      { id: 'a1-m2', role: 'assistant', speaker: 'Codex 1', turnNum: 1, createdAt: now + 3, content: 'ASK: 手机推送要不要现在做？\n做的话多半天。\nRESULT: PASS\nBLOCKERS: 无\nVERIFIED: dry-run 全过\nNEXT: 无' },
    ],
  };
  const s = Feed.summarizeGroupState(state);
  assert.equal(s.plan.text, '先改解析器\n再接工作台。');
  assert.equal(s.ask.text, '手机推送要不要现在做？\n做的话多半天。');
  assert.equal(s.card.notes, '顺带说明\n没做手机推送。');
  assert.equal(s.review.decision, 'pass');
  assert.deepEqual(s.timeline.map(e => e.kind), ['plan', 'update', 'handoff', 'ask', 'review']);
  assert.ok(s.timeline[2].text.includes('没做手机推送'), '交付说明要跟着交付那条进纪事');
});

test('C3 · 合同、工作流预设、解析器三方对齐（谁漂移谁红）', () => {
  const author = read('.agents/AUTHOR.md');
  const merger = read('.agents/MERGER.md');
  const WT = require('../renderer/workflow-templates.js');
  const prompts = WT.createTemplateConfig('dev-task',
    [{ memberId: 'm1', kind: 'claude' }, { memberId: 'm2', kind: 'codex' }]).stepConfigs.map(s => s.prompt);

  for (const label of ['PLAN:', 'UPDATE:', 'ASK:', 'NOTES:']) {
    assert.ok(author.includes(label), 'AUTHOR.md 缺人话标签 ' + label);
    assert.ok(prompts[0].includes(label), '工作位 prompt 缺人话标签 ' + label);
  }
  for (const label of ['UPDATE:', 'ASK:', 'NOTES:']) {
    assert.ok(merger.includes(label), 'MERGER.md 缺人话标签 ' + label);
    assert.ok(prompts[1].includes(label), '合并位 prompt 缺人话标签 ' + label);
  }
  // 合同教的每个标签，解析器都必须真认得 —— 否则写了也进不了工作台
  const sample = 'PLAN: a\nUPDATE: b\nASK: c\nNOTES: d';
  assert.deepEqual(Feed.fields(sample), { PLAN: 'a', UPDATE: 'b', ASK: 'c', NOTES: 'd' });
  // 合同必须说明这些标签可以写成段落，否则 agent 照旧只写一行
  assert.ok(/下限/.test(author) && /下限/.test(merger), '合同要给字数下限而不是上限，这是这次改动的重点');
});

console.log('\n通过 ' + pass + ' / 失败 0');
