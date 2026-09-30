'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transcriptWheelTarget, createCodexTranscriptWheelRouter } = require('../renderer/codex-transcript-wheel');

function fixture() {
  // Shape captured from real Codex 0.157.1 while a tool runs in 17 rows.
  const lines = ['Earlier question', '10:38 AM', '', '', '› Current question', '', '',
    '• I will run the command.', '', 'Working (7s • esc to interrupt)', '',
    'New activity · ↓ Back to bottom · esc', '', '› Ask Codex to do anything', '',
    'GPT-6-Astra low · Context 98% left', '? for shortcuts'];
  const rect = { left: 400, top: 100, width: 780, height: 340 };
  const terminal = {
    rows: lines.length,
    buffer: { active: { type: 'alternate', baseY: 0, getLine: row => ({ translateToString: () => lines[row] }) } },
    element: { querySelector: () => ({ getBoundingClientRect: () => rect }) },
  };
  const event = { clientX: 790, clientY: 270, deltaY: -420, deltaX: 0, deltaMode: 0 };
  return { terminal, lines, event, rect };
}

test('short running viewport redirects its center/status to transcript row 2', () => {
  const { terminal, event } = fixture();
  assert.deepEqual(transcriptWheelTarget(terminal, event), { clientX: 790, clientY: 130 });
  assert.deepEqual(transcriptWheelTarget(terminal, { ...event, deltaY: 420 }), { clientX: 790, clientY: 130 });
});

test('real transcript coordinates stay untouched; heading and footer can scroll', () => {
  const { terminal, event } = fixture();
  for (const clientY of [130, 170, 230]) assert.equal(transcriptWheelTarget(terminal, { ...event, clientY }), null);
  for (const clientY of [105, 330, 390]) assert.ok(transcriptWheelTarget(terminal, { ...event, clientY }));
});

test('zoom, selection, horizontal wheel and inline terminals retain native behavior', () => {
  const { terminal, event } = fixture();
  for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    assert.equal(transcriptWheelTarget(terminal, { ...event, [key]: true }), null);
  }
  assert.equal(transcriptWheelTarget(terminal, { ...event, deltaY: 0, deltaX: 100 }), null);
  terminal.buffer.active.type = 'normal';
  assert.equal(transcriptWheelTarget(terminal, event), null);
});

test('menus, approvals and nonempty native drafts are not redirected', () => {
  for (const composer of ['› /', '› /model', '› my draft', 'Choose an option']) {
    const { terminal, lines, event } = fixture(); lines[13] = composer;
    assert.equal(transcriptWheelTarget(terminal, event), null, composer);
  }
  const { terminal, lines, event } = fixture(); lines[16] = 'Enter to confirm · Esc to go back';
  assert.equal(transcriptWheelTarget(terminal, event), null);
});

test('detached/hidden terminal surfaces cannot generate redirected mouse input', () => {
  const { terminal, rect, event } = fixture(); rect.height = 0;
  assert.equal(transcriptWheelTarget(terminal, event), null);
});

test('router forwards exactly once with wheel magnitude/mode intact and no provider cross-talk', () => {
  const { terminal, event } = fixture();
  let enabled = true, prevented = 0, calls = 0, received;
  let route;
  const originalQuery = terminal.element.querySelector;
  terminal.element.querySelector = selector => selector === '.xterm-viewport'
    ? { dispatchEvent: redirected => { calls++; received = redirected; assert.equal(route(redirected), false); } }
    : originalQuery(selector);
  route = createCodexTranscriptWheelRouter({ terminal, ownsTranscript: () => enabled,
    WheelEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } } });
  assert.equal(route({ ...event, deltaMode: 1, preventDefault: () => prevented++ }), true);
  assert.equal(calls, 1); assert.equal(prevented, 1);
  assert.equal(received.deltaY, -420); assert.equal(received.deltaMode, 1);
  assert.equal(received.clientY, 130);
  enabled = false;
  assert.equal(route(event), false); assert.equal(calls, 1);
});
