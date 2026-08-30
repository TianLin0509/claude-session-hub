'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionListRenderer } = require('../renderer/session-list-renderer.js');

function targetFor(attribute, id) {
  const selector = `[${attribute}]`;
  const row = {
    getAttribute(name) { return name === attribute ? id : null; },
    closest(query) { return query === selector ? row : null; },
  };
  return {
    closest(query) { return query === selector ? row : null; },
  };
}

function makeHarness() {
  const listeners = new Map();
  const selected = [];
  const meetings = [];
  const sessionListEl = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  createSessionListRenderer({
    document: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionListEl,
    isAiKind: () => true,
    modelShort: () => '',
    modelClass: () => '',
    escapeHtml: value => String(value || ''),
    formatTime: () => '',
    pctClass: () => '',
    selectSession: (id, opts) => selected.push({ id, opts }),
    selectMeeting: (id, opts) => meetings.push({ id, opts }),
    openContextMenu() {},
  });
  const emit = (type, event) => {
    for (const handler of listeners.get(type) || []) handler(event);
  };
  return { emit, selected, meetings };
}

test('pointer intent survives row replacement between down and up', () => {
  const harness = makeHarness();
  harness.emit('pointerdown', {
    button: 0, pointerId: 7, clientX: 10, clientY: 20,
    target: targetFor('data-session-id', 'session-b'),
  });
  // pointer-up lands on the stable container after the original row vanished.
  harness.emit('pointerup', {
    pointerId: 7, clientX: 10, clientY: 20, target: {},
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(harness.selected, [{
    id: 'session-b', opts: { forceScrollBottom: true },
  }]);

  // Chromium may still synthesize click after pointer-up. A rebuild may also
  // reorder the list, putting a different row under the mouse. That one
  // compatibility click must not override the intent captured on down.
  harness.emit('click', {
    detail: 1,
    target: targetFor('data-session-id', 'session-c'),
    preventDefault() {}, stopPropagation() {},
  });
  assert.equal(harness.selected.length, 1);

  // Keyboard activation is a genuine click (detail=0), not a duplicate.
  harness.emit('click', {
    detail: 0,
    target: targetFor('data-session-id', 'session-c'),
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(harness.selected.at(-1), {
    id: 'session-c', opts: { forceScrollBottom: true },
  });
});

test('pointer drag is cancelled and its synthetic click is suppressed', () => {
  const harness = makeHarness();
  const target = targetFor('data-session-id', 'session-drag');
  harness.emit('pointerdown', {
    button: 0, pointerId: 8, clientX: 10, clientY: 20, target,
  });
  harness.emit('pointerup', {
    pointerId: 8, clientX: 40, clientY: 20, target: {},
    preventDefault() {}, stopPropagation() {},
  });
  harness.emit('click', { detail: 1, target, preventDefault() {}, stopPropagation() {} });
  assert.equal(harness.selected.length, 0);
});
