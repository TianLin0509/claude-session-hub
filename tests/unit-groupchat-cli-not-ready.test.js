'use strict';
// B3 回归测试（2026-07-29 道雪）：CLI 未就绪的成员不得静默消失
//
// 现场：用户勾了 Claude + Codex + Kimi，Codex 240s 都没 ready，
//   后端 groupchat-turn-targets 只发了 claude + kimi，renderer 把 Codex 气泡整条移除；
//   而输入区还写着「目标 3/3」。用户视角：勾了 3 个，第 3 个凭空消失，没有任何解释。
//
// 两层覆盖：
//   A. 判据层 —— core/group-chat-cli-ready-detector.js 为什么把已经就绪的 Codex 判成没就绪
//      （真实 ring buffer 取证快照：tests/fixtures/codex-ring-buffer-mcp-boot.txt）
//   B. 派发层 —— main/groupchat/dispatcher.js 对"发不出去"的成员必须给确定态而不是丢弃

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const detector = require('../core/group-chat-cli-ready-detector.js');
const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const groupchat = require('../core/group-chat-orchestrator.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- stub PTY 副作用 ---
let _notReadySids = new Set();
groupChatWatcher.sendToPty = async (sid, _p, _k, opts = {}) => {
  await sleep(10);
  // 真实 sendToPty 在 waitCliReady 超时时 return false —— prompt 一个字都没写进 PTY，
  //   也不会触发 onSubmitted。这里 1:1 复刻这条唯一的 falsy 返回路径。
  if (_notReadySids.has(sid)) return false;
  if (typeof opts.onSubmitted === 'function') opts.onSubmitted();
  return { ok: true, sendStatus: 'ok' };
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
      const t = setTimeout(() => reject(new Error(`超时未收敛（${label}）`)), ms);
      t.unref?.();
    }),
  ]);
}

// ==========================================================================
// A. 判据层：Codex 的 MCP 启动行留在 ring buffer 里，不该把它永久判成"没就绪"
// ==========================================================================
function testDetectorStaleTransientBlocker() {
  const FIXTURE = path.join(__dirname, 'fixtures', 'codex-ring-buffer-mcp-boot.txt');
  const buf = fs.readFileSync(FIXTURE, 'utf8');

  // 前置事实（真实取证）：这份 buffer 的最近 2000 字符里确实同时命中两条 blocker，
  //   而就绪页脚 marker 是在它们**之后**才重绘的。
  const tail = buf.slice(-2000);
  assert.ok(/Booting MCP server/i.test(tail), 'fixture 应含 Booting MCP server（老实现正是被它永久卡住）');
  assert.ok(/esc to interrupt/i.test(tail), 'fixture 应含 esc to interrupt');
  const markerIdx = buf.lastIndexOf('Context ');
  let m; let bootIdx = -1;
  const re = /Booting MCP server/ig;
  while ((m = re.exec(buf)) !== null) bootIdx = m.index;
  assert.ok(markerIdx > bootIdx, `就绪页脚(${markerIdx}) 必须晚于 MCP 启动行(${bootIdx})，否则这份 fixture 说明不了问题`);

  // A/B：老判据（"末 2000 字符里出现过 blocker 就 not ready"）在这份真实 buffer 上
  //   会永远返回 false —— 这正是现场 240s 都不 ready 的根因。
  const oldRuleBlocked = [/Do you trust the contents of this directory/i, /Booting MCP server/i, /esc to interrupt/i]
    .some(re => re.test(tail));
  assert.strictEqual(oldRuleBlocked, true,
    '老判据在这份真实 buffer 上必然判 blocked（复现），新判据必须能走出来');

  const sid = 'codex-stale-blocker';
  detector.cleanup(sid);
  assert.strictEqual(detector.isReady(sid, 'codex', buf), false, '首次调用建立静默基线，返回 false 是对的');
  // 静默期只跟"buffer 长度是否还在变"有关；这里 buffer 不变 → 1.5s 后必须 ready
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 4000) {
    if (detector.isReady(sid, 'codex', buf)) { ready = true; break; }
  }
  assert.strictEqual(ready, true,
    'Codex TUI 已经就绪（输入框+页脚都在、PTY 完全静默）时必须判 ready —— 历史残留的 MCP 启动行不能永久拦路');
  console.log('  ✓ 真实 ring buffer：历史残留的 MCP 启动行不再让 Codex 永久 not-ready');

  // 反向：blocker 是最新出现的（页脚之后）→ 仍然必须拦住，不能把保护也一起删掉
  const stillBusy = buf + '\r\n• Working (12s • esc to interrupt)\r\n';
  const sid2 = 'codex-live-blocker';
  detector.cleanup(sid2);
  const t1 = Date.now();
  let wrongly = false;
  while (Date.now() - t1 < 2500) {
    if (detector.isReady(sid2, 'codex', stillBusy)) { wrongly = true; break; }
  }
  assert.strictEqual(wrongly, false, 'blocker 出现在就绪页脚之后（codex 真在干活）时必须继续判 not ready');
  console.log('  ✓ blocker 仍在最新位置时（真忙）保护不失效');

  // 非 transient 的模态框 blocker 保持老语义：出现在窗口里就拦，不看位置
  const trust = buf + '\r\n  Context 100% left\r\nDo you trust the contents of this directory?\r\n';
  const trust2 = trust + '\r\n  gpt-5.6-sol · Context 100% left · C:\\x\r\n';
  const sid3 = 'codex-trust';
  detector.cleanup(sid3);
  const t2 = Date.now();
  let trustReady = false;
  while (Date.now() - t2 < 2500) {
    if (detector.isReady(sid3, 'codex', trust2)) { trustReady = true; break; }
  }
  assert.strictEqual(trustReady, false, 'trust 模态框是非 transient blocker，即使之后又重绘了页脚也必须继续拦');
  console.log('  ✓ trust dialog 等静止模态框仍按老语义拦截（没被一起放开）');

  detector.cleanup(sid); detector.cleanup(sid2); detector.cleanup(sid3);
}

