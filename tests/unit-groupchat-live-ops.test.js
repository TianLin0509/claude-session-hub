'use strict';
// AI 群聊「运行中也能操作」集成测试（2026-07-29 道雪）
//
// 真实跑 dispatcher + orchestrator（非查源码字符串），覆盖用户诉求的两件事：
//   1. 运行中追加提问不被拒（抢占式连发），且轮次归属不串
//   2. 运行中可以中断：向在跑成员下发 ESC + 状态确定性收敛到 interrupted / idle
//   3. 中断的竞态窗口（sendToPty 还没跑完就点停止）不制造「永久思考中」卡死
//   4. 中断后仍能正常发下一轮
//   5. 串行/循环工作流语义：被中断或被新提问抢占 → 停整个工作流，不拿空结果往下跑
//
// 依赖用最小 mock：sessionManager / transcriptTap / meetingManager；orchestrator 用真实实现。
// group-chat-watcher 的 PTY 副作用 stub 成可观测的 no-op（writeToSession 记账验证 ESC）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const groupchat = require('../core/group-chat-orchestrator.js');
const { createGroupChatDispatcher, INTERRUPT_KEY } = require('../main/groupchat/dispatcher.js');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');

// --- stub PTY 副作用（不真发终端）---
let _sendToPtyDelayMs = 0;
let _streamingText = '';
groupChatWatcher.sendToPty = async () => {
  if (_sendToPtyDelayMs > 0) await sleep(_sendToPtyDelayMs);
  return { ok: true, sendStatus: 'ok' };
};
groupChatWatcher.extractStreamingText = () => ({ text: _streamingText, blocks: [], source: 'pty_buffer' });
groupChatWatcher.cleanBufLen = () => 0;
groupChatWatcher.checkHostShellTakeover = () => false;
groupChatWatcher.resendCurrentPrompt = async () => ({ ok: true });
pasteTrappedDetector.start = () => {};
pasteTrappedDetector.tick = () => 'ok';
pasteTrappedDetector.stop = () => {};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_r, reject) => {
      const t = setTimeout(() => reject(new Error(`超时未收敛（${label}）—— 疑似卡死回归`)), ms);
      t.unref?.();
    }),
  ]);
}

function makeHarness(tmpDir) {
  const meetings = new Map();
  const sessions = {};
  const ptyWrites = [];   // { sid, data }
  const ipcSent = [];

  const tap = new EventEmitter();
  tap.setMaxListeners(50);
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  tap.extractLatestTurn = async () => ({ text: '', extractMode: null });
  tap.hasCodexUserMessageSince = async () => false;

  const deps = {
    cliReadyDetector: {},
    getHubDataDir: () => tmpDir,
    groupchat,
    isCodexBaseKind: (k) => k === 'codex',
    kindLabels: { gemini: 'Gemini' },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    maybeAutoTitleMeetingFromPrompt: () => {},
    meetingManager: { getMeeting: (id) => meetings.get(id) || null },
    sendToRenderer: (ch, payload) => ipcSent.push({ ch, payload }),
    sessionManager: {
      getSession: (sid) => sessions[sid],
      getSessionBuffer: () => '',
      getGroupChatLastActivity: () => 0,
      getGroupChatReady: () => true,
      setGroupChatReady: () => {},
      clearStreamingBuf: () => {},
      writeToSession: (sid, data) => ptyWrites.push({ sid, data }),
    },
    transcriptTap: tap,
  };

  function addMeeting(meetingId, sids) {
    for (const sid of sids) sessions[sid] = { kind: 'gemini', status: 'active', title: sid.toUpperCase() };
    meetings.set(meetingId, {
      id: meetingId,
      groupChat: true,
      subSessions: sids.slice(),
      slotSpecs: sids.map(() => ({ kind: 'gemini' })),
      participants: sids.map((_s, i) => i),
    });
  }

  return { deps, tap, ptyWrites, ipcSent, addMeeting, meetings };
}

