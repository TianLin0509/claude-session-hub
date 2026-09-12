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

test('C3 · 项目合同精简，旧协议留在旧模板，新流程由 Hub 注入', () => {
  const author = read('.agents/AUTHOR.md'), merger = read('.agents/MERGER.md');
  for (const contract of [author, merger]) {
    assert(!/ASK:|RESULT:|PROGRESS:|NOTES:/.test(contract));
    assert(contract.includes('project.json'));
    assert(contract.includes('node scripts/run_unit_tests.js'));
  }
  const WT = require('../renderer/workflow-templates.js');
  const members = [{memberId:'m1'}, {memberId:'m2'}];
  const legacy = WT.createTemplateConfig('dev-task', members, {devPhase:'build'});
  assert(legacy.stepConfigs[1].prompt.includes('RESULT: PASS 或 FAIL'));
  assert(legacy.stepConfigs[0].prompt.includes('PROGRESS / VERIFIED / RISK / REPORT'));
  const F = require('../core/dev-file-workflow');
  const prompt = F.phasePrompt({}, '/fixture', F.spec('merge', 1));
  assert(F.common({}, '/fixture').includes('不用固定英文标签'));
  assert(prompt.includes('大白话'));
  assert(prompt.includes('需返工-合并手册-轮次1.md'));
  assert.deepEqual(Feed.fields('PLAN: a\nUPDATE: b\nASK: c\nNOTES: d'), {PLAN:'a', UPDATE:'b', ASK:'c', NOTES:'d'});
});

