const test = require('node:test');
const assert = require('node:assert');
const {
  parseQuestionsFromLines,
  isWaitingForUser,
  createTerminalActivityMonitor,
  UI_RESIZE_REDRAW_SUPPRESS_MS,
} = require('../renderer/terminal-activity-monitor.js');
const { classifyTerminalRuntime } = require('../core/terminal-runtime-state.js');

function makeLine(text) {
  return { translateToString: () => text };
}

function makeTerminalCache(lines, extra = {}) {
  return new Map([['s1', {
    opened: true,
    terminal: {
      buffer: {
        active: {
          length: lines.length,
          getLine: (idx) => lines[idx] ? makeLine(lines[idx]) : null,
        },
      },
    },
    ...extra,
  }]]);
}

test('parses unique user prompt lines and skips assistant markers', () => {
  const questions = parseQuestionsFromLines([
    '│ ❯ first question │',
    '⏺ thinking output',
    '> first question',
    '> second question',
  ]);
  assert.deepStrictEqual(questions, ['first question', 'second question']);
});

test('classifies confirm and choice waits', () => {
  assert.deepStrictEqual(
    isWaitingForUser(['Proceed? [y/N]']),
    { waiting: true, reason: 'confirm', text: 'Proceed? [y/N]' }
  );
  assert.deepStrictEqual(
    isWaitingForUser(['1. Alpha', '2. Beta', 'Which option?']),
    { waiting: true, reason: 'choice', text: 'Which option?' }
  );
  assert.deepStrictEqual(isWaitingForUser(['done.']), { waiting: false });
});

test('reads terminal signature and preview through injected cache', () => {
  const sessions = new Map([['s1', { id: 's1', status: 'idle' }]]);
  let rendered = 0;
  let persisted = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache(['noise', '│ ❯ explain renderer.js │']),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered++; },
    schedulePersist: () => { persisted++; },
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
  });

  assert.strictEqual(monitor.getQuestionsSignature('s1'), 'explain renderer.js');
  const result = monitor.readTerminalPreview('s1');
  assert.deepStrictEqual(result, { skipped: false, signature: 'explain renderer.js', changed: true });
  assert.strictEqual(sessions.get('s1').lastOutputPreview, 'explain renderer.js');
  assert.strictEqual(rendered, 1);
  assert.strictEqual(persisted, 1);
});

test('authoritative transcript preview skips synchronous scrollback scanning', () => {
  let translated = 0;
  const sessions = new Map([['s1', {
    id: 's1',
    status: 'idle',
    lastOutputPreview: 'authoritative',
    _previewFromTranscript: true,
  }]]);
  const terminalCache = new Map([['s1', {
    opened: true,
    terminal: {
      buffer: {
        active: {
          length: 50000,
          getLine: () => ({ translateToString: () => { translated++; return '> stale'; } }),
        },
      },
    },
  }]]);
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache,
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
  });

  assert.deepStrictEqual(monitor.readTerminalPreview('s1'), { skipped: true, signature: '' });
  assert.strictEqual(translated, 0);
});

test('PTY burst is a running fallback when no semantic signal is actually active', () => {
  const session = { id: 's1', kind: 'claude', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let rendered = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered++; },
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
  });

  monitor.onTerminalOutput('s1', 201);
  assert.equal(session.status, 'running');
  assert.equal(session._runSource, 'burst');
  assert.equal(rendered, 1);
  monitor.clearSession('s1');
});

test('renderer resize redraw does not create a running pulse', () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let rendered = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([], { _lastPtyResizeAt: Date.now() }),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered++; },
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
  });

  monitor.onTerminalOutput('s1', 1000);
  assert.equal(session.status, 'idle');
  assert.equal(session._runSource, undefined);
  assert.equal(session._lastOutputTs, undefined);
  assert.equal(rendered, 0);
  monitor.clearSession('s1');
});

