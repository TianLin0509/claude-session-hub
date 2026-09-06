'use strict';

// 回归：群聊把 Claude 接进 auto-extract 后，必须只认「本轮提交之后完成」的 transcript turn。
//   曾经的判据是 promptSubmitSinceTs（= 真实提交时刻 - 1s，那 1s 是给 CLI 写 rollout 的时钟
//   偏差留的搜索余量）。用它判断归属，会让「上一轮在这 1s 内刚完成的答案」被当成本轮答案：
//   串行工作流第 N 步结束后立刻派发第 N+1 步，正好落在这个窗口里，第 N+1 步会在几秒内
//   "完成"并复读第 N 步的输出。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const groupchat = require(path.join(root, 'core', 'group-chat-orchestrator.js'));
const { createGroupChatDispatcher } = require(path.join(root, 'main', 'groupchat', 'dispatcher.js'));

const STALE_TEXT = '【上一步的旧答案】不应出现在下一步';
const FRESH_TEXT = '【本轮的新答案】';

function harness({ completedAtOffsetMs, extractMode = 'final_answer' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stale-guard-'));
  const meetingId = 'm-stale-guard';
  const meeting = { id: meetingId, groupChat: true, subSessions: ['s1'], groupMode: 'deliberation' };

  // 基准时刻：dispatch 之前。offset 为负 = 上一轮在提交前完成。
  const baseTs = Date.now();

  class Tap extends EventEmitter {
    clearStreamingBuf() {} clearLastTokens() {} notePrompt() {}
    getStreamingText() { return ''; }
    async hasCodexUserMessageSince() { return false; }
    async extractLatestTurn() {
      // 真实 ClaudeTap.extractLatestTurn 一定带 extractMode：final_answer 表示
      //   transcript 里 stop_reason 已是终态；partial_commentary 表示 Claude 还在干活。
      return {
        text: completedAtOffsetMs < 0 ? STALE_TEXT : FRESH_TEXT,
        source: 'manual_claude_transcript',
        completedAt: baseTs + completedAtOffsetMs,
        stopReason: extractMode === 'final_answer' ? 'end_turn' : 'tool_use',
        extractMode,
      };
    }
  }

  class SM extends EventEmitter {
    constructor() { super(); this.setMaxListeners(0); this.buf = ''; }
    getSession() { return { id: 's1', kind: 'claude', transcriptKind: 'claude', status: 'active', transcriptPath: 'x' }; }
    getGroupChatReady() { return true; }
    setGroupChatReady() {}
    getGroupChatLastActivity() { return this._activityTs || 0; }
    getGroupChatOutputBytes() { return this.buf.length; }
    getAgentTurnStartSeq() { return 0; }
    getSessionBuffer() { return this.buf; }
    writeToSession(sid, data) {
      this.buf += String(data).slice(0, 200);
      this.emit('output', { sessionId: sid, data: 'x' });
      if (data === '\r') {
        setTimeout(() => this.emit('agent-turn-started', {
          sessionId: sid, seq: 1, observedAt: Date.now(), signalSource: 'claude-user-prompt-submit',
        }), 5);
      }
    }
  }

  const sessionManager = new SM();
  const dispatcher = createGroupChatDispatcher({
    cliReadyDetector: { isReady: () => true },
    getHubDataDir: () => dir,
    groupchat,
    isCodexBaseKind: k => /codex/.test(String(k)),
    kindLabels: { claude: 'Claude' },
    logger: { log() {}, warn() {}, error() {} },
    maybeAutoTitleMeetingFromPrompt: () => {},
    meetingManager: { getMeeting: id => (id === meetingId ? meeting : null), updateMeeting: () => {} },
    onGroupChatComplete: () => {},
    sendToRenderer: () => {},
    sessionManager,
    transcriptTap: new Tap(),
  });
  return { dispatcher, meetingId, sessionManager };
}

test('a Claude turn that finished just before this prompt was submitted is never adopted as this turn答案', async () => {
  // 上一轮在提交前 400ms 完成 —— 正落在旧判据那 1s 松弛里。
  const { dispatcher, meetingId } = harness({ completedAtOffsetMs: -400 });
  const result = await dispatcher.dispatchGroupChatTurn(meetingId, {
    userInput: '第 N+1 步：请定稿',
    targetMemberIds: ['m1'],
    appendUserMessage: true,
    dispatchMode: 'serial',
    turnTimeoutMs: 9000,
    allowActiveExtend: false,
  });
  const answer = String(((result.results || [])[0] || {}).text || '');
  assert.ok(!answer.includes(STALE_TEXT),
    `previous-step answer leaked into the next step: ${JSON.stringify(answer.slice(0, 80))}`);
});

test('a Claude turn that finished after submit is still adopted through the auto-extract fallback', async () => {
  // 真实场景：本轮提交后才完成 —— fallback 必须照常兜底，不能被上面的收紧误伤。
  const { dispatcher, meetingId } = harness({ completedAtOffsetMs: 60_000 });
  const result = await dispatcher.dispatchGroupChatTurn(meetingId, {
    userInput: '第 N+1 步：请定稿',
    targetMemberIds: ['m1'],
    appendUserMessage: true,
    dispatchMode: 'serial',
    turnTimeoutMs: 30_000,
    allowActiveExtend: false,
  });
  const participant = (result.results || [])[0] || {};
  assert.strictEqual(participant.status, 'completed');
  assert.ok(String(participant.text || '').includes(FRESH_TEXT),
    'the auto-extract fallback must still settle a genuinely new answer');
});

// 2026-09-06 事故复现（开发场景串行工作流 Claude → Codex）：
//   Claude 只写了「我先读 X 和两张截图，弄清合同与现状，再在 worktree 里改。」就被判
//   「已答」，工作流立刻放行 Codex。那条 entry 的 stop_reason 是 'tool_use'，Claude 根本
//   还没干活。时间上它确实属于本轮，所以上面那条时间下界守卫拦不住它 ——
//   必须由终态判据来拦。
test('a fresh-but-unfinished Claude preamble must not settle the turn', async () => {
  const { dispatcher, meetingId } = harness({
    completedAtOffsetMs: 3_000,          // 时间上属于本轮，下界守卫放行
    extractMode: 'partial_commentary',   // 但 stop_reason='tool_use'，还没答完
  });
  const result = await dispatcher.dispatchGroupChatTurn(meetingId, {
    userInput: '第 1 步：实现目标并完成最小相关验证',
    targetMemberIds: ['m1'],
    appendUserMessage: true,
    dispatchMode: 'serial',
    turnTimeoutMs: 9000,
    allowActiveExtend: false,
  });
  const participant = (result.results || [])[0] || {};
  assert.notStrictEqual(participant.status, 'completed',
    '未完成的开场白被结算成 completed —— 串行工作流会据此放行下一步');
  assert.ok(!String(participant.text || '').includes(FRESH_TEXT),
    'auto-extract 不得把 partial_commentary 写成本轮最终答案');
});