// ==========================================================================
// B. 派发层
// ==========================================================================
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
    kindLabels: { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' },
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
    for (const s of specs) sessions[s.sid] = { kind: s.kind, status: 'active', title: s.title };
    meetings.set(meetingId, {
      id: meetingId,
      groupChat: true,
      subSessions: sids.slice(),
      slotSpecs: specs.map(s => ({ kind: s.kind })),
      participants: sids.map((_s, i) => i),
    });
  }
  return { deps, tap, ipcSent, addMeeting };
}

async function testNotReadyMemberKeepsIdentity(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b3';
  h.addMeeting(meetingId, [
    { sid: 'cl', kind: 'claude', title: 'Claude 1' },
    { sid: 'cx', kind: 'codex', title: 'Codex 2' },
    { sid: 'km', kind: 'kimi', title: 'Kimi 3' },
  ]);
  const dispatcher = createGroupChatDispatcher(h.deps);
  _notReadySids = new Set(['cx']);   // 真实现场：Codex 240s 都没 ready

  const turn = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '三家一起答' });
  await sleep(120);
  h.tap.emit('turn-complete', { hubSessionId: 'cl', text: 'Claude 的答案', signalSource: 'stop_hook', completedAt: Date.now() });
  h.tap.emit('turn-complete', { hubSessionId: 'km', text: 'Kimi 的答案', signalSource: 'stop_hook', completedAt: Date.now() });
  const res = await withTimeout(turn, 6000, 'B3 三家轮');

  // 1) 目标数 == 结果数：勾了 3 位就必须有 3 份结局，不能只回 2 份
  assert.strictEqual(res.results.length, 3, '勾选 3 位 → 本轮必须有 3 份结局（未就绪的也算一份），不能静默丢弃');
  const cx = res.results.find(r => r.sid === 'cx');
  assert.ok(cx, 'Codex 必须出现在本轮结果里');
  assert.strictEqual(cx.status, 'cli_not_ready', '未就绪成员必须是明确状态 cli_not_ready，而不是消失');
  assert.strictEqual(cx.reason, 'cli_not_ready', '必须带机器可读的原因');
  assert.strictEqual(cx.text, '', '未发出的成员没有回答文本');

  // 2) renderer 拿到的目标名单必须含它 —— 否则 _gcActiveSids 不含它 → 气泡被整条移除
  const targetsEvt = h.ipcSent.filter(e => e.ch === 'groupchat-turn-targets').pop();
  assert.ok(targetsEvt, '必须广播 groupchat-turn-targets');
  assert.ok(targetsEvt.payload.sids.includes('cx'),
    'turn-targets 的 sids 必须包含未就绪成员，否则前端会把它的气泡整条删掉（= 凭空消失）');
  assert.strictEqual(targetsEvt.payload.sids.length, 3, 'turn-targets 名单长度必须与勾选数一致');
  assert.deepStrictEqual(targetsEvt.payload.sentSids.slice().sort(), ['cl', 'km'],
    'sentSids 只含真正发出去的，供前端区分"发出去了"和"没发出去"');
  assert.strictEqual(targetsEvt.payload.undelivered.length, 1, 'undelivered 明确列出未发出的成员');
  assert.strictEqual(targetsEvt.payload.undelivered[0].sid, 'cx');

  // 3) 未就绪成员必须立刻收到一条 partial-update（气泡当场变成"未发出"，不是等到轮末）
  const partials = h.ipcSent.filter(e => e.ch === 'groupchat-partial-update' && e.payload.sid === 'cx');
  assert.ok(partials.length >= 1, '未就绪成员必须立刻推 partial-update，让气泡当场有确定状态');
  assert.strictEqual(partials[0].payload.status, 'cli_not_ready');
  assert.strictEqual(partials[0].payload.reason, 'cli_not_ready');

  // 4) 落盘：轮记录 + 消息都留痕，重启/回看仍能解释"第三位去哪了"
  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  const t = orch.state.turns.find(x => x.n === res.turnNum);
  assert.strictEqual(t.byStatus.cx, 'cli_not_ready', '轮记录里必须留下 cli_not_ready');
  assert.strictEqual(t.byStatus.cl, 'completed');
  assert.strictEqual(t.byStatus.km, 'completed');
  const msg = orch.state.messages.find(m => m.role === 'assistant' && m.turnNum === res.turnNum && m.sid === 'cx');
  assert.ok(msg, '未就绪成员也要落一条消息，前端据此渲染气泡');
  assert.strictEqual(msg.status, 'cli_not_ready');
  assert.strictEqual(orch.state.currentMode, 'idle', '整轮必须收敛回 idle');

  // 5) 一个字都没收到的成员不得被记成"已读到本轮"——否则下一轮 buildFirstDelta
  //    不再给它发 systemPrompt（整套群聊规则），本轮内容也对它永久丢失。
  assert.strictEqual(orch.state.lastDeliveredIdx.cx, undefined,
    '未就绪成员的 lastDeliveredIdx 必须保持未投递（首次入群下一轮仍要带 systemPrompt）');
  assert.ok(typeof orch.state.lastDeliveredIdx.cl === 'number', '真发出去的成员正常推进已读位置');
  const nextPrompt = orch.buildFirstDelta('cx', '下一问', 'SYSTEM_PROMPT_MARK', { currentUserMessageAppended: false });
  assert.ok(nextPrompt.includes('SYSTEM_PROMPT_MARK'),
    '下一轮必须仍然给这位从没收到过东西的成员带上 systemPrompt');
  console.log('  ✓ 未就绪成员：结果数=勾选数 + 明确状态 + turn-targets 保留 + 即时 partial + 落盘留痕');
}

