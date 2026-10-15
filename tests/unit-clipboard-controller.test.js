'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createClipboardController,
  normalizeClipboardText,
  readSelectedText,
  selectedTextFromInput,
} = require('../renderer/clipboard-controller.js');

test('input selection preserves the exact selected text', () => {
  const input = { value: 'alpha 中文 omega', selectionStart: 6, selectionEnd: 8 };
  assert.equal(selectedTextFromInput(input), '中文');
  assert.equal(readSelectedText({
    nodeType: 1,
    closest: selector => selector.includes('textarea') ? input : null,
  }, null), '中文');
});

test('clipboard verification treats Windows and DOM line endings as equal', () => {
  assert.equal(normalizeClipboardText('a\r\nb\r'), 'a\nb\n');
  assert.equal(normalizeClipboardText('a\nb\n'), 'a\nb\n');
});

test('copy retries a silent clipboard miss and reports only verified success', async () => {
  let stored = 'old clipboard';
  let writes = 0;
  const feedback = [];
  const controller = createClipboardController({
    clipboard: {
      writeText(text) {
        writes += 1;
        if (writes >= 2) stored = text;
      },
      readText() { return stored; },
    },
    retryDelaysMs: [0, 1, 1],
    wait: async () => {},
    renderFeedback: false,
    onFeedback: value => feedback.push(value),
  });

  const result = await controller.copyText('verified payload');
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(stored, 'verified payload');
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].ok, true);
});

test('Ctrl+C snapshots a DOM selection and suppresses competing handlers', async () => {
  let stored = '';
  let prevented = false;
  let stopped = false;
  const target = { nodeType: 1, closest: () => null };
  const controller = createClipboardController({
    window: {
      getSelection: () => ({ rangeCount: 1, isCollapsed: false, toString: () => 'selected once' }),
    },
    clipboard: {
      writeText(text) { stored = text; },
      readText() { return stored; },
    },
    retryDelaysMs: [0],
    renderFeedback: false,
  });
  const handled = controller.handleKeydown({
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    key: 'c',
    code: 'KeyC',
    target,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
    stopPropagation() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(stored, 'selected once');
});

test('bare Ctrl+C inside xterm stays available for SIGINT', () => {
  let wrote = false;
  const controller = createClipboardController({
    window: { getSelection: () => ({ rangeCount: 1, isCollapsed: false, toString: () => 'stale' }) },
    clipboard: { writeText() { wrote = true; }, readText: () => '' },
    renderFeedback: false,
  });
  const handled = controller.handleKeydown({
    ctrlKey: true,
    key: 'c',
    target: { nodeType: 1, closest: selector => selector.includes('.xterm') ? {} : null },
  });
  assert.equal(handled, false);
  assert.equal(wrote, false);
});

test('copy failure is explicit after bounded retries', async () => {
  const feedback = [];
  const controller = createClipboardController({
    clipboard: { writeText() {}, readText: () => 'someone else owns it' },
    retryDelaysMs: [0, 1],
    wait: async () => {},
    renderFeedback: false,
    onFeedback: value => feedback.push(value),
  });
  const result = await controller.copyText('wanted');
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.match(result.message, /复制失败/);
  assert.equal(feedback.length, 1);
});

test('a newer copy cancels an older retry and its success feedback', async () => {
  let stored = 'before';
  let resumeRetry;
  let oldWrites = 0;
  const feedback = [];
  const controller = createClipboardController({
    clipboard: {
      writeText(text) { if (text !== 'old' || ++oldWrites > 1) stored = text; },
      readText() { return stored; },
    },
    retryDelaysMs: [0, 1],
    wait: () => new Promise(resolve => { resumeRetry = resolve; }),
    renderFeedback: false,
    onFeedback: value => feedback.push(value),
  });
  const old = controller.copyText('old');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await controller.copyText('new')).ok, true);
  resumeRetry();
  assert.equal((await old).ok, false);
  assert.equal(stored, 'new', 'an old retry must never overwrite the latest user copy');
  assert.equal(oldWrites, 1);
  assert.equal(feedback.length, 1, 'stale work must not replace the latest feedback');
});

test('a writer without readback cannot claim verified success', async () => {
  const controller = createClipboardController({
    clipboard: { writeText() {} }, retryDelaysMs: [0], renderFeedback: false,
  });
  assert.equal((await controller.copyText('unverified')).ok, false);
});

test('renderer waits for the main-process acknowledgement and never trusts its own clipboard cache', async () => {
  let resolveWrite;
  const feedback = [];
  const controller = createClipboardController({
    clipboard: { writeText() { throw new Error('renderer writer must not run'); }, readText: () => 'false cached success' },
    writeTextVerified: () => new Promise(resolve => { resolveWrite = resolve; }),
    renderFeedback: false, onFeedback: value => feedback.push(value),
  });
  const pending = controller.copyText('wanted');
  assert.equal(feedback.length, 0);
  resolveWrite({ ok: false, reason: 'system clipboard busy', attempts: 5 });
  assert.equal((await pending).ok, false);
  assert.equal(feedback.at(-1).ok, false);
});

test('native copy snapshots immediately and uses the verified writer', async () => {
  let copied = ''; let prevented = false;
  const controller = createClipboardController({
    window: { getSelection: () => ({ rangeCount: 1, isCollapsed: false, toString: () => 'native selection' }) },
    writeTextVerified: async text => { copied = text; return { ok: true }; }, renderFeedback: false,
  });
  controller.handleNativeCopy({ target: { nodeType: 1, closest: () => null }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(copied, 'native selection');
});

test('a superseded button copy cannot replace newer feedback with an error', () => {
  const feedback = [];
  const controller = createClipboardController({ renderFeedback:false, onFeedback: value => feedback.push(value) });
  controller.showFeedback({ok:true,length:3});
  controller.showFeedback({ok:false,reason:'superseded'});
  assert.equal(feedback.length,1);
  assert.equal(feedback[0].ok,true);
});
