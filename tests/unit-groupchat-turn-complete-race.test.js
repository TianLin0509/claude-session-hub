'use strict';
// B2 回归测试（2026-07-29 道雪）：turn-complete 早于 watcher 订阅 → 整轮永久「思考中」
//
// 真实现场：用户勾了 Claude + Codex + Kimi。Codex 冷启动 60s 都没 ready，
//   dispatcher 的 `await Promise.all(所有成员 sendToPty)` 被它拖住；Claude 3s 就收到
//   prompt、31s 就答完并 emit 了 turn-complete —— 而 Claude 的 watcher 要等
//   Promise.all 整体 resolve（60s+）之后才 `transcriptTap.on('turn-complete')`。
//   事件没有重放机制（transcriptTap 内部 entry.lastText 去重，重放 stop hook 也不会
//   再 emit），于是这一轮永远等不到，气泡永久停在思考中。
//
// 本测试用可控时序把这个窗口构造出来：快成员先提交、在慢成员还卡在 sendToPty 时
//   就 emit turn-complete。修复前整轮挂死（withTimeout 抛错），修复后正常收敛。
//
// 契约：只要 prompt 的提交信号已经写进 PTY，这一家的 turn-complete 就必须能被接住 ——
//   不管同一轮别的成员的 sendToPty 还要跑多久。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const groupchat = require('../core/group-chat-orchestrator.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- stub PTY 副作用：每个 sid 可以有自己的耗时/结果 ---
let _sendPlan = {};   // sid → { delayMs, ok, submit }
const _sendLog = [];  // { sid, at, phase }
groupChatWatcher.sendToPty = async (sid, _prompt, _kind, opts = {}) => {
  const plan = _sendPlan[sid] || { delayMs: 0, ok: true, submit: true };
  await sleep(plan.delayMs || 0);
  if (plan.submit !== false) {
    _sendLog.push({ sid, at: Date.now(), phase: 'submitted' });
    // 新契约：提交信号一写出去就通知调用方（dispatcher 在这里挂 watcher）。
    //   老实现没有这个回调，dispatcher 会等到 Promise.all 之后才挂 —— 正是本 bug。
    if (typeof opts.onSubmitted === 'function') opts.onSubmitted();
  }
  _sendLog.push({ sid, at: Date.now(), phase: 'returned' });
  return plan.ok === false ? false : { ok: true, sendStatus: 'ok' };
};
groupChatWatcher.extractStreamingText = () => ({ text: '', blocks: [], source: 'pty_buffer' });
groupChatWatcher.cleanBufLen = () => 0;
groupChatWatcher.checkHostShellTakeover = () => false;
groupChatWatcher.resendCurrentPrompt = async () => ({ ok: true });
pasteTrappedDetector.start = () => {};
pasteTrappedDetector.tick = () => 'ok';
pasteTrappedDetector.stop = () => {};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_r, reject) => {
      const t = setTimeout(() => reject(new Error(`超时未收敛（${label}）—— turn-complete 落进了「已发未监听」窗口`)), ms);
      t.unref?.();
    }),
  ]);
}

function makeHarness(tmpDir) {
  const meetings = new Map();
  const sessions = {};
  const ipcSent = [];

  const tap = new EventEmitter();
  tap.setMaxListeners(50);
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  tap.extractLatestTurn = async () => null;
  tap.hasCodexUserMessageSince = async () => false;

  const deps = {
    cliReadyDetector: {},
    getHubDataDir: () => tmpDir,
    groupchat,
    isCodexBaseKind: (k) => k === 'codex',
    kindLabels: { gemini: 'Gemini', codex: 'Codex' },
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
      writeToSession: () => {},
    },
    transcriptTap: tap,
  };

  function addMeeting(meetingId, specs) {
    const sids = specs.map(s => s.sid);
    for (const s of specs) sessions[s.sid] = { kind: s.kind || 'gemini', status: 'active', title: s.sid.toUpperCase() };
    meetings.set(meetingId, {
      id: meetingId,
      groupChat: true,
      subSessions: sids.slice(),
      slotSpecs: specs.map(s => ({ kind: s.kind || 'gemini' })),
      participants: sids.map((_s, i) => i),
    });
  }

  return { deps, tap, ipcSent, addMeeting };
}

