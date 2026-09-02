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

function watcherHarness({ screenReadsRunning }) {
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
      // 关键：永远不发语义确认事件，只靠屏幕内容区分两种情形。
      this.buf += screenReadsRunning
        ? '\n• Working (3s • esc to interrupt)\n'
        : '\n› Ask Codex to do anything\n';
      this.emit('output', { sessionId: sid, data: this.buf.slice(-80) });
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
