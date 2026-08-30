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

test('back-to-back pointer activations suppress every delayed compatibility click', () => {
  const harness = makeHarness();
  const first = targetFor('data-session-id', 'session-first');
  const second = targetFor('data-session-id', 'session-second');

  // Chromium can defer both compatibility clicks until after both pointer-up
  // handlers and the sidebar rebuilds they trigger. Neither delayed click may
  // navigate whatever row happens to sit under the old coordinates.
  harness.emit('pointerdown', {
    button: 0, pointerId: 10, clientX: 10, clientY: 20, target: first,
  });
  harness.emit('pointerup', {
    pointerId: 10, clientX: 10, clientY: 20, target: {},
    preventDefault() {}, stopPropagation() {},
  });
  harness.emit('pointerdown', {
    button: 0, pointerId: 11, clientX: 40, clientY: 20, target: second,
  });
  harness.emit('pointerup', {
    pointerId: 11, clientX: 40, clientY: 20, target: {},
    preventDefault() {}, stopPropagation() {},
  });

  assert.deepEqual(harness.selected.map(entry => entry.id), ['session-first', 'session-second']);
  harness.emit('click', {
    detail: 1,
    target: targetFor('data-session-id', 'retargeted-after-first-rebuild'),
    preventDefault() {}, stopPropagation() {},
  });
  harness.emit('click', {
    detail: 1,
    target: targetFor('data-session-id', 'retargeted-after-second-rebuild'),
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(harness.selected.map(entry => entry.id), ['session-first', 'session-second']);
});

test('same-position double click keeps the first row intent after reordering', () => {
  const harness = makeHarness();
  harness.emit('pointerdown', {
    button: 0, pointerId: 12, clientX: 12, clientY: 24,
    target: targetFor('data-session-id', 'original-row'),
  });
  harness.emit('pointerup', {
    pointerId: 12, clientX: 12, clientY: 24, target: {},
    preventDefault() {}, stopPropagation() {},
  });

  // Selection/resume reorders the list before the second press, so Chromium
  // reports the replacement row under the unchanged mouse coordinates.
  harness.emit('pointerdown', {
    button: 0, pointerId: 13, clientX: 12, clientY: 24,
    target: targetFor('data-session-id', 'replacement-row'),
  });
  harness.emit('pointerup', {
    pointerId: 13, clientX: 12, clientY: 24, target: {},
    preventDefault() {}, stopPropagation() {},
  });

  assert.deepEqual(harness.selected.map(entry => entry.id), ['original-row', 'original-row']);
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

test('meeting pointer intent also survives a full sidebar rebuild', () => {
  const harness = makeHarness();
  harness.emit('pointerdown', {
    button: 0, pointerId: 9, clientX: 12, clientY: 24,
    target: targetFor('data-meeting-id', 'meeting-a'),
  });
  harness.emit('pointerup', {
    pointerId: 9, clientX: 12, clientY: 24, target: {},
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(harness.meetings, [{
    id: 'meeting-a', opts: { forceScrollBottom: true },
  }]);
});
