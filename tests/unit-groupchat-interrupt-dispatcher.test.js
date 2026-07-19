'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const groupChatWatcher = require('../core/group-chat-watcher.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for predicate');
}

function makeOrchestrator() {
  let nextTurn = 0;
  return {
    state: { messages: [], turns: [], currentTurn: 0 },
    beginTurn() {
      this.state.currentTurn = ++nextTurn;
      return { turnNum: nextTurn, didAppendUserMessage: true };
    },
    buildFirstDelta(_sid, input) { return `PROMPT:${input}`; },
    recordTurnPrompt() {},
    setSendStatus() {},
    rollbackTurn() {},
    clearTurnInProgress() {},
    completeTurn(turnNum, userInput, results) {
      const turn = { n: turnNum, userInput, results, meta: {} };
      this.state.turns.push(turn);
      return turn;
    },
  };
}

test('interrupt sends Ctrl+C only to active recipients in the addressed meeting', async () => {
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const scheduledTimers = new Set();
  // Dispatcher deliberately keeps completed-answer patch listeners for five
  // minutes. Compress only those two long cleanup timers in this isolated test.
  global.setTimeout = (callback, delay, ...args) => {
    let handle;
    handle = originalSetTimeout((...callbackArgs) => {
      scheduledTimers.delete(handle);
      callback(...callbackArgs);
    }, Number(delay) >= 300_000 ? 5 : delay, ...args);
    scheduledTimers.add(handle);
    return handle;
  };
  global.setInterval = (callback, delay, ...args) => {
    const handle = originalSetInterval(callback, delay, ...args);
    scheduledTimers.add(handle);
    return handle;
  };
  const original = {
    sendToPty: groupChatWatcher.sendToPty,
    extractStreamingText: groupChatWatcher.extractStreamingText,
    cleanBufLen: groupChatWatcher.cleanBufLen,
    checkHostShellTakeover: groupChatWatcher.checkHostShellTakeover,
  };

  const writes = [];
  const sessions = new Map([
    ['a1', { id: 'a1', kind: 'claude', title: 'Claude A' }],
    ['a2', { id: 'a2', kind: 'gemini', title: 'Gemini A' }],
    ['b1', { id: 'b1', kind: 'claude', title: 'Claude B' }],
  ]);
  const meetings = new Map([
    ['meeting-a', { id: 'meeting-a', groupChat: true, scene: 'general', subSessions: ['a1', 'a2'], participants: [0, 1], slotSpecs: [] }],
    ['meeting-b', { id: 'meeting-b', groupChat: true, scene: 'general', subSessions: ['b1'], participants: [0], slotSpecs: [] }],
  ]);
  const orchestrators = new Map([...meetings.keys()].map(id => [id, makeOrchestrator()]));
  const transcriptTap = new EventEmitter();
  transcriptTap.clearStreamingBuf = () => {};
  transcriptTap.clearLastTokens = () => {};
  transcriptTap.getLastTokens = () => null;

  try {
    groupChatWatcher.sendToPty = async () => ({ ok: true, sendStatus: 'ok' });
    groupChatWatcher.extractStreamingText = () => ({ text: '', blocks: [], source: 'placeholder' });
    groupChatWatcher.cleanBufLen = () => 0;
    groupChatWatcher.checkHostShellTakeover = () => false;

    const dispatcher = createGroupChatDispatcher({
      cliReadyDetector: {},
      getHubDataDir: () => 'test-data',
      groupchat: {
        getOrchestrator: (_dir, meetingId) => orchestrators.get(meetingId),
        buildSystemPromptText: () => 'SYSTEM',
      },
      isCodexBaseKind: () => false,
      kindLabels: { claude: 'Claude', gemini: 'Gemini' },
      logger: { log() {}, warn() {} },
      maybeAutoTitleMeetingFromPrompt() {},
      meetingManager: { getMeeting: id => meetings.get(id) },
      sendToRenderer() {},
      sessionManager: {
        getSession: sid => sessions.get(sid),
        getSessionBuffer: () => '',
        getGroupChatLastActivity: () => 0,
        setGroupChatReady() {},
        writeToSession: (sid, text) => writes.push([sid, text]),
      },
      transcriptTap,
    });

    const turnA = dispatcher.dispatchGroupChatTurn('meeting-a', { userInput: 'A question' });
    const turnB = dispatcher.dispatchGroupChatTurn('meeting-b', { userInput: 'B question' });
    await waitFor(() => dispatcher.getActiveWatchers().size === 3);

    const interrupted = dispatcher.interruptGroupChatTurn('meeting-a');
    assert.deepEqual(interrupted.interruptedSids.sort(), ['a1', 'a2']);
    assert.deepEqual(writes.sort((a, b) => a[0].localeCompare(b[0])), [['a1', '\x03'], ['a2', '\x03']]);
    assert.equal(dispatcher.getActiveWatchers().has('b1'), true, 'other meeting must remain active');

    const resultA = await turnA;
    assert.equal(resultA.status, 'interrupted');
    assert.deepEqual(resultA.results.map(result => result.status), ['interrupted', 'interrupted']);

    transcriptTap.emit('turn-complete', {
      hubSessionId: 'b1',
      text: 'B completed normally',
      signalSource: 'stop_hook',
      completedAt: Date.now(),
    });
    const resultB = await turnB;
    assert.equal(resultB.status, 'completed');
    assert.equal(resultB.results[0].text, 'B completed normally');
    assert.equal(dispatcher.getActiveWatchers().size, 0);
    await new Promise(resolve => originalSetTimeout(resolve, 15));
  } finally {
    for (const handle of scheduledTimers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    Object.assign(groupChatWatcher, original);
  }
});
