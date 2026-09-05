'use strict';
const assert = require('assert');
const DP = require('../renderer/dev-progress.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-progress');

// ── 人话卡解析 ─────────────────────────────────────────────────────────────
test('抠得出四行人话卡', () => {
  const c = DP.parseProgressCard([
    '我改完了，下面是汇报。',
    'PROGRESS: 给 TBS 计算补上了 PDCCH 开销的扣除',
    'VERIFIED: 337 个单测全过，新加 3 条',
    'RISK: 吞吐量估计会比之前略低',
    'REPORT: C:\\Users\\x\\a.html',
  ].join('\n'));
  assert(c);
  assert.strictEqual(c.progress, '给 TBS 计算补上了 PDCCH 开销的扣除');
  assert.strictEqual(c.verified, '337 个单测全过，新加 3 条');
  assert.strictEqual(c.risk, '吞吐量估计会比之前略低');
  assert.strictEqual(c.report, 'C:\\Users\\x\\a.html');
});

test('「无」一律归一成空，不要在看板上显示「风险：无」这种废话', () => {
  const c = DP.parseProgressCard('PROGRESS: 改了文档\nRISK: 无\nREPORT: 无');
  assert.strictEqual(c.risk, '');
  assert.strictEqual(c.report, '');
});

test('中文冒号也认（Agent 经常打成全角）', () => {
  const c = DP.parseProgressCard('PROGRESS：修好了登录\nVERIFIED：跑了 12 条');
  assert(c && c.progress === '修好了登录' && c.verified === '跑了 12 条');
});

test('没有 PROGRESS 就不算一张卡（半张卡会让人误以为这步做完了）', () => {
  assert.strictEqual(DP.parseProgressCard('RISK: 有点风险'), null);
  assert.strictEqual(DP.parseProgressCard('我干完了'), null);
  assert.strictEqual(DP.parseProgressCard(''), null);
  assert.strictEqual(DP.parseProgressCard(null), null);
});

// ── 判定解析 ───────────────────────────────────────────────────────────────
test('认得出 PASS / FAIL，并带出阻断项', () => {
  const p = DP.parseReviewCard('RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 跑了 337 条\nNEXT: 无');
  assert.strictEqual(p.decision, 'pass');
  assert.strictEqual(p.blockers, '');

  const f = DP.parseReviewCard('RESULT: FAIL\nBLOCKERS: 边界情况没测\nVERIFIED: 1 条红\nNEXT: 补测试');
  assert.strictEqual(f.decision, 'fail');
  assert.strictEqual(f.blockers, '边界情况没测');
});

test('不按格式就返回 null，不瞎猜', () => {
  assert.strictEqual(DP.parseReviewCard('我觉得可以合了'), null);
});

// ── 阶段推导（不问 Agent，全从 Hub 自己的数据算）──────────────────────────
test('没跑过 = 未开始', () => {
  assert.strictEqual(DP.deriveStage({}).key, 'idle');
});

test('跑第 0 步 = 工作位实现中；第 1 步 = 合并位审查中', () => {
  const w = DP.deriveStage({ serialWorkflow: { loopState: { running: true, stepIndex: 0 } } });
  assert.strictEqual(w.key, 'working');
  const r = DP.deriveStage({ serialWorkflow: { loopState: { running: true, stepIndex: 1 } } });
  assert.strictEqual(r.key, 'reviewing');
});

test('按 loop-engine 真实持久化字段识别运行态与当前步骤', () => {
  const w = DP.deriveStage({
    serialWorkflow: { loopState: { status: 'running', currentStep: 'builder', round: 0 } },
  });
  assert.strictEqual(w.key, 'working');
  assert.strictEqual(w.running, true);

  const r = DP.deriveStage({
    serialWorkflow: { loopState: { status: 'running', currentStep: 'reviewer', round: 0 } },
  });
  assert.strictEqual(r.key, 'reviewing');
  assert.strictEqual(r.running, true);
});