async function testAppendWhileRunning(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-append';
  h.addMeeting(meetingId, ['a1', 'a2']);
  const dispatcher = createGroupChatDispatcher(h.deps);
  const watchers = dispatcher.getActiveWatchers();

  const t1 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '第一问' });
  await sleep(60);
  assert.ok(watchers.get('a1') && !watchers.get('a1').isSettled(), '轮1: a1 应仍在回答中');

  // 用户在 a1/a2 都还在跑时追加第二问 —— 必须被接受，不能返回 busy/error
  const t2 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '第二问（运行中追加）' });
  const r1 = await withTimeout(t1, 5000, '运行中追加后轮1收尾');
  assert.strictEqual(r1.status, 'completed', '轮1 应被抢占收尾而不是无限期挂起');
  assert.strictEqual(r1.superseded, true, '轮1 返回值应带 superseded=true（供工作流判定用户接管）');

  await sleep(60);
  h.tap.emit('turn-complete', { hubSessionId: 'a1', text: '答2-1', signalSource: 'stop_hook', completedAt: 1 });
  h.tap.emit('turn-complete', { hubSessionId: 'a2', text: '答2-2', signalSource: 'stop_hook', completedAt: 1 });
  const r2 = await withTimeout(t2, 5000, '追加轮完成');
  assert.strictEqual(r2.status, 'completed', '追加的第二问必须正常完成（没有被拒绝/排队饿死）');
  assert.strictEqual(r2.superseded, false, '第二问是最新轮，superseded 应为 false');
  assert.strictEqual(r2.turnNum, r1.turnNum + 1, '追加应开新一轮，不复用旧轮号');

  // 轮次归属：两轮的用户消息 / AI 消息各挂各的 turnNum，不串轮
  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  const u1 = orch.state.messages.find(m => m.role === 'user' && m.turnNum === r1.turnNum);
  const u2 = orch.state.messages.find(m => m.role === 'user' && m.turnNum === r2.turnNum);
  assert.ok(u1 && u1.content === '第一问', '第一问挂在轮1');
  assert.ok(u2 && u2.content === '第二问（运行中追加）', '追加问挂在轮2，不覆盖轮1');
  const a2msgs = orch.state.messages.filter(m => m.role === 'assistant' && m.turnNum === r2.turnNum);
  assert.strictEqual(a2msgs.length, 2, '轮2 两位 AI 各一条消息');
  assert.ok(a2msgs.every(m => m.content && m.content.startsWith('答2-')), '轮2 内容不串到轮1');
  const t1rec = orch.state.turns.find(t => t.n === r1.turnNum);
  assert.strictEqual(t1rec.byStatus.a1, 'superseded', '轮1 被抢占的成员标 superseded');
  console.log('  ✓ 运行中追加提问：不被拒 + 立即开新轮 + 轮次归属不串');
}

