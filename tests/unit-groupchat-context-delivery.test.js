'use strict';
// 2026-09-26 群聊上下文送达的四件事：
//   1. 缺席 / 发送失败的成员不推进「已读」游标 —— 下一轮补上漏掉的内容，首次失败者仍拿到群规则；
//   2. CLI 压缩上下文后重发一次群规则（与梦境索引 / 工作区规则共用同一压缩判据）；
//   3. 首轮群规则带成员名单（只写名字 + CLI/模型），名单增减时给老成员一行变更；
//   4. 重启续作从 attempt 还原结果时，不送达的标记要跟着留下来。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const groupchat = require('../core/group-chat-orchestrator.js');
const { checkCompaction, COMPACTION_MIN_PEAK } = require('../core/context-compaction.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gc-context-'));
let seed = 0;
function fresh() {
  const meetingId = `gc-context-${process.pid}-${++seed}`;
  return { meetingId, orch: groupchat.getOrchestrator(TMP, meetingId) };
}

const RULES = '## 规则\n- 这里是AI群聊，你是X。';
const members = {
  a: { sid: 'a', memberId: 'm1', displayName: 'Claude', kind: 'claude' },
  b: { sid: 'b', memberId: 'm2', displayName: 'Codex', kind: 'codex' },
  c: { sid: 'c', memberId: 'm3', displayName: 'Gemini', kind: 'gemini' },
};
const roster = [
  { sid: 'a', name: 'Claude', kind: 'claude', model: 'claude-haiku-4-5' },
  { sid: 'b', name: 'Codex', kind: 'codex', model: 'gpt-6-astra' },
  { sid: 'c', name: 'Gemini', kind: 'gemini' },
];

// 一轮：给每位成员建 prompt，按 outcome 结算。返回各人本轮收到的 prompt。
function runTurn(orch, userInput, outcomes, opts = {}) {
  const begin = orch.beginTurn(userInput, { appendUserMessage: true });
  const deliveredIdx = orch.state.messages.length - 1;
  const deliveredSeq = orch.state.messages[deliveredIdx].seq;
  const prompts = {};
  for (const sid of Object.keys(outcomes)) {
    if (outcomes[sid] === 'absent') continue;
    prompts[sid] = orch.buildFirstDelta(sid, userInput, RULES, {
      currentUserMessageAppended: true,
      roster: opts.roster || roster,
      contextUsed: opts.contextUsed ? opts.contextUsed[sid] : undefined,
    });
  }
  const results = Object.entries(outcomes).map(([sid, outcome]) => {
    if (outcome === 'absent') {
      return { sid, status: 'absent', text: '', reason: 'session_not_ready', deliveredIdx: null, promptDelivered: false };
    }
    if (outcome === 'send_failed') {
      return { sid, status: 'errored', text: '', reason: 'cli_not_ready', deliveredIdx, deliveredSeq, promptDelivered: false };
    }
    return { sid, status: 'completed', text: String(outcome), deliveredIdx, deliveredSeq };
  });
  orch.completeTurn(begin.turnNum, userInput, results, members);
  return prompts;
}