async function testAllMembersNotReady(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b3-all';
  h.addMeeting(meetingId, [{ sid: 'z1', kind: 'codex', title: 'Codex 1' }]);
  const dispatcher = createGroupChatDispatcher(h.deps);
  _notReadySids = new Set(['z1']);

  const res = await withTimeout(dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '唯一成员没就绪' }), 6000, '全员未就绪轮');
  assert.strictEqual(res.status, 'completed', '全员未就绪时不能整轮 rollback 消失（旧行为：no_sent + rollback）');
  assert.strictEqual(res.results.length, 1);
  assert.strictEqual(res.results[0].status, 'cli_not_ready');
  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  const u = orch.state.messages.find(m => m.role === 'user' && m.turnNum === res.turnNum);
  assert.ok(u && u.content === '唯一成员没就绪', '用户的提问必须留在时间线上（不能连问题一起回滚掉）');
  const targetsEvt = h.ipcSent.filter(e => e.ch === 'groupchat-turn-targets').pop();
  assert.ok(targetsEvt && targetsEvt.payload.sids.includes('z1'), '全员未就绪时也要广播目标名单');
  console.log('  ✓ 全员未就绪：整轮仍落地（问题不丢、成员不消失），不再静默回滚');
}

async function testReadyMembersUnaffected(tmpDir) {
  const h = makeHarness(tmpDir);
  const meetingId = 'mtg-b3-normal';
  h.addMeeting(meetingId, [
    { sid: 'n1', kind: 'claude', title: 'Claude 1' },
    { sid: 'n2', kind: 'kimi', title: 'Kimi 2' },
  ]);
  const dispatcher = createGroupChatDispatcher(h.deps);
  _notReadySids = new Set();

  const turn = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: '都就绪的正常轮' });
  await sleep(120);
  h.tap.emit('turn-complete', { hubSessionId: 'n1', text: 'A', signalSource: 'stop_hook', completedAt: Date.now() });
  h.tap.emit('turn-complete', { hubSessionId: 'n2', text: 'B', signalSource: 'stop_hook', completedAt: Date.now() });
  const res = await withTimeout(turn, 6000, '正常轮');
  assert.strictEqual(res.results.length, 2);
  assert.ok(res.results.every(r => r.status === 'completed'), '全员就绪的正常轮不受影响');
  const targetsEvt = h.ipcSent.filter(e => e.ch === 'groupchat-turn-targets').pop();
  assert.strictEqual(targetsEvt.payload.undelivered.length, 0, '没有未发出成员时 undelivered 为空');
  console.log('  ✓ 全员就绪的正常轮行为不变');
}

async function main() {
  testDetectorStaleTransientBlocker();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-b3-'));
  try {
    await testNotReadyMemberKeepsIdentity(tmpDir);
    await testAllMembersNotReady(tmpDir);
    await testReadyMembersUnaffected(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('All passed.')).catch(e => {
  console.error('FAIL:', (e && e.stack) || e);
  process.exit(1);
});
