'use strict';

// 群聊记录 md + 增量预算 + 整群分支的状态迁移（2026-09-17）。
//
// 三件事各自的底线：
//   1. md 是权威消息流的投影，永远有全文，不许截断；过程汇报不收录。
//   2. prompt 里的历史有预算；超预算不是丢掉，而是换成「md 路径 + #序号」。
//   3. 整群分支必须把每一张按 sid 记的账本都改名到新会话，漏一张就等于
//      新群聊要么重灌历史、要么把成员认成陌生人。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const groupchat = require('../core/group-chat-orchestrator.js');
const transcript = require('../core/group-chat-transcript.js');
const { remapForkedGroupState } = require('../core/group-chat-fork.js');
const { HISTORY_INLINE_BUDGET, SINGLE_MESSAGE_INLINE_LIMIT } = groupchat._private;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gc-transcript-'));
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name); console.error(error.stack || error.message); }
}

let counter = 0;
function fresh() {
  counter += 1;
  const meetingId = `gc-fork-${Date.now()}-${counter}`;
  return { meetingId, orch: groupchat.getOrchestrator(tmp, meetingId) };
}

function member(sid, name) {
  return { sid, memberId: name.toLowerCase(), kind: 'codex', displayName: name };
}

console.log('Running group chat transcript / fork tests...');

// ── 群聊记录 md ──────────────────────────────────────────────────────────────