test('缺席成员不推进游标：下一轮能收到它漏掉的问题和队友发言，且仍拿到群规则', () => {
  const { orch } = fresh();
  runTurn(orch, '第一问', { a: 'A 的第一轮答复', b: 'B 的第一轮答复', c: 'absent' });
  assert.equal(orch.state.lastDeliveredIdx.c, undefined, '缺席者的游标必须保持原位');
  assert.equal(orch.state.lastDeliveredSeq.c, undefined);
  assert.ok(Number.isInteger(orch.state.lastDeliveredSeq.a));

  const prompts = runTurn(orch, '第二问', { a: 'A2', b: 'B2', c: 'C2' });
  assert.match(prompts.c, /## 规则/, '从没收到过规则的成员这次必须拿到群规则');
  assert.match(prompts.c, /第一问/, '漏掉的用户提问要补上');
  assert.match(prompts.c, /A 的第一轮答复/);
  assert.match(prompts.c, /B 的第一轮答复/);
  assert.doesNotMatch(prompts.a, /## 规则/, '老成员不重复收规则');
  assert.doesNotMatch(prompts.a, /A 的第一轮答复/, '自己的发言不回灌');
  assert.match(prompts.a, /B 的第一轮答复/);
});

test('首次参与即发送失败：下一轮仍按首次参与处理（群规则 + 漏掉的内容）', () => {
  const { orch } = fresh();
  const first = runTurn(orch, '开场问题', { a: 'A 开场答复', b: 'send_failed' });
  assert.match(first.b, /## 规则/);
  assert.equal(orch.state.lastDeliveredIdx.b, undefined, '发送失败者不能被当成老成员');
  assert.equal(orch.state.groupContextBySid.b, undefined, '没送达就不记群规则回执');

  const second = runTurn(orch, '追问', { a: 'A 追问答复', b: 'B 终于答了' });
  assert.match(second.b, /## 规则/);
  assert.match(second.b, /开场问题/);
  assert.match(second.b, /A 开场答复/);
  const third = runTurn(orch, '再问', { a: 'A3', b: 'B3' });
  assert.doesNotMatch(third.b, /## 规则/, '送达之后不再重复发规则');
});

test('老调用方（结果不带 promptDelivered）行为不变：照常推进游标', () => {
  const { orch } = fresh();
  const begin = orch.beginTurn('问', { appendUserMessage: true });
  orch.completeTurn(begin.turnNum, '问', [{ sid: 'a', status: 'errored', text: '' }], members);
  assert.ok(Number.isInteger(orch.state.lastDeliveredIdx.a));
});

test('投委会 silent 路径：发送失败的委员同样不推进', () => {
  const { orch } = fresh();
  orch.buildFirstDelta('a', '幕一', RULES, { includeCommitteeMid: true });
  orch.buildFirstDelta('b', '幕一', RULES, { includeCommitteeMid: true });
  orch.markDeliveredSilent([
    { sid: 'a', status: 'completed', text: 'x', deliveredIdx: -1, deliveredSeq: 0 },
    { sid: 'b', status: 'errored', text: '', promptDelivered: false, deliveredIdx: -1, deliveredSeq: 0 },
  ]);
  assert.equal(orch.state.lastDeliveredSeq.a, 0);
  assert.equal(orch.state.lastDeliveredIdx.b, undefined);
  assert.match(orch.buildFirstDelta('b', '幕二', RULES, { includeCommitteeMid: true }), /## 规则/);
  assert.doesNotMatch(orch.buildFirstDelta('a', '幕二', RULES, { includeCommitteeMid: true }), /## 规则/);
});

test('attempt 结算保留「未送达」标记，供重启续作还原', () => {
  const { orch } = fresh();
  const begin = orch.beginTurn('问', { appendUserMessage: true });
  const receipt = orch.recordTurnPrompt(begin.turnNum, 'b', 'prompt', { runId: begin.runId, kind: 'codex' });
  orch.settleAttempt(receipt.attemptId, { status: 'errored', promptDelivered: false, reason: 'cli_not_ready' });
  assert.equal(orch.getAttempt(receipt.attemptId).promptDelivered, false);
  const receipt2 = orch.recordTurnPrompt(begin.turnNum, 'a', 'prompt', { runId: begin.runId, kind: 'claude' });
  orch.settleAttempt(receipt2.attemptId, { status: 'completed', text: 'ok' });
  assert.equal(orch.getAttempt(receipt2.attemptId).promptDelivered, undefined);
});

test('压缩判据与梦境索引共用：跌破峰值一半才算压缩，峰值太小不算', () => {
  assert.deepEqual(checkCompaction(0, null), { compacted: false, peak: 0 });
  assert.deepEqual(checkCompaction(0, 50000), { compacted: false, peak: 50000 });
  assert.deepEqual(checkCompaction(100000, 90000), { compacted: false, peak: 100000 });
  assert.deepEqual(checkCompaction(100000, 30000), { compacted: true, peak: 100000 });
  assert.equal(checkCompaction(COMPACTION_MIN_PEAK - 1, 1).compacted, false);
});

test('压缩后重发一次群规则；没送达就下一轮继续重发；送达后不再重复', () => {
  const { orch } = fresh();
  runTurn(orch, 'q1', { a: 'A1' }, { contextUsed: { a: 20000 } });
  let p = runTurn(orch, 'q2', { a: 'A2' }, { contextUsed: { a: 60000 } });
  assert.doesNotMatch(p.a, /## 规则/);
  p = runTurn(orch, 'q3', { a: 'A3' }, { contextUsed: { a: 120000 } });
  assert.doesNotMatch(p.a, /## 规则/);
  assert.equal(orch.state.groupContextBySid.a.peakContext, 120000);

  // CLI 压缩了：已用上下文掉到峰值一半以下。本轮发送失败 → 下一轮还要重发。
  p = runTurn(orch, 'q4', { a: 'send_failed' }, { contextUsed: { a: 30000 } });
  assert.match(p.a, /## 规则/, '压缩后必须重发群规则');
  assert.match(p.a, /## 群成员/, '重发的群规则带名单');
  p = runTurn(orch, 'q5', { a: 'A5' }, { contextUsed: { a: 31000 } });
  assert.match(p.a, /## 规则/, '上次没送达，这次继续重发');
  assert.equal(orch.state.groupContextBySid.a.peakContext, 0, '送达后峰值重新观测');

  p = runTurn(orch, 'q6', { a: 'A6' }, { contextUsed: { a: 35000 } });
  assert.doesNotMatch(p.a, /## 规则/, '只重发一次');
  p = runTurn(orch, 'q7', { a: 'A7' }, { contextUsed: { a: 90000 } });
  assert.doesNotMatch(p.a, /## 规则/);
});

test('拿不到已用上下文时不猜，不重发', () => {
  const { orch } = fresh();
  runTurn(orch, 'q1', { a: 'A1' }, { contextUsed: { a: 150000 } });
  runTurn(orch, 'q2', { a: 'A2' }, { contextUsed: { a: 160000 } });
  const p = runTurn(orch, 'q3', { a: 'A3' });
  assert.doesNotMatch(p.a, /## 规则/);
});

test('首轮群规则带成员名单：只有名字 + CLI/模型，不带角色描述', () => {
  const { orch } = fresh();
  const p = runTurn(orch, '开场', { a: 'A', b: 'B', c: 'C' });
  const block = p.a.split('## 群成员')[1].split('\n\n')[0];
  assert.match(block, /- Claude（claude \/ claude-haiku-4-5）（你）/);
  assert.match(block, /- Codex（codex \/ gpt-6-astra）/);
  assert.match(block, /- Gemini（gemini）/);
  assert.doesNotMatch(block, /角色|职责|立场|负责|担任/);
  assert.ok(p.a.indexOf('## 规则') < p.a.indexOf('## 群成员'), '名单跟在群规则后面');
});

test('名单增减时老成员下一轮收到一行变更；没变化就什么都不加', () => {
  const { orch } = fresh();
  runTurn(orch, '开场', { a: 'A', b: 'B' }, { roster: roster.slice(0, 2) });
  let p = runTurn(orch, '第二轮', { a: 'A2', b: 'B2' }, { roster: roster.slice(0, 2) });
  assert.doesNotMatch(p.a, /群成员/);

  // Gemini 加入，Codex 离开
  p = runTurn(orch, '第三轮', { a: 'A3', c: 'C3' }, { roster: [roster[0], roster[2]] });
  const firstLine = p.a.split('\n')[0];
  assert.match(firstLine, /^（群成员变更：新加入 Gemini（gemini）；已离开 Codex（codex \/ gpt-6-astra）。当前成员：Claude、Gemini）$/);
  assert.match(p.c, /## 规则/, '新成员走首轮：群规则 + 全量名单');
  assert.match(p.c, /- Gemini（gemini）（你）/);
  assert.doesNotMatch(p.c, /群成员变更/);

  p = runTurn(orch, '第四轮', { a: 'A4', c: 'C4' }, { roster: [roster[0], roster[2]] });
  assert.doesNotMatch(p.a, /群成员/, '变更只报一次');
});

test('功能上线前加入的老成员（回执里没有名单）补一次全量名单，之后只报增减', () => {
  const { orch } = fresh();
  const begin = orch.beginTurn('旧问题', { appendUserMessage: true });
  orch.completeTurn(begin.turnNum, '旧问题', [{ sid: 'a', status: 'completed', text: 'old' }], members);
  delete orch.state.groupContextBySid.a;
  let p = runTurn(orch, '新问题', { a: 'A' });
  assert.match(p.a, /^## 群成员\n/);
  assert.doesNotMatch(p.a, /## 规则/);
  p = runTurn(orch, '再问', { a: 'A' });
  assert.doesNotMatch(p.a, /群成员/);
});

test('状态持久化：回执与待确认部分都能随状态文件重载', () => {
  const { meetingId, orch } = fresh();
  runTurn(orch, '开场', { a: 'A', b: 'send_failed' });
  orch.buildFirstDelta('b', '下一问', RULES, { roster });
  orch._saveState('test');
  groupchat._private.resetCache();
  const reloaded = groupchat.getOrchestrator(TMP, meetingId);
  assert.deepEqual(reloaded.state.groupContextBySid.a.roster.map(r => r.sid), ['a', 'b', 'c']);
  assert.equal(reloaded.state.groupContextPendingBySid.b.rules, true);
});

test('卡片视图识别补发名单的群聊外壳，只显示用户真正输入', () => {
  const { displayUserText } = require('../core/synthetic-user-filter.js');
  const { orch } = fresh();
  const begin = orch.beginTurn('旧问题', { appendUserMessage: true });
  orch.completeTurn(begin.turnNum, '旧问题', [{ sid: 'a', status: 'completed', text: 'old' }], members);
  delete orch.state.groupContextBySid.a;
  const prompt = runTurn(orch, '真正的提问', { a: 'A' }).a;
  assert.match(prompt, /^## 群成员/);
  assert.equal(displayUserText(prompt), '真正的提问');
});

// ---------- 调度器级：真实 dispatchGroupChatTurn ----------

const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(sids) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-context-int-'));
  const tap = new EventEmitter();
  tap.setMaxListeners(100);
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  tap.extractLatestTurn = async () => ({ text: '', extractMode: 'no_task_complete_yet' });
  tap.hasCodexUserMessageSince = async () => true;
  const sessionManager = new EventEmitter();
  const sessions = Object.fromEntries(sids.map((sid, index) => [sid, {
    id: sid, kind: 'codex', transcriptKind: 'codex', title: `Codex ${index + 1}`,
    status: 'active', meetingId: 'meeting', currentModel: { id: 'gpt-test' },
  }]));
  sessionManager.getSession = sid => sessions[sid] || null;
  sessionManager.getSessionBuffer = () => '';
  sessionManager.getGroupChatLastActivity = () => 0;
  sessionManager.getGroupChatOutputBytes = () => 0;
  sessionManager.getGroupChatReady = () => true;
  sessionManager.setGroupChatReady = () => {};
  sessionManager.writeToSession = () => {};
  const meeting = {
    id: 'meeting', groupChat: true, scene: 'general', answerSource: 'transcript', // tests the transcript pipeline
    subSessions: sids.slice(),
    slotSpecs: sids.map((_, index) => ({ kind: 'codex', memberId: `m${index + 1}` })),
    participants: sids.map((_, index) => index),
  };
  const deps = {
    cliReadyDetector: {},
    getHubDataDir: () => tmp,
    groupchat,
    isCodexBaseKind: kind => kind === 'codex',
    kindLabels: { codex: 'Codex' },
    logger: { log() {}, warn() {}, error() {} },
    maybeAutoTitleMeetingFromPrompt() {},
    meetingManager: { getMeeting: id => id === meeting.id ? meeting : null, getAllMeetings: () => [meeting] },
    sendToRenderer: () => {},
    sessionManager,
    transcriptTap: tap,
  };
  return { tmp, tap, meeting, sessions, dispatcher: createGroupChatDispatcher(deps) };
}

test('调度器：缺席 + 发送失败的成员下一轮补上漏掉的内容与群规则', async () => {
  const saved = {
    send: groupChatWatcher.sendToPty,
    stream: groupChatWatcher.extractStreamingText,
    clean: groupChatWatcher.cleanBufLen,
    host: groupChatWatcher.checkHostShellTakeover,
    resend: groupChatWatcher.resendCurrentPrompt,
    inspect: groupChatWatcher.inspectPromptSubmissionState,
    paste: { start: pasteTrappedDetector.start, tick: pasteTrappedDetector.tick, stop: pasteTrappedDetector.stop },
  };
  groupChatWatcher.extractStreamingText = () => ({ text: '', blocks: [], source: 'placeholder' });
  groupChatWatcher.cleanBufLen = () => 0;
  groupChatWatcher.checkHostShellTakeover = () => false;
  groupChatWatcher.resendCurrentPrompt = async () => ({ ok: false, reason: 'must_not_resend' });
  groupChatWatcher.inspectPromptSubmissionState = () => ({ state: 'running_clear' });
  pasteTrappedDetector.start = () => {};
  pasteTrappedDetector.tick = () => 'ok';
  pasteTrappedDetector.stop = () => {};
  try {
    const h = harness(['c1', 'c2', 'c3']);
    h.sessions.c3.status = 'dormant';
    let round = 1;
    const prompts = {};
    groupChatWatcher.sendToPty = async (sid, prompt) => {
      prompts[`${round}:${sid}`] = prompt;
      if (round === 1 && sid === 'c2') return { ok: false, reason: 'cli_not_ready' };
      return { ok: true, sendStatus: 'ok', acknowledgementSource: 'task_started', acknowledgementTurnId: `t${round}-${sid}`, enterAttempts: 1 };
    };
    const pending1 = h.dispatcher.dispatchGroupChatTurn('meeting', { userInput: '第一问：怎么看' });
    await sleep(40);
    h.tap.emit('turn-complete', { hubSessionId: 'c1', turnId: 't1-c1', signalSource: 'task_complete', text: 'C1 第一轮答复', completedAt: Date.now() });
    const r1 = await pending1;
    assert.deepEqual(r1.results.map(r => `${r.sid}:${r.status}`).sort(), ['c1:completed', 'c2:errored', 'c3:absent']);
    assert.match(prompts['1:c1'], /## 群成员[\s\S]*Codex 1（codex \/ gpt-test）（你）[\s\S]*Codex 3（codex \/ gpt-test）/);
    const state1 = groupchat.getOrchestrator(h.tmp, 'meeting').getState();
    assert.equal(state1.lastDeliveredIdx.c2, undefined);
    assert.equal(state1.lastDeliveredIdx.c3, undefined);

    round = 2;
    h.sessions.c3.status = 'active';
    const pending2 = h.dispatcher.dispatchGroupChatTurn('meeting', { userInput: '第二问：继续' });
    await sleep(40);
    for (const sid of ['c1', 'c2', 'c3']) {
      h.tap.emit('turn-complete', { hubSessionId: sid, turnId: `t2-${sid}`, signalSource: 'task_complete', text: `${sid} 第二轮`, completedAt: Date.now() });
    }
    await pending2;
    for (const sid of ['c2', 'c3']) {
      const p = prompts[`2:${sid}`];
      assert.match(p, /## 规则/, `${sid} 仍是首次参与，要拿到群规则`);
      assert.match(p, /第一问：怎么看/, `${sid} 要补上漏掉的提问`);
      assert.match(p, /C1 第一轮答复/, `${sid} 要补上漏掉的队友发言`);
    }
    assert.doesNotMatch(prompts['2:c1'], /## 规则/);
    assert.doesNotMatch(prompts['2:c1'], /群成员/, '名单没变，老成员不再收名单');
  } finally {
    groupChatWatcher.sendToPty = saved.send;
    groupChatWatcher.extractStreamingText = saved.stream;
    groupChatWatcher.cleanBufLen = saved.clean;
    groupChatWatcher.checkHostShellTakeover = saved.host;
    groupChatWatcher.resendCurrentPrompt = saved.resend;
    groupChatWatcher.inspectPromptSubmissionState = saved.inspect;
    pasteTrappedDetector.start = saved.paste.start;
    pasteTrappedDetector.tick = saved.paste.tick;
    pasteTrappedDetector.stop = saved.paste.stop;
  }
});