async function testInterruptWhileRunning(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-interrupt';
  h.addMeeting(meetingId, ['b1', 'b2']);
  const dispatcher = createGroupChatDispatcher(h.deps);
  const watchers = dispatcher.getActiveWatchers();

  _streamingText = '这是被叫停前已经流出来的半截回答';
  const t1 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '会被中断的一问' });
  await sleep(60);
  assert.ok(watchers.get('b1') && !watchers.get('b1').isSettled(), '中断前 b1 应在回答中');
  assert.ok(watchers.get('b2') && !watchers.get('b2').isSettled(), '中断前 b2 应在回答中');

  const r = dispatcher.interruptMeetingTurn(meetingId, { reason: 'user_interrupt' });
  assert.strictEqual(r.ok, true, '中断应成功');
  assert.deepStrictEqual(r.stopped.slice().sort(), ['b1', 'b2'], '两位在跑成员都应被结算');
  assert.deepStrictEqual(r.signaled.slice().sort(), ['b1', 'b2'], '两位在跑成员都应收到中断键');

  // 中断走的就是单 session 的那条路：sessionManager.writeToSession(sid, ESC)
  for (const sid of ['b1', 'b2']) {
    const escWrites = h.ptyWrites.filter(w => w.sid === sid && w.data === INTERRUPT_KEY);
    assert.ok(escWrites.length >= 1, `${sid} 应收到至少一次 ESC（与终端按 ESC 同一条路径）`);
  }
  assert.strictEqual(INTERRUPT_KEY, '\x1b', '中断键必须是 ESC，不是 Ctrl+C（codex 双 Ctrl+C 会退出 CLI）');

  const res = await withTimeout(t1, 5000, '中断后整轮收敛');
  assert.strictEqual(res.status, 'completed', '中断后整轮必须收敛，不能永远挂起');
  assert.strictEqual(res.interrupted, true, '返回值应标记本轮被用户中断');
  assert.ok(res.results.every(x => x.status === 'interrupted'), '每位在跑成员都应结算为 interrupted');

  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  assert.strictEqual(orch.state.currentMode, 'idle', '中断后 currentMode 必须收敛回 idle（否则 UI 永久思考中）');
  const turn = orch.state.turns.find(t => t.n === res.turnNum);
  assert.strictEqual(turn.byStatus.b1, 'interrupted', '轮记录里 b1 状态 = interrupted');
  assert.strictEqual(turn.byStatus.b2, 'interrupted', '轮记录里 b2 状态 = interrupted');
  assert.strictEqual(turn.by.b1, '这是被叫停前已经流出来的半截回答', '中断保留已生成的半截文本，不丢内容');
  const msg = orch.state.messages.find(m => m.role === 'assistant' && m.turnNum === res.turnNum && m.sid === 'b1');
  assert.ok(msg && msg.status === 'interrupted', '持久化消息状态 = interrupted（前端据此不再渲染思考中）');

  // 中断后 CLI 迟到的 turn-complete 不得回填这条已叫停的记录
  h.tap.emit('turn-complete', { hubSessionId: 'b1', text: '迟到的完整答案不该覆盖', signalSource: 'stop_hook', completedAt: 2 });
  await sleep(60);
  const orch2 = groupchat.getOrchestrator(tmpDir, meetingId);
  const turnAfter = orch2.state.turns.find(t => t.n === res.turnNum);
  assert.strictEqual(turnAfter.by.b1, '这是被叫停前已经流出来的半截回答', '中断态不进 patch 窗口，迟到内容不回填');
  console.log('  ✓ 运行中中断：ESC 下发 + interrupted 落地 + currentMode 收敛 idle + 半截文本保留');

  // === 中断后仍能正常发下一轮（状态机没被卡住）===
  _streamingText = '';
  const t2 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '中断之后的新一问' });
  await sleep(80);
  h.tap.emit('turn-complete', { hubSessionId: 'b1', text: '新轮答案', signalSource: 'stop_hook', completedAt: 3 });
  h.tap.emit('turn-complete', { hubSessionId: 'b2', text: '新轮答案2', signalSource: 'stop_hook', completedAt: 3 });
  const r2 = await withTimeout(t2, 5000, '中断后的新一轮');
  assert.strictEqual(r2.status, 'completed', '中断之后必须还能正常发下一轮');
  assert.strictEqual(r2.interrupted, false, '新一轮没被中断');
  const turn2 = groupchat.getOrchestrator(tmpDir, meetingId).state.turns.find(t => t.n === r2.turnNum);
  assert.strictEqual(turn2.byStatus.b1, 'completed', '新一轮正常 completed');
  console.log('  ✓ 中断后状态机收敛，可继续正常提问');
}

async function testAppendDuringSendRace(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-append-race';
  h.addMeeting(meetingId, ['e1']);
  const dispatcher = createGroupChatDispatcher(h.deps);

  _sendToPtyDelayMs = 250;   // 本轮还卡在 sendToPty 里时用户就追问了下一条
  try {
    const t1 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '慢发送的第一问' });
    await sleep(40);
    const t2 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '在 send 窗口里追加的第二问' });
    // 轮1 必须迅速收尾（补抢占），否则轮2 会被串行队列扣到 CLI 自然结算为止
    const r1 = await withTimeout(t1, 4000, 'send 窗口追加后轮1收尾');
    assert.strictEqual(r1.superseded, true, 'send 窗口内的追加同样要抢占轮1');
    assert.ok(r1.results.every(x => x.status === 'superseded'), '轮1 成员应结算为 superseded 而不是继续空等');

    await sleep(320);
    h.tap.emit('turn-complete', { hubSessionId: 'e1', text: '第二问的答案', signalSource: 'stop_hook', completedAt: 1 });
    const r2 = await withTimeout(t2, 4000, 'send 窗口追加轮完成');
    assert.strictEqual(r2.status, 'completed', 'send 窗口内追加的提问必须能跑完');
    assert.strictEqual(r2.turnNum, r1.turnNum + 1, '追加提问归属新一轮');
    console.log('  ✓ send 窗口内追加：补抢占生效，追问不被串行队列扣住');
  } finally {
    _sendToPtyDelayMs = 0;
  }
}

