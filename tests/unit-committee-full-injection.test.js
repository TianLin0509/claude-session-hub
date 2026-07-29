'use strict';
/**
 * [全量注入] 单测（2026-06-29 道雪）——投委会幕间复用自由群聊 deliveredIdx 机制，把上一幕委员发言
 * 全文注入下一幕，每个 AI 看到队友调研全文（点评看建库、辩论看点评），取代旧的 reviewsDigest 压缩摘要。
 * 真实执行 orchestrator：markDeliveredSilent(deliveredIdx 停本幕前) + buildDelta(includeCommitteeMid)。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inject-'));
const groupchat = require('../core/group-chat-orchestrator.js');
const root = path.join(__dirname, '..');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name); console.error('    ' + (e.stack || e.message)); }
}
function fresh() {
  const meetingId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return groupchat.getOrchestrator(tmp, meetingId);
}

console.log('--- 投委会全量注入 ---');

// ── 核心：点评幕看到建库全部委员发言 ──
test('点评幕 buildDelta(includeCommitteeMid) 带上建库幕全部队友发言全文', () => {
  const orch = fresh();
  const idxBeforeBuild = orch.state.messages.length - 1;        // 建库发言前的位置
  orch.appendCommitteeSpeeches([
    { sid: 's-claude',   speaker: 'Claude',   content: '基本面：旭光 PE 30、质押低、业绩兑现' },
    { sid: 's-deepseek', speaker: 'DeepSeek', content: '技术面：旭光 RS99 ADX56 强趋势' },
    { sid: 's-codex',    speaker: 'Codex',    content: '消息面：旭光 军工催化进行中' },
  ], { act: '建库' });
  // markDeliveredSilent 用 deliveredIdx 停在建库发言前（不推末尾）→ 下一幕看得到建库发言
  orch.markDeliveredSilent([
    { sid: 's-claude', deliveredIdx: idxBeforeBuild },
    { sid: 's-deepseek', deliveredIdx: idxBeforeBuild },
    { sid: 's-codex', deliveredIdx: idxBeforeBuild },
  ]);
  // 点评幕：DeepSeek 收到的 delta 应含 Claude/Codex 的建库全文（不含自己的）
  const p = orch.buildDelta('s-deepseek', '【点评】综合三面打分', { currentUserMessageAppended: false, includeCommitteeMid: true });
  assert.ok(p.includes('基本面：旭光 PE 30'), 'DeepSeek 点评 prompt 含 Claude 的基本面建库全文');
  assert.ok(p.includes('消息面：旭光 军工催化'), 'DeepSeek 点评 prompt 含 Codex 的消息面建库全文');
  assert.ok(!p.includes('技术面：旭光 RS99'), '不含自己的发言（sid===selfSid 过滤）');
});

// ── 对比：自由聊默认不注入中间幕（省 token，点6） ──
test('自由聊 buildDelta（默认 includeCommitteeMid=false）→ 中间幕发言不注入', () => {
  const orch = fresh();
  const idxBefore = orch.state.messages.length - 1;
  orch.appendCommitteeSpeeches([{ sid: 's-claude', speaker: 'Claude', content: '建库中间幕发言XYZ' }], { act: '建库' });
  orch.markDeliveredSilent([{ sid: 's-deepseek', deliveredIdx: idxBefore }]);
  const free = orch.buildDelta('s-deepseek', '自由聊提问', { currentUserMessageAppended: false });
  assert.ok(!free.includes('建库中间幕发言XYZ'), '自由聊默认不注入中间幕发言');
});

// ── outcome 发言（末轮辩论/收敛）始终注入（点6 回归自由聊） ──
test('outcome 发言即使 includeCommitteeMid=false 也注入（点6）', () => {
  const orch = fresh();
  const idxBefore = orch.state.messages.length - 1;
  orch.appendCommitteeSpeeches([{ sid: 's-claude', speaker: 'Claude', content: '收敛幕主席结论ABC' }], { act: '收敛', outcome: true });
  orch.markDeliveredSilent([{ sid: 's-deepseek', deliveredIdx: idxBefore }]);
  const free = orch.buildDelta('s-deepseek', '自由聊', { currentUserMessageAppended: false });
  assert.ok(free.includes('收敛幕主席结论ABC'), 'outcome 发言始终注入（回归自由聊带给没看到的 AI）');
});

// ── buildFirstDelta 透传 includeCommitteeMid ──
test('buildFirstDelta 首次带 systemPrompt + 透传 includeCommitteeMid', () => {
  const orch = fresh();
  orch.appendCommitteeSpeeches([{ sid: 's-claude', speaker: 'Claude', content: '建库全文MARK' }], { act: '建库' });
  const p = orch.buildFirstDelta('s-deepseek', '点评', 'SYSTEM_PROMPT_MARK', { currentUserMessageAppended: false, includeCommitteeMid: true });
  assert.ok(p.includes('SYSTEM_PROMPT_MARK'), '首次带 systemPrompt');
  assert.ok(p.includes('建库全文MARK'), 'includeCommitteeMid 透传到 buildDelta，带中间幕发言');
});

// ── dispatcher 静态契约：dispatchInternalPrompt 三件套 ──
test('dispatcher：dispatchInternalPrompt 记 deliveredIdx + 传 includeCommitteeMid + results 带出', () => {
  const d = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
  // 2026-07-29：切片按**函数边界**取，不再用固定 3200 字符 —— 函数里加几行注释就会把
  //   被断言的代码挤出窗口，制造与契约无关的假失败。
  const _start = d.indexOf('async function dispatchInternalPrompt');
  const _end = d.indexOf('function supersedeActiveWatchersForMeeting', _start);
  assert.ok(_start >= 0 && _end > _start, '找不到 dispatchInternalPrompt 函数体边界');
  const seg = d.slice(_start, _end);
  assert.ok(/const deliveredIdx = _orch\.state\.messages\.length - 1/.test(seg), '记录本幕发言前位置 deliveredIdx');
  assert.ok(/includeCommitteeMid: true/.test(seg), 'buildFirstDelta 传 includeCommitteeMid:true');
  assert.ok(/deliveredIdx: _deliveredIdx/.test(seg), 'results 带出 deliveredIdx 供 markDeliveredSilent');
});

// ── conductor 静态契约：三处 prompt 改造 ──
test('conductor：建库禁异步 + 点评综合三面 + 辩论删摘要', () => {
  const c = fs.readFileSync(path.join(root, 'main', 'groupchat', 'committee-conductor.js'), 'utf8');
  assert.ok(/不要\*\*起后台子任务/.test(c) || /不要.{0,4}起后台子任务/.test(c), '建库 prompt 禁后台异步子任务');
  assert.ok(/综合三面/.test(c), '点评 prompt 要求综合三面');
  assert.ok(/通读队友另外两面的调研/.test(c), '点评 prompt 让 AI 通读队友调研');
  assert.ok(!/reviewsDigest\(/.test(c), '辩论不再调用 reviewsDigest 摘要');
  assert.ok(/上一轮的完整发言|上一轮的点评全文|各委员上一轮/.test(c), '辩论 prompt 改为靠全量发言注入');
});

console.log(`\n${failed === 0 ? 'OK 全绿' : 'FAIL ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