test('E1 · 实时通道送来的 PLAN / ASK 要按各自标签落盘，并直接进摘要', () => {
  // 采集端（transcript-tap）已经把标签认出来了，落盘这一侧不能再把它们统统写成 UPDATE ——
  // 那样解析回来全是进展，方案和提问依旧显示不出来。
  const orch = groupchat.getOrchestrator(root, 'gc-live-tags');
  const { turnNum, runId } = orch.beginTurn('接通实时通道');
  orch.recordTurnPrompt(turnNum, 's1', '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  const t0 = Date.now();
  const say = (tag, text, offset) => orch.recordProgressUpdate('s1', text, t0 + offset, 'Claude 1', { tag });
  assert.equal(say('PLAN', '打算分两步\n先改解析器，再接工作台。', 1), true);
  assert.equal(say('UPDATE', '解析器改完了', 2), true);
  assert.equal(say('ASK', '手机推送要不要现在做？', 3), true);
  // 认不出的标签退回 UPDATE，而不是把原文丢掉
  assert.equal(say('WHATEVER', '未知标签也要落下来', 4), true);

  const messages = orch.state.messages.filter(m => m.status === 'progress_update');
  assert.deepEqual(messages.map(m => m.content.split(':')[0]), ['PLAN', 'UPDATE', 'ASK', 'UPDATE']);
  assert.equal(messages[0].content, 'PLAN: 打算分两步\n先改解析器，再接工作台。');

  const summary = orch.state.devWorkbench;
  assert.equal(summary.plan.text, '打算分两步\n先改解析器，再接工作台。', '方案没进摘要，工作台就显示不出来');
  assert.equal(summary.ask.text, '手机推送要不要现在做？');
  assert.equal(summary.update.text, '未知标签也要落下来', '任务行仍取最新一条进展');
  assert.deepEqual(summary.timeline.map(e => e.kind), ['plan', 'update', 'ask', 'update']);

  // 同一条 transcript 记录被重新读到（来源时刻一样）算重放，挡掉
  assert.equal(say('PLAN', '打算分两步\n先改解析器，再接工作台。', 1), false, '同一条来源记录重放不该再落一条');
});

test('E2 · 同一句话再说一遍是真进展，不是重放 —— 跑测试→修红→再跑测试', () => {
  // 合并位实测的反例：上一版按「正文相同」去重，把第三条真进展也拒了，
  // 工作台就永远停在「在修」那一句上，看起来像卡死。
  const orch = groupchat.getOrchestrator(root, 'gc-repeat-progress');
  const { turnNum, runId } = orch.beginTurn('区分重放与同文新消息');
  orch.recordTurnPrompt(turnNum, 's1', '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  const t0 = Date.now();
  const say = (text, offset) => orch.recordProgressUpdate('s1', text, t0 + offset, 'Claude 1', { tag: 'UPDATE' });

  assert.equal(say('开始跑单测', 1), true);
  assert.equal(say('有一条红，正在修', 2), true);
  assert.equal(say('开始跑单测', 3), true, 'A→B→A 的第三条是真进展，不许当成重放丢掉');

  const updates = orch.state.messages.filter(m => m.status === 'progress_update');
  assert.equal(updates.length, 3, '三条真进展只剩 ' + updates.length + ' 条');
  assert.deepEqual(updates.map(m => m.content),
    ['UPDATE: 开始跑单测', 'UPDATE: 有一条红，正在修', 'UPDATE: 开始跑单测']);
  assert.equal(orch.state.devWorkbench.update.text, '开始跑单测', '工作台停在旧状态了');

  // 重放判据：正文相同**且**来源时刻相同。三条各重放一遍，一条都不该多出来。
  assert.equal(say('开始跑单测', 1), false, '第一条的重放');
  assert.equal(say('有一条红，正在修', 2), false, '中间那条的重放');
  assert.equal(say('开始跑单测', 3), false, '最后一条的重放');
  assert.equal(orch.state.messages.filter(m => m.status === 'progress_update').length, 3);

  // 紧挨着的同一句仍然只留一条（来源没有时间戳、回落到 Date.now() 时靠这条兜底）
  assert.equal(say('开始跑单测', 4), false, '连着说同一句只留一条');
});

// ── 工作台一侧：需要我 / 任务纪事 / 项目名 ──────────────────────────────────
const { createDevWorkbench } = require('../main/groupchat/dev-workbench');
const Model = require('../renderer/dev-workbench-model');

function board(meetingId, workspace) {
  const meeting = { id: meetingId, title: '任务 ' + meetingId, scene: 'dev', groupChat: true, workspace,
    workspaceLabel: '好的，收到任务。我先阅读仓库的 `.agents/AUTHO',
    subSessions: ['s1', 's2'],
    serialWorkflow: { enabled: true, steps: [['m1'], ['m2']], loop: { enabled: true, maxRounds: 3 },
      loopState: { runId: 'run-' + meetingId, goal: '实现人话通道', status: 'paused', round: 1, currentStep: 'builder', history: [] } } };
  const instance = createDevWorkbench({
    meetingManager: { getMeeting: id => id === meetingId ? meeting : null, getAllMeetings: () => [meeting], updateMeeting: () => meeting },
    loopEngine: { getStatus: () => ({ running: false }), isRunning: () => false },
    getHubDataDir: () => root, sendToRenderer() {}, logger: { warn() {} }, readSummary: async () => ({ missing: true }),
  });
  return { instance, row: () => instance.snapshot().rows.find(r => r.id === meetingId) };
}

test('D1 · 旧 ASK 保留在历史摘要，但不冒充结构化用户待决事项', () => {
  const id = 'gc-ask';
  const orch = groupchat.getOrchestrator(root, id);
  const now = Date.now();
  orch.state.messages = [
    { id: 'u1', role: 'user', speaker: '你', turnNum: 1, createdAt: now },
    { id: 'a1-m1', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now + 10,
      content: 'ASK: 手机推送要不要现在做？\n做的话多半天，不做也不挡别的。' },
  ];
  const { instance, row } = board(id, root);
  try {
    orch._saveState();   // 摘要是落盘那一刻推给订阅者的，工作台必须先在场
    instance.flush();
    let r = row();
    assert.equal(r.attention, null, '旧 ASK 不计入当前待决事项');
    assert.ok(r.ask.includes('手机推送'), '原始摘要仍保留供兼容读取');

    // 维护者在群里回了一句 —— 这条提问就不该继续挂着
    orch.state.messages.push({ id: 'u2', role: 'user', speaker: '你', turnNum: 2, createdAt: now + 20 });
    orch._saveState(); instance.flush();
    r = row();
    assert.ok(!r.attention || r.attention.kind !== 'ask', '维护者回话后旧提问仍挂在「需要我」上');
    assert.equal(r.ask, '');
  } finally { instance.dispose(); }
});

test('D2 · 任务纪事随行下发；项目名读 project.json，读不到退回目录名', () => {
  const id = 'gc-chronicle';
  const orch = groupchat.getOrchestrator(root, id);
  const now = Date.now();
  orch.state.messages = [
    { id: 'p1-s1', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now, content: 'PLAN: 先改解析器\n再接工作台。' },
    { id: 'p1-s1.2', role: 'assistant', speaker: 'Claude 1', turnNum: 1, createdAt: now + 1, content: 'UPDATE: 解析器改完了' },
  ];

  // 没有 .agents/project.json：项目名留空，渲染层按目录名兜底
  const bare = fs.mkdtempSync(path.join(root, 'bare-'));
  let b = board(id, bare);
  try {
    orch._saveState();
    b.instance.flush();
    const r = b.row();
    assert.equal(r.project, '', '拿不到 project.json 时不该硬塞一个名字');
    assert.equal(Model.projectName(r), path.basename(bare), '渲染层要退回工作目录名');
    assert.ok(r.plan.includes('先改解析器'));
    assert.deepEqual(r.chronicle.map(e => e.kind), ['plan', 'update']);
  } finally { b.instance.dispose(); }

  // 有 project.json：用它的 name，而不是被自动标题污染的 workspaceLabel
  const named = fs.mkdtempSync(path.join(root, 'named-'));
  fs.mkdirSync(path.join(named, '.agents'));
  fs.writeFileSync(path.join(named, '.agents', 'project.json'), JSON.stringify({ name: 'AI HUB', trunk: 'master' }), 'utf8');
  b = board(id, named);
  try {
    orch._saveState();
    b.instance.flush();
    const r = b.row();
    assert.equal(r.project, 'AI HUB', '项目卡标题仍不是项目名');
    assert.ok(!r.project.includes('收到任务'), 'workspaceLabel 会被自动标题写成 AI 的第一句回复，不能再用它');
  } finally { b.instance.dispose(); }
});

console.log('\n通过 ' + pass + ' / 失败 0');
