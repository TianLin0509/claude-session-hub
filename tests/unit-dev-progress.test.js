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

// ── C 层：真实用户会遇到的「停了」，必须分得清是哪一种 ────────────────────
test('四种停止原因显示成四种不同说法（以前全叫「已停止」，等于什么都没说）', () => {
  const mk = (status, round) => DP.deriveStage({
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { status, round: round || 0 } },
  });
  assert.strictEqual(mk('stopped_user').label, '你已停止');
  assert.strictEqual(mk('stopped_max', 3).label, '返工用尽，等你决定');
  assert.strictEqual(mk('stopped_deadline').label, '超时停止');
  assert.strictEqual(mk('stopped_stuck').label, '卡住了，没进展');
  assert.strictEqual(mk('paused').label, '出错暂停，等你处理');
  assert.strictEqual(mk('done').label, '已通过');
  // 四种「坏」状态都得是刺眼的色调，不能混在普通灰色里被忽略
  for (const s of ['stopped_max', 'stopped_deadline', 'stopped_stuck', 'paused']) {
    assert.strictEqual(mk(s, 3).tone, 'bad', s + ' 应该显眼');
  }
  // 用户自己停的不算故障，不该报红
  assert.strictEqual(mk('stopped_user').tone, 'idle');
});

test('引擎源码里出现的每个 status，看板都必须认识（新增状态忘登记就会红）', () => {
  // 这条守的是「悄悄退化」：以后有人给引擎加了新终态却没在看板登记，
  // 用户看到的会是含糊的「已停止」而不是真实原因。让测试先红，别让用户去猜。
  const fs2 = require('fs');
  const path2 = require('path');
  const REPO2 = path2.resolve(__dirname, '..');
  const srcs = [
    fs2.readFileSync(path2.join(REPO2, 'main/groupchat/loop-engine.js'), 'utf-8'),
    fs2.readFileSync(path2.join(REPO2, 'renderer/loop-workflow.js'), 'utf-8'),
  ].join('\n');

  // 只认「写进循环状态」的那些：state.status = '...'（引擎）与 status: '...'（loop-workflow
  // 构造 loopState 的地方）。dispatch 结果自己的 status（completed/errored 等）不在此列。
  const found = new Set();
  for (const m of srcs.matchAll(/state\.status\s*=\s*'([a-z_]+)'/g)) found.add(m[1]);
  for (const m of srcs.matchAll(/\bstatus:\s*'(done|running|stopped_[a-z_]+|paused)'/g)) found.add(m[1]);
  // running 由 deriveStage 单独处理（映射到工作位/合并位两种进行中）
  found.delete('running');
  assert(found.size >= 5, '应该抠到多个终态，实得 ' + [...found].join(','));

  const known = new Set(Object.keys(DP.STATUS_TO_STAGE));
  const missing = [...found].filter(s => !known.has(s));
  assert.deepStrictEqual(missing, [],
    '引擎会写这些 status 但看板没登记，用户会看到含糊的「已停止」：' + missing.join(', '));

  // 反向：登记表里每个目标 stage 都得真实存在且有说法
  for (const [status, key] of Object.entries(DP.STATUS_TO_STAGE)) {
    assert(DP.STAGE[key], status + ' 指向了不存在的 stage: ' + key);
    assert(DP.STAGE[key].label && DP.STAGE[key].label.length > 1, key + ' 缺少可读的 label');
  }
});

test('认不出的新状态回落到「已停止」，不冒充「返工用尽」', () => {
  const s = DP.deriveStage({
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { status: 'some_future_status', round: 1 } },
  });
  assert.strictEqual(s.key, 'stopped', '未知状态不该被猜成别的具体原因');
  assert(s.label);
});

test('闲置时长能算出来', () => {
  assert.strictEqual(DP.idleFor({ lastActiveTs: Date.now() - 5 * 60000 }), '5 分钟前');
  assert.strictEqual(DP.idleFor({ lastActiveTs: Date.now() - 3 * 3600000 }), '3 小时前');
  assert.strictEqual(DP.idleFor({}), '');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