test('每轮结束后 md 落盘，正文是全文，过程汇报不收录', () => {
  const { orch, meetingId } = fresh();
  const { turnNum } = orch.beginTurn('第一个问题');
  orch.recordProgressUpdate?.(turnNum, 's-a', 'UPDATE: 正在查资料');
  orch.completeTurn(turnNum, '第一个问题', [
    { sid: 's-a', status: 'completed', text: '甲的完整回答\n第二行' },
    { sid: 's-b', status: 'errored', text: '' },
  ], { 's-a': member('s-a', 'Alpha'), 's-b': member('s-b', 'Beta') });

  const filePath = transcript.transcriptPath(tmp, meetingId);
  assert.ok(fs.existsSync(filePath), 'md 必须在状态保存时一起落盘');
  const text = fs.readFileSync(filePath, 'utf8');
  assert.match(text, /## 第 1 轮/);
  assert.match(text, /### #\d+ 你/);
  assert.ok(text.includes('第一个问题'), '用户提问必须在记录里');
  assert.ok(text.includes('甲的完整回答\n第二行'), '正文必须是全文，不能截断');
  assert.ok(text.includes('失败'), '失败状态要标出来');
  assert.ok(!text.includes('UPDATE: 正在查资料'), '过程汇报不进存档');
  assert.strictEqual(orch.transcriptPath(), filePath);
});

test('内容没变就不重写 md（每轮要保存十几次状态，不能每次都全量写盘）', () => {
  const { orch } = fresh();
  const { turnNum } = orch.beginTurn('问题');
  orch.completeTurn(turnNum, '问题', [{ sid: 's-a', status: 'completed', text: '答' }],
    { 's-a': member('s-a', 'Alpha') });
  const filePath = orch.transcriptPath();
  const before = fs.statSync(filePath).mtimeMs;
  const marker = '// 探针：内容未变时这行不该被覆盖';
  fs.appendFileSync(filePath, marker, 'utf8');
  orch.syncTranscriptFile();
  assert.ok(fs.readFileSync(filePath, 'utf8').includes(marker), '签名未变时不应重写');
  orch.syncTranscriptFile({ force: true });
  assert.ok(!fs.readFileSync(filePath, 'utf8').includes(marker), 'force 必须真的重写');
  assert.ok(before > 0);
});

test('删掉 meeting 时 md 一起清理', () => {
  const { orch, meetingId } = fresh();
  const { turnNum } = orch.beginTurn('问题');
  orch.completeTurn(turnNum, '问题', [{ sid: 's-a', status: 'completed', text: '答' }],
    { 's-a': member('s-a', 'Alpha') });
  const filePath = transcript.transcriptPath(tmp, meetingId);
  assert.ok(fs.existsSync(filePath));
  groupchat.cleanup(tmp, meetingId);
  assert.ok(!fs.existsSync(filePath), '群聊删除后不该留下记录文件');
  assert.ok(!fs.existsSync(groupchat.groupChatStatePath(tmp, meetingId)));
});

// ── 新成员补历史 + 预算 ──────────────────────────────────────────────────────

test('新成员的第一条 prompt 带群规、记录路径和历史问答', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('老问题');
  orch.completeTurn(first.turnNum, '老问题', [{ sid: 's-a', status: 'completed', text: '老回答' }],
    { 's-a': member('s-a', 'Alpha') });
  orch.beginTurn('新问题');

  const prompt = orch.buildFirstDelta('s-new', '新问题', '## 规则\n你是 Gamma。');
  assert.ok(prompt.startsWith('## 规则'), '首次必须带群规');
  assert.ok(prompt.includes('## 群聊记录'), '首次必须告诉它完整记录在哪');
  assert.ok(prompt.includes(orch.transcriptPath()), '记录路径必须是真实绝对路径');
  assert.ok(prompt.includes('你：老问题'), '新成员要知道之前问过什么');
  assert.ok(prompt.includes('Alpha：老回答'), '新成员要看到队友答过什么');
  assert.ok(prompt.trimEnd().endsWith('请发言。'));
});

test('空群聊的第一位成员不会收到记录路径这段噪声', () => {
  const { orch } = fresh();
  orch.beginTurn('第一个问题');
  const prompt = orch.buildFirstDelta('s-a', '第一个问题', '## 规则');
  assert.ok(!prompt.includes('## 群聊记录'));
});

test('历史超预算时改给 md 路径，而不是硬塞进 prompt', () => {
  const { orch } = fresh();
  const chunk = '很长的讨论内容。'.repeat(400); // 约 3200 字符
  const rounds = Math.ceil((HISTORY_INLINE_BUDGET / chunk.length) * 2);
  for (let i = 0; i < rounds; i += 1) {
    const { turnNum } = orch.beginTurn(`问题 ${i}`);
    orch.completeTurn(turnNum, `问题 ${i}`, [{ sid: 's-a', status: 'completed', text: `${chunk}#${i}` }],
      { 's-a': member('s-a', 'Alpha') });
  }
  orch.beginTurn('最新问题');
  const prompt = orch.buildFirstDelta('s-new', '最新问题', '## 规则');
  const history = prompt.split('## 用户')[0];
  assert.ok(history.length < HISTORY_INLINE_BUDGET * 1.5, `历史段必须受预算约束，实际 ${history.length}`);
  assert.match(prompt, /更早的 \d+ 条没有展开/);
  assert.ok(prompt.includes(orch.transcriptPath()), '没展开的部分必须给出可读的文件路径');
  assert.ok(prompt.includes(`${chunk}#${rounds - 1}`), '最近一条必须完整内联');
  // 而 md 里必须什么都不少
  const text = fs.readFileSync(orch.transcriptPath(), 'utf8');
  for (let i = 0; i < rounds; i += 1) assert.ok(text.includes(`${chunk}#${i}`), `md 里缺了第 ${i} 轮`);
});

test('单条超长发言只给开头，并在原地说明去哪看全文', () => {
  const { orch } = fresh();
  const huge = 'X'.repeat(SINGLE_MESSAGE_INLINE_LIMIT + 5000);
  const { turnNum } = orch.beginTurn('问题');
  orch.completeTurn(turnNum, '问题', [{ sid: 's-a', status: 'completed', text: huge }],
    { 's-a': member('s-a', 'Alpha') });
  orch.beginTurn('下一个问题');
  const prompt = orch.buildFirstDelta('s-new', '下一个问题', '## 规则');
  assert.ok(prompt.includes('这条太长'), '截断必须看得见');
  assert.match(prompt, /全文见群聊记录 #\d+/);
  assert.ok(prompt.length < huge.length, '不能把超长原文整个塞进去');
  assert.ok(fs.readFileSync(orch.transcriptPath(), 'utf8').includes(huge), 'md 必须留着全文');
});

test('老成员每轮只拿到队友新发言，历史不会重复灌', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('问题一');
  // 调度器按「派发那一刻的位置」记游标，本轮队友的答复才会留到下一轮送出。
  const deliveredIdx = orch.state.messages.length - 1;
  orch.completeTurn(first.turnNum, '问题一', [
    { sid: 's-a', status: 'completed', text: '甲答一', deliveredIdx },
    { sid: 's-b', status: 'completed', text: '乙答一', deliveredIdx },
  ], { 's-a': member('s-a', 'Alpha'), 's-b': member('s-b', 'Beta') });
  orch.beginTurn('问题二');
  const prompt = orch.buildFirstDelta('s-a', '问题二', '## 规则');
  assert.ok(!prompt.includes('## 规则'), '发过言的成员不再重发群规');
  assert.ok(prompt.includes('乙答一'), '队友的新发言要带上');
  assert.ok(!prompt.includes('甲答一'), '自己说过的话不回灌');
  assert.ok(!prompt.includes('问题一'), '已经收到过的问题不重复');
});

// ── 整群分支的状态迁移 ──────────────────────────────────────────────────────

test('分支把每一张按 sid 记的账本都改名到新会话', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('问题一');
  // 成员身份由调度器在发 prompt 时登记，这里照它的顺序补上。
  orch.ensureMemberIdentity('s-a', 'm1');
  orch.ensureMemberIdentity('s-b', 'm2');
  orch.completeTurn(first.turnNum, '问题一', [
    { sid: 's-a', status: 'completed', text: '甲答' },
    { sid: 's-b', status: 'completed', text: '乙答' },
  ], { 's-a': member('s-a', 'Alpha'), 's-b': member('s-b', 'Beta') });
  orch.appendUserSupplement('顺带补一句', { recipientSids: ['s-a', 's-b'] });
  const source = orch.getState();

  const target = groupchat.getOrchestrator(tmp, `${orch.meetingId}-fork`);
  const imported = target.importForkedState(source, {
    sidMap: { 's-a': 'n-a', 's-b': 'n-b' },
    sourceMeetingId: orch.meetingId,
    sourceTitle: '源群聊',
  });

  assert.deepStrictEqual(Object.keys(imported.lastDeliveredSeq).sort(), ['n-a', 'n-b']);
  assert.deepStrictEqual(Object.keys(imported.memberIdsBySid).sort(), ['n-a', 'n-b']);
  assert.deepStrictEqual(Object.keys(imported.aiStats).sort(), ['n-a', 'n-b']);
  assert.deepStrictEqual(Object.keys(imported.userSupplements.deliveredBySid || {}).sort(), []);
  assert.deepStrictEqual(Object.keys(imported.userSupplements.pendingBySid).sort(), ['n-a', 'n-b']);
  assert.ok(imported.messages.some(m => m.sid === 'n-a' && m.content === '甲答'));
  assert.ok(!imported.messages.some(m => m.sid === 's-a'), '不能留下指向源会话的消息');
  assert.ok(imported.messages.every(m => !m.anchor || m.anchor.includes(target.meetingId)), 'anchor 要指向新群聊');
  assert.strictEqual(imported.currentMode, 'idle');
  assert.deepStrictEqual(imported.attempts, {});
  // 只留导入这一条事件；源群聊的在途投递账本一条都不继承（它们指向源侧的原生 turn）。
  assert.deepStrictEqual(imported.attemptEvents.map(e => e.type), ['forked_state_imported']);
  assert.strictEqual(imported.activeRun, null);
  assert.strictEqual(imported.forkedFrom.meetingId, orch.meetingId);
  assert.strictEqual(imported.currentTurn, source.currentTurn);

  // 分支之后各聊各的：新群聊的成员不该再收到已经读过的历史。
  target.beginTurn('分支后的新问题');
  const prompt = target.buildFirstDelta('n-a', '分支后的新问题', '## 规则');
  assert.ok(!prompt.includes('甲答'), '继承了游标，就不该重灌历史');
  assert.ok(!prompt.includes('## 规则'), '继承了游标，就不该重发群规');
});

