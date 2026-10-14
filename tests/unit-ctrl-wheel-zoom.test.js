'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWheelStepper, wheelDeltaPixels, installCtrlWheelZoom } = require('../renderer/ctrl-wheel-zoom');

test('a mouse notch is one step even when zoom shrinks its delta, never two', () => {
  let t = 0;
  const step = createWheelStepper({ now: () => (t += 500) });
  assert.equal(step(-100), 1, 'notch up = zoom in');
  assert.equal(step(-83), 1, 'Hub UI at 120%');
  assert.equal(step(-240), 1, 'a fast flick is still one step');
  assert.equal(step(91), -1, 'notch down = zoom out');
});

test('touchpad deltas add up to half a notch; a pause or reversal starts over', () => {
  let t = 0;
  const step = createWheelStepper({ now: () => (t += 16) });
  assert.deepEqual([-12, -12, -12, -12].map(step), [0, 0, 0, 0]);
  assert.equal(step(-12), 1, 'five small moves make one step');
  assert.equal(step(-30), 0);
  assert.equal(step(30), 0, 'reversal drops the pending upward motion');
  t += 1000;
  assert.equal(step(-30), 0, 'after a pause the old remainder is gone');
});

test('line and page wheel modes convert to pixels', () => {
  assert.equal(wheelDeltaPixels({ deltaMode: 0, deltaY: -100 }), -100);
  assert.equal(wheelDeltaPixels({ deltaMode: 1, deltaY: -3 }), -99);
  assert.equal(wheelDeltaPixels({ deltaMode: 2, deltaY: 1 }), 800);
});

function fakeDom() {
  const listeners = [];
  const el = (cls) => ({ cls, closest(sel) { return sel.split(',').some(s => this.cls.includes(s.trim().replace(/^[.#]/, ''))) ? this : null; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) });
  const body = { append() {} };
  const doc = { body, defaultView: { innerWidth: 1500 }, createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, setAttribute() {} }) };
  const win = { addEventListener: (type, fn, opts) => listeners.push({ type, fn, capture: !!(opts && opts.capture) }) };
  const dispatch = (target, deltaY, ctrlKey = true, takenByPreview = false) => {
    const ev = { target, deltaY, deltaMode: 0, ctrlKey, defaultPrevented: takenByPreview, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const l of listeners.filter(l => l.capture)) l.fn(ev);
    if (!ev.stopped) for (const l of listeners.filter(l => !l.capture)) l.fn(ev);
    return ev;
  };
  return { win, doc, el, dispatch };
}

test('cards change the reading size, the terminal its font, and the window never zooms', () => {
  const { win, doc, el, dispatch } = fakeDom();
  let reading = 16, terminal = 15;
  installCtrlWheelZoom({ window: win, document: doc,
    getReadingSize: () => reading, setReadingSize: v => { reading = v; },
    getTerminalSize: () => terminal, setTerminalSize: v => { terminal = v; } });
  const card = el('msg-overlay turn-card');
  let ev = dispatch(card, -100);
  assert.equal(reading, 17); assert.equal(ev.defaultPrevented, true, 'Chromium page zoom suppressed');
  ev = dispatch(el('xterm'), 100);
  assert.equal(terminal, 14); assert.equal(reading, 17); assert.equal(ev.stopped, true, 'xterm does not also scroll');
  ev = dispatch(card, -100, false);
  assert.equal(reading, 17, 'plain wheel scrolls, it does not zoom'); assert.equal(ev.defaultPrevented, false);
});

test('an event the preview already took is left alone', () => {
  const { win, doc, el, dispatch } = fakeDom();
  let reading = 16;
  installCtrlWheelZoom({ window: win, document: doc, getReadingSize: () => reading, setReadingSize: v => { reading = v; }, getTerminalSize: () => 15, setTerminalSize() {} });
  // The preview's own handler ran first and called preventDefault().
  dispatch(el('preview-body'), -100, true, true);
  assert.equal(reading, 16);
});

test('web previews are zoomed once (body CSS zoom), and their wheel is forwarded', () => {
  const controller = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'preview-panel-controller.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'preview-webview-preload.js'), 'utf8');
  assert.doesNotMatch(controller, /setZoomFactor\(previewZoomLevel\)/);
  assert.match(controller, /action === 'wheel-zoom'/);
  assert.match(preload, /sendToHost\('preview-shortcut', 'wheel-zoom'/);
});