test('PTY fallback resumes after the renderer resize redraw window', () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([], {
      _lastPtyResizeAt: Date.now() - UI_RESIZE_REDRAW_SUPPRESS_MS - 1,
    }),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
  });

  monitor.onTerminalOutput('s1', 201);
  assert.equal(session.status, 'running');
  assert.equal(session._runSource, 'burst');
  monitor.clearSession('s1');
});

test('unarmed AI TUI animation cannot move a recent session to running', () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let rendered = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered++; },
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
  });

  for (let i = 0; i < 8; i += 1) monitor.onTerminalOutput('s1', 500);
  assert.equal(session.status, 'idle');
  assert.equal(session._runSource, undefined);
  assert.equal(session._lastOutputTs, undefined);
  assert.equal(rendered, 0);
  monitor.clearSession('s1');
});

test('unarmed Codex output still probes a strong Working row on the live screen', async () => {
  const session = {
    id: 's1', kind: 'codex', status: 'idle',
    runtimeTruth: {
      state: 'completed', source: 'pty-codex-input-ready', confidence: 'strong',
      observedAt: Date.now() - 1000, completedAt: Date.now() - 1000, sequence: 1,
    },
  };
  const sessions = new Map([['s1', session]]);
  let classified = 0;
  let applied = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([
      '• Running .\\gradlew.bat :app:testDebugUnitTest',
      '• Working (25s • esc to interrupt)',
      '› Use /skills to list available skills',
      'gpt-5.6-sol max fast · Context 92% left · C:\\Vibe\\repo',
    ]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
    canObserveRuntimeState: () => true,
    classifyRuntimeState: (item, liveLines) => {
      classified += 1;
      return classifyTerminalRuntime(item.kind, liveLines);
    },
    onRuntimeState: (item, runtime) => {
      applied += 1;
      if (runtime.state === 'running') item.status = 'running';
      return true;
    },
    runtimeProbeMs: 5,
    silenceMs: 50,
  });

  monitor.onTerminalOutput('s1', 500);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(classified, 1, 'strong current-screen evidence must reach the classifier');
  assert.equal(applied, 1);
  assert.equal(session.status, 'running');
  monitor.clearSession('s1');
});

test('unarmed Claude output still probes a structured animated status row', async () => {
  const session = { id: 's1', kind: 'claude', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let observed = null;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([
      '✻ Cultivating… (4s · ↓ 48 tokens)',
      '>',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
    canObserveRuntimeState: () => true,
    classifyRuntimeState: (item, liveLines) => classifyTerminalRuntime(item.kind, liveLines),
    onRuntimeState: (item, runtime) => {
      observed = runtime;
      if (runtime.state === 'running') item.status = 'running';
      return true;
    },
    runtimeProbeMs: 5,
    silenceMs: 50,
  });

  monitor.onTerminalOutput('s1', 500);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(observed && observed.reason, 'claude-active-status');
  assert.equal(session.status, 'running');
  monitor.clearSession('s1');
});

test('probing an unarmed idle Codex footer does not promote it to running', async () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let observed = null;
  let rendered = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([
      '› Improve documentation in @filename',
      'gpt-5.6-sol max fast · Context 92% left · C:\\Vibe\\repo',
    ]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered += 1; },
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
    canObserveRuntimeState: () => true,
    classifyRuntimeState: (item, liveLines) => classifyTerminalRuntime(item.kind, liveLines),
    onRuntimeState: (_item, runtime) => {
      observed = runtime;
      return false;
    },
    runtimeProbeMs: 5,
    silenceMs: 50,
  });

  for (let index = 0; index < 20; index += 1) monitor.onTerminalOutput('s1', 500);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(observed && observed.state, 'idle');
  assert.equal(session.status, 'idle');
  assert.equal(rendered, 0);
  monitor.clearSession('s1');
});

test('expired AI PTY fallback immediately clears an existing burst state', () => {
  const session = { id: 's1', kind: 'codex', status: 'running', _runSource: 'burst' };
  const sessions = new Map([['s1', session]]);
  let rendered = 0;
  let settled = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => { rendered++; },
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
    onPtyBurstSettled: () => { settled++; },
  });

  monitor.onTerminalOutput('s1', 500);
  assert.equal(session.status, 'idle');
  assert.equal(session._runSource, null);
  assert.equal(rendered, 1);
  assert.equal(settled, 1);
  monitor.clearSession('s1');
});