async function testInterruptDuringSendRace(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-race';
  h.addMeeting(meetingId, ['c1']);
  const dispatcher = createGroupChatDispatcher(h.deps);

  _sendToPtyDelayMs = 200;   // 模拟 sendToPty 真实耗时（bracketed paste + Enter 校验）
  try {
    const t1 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '在 send 窗口里被叫停' });
    await sleep(40);
    // 此刻 watcher 还没建好 —— 老实现下这一停会落空，随后本轮开始等待 → 永久思考中
    const r = dispatcher.interruptMeetingTurn(meetingId, { reason: 'user_interrupt' });
    assert.strictEqual(r.ok, true, 'send 窗口里的中断也应返回 ok');
    assert.strictEqual(r.stopped.length, 0, '此刻确实没有 watcher 可结算（竞态窗口）');

    const res = await withTimeout(t1, 6000, 'send 窗口中断后的收敛');
    assert.strictEqual(res.status, 'completed', 'send 窗口被中断的轮同样必须收敛');
    assert.strictEqual(res.interrupted, true, '应识别为「本轮已被用户中断」');
    assert.ok(res.results.every(x => x.status === 'interrupted'), '成员应结算为 interrupted 而不是永远等待');
    const orch = groupchat.getOrchestrator(tmpDir, meetingId);
    assert.strictEqual(orch.state.currentMode, 'idle', '竞态中断后 currentMode 仍必须回到 idle');
    console.log('  ✓ send 窗口内中断：补结算成功，无「永久思考中」卡死');
  } finally {
    _sendToPtyDelayMs = 0;
  }
}

async function testInterruptWithNothingRunning(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-idle-stop';
  h.addMeeting(meetingId, ['d1']);
  const dispatcher = createGroupChatDispatcher(h.deps);

  const t1 = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '先跑一轮' });
  await sleep(60);
  h.tap.emit('turn-complete', { hubSessionId: 'd1', text: 'ok', signalSource: 'stop_hook', completedAt: 1 });
  await withTimeout(t1, 5000, '正常完成一轮');

  const r = dispatcher.interruptMeetingTurn(meetingId, { reason: 'user_interrupt' });
  assert.strictEqual(r.ok, true, '空转中断也应 ok（幂等），不抛错');
  assert.strictEqual(r.stopped.length, 0, '没人在跑 → stopped 为空');
  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  assert.strictEqual(orch.state.currentMode, 'idle', '空转中断后仍是 idle');
  const evt = h.ipcSent.filter(e => e.ch === 'groupchat-turn-interrupted').pop();
  assert.ok(evt && evt.payload.meetingId === meetingId, '应向前端广播 groupchat-turn-interrupted');
  console.log('  ✓ 无人在跑时点停止：幂等、不抛错、状态仍收敛');
}

async function testSerialWorkflowSemantics() {
  const meeting = {
    id: 'mtg-loop',
    groupChat: true,
    subSessions: ['w1', 'w2'],
    serialWorkflow: {
      enabled: true,
      steps: [['m1'], ['m2']],
      stepConfigs: [{ prompt: '' }, { prompt: '' }],
      loop: { enabled: true, maxRounds: 3 },
    },
  };
  const sessions = { w1: { kind: 'claude', status: 'active', title: 'B' }, w2: { kind: 'claude', status: 'active', title: 'R' } };

  for (const flag of ['interrupted', 'superseded']) {
    const calls = [];
    const engine = createLoopEngine({
      getDispatcher: () => ({
        dispatchGroupChatTurn: async (_id, args) => {
          calls.push(args.targetMemberIds.join(','));
          return { status: 'completed', turnNum: 1, results: [], [flag]: true };
        },
      }),
      meetingManager: { getMeeting: () => meeting, updateMeeting: () => {}, getAllMeetings: () => [meeting] },
      sessionManager: { getSession: (sid) => sessions[sid], createSession: () => {} },
      sendToRenderer: () => {},
      writeReport: () => null,
      logger: { log: () => {} },
    });
    const state = await withTimeout(engine.runLoop(meeting.id, '目标', null), 8000, `loop ${flag}`);
    assert.ok(state, `loop（${flag}）应返回状态`);
    assert.strictEqual(state.status, 'stopped_user', `${flag} → 循环整体停在 stopped_user（明确语义：中断整个工作流）`);
    assert.deepStrictEqual(calls, ['m1'], `${flag} 后不得继续派发 reviewer 步（不拿空结果往下跑）`);
    assert.strictEqual(engine.isRunning(meeting.id), false, '循环应已释放运行标记');
  }
  console.log('  ✓ 串行/循环工作流语义：被中断或被新提问抢占 → 停整个工作流，不跑下一步');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-live-ops-'));
  try {
    await testAppendWhileRunning(tmpDir);
    await testAppendDuringSendRace(tmpDir);
    await testInterruptWhileRunning(tmpDir);
    await testInterruptDuringSendRace(tmpDir);
    await testInterruptWithNothingRunning(tmpDir);
    await testSerialWorkflowSemantics();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('All passed.')).catch(e => {
  console.error('FAIL:', (e && e.stack) || e);
  process.exit(1);
});