test('分支到已有发言的群聊会被拒绝（那是覆盖历史，不是分支）', () => {
  const { orch } = fresh();
  const first = orch.beginTurn('问题');
  orch.completeTurn(first.turnNum, '问题', [{ sid: 's-a', status: 'completed', text: '答' }],
    { 's-a': member('s-a', 'Alpha') });

  const other = fresh();
  other.orch.beginTurn('这个群聊已经聊过了');
  assert.throws(() => other.orch.importForkedState(orch.getState(), { sidMap: { 's-a': 'n-a' } }),
    /已经有发言/);
});

test('源群聊里已退群成员的账本不会被带进分支', () => {
  const state = {
    schemaVersion: 4,
    meetingId: 'src',
    currentTurn: 1,
    messages: [{ id: 'a1-x', seq: 1, role: 'assistant', sid: 's-gone', content: '退群成员说过的话' }],
    lastDeliveredSeq: { 's-a': 1, 's-gone': 1 },
    memberIdsBySid: { 's-a': 'm1', 's-gone': 'm9' },
    aiStats: { 's-gone': { turns: 3 } },
    turns: [{ n: 1, by: { 's-a': '甲', 's-gone': '旧' } }],
    nextMessageSeq: 2,
  };
  const next = remapForkedGroupState(state, { meetingId: 'dst', sidMap: { 's-a': 'n-a' } });
  assert.deepStrictEqual(Object.keys(next.lastDeliveredSeq), ['n-a']);
  assert.deepStrictEqual(Object.keys(next.memberIdsBySid), ['n-a']);
  assert.deepStrictEqual(next.aiStats, {});
  // 但历史正文要留着：那是真实发生过的讨论。只是 sid 必须改成明确「已经不在了」，
  // 不能原样指向源群聊里那个会话（否则新群聊的卡片会把人带去别人的房间）。
  assert.strictEqual(next.messages[0].content, '退群成员说过的话');
  assert.strictEqual(next.messages[0].sid, 'fork-orphan:s-gone');
  assert.strictEqual(next.messages[0].orphanedFromFork, true);
  assert.strictEqual(next.turns[0].by['fork-orphan:s-gone'], '旧');
  assert.ok(!('s-gone' in next.turns[0].by));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
