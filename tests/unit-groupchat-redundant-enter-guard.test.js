'use strict';

// 两条「不要自作主张」的守卫，都是实测逼出来的：
//
// 1) 补 Enter 必须要有否定证据。实测 Codex CLI 0.151.0 发 222 行 / 14,061 字，
//    提交到 task_started 稳定落在 4708-4847ms；确认窗口若取 4000ms，这条本该
//    "有条件"的补 Enter 会每次都触发，3 次试验还多打出过一个 Codex turn。
//    窗口放宽到 9s，并且屏幕已经读成 running 时一律不补、只延长等待。
//
// 2) 开机自动续跑串行工作流要有年龄下限。循环工作流有 deadlineTs 兜底，串行没有，
//    几天前被打断的一次串行会在下次开 Hub 时静默地重新向 CLI 发指令。

const assert = require('assert');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const watcher = require(path.join(root, 'core', 'group-chat-watcher.js'));
const { createLoopEngine } = require(path.join(root, 'main', 'groupchat', 'loop-engine.js'));

function watcherHarness({ screenReadsRunning, pasteStuckInInputBox = false }) {
  const transcriptTap = new EventEmitter();
  let enters = 0;
  class SM extends EventEmitter {
    constructor() { super(); this.setMaxListeners(0); this.buf = ''; }
    getSession() { return { id: 's', transcriptKind: 'codex', kind: 'codex', cwd: process.cwd() }; }
    getGroupChatReady() { return true; }
    setGroupChatReady() {}
    getGroupChatLastActivity() { return Date.now(); }
    getGroupChatOutputBytes() { return this.buf.length; }
    getAgentTurnStartSeq() { return 0; }
    getSessionBuffer() { return this.buf; }
    writeToSession(sid, data) {
      if (data === '\r') enters += 1;
      // 关键：永远不发语义确认事件，只靠屏幕内容区分几种情形。
      let frame = screenReadsRunning
        ? '\n• Working (3s • esc to interrupt)\n'
        : '\n› Ask Codex to do anything\n';
      // 「上一轮还在收尾，但本轮的粘贴还挂在输入框里没提交」——
      //   屏幕同时读成 running 且末尾挂着折叠标记。
      if (pasteStuckInInputBox) frame += '› [Pasted Content 10377 chars]\n';
      this.buf += frame;
      this.emit('output', { sessionId: sid, data: frame });
    }
  }
  const sessionManager = new SM();
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    agentTurnStartAckMs: 150,
    agentTurnStartRecoveryMs: 150,
  });
  return { get enters() { return enters; } };
}

test('a screen that already reads running never gets a redundant Enter', async () => {
  const state = watcherHarness({ screenReadsRunning: true });
  const result = await watcher.sendToPty('s', 'x'.repeat(500), 'codex');
  assert.strictEqual(state.enters, 1,
    'pressing Enter into an already-working TUI can submit a second turn');
  assert.strictEqual(result.enterAttempts, 1);
  // 2026-09-03：屏幕跑过 + 输入框空 = 已提交，不能报 stuck。
  //   实测现场：新建 Codex 会话第一轮，rollout 未绑定所以 task_started 迟到，
  //   答案又短到 running footer 撑不满确认帧 —— 屏幕上答案都打出来了却报 stuck，
  //   生产里就是给一次完全正常的发送弹「⚠ 消息可能没提交」。
  assert.notStrictEqual(result.sendStatus, 'stuck',
    '输入框已经空了、屏幕也跑过，就不该告诉用户消息没提交');
});

// 2026-09-03 真机压测抓到的反例：Codex 普通会话连发，第 2 条 220 行的 prompt 以
//   `› [Pasted Content 10377 chars]` 卡在输入框，而屏幕因为上一轮还在收尾被读成 running。
//   旧逻辑把 looksAlreadyRunning 的 continue 和补回车放在同一个 retryMax 预算里，
//   结果那次 continue 直接耗尽预算 —— 补发回车一次都没发就报了 stuck，用户干等 5 分钟。
//   「屏幕在跑」不足以证明**这一次**的粘贴提交了；输入框里还挂着折叠标记就是没提交的铁证。
test('a running screen does NOT excuse a paste still sitting in the input box', async () => {
  const state = watcherHarness({ screenReadsRunning: true, pasteStuckInInputBox: true });
  const result = await watcher.sendToPty('s', 'x'.repeat(500), 'codex');
  assert.strictEqual(state.enters, 2,
    '输入框里还有没提交的折叠粘贴时，必须补一次隔离回车，不能被 running 读数挡掉');
  assert.strictEqual(result.enterAttempts, 2);
});

test('a genuinely idle input box still gets exactly one bounded recovery Enter', async () => {
  const state = watcherHarness({ screenReadsRunning: false });
  const result = await watcher.sendToPty('s', 'x'.repeat(500), 'codex');
  assert.strictEqual(state.enters, 2, 'the stuck-paste fallback must survive the running guard');
  assert.strictEqual(result.enterAttempts, 2);
  assert.strictEqual(result.sendStatus, 'stuck');
});

test('the first acknowledgement window clears the measured Codex task_started latency', () => {
  const src = require('fs').readFileSync(path.join(root, 'core', 'group-chat-watcher.js'), 'utf8');
  const m = src.match(/agentTurnStartAckMs \|\| _deps\.codexTurnStartAckMs\) \|\| (\d+)\)/);
  assert.ok(m, 'first-ack window default should stay greppable');
  assert.ok(Number(m[1]) >= 8000,
    `first-ack window ${m[1]}ms must clear the measured 4708-4847ms task_started latency with margin`);
});

function loopHarness(updatedAt) {
  const meeting = {
    id: 'm', groupChat: true, subSessions: ['s1'],
    serialWorkflow: {
      enabled: true, steps: [['m1']], stepConfigs: [{}],
      serialRunState: {
        status: 'running', runId: 'r', goal: 'g', nextStepIndex: 0, currentStepIndex: null,
        attemptsByStep: {}, completedSteps: [], startedAt: updatedAt, updatedAt,
      },
    },
  };
  const calls = [];
  const engine = createLoopEngine({
    getDispatcher: () => ({
      dispatchGroupChatTurn: async (...args) => {
        calls.push(args);
        return { status: 'completed', turnNum: 1, results: [{ sid: 's1', status: 'completed', text: 'ok' }] };
      },
      interruptMeetingTurn: () => {},
    }),
    getOrchestrator: () => null,
    meetingManager: {
      getMeeting: () => meeting,
      getAllMeetings: () => [meeting],
      updateMeeting: (_id, patch) => Object.assign(meeting, patch),
    },
    sessionManager: { getSession: () => ({ id: 's1', status: 'active' }) },
    resumeSession: async s => s,
    sendToRenderer: () => {},
    writeReport: () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  engine.resumePending();
  return calls;
}

test('boot resumes a serial workflow that was interrupted recently', async () => {
  const calls = loopHarness(Date.now() - 60 * 60 * 1000);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(calls.length >= 1, 'a workflow interrupted an hour ago should continue on boot');
});

test('boot refuses to silently re-dispatch a long-abandoned serial workflow', async () => {
  const calls = loopHarness(Date.now() - 30 * 60 * 60 * 1000);
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(calls.length, 0,
    'a workflow abandoned 30h ago must wait for an explicit serial:resume, not fire on launch');
});