test('status=done 或有过 PASS = 已通过', () => {
  assert.strictEqual(DP.deriveStage({ serialWorkflow: { loopState: { status: 'done' } } }).key, 'passed');
  assert.strictEqual(
    DP.deriveStage({ serialWorkflow: { loopState: { history: [{ pass: true }] } } }).key, 'passed');
});

test('轮次用尽且没过 = 等你决定（不能显示成普通停止，那会被忽略）', () => {
  const s = DP.deriveStage({
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { status: 'stopped', round: 3 } },
  });
  assert.strictEqual(s.key, 'exhausted');
  assert.strictEqual(s.tone, 'bad');
});

test('loopState 必须从 serialWorkflow 下面取（取错层级会永远显示未开始）', () => {
  // 这是写 E2E 时踩过的坑：状态在 meeting.serialWorkflow.loopState，
  // 不是 meeting.status，也不是 meeting.state.status。
  const wrong = DP.deriveStage({ status: 'done' });
  assert.strictEqual(wrong.key, 'idle', '放错层级不该被误读成已完成');
});

// ── 看板一行 ───────────────────────────────────────────────────────────────
test('看板一行 = 推导的阶段 + 申报的人话', () => {
  const meeting = {
    id: 'm-1', title: '刷新文档', scene: 'dev', groupChat: true,
    workspaceLabel: 'AI HUB',
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { running: true, stepIndex: 1, round: 2 } },
  };
  const msgs = [
    { text: 'PROGRESS: 刷新了 3 份文档\nVERIFIED: 337 个单测全过\nRISK: 无' },
    { text: 'RESULT: FAIL\nBLOCKERS: 有一份漏了\nVERIFIED: 看了 diff\nNEXT: 补上' },
  ];
  const row = DP.boardRow(meeting, msgs);
  assert.strictEqual(row.stage.key, 'reviewing');      // 推导
  assert.strictEqual(row.stage.round, 2);
  assert.strictEqual(row.progress, '刷新了 3 份文档');  // 申报
  assert.strictEqual(row.risk, '');                     // 「无」归一成空
  assert.strictEqual(row.blockers, '有一份漏了');
  assert.strictEqual(row.workspace, 'AI HUB');
});

test('取最新的卡，不是最早的', () => {
  const { card } = DP.latestCards([
    { text: 'PROGRESS: 第一版' },
    { text: 'PROGRESS: 第二版' },
  ]);
  assert.strictEqual(card.progress, '第二版');
});

test('从 groupchat 真实 messages 结构提取 AI 人话卡，不把用户原文当成进度', () => {
  const messages = DP.messagesFromGroupState({
    turns: [{ n: 1, by: { s1: '旧兼容数据' } }],
    messages: [
      { role: 'user', content: '请最后输出 PROGRESS: 这不是完成申报' },
      { role: 'assistant', content: 'PROGRESS: 已修复状态推导\nVERIFIED: 16 条通过' },
      { role: 'assistant', content: 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 全量通过\nNEXT: 无' },
    ],
  });
  assert.deepStrictEqual(messages, [
    { text: 'PROGRESS: 已修复状态推导\nVERIFIED: 16 条通过' },
    { text: 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 全量通过\nNEXT: 无' },
  ]);
});

test('只认开发场景的群聊', () => {
  assert.strictEqual(DP.isDevMeeting({ groupChat: true, scene: 'dev' }), true);
  assert.strictEqual(DP.isDevMeeting({ groupChat: true, scene: 'research' }), false);
  assert.strictEqual(DP.isDevMeeting({ scene: 'dev' }), false);   // 单聊不算
  assert.strictEqual(DP.isDevMeeting(null), false);
});

test('闲置时长能算出来', () => {
  assert.strictEqual(DP.idleFor({ lastActiveTs: Date.now() - 5 * 60000 }), '5 分钟前');
  assert.strictEqual(DP.idleFor({ lastActiveTs: Date.now() - 3 * 3600000 }), '3 小时前');
  assert.strictEqual(DP.idleFor({}), '');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
