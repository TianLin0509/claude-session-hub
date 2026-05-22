const test = require('node:test');
const assert = require('node:assert');
const {
  parseQuestionsFromLines,
  isWaitingForUser,
  createTerminalActivityMonitor,
} = require('../renderer/terminal-activity-monitor.js');

function makeLine(text) {
  return { translateToString: () => text };
}

function makeTerminalCache(lines) {
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
  monitor.readTerminalPreview('s1');
  assert.strictEqual(sessions.get('s1').lastOutputPreview, 'explain renderer.js');
  assert.strictEqual(rendered, 1);
  assert.strictEqual(persisted, 1);
});