test('active semantic signal remains authoritative over PTY burst fallback', () => {
  const session = { id: 's1', kind: 'claude', status: 'running', _runSource: 'semantic' };
  const sessions = new Map([['s1', session]]);
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => true,
  });

  monitor.onTerminalOutput('s1', 1000);
  assert.equal(session.status, 'running');
  assert.equal(session._runSource, 'semantic');
  monitor.clearSession('s1');
});

test('provider runtime observation reads only the logical live screen and can settle a missed completion', () => {
  const session = { id: 's1', kind: 'codex', status: 'running', _runSource: 'semantic' };
  const sessions = new Map([['s1', session]]);
  const lines = [
    '• Working (99s • esc to interrupt)', // historical scrollback: must be ignored
    '• PTY_STATE_DONE',
    '› Improve documentation in @filename',
    '  gpt-5.6-sol max fast · Context 95% left · ~\\repo',
  ];
  const terminalCache = makeTerminalCache(lines);
  const cached = terminalCache.get('s1');
  cached.terminal.rows = 3;
  cached.terminal.buffer.active.baseY = 1;
  let observed = null;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache,
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => true,
    classifyRuntimeState: (item, liveLines) => classifyTerminalRuntime(item.kind, liveLines),
    onRuntimeState: (item, runtime) => {
      observed = runtime;
      if (runtime.state === 'idle') item.status = 'idle';
    },
  });

  assert.deepStrictEqual(monitor.extractLiveScreenLines('s1'), lines.slice(1));
  const result = monitor.observeRuntimeState('s1');
  assert.equal(result.state, 'idle');
  assert.equal(observed.reason, 'codex-input-ready');
  assert.equal(session.status, 'idle');
  monitor.clearSession('s1');
});

test('an input-ready frame can defer burst settlement until the provider running phase was observed', async () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([
      '› Improve documentation in @filename',
      'gpt-5.6-sol max fast · Context 100% left · C:\\repo',
    ]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => true,
    canObserveRuntimeState: () => true,
    classifyRuntimeState: (item, liveLines) => classifyTerminalRuntime(item.kind, liveLines),
    onRuntimeState: () => false,
    runtimeProbeMs: 5,
    silenceMs: 20,
  });

  monitor.onTerminalOutput('s1', 201);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(session.status, 'running');
  assert.equal(session._runSource, 'burst');
  monitor.clearSession('s1');
});

test('an unarmed PTY chunk storm coalesces live-screen classification probes', async () => {
  const session = { id: 's1', kind: 'codex', status: 'idle' };
  const sessions = new Map([['s1', session]]);
  let classifyCount = 0;
  const monitor = createTerminalActivityMonitor({
    sessions,
    terminalCache: makeTerminalCache([
      '• Working (3s • esc to interrupt)',
      '› Improve documentation in @filename',
      'gpt-5.6-sol max fast · Context 100% left · C:\\repo',
    ]),
    getActiveSessionId: () => 's1',
    renderSessionList: () => {},
    schedulePersist: () => {},
    updateStreamingIndicator: () => {},
    hasSemanticCardWorking: () => false,
    hasSemanticWorking: () => false,
    canUsePtyBurstFallback: () => false,
    canObserveRuntimeState: () => true,
    classifyRuntimeState: (item, liveLines) => {
      classifyCount += 1;
      return classifyTerminalRuntime(item.kind, liveLines);
    },
    onRuntimeState: () => true,
    runtimeProbeMs: 5,
    silenceMs: 100,
  });
  for (let index = 0; index < 1000; index += 1) monitor.onTerminalOutput('s1', 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(classifyCount, 1, '1000 PTY chunks should schedule one current-screen probe');
  monitor.clearSession('s1');
});