// --------------------------------------------------------------------------
// 核心用例：慢成员把发送阶段拖长，快成员在这段窗口里就答完了
async function testCompleteDuringSlowSendWindow(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b2-race';
  h.addMeeting(meetingId, [{ sid: 'fast1', kind: 'gemini' }, { sid: 'slow1', kind: 'gemini' }]);
  const dispatcher = createGroupChatDispatcher(h.deps);

  _sendPlan = {
    fast1: { delayMs: 30, ok: true },
    slow1: { delayMs: 900, ok: true },   // 现实里就是 codex 的 60s waitCliReady
  };
  _sendLog.length = 0;

  const turn = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: 'B2 竞态提问' });

  // 快成员已提交、慢成员还卡在 sendToPty 里 —— 老实现此刻还没有任何 watcher
  await sleep(200);
  const fastSubmitted = _sendLog.some(x => x.sid === 'fast1' && x.phase === 'submitted');
  const slowReturned = _sendLog.some(x => x.sid === 'slow1' && x.phase === 'returned');
  assert.strictEqual(fastSubmitted, true, '前置条件：快成员此刻已把 prompt 提交进 PTY');
  assert.strictEqual(slowReturned, false, '前置条件：慢成员此刻还卡在 sendToPty 里（构造出竞态窗口）');

  // 就在这个窗口里，快成员答完了 —— transcriptTap emit 一次，且不会重放
  h.tap.emit('turn-complete', { hubSessionId: 'fast1', text: '快成员在慢成员还没发完时就答完了', signalSource: 'stop_hook', completedAt: Date.now() });

  await sleep(900);
  h.tap.emit('turn-complete', { hubSessionId: 'slow1', text: '慢成员的答案', signalSource: 'stop_hook', completedAt: Date.now() });

  const res = await withTimeout(turn, 6000, 'B2 竞态窗口内完成的整轮');
  assert.strictEqual(res.status, 'completed', '整轮必须收敛');
  const fast = res.results.find(r => r.sid === 'fast1');
  assert.ok(fast, '快成员必须在结果里');
  assert.strictEqual(fast.status, 'completed', '快成员的 turn-complete 不得因为 watcher 挂晚了而丢失');
  assert.strictEqual(fast.text, '快成员在慢成员还没发完时就答完了', '快成员的答案文本必须落地');

  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  assert.strictEqual(orch.state.currentMode, 'idle', 'currentMode 必须收敛回 idle（否则 UI 永久思考中）');
  const t = orch.state.turns.find(x => x.n === res.turnNum);
  assert.strictEqual(t.byStatus.fast1, 'completed', '轮记录里快成员 = completed');
  assert.strictEqual(t.by.fast1, '快成员在慢成员还没发完时就答完了', '轮记录里保留快成员答案');
  console.log('  ✓ 慢成员拖长发送阶段时，快成员的 turn-complete 不再丢失');
}

// --------------------------------------------------------------------------
// 极端时序：提交信号刚写出去，回答立刻就来了（同一 tick）
async function testCompleteImmediatelyAfterSubmit(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b2-instant';
  h.addMeeting(meetingId, [{ sid: 'i1', kind: 'gemini' }, { sid: 'i2', kind: 'gemini' }]);
  const dispatcher = createGroupChatDispatcher(h.deps);

  // i1 一提交就"秒答"；i2 慢半拍。老实现里 i1 的事件同样落进窗口。
  _sendPlan = {
    i1: { delayMs: 10, ok: true },
    i2: { delayMs: 500, ok: true },
  };
  _sendLog.length = 0;

  const seen = [];
  const origEmit = h.tap.emit.bind(h.tap);
  // 在 sendToPty 的 onSubmitted 之后立刻 emit：用 setTimeout(0) 逼近"同一时刻"
  const turn = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '秒答提问' });
  const fire = setInterval(() => {
    if (_sendLog.some(x => x.sid === 'i1' && x.phase === 'submitted') && !seen.length) {
      seen.push(1);
      origEmit('turn-complete', { hubSessionId: 'i1', text: '秒答', signalSource: 'stop_hook', completedAt: Date.now() });
      clearInterval(fire);
    }
  }, 1);
  fire.unref?.();

  await sleep(600);
  h.tap.emit('turn-complete', { hubSessionId: 'i2', text: '第二家答案', signalSource: 'stop_hook', completedAt: Date.now() });
  const res = await withTimeout(turn, 6000, '秒答场景整轮');
  const i1 = res.results.find(r => r.sid === 'i1');
  assert.strictEqual(i1.status, 'completed', '提交后立刻到达的 turn-complete 也必须接住');
  assert.strictEqual(i1.text, '秒答', '秒答文本必须落地');
  console.log('  ✓ 提交后立刻到达的 turn-complete 也能接住（无最小窗口依赖）');
}

// --------------------------------------------------------------------------
// 回归保护：sendToPty 不调 onSubmitted（老实现 / 未来新分支）时仍必须有 watcher
async function testFallbackArmWhenNoSubmitCallback(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b2-fallback';
  h.addMeeting(meetingId, [{ sid: 'g1', kind: 'gemini' }]);
  const dispatcher = createGroupChatDispatcher(h.deps);

  _sendPlan = { g1: { delayMs: 20, ok: true, submit: false } };  // 永不回调
  _sendLog.length = 0;
  const turn = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '兜底挂载' });
  await sleep(120);
  const watcher = dispatcher.getActiveWatchers().get('g1');
  assert.ok(watcher && !watcher.isSettled(), 'sendToPty 没回调时，dispatcher 必须兜底把 watcher 挂上');
  h.tap.emit('turn-complete', { hubSessionId: 'g1', text: '兜底也能收到', signalSource: 'stop_hook', completedAt: Date.now() });
  const res = await withTimeout(turn, 5000, '兜底挂载轮');
  assert.strictEqual(res.results[0].text, '兜底也能收到', '兜底挂载的 watcher 同样能接住完成事件');
  console.log('  ✓ sendToPty 未回调时 dispatcher 兜底挂 watcher，不留裸奔的轮');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-b2-race-'));
  try {
    await testCompleteDuringSlowSendWindow(tmpDir);
    await testCompleteImmediatelyAfterSubmit(tmpDir);
    await testFallbackArmWhenNoSubmitCallback(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('All passed.')).catch(e => {
  console.error('FAIL:', (e && e.stack) || e);
  process.exit(1);
});
