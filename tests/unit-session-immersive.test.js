'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionImmersiveController } = require('../renderer/session-immersive');

function fixture() {
  function element() {
    const classes = new Set(), listeners = {};
    return { hidden: false, disabled: false, listeners,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener: (name, fn) => { listeners[name] = fn; }, setAttribute() {}, append() {}, remove() {}, querySelector: () => null,
    };
  }
  const button = element(), body = element(), surface = element(), events = {}, requests = [];
  let id = 'a';
  const controller = createSessionImmersiveController({
    document: { body, getElementById: () => button, createElement: element, addEventListener() {} },
    ipcRenderer: { on: (name, fn) => { events[name] = fn; }, invoke: (_name, value) => new Promise(resolve => requests.push({ value, resolve })) },
    getSurface: () => surface, getSessionId: () => id, refit() {}, onError: message => { throw Error(message); },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { button, body, controller, events, requests, tick, changeSession: value => { id = value; } };
}

test('navigation during pending entry cannot reopen the departed session', async () => {
  const f = fixture(); f.button.listeners.click(); f.controller.sync(false);
  assert.deepEqual(f.requests.map(request => request.value), [true, false]);
  f.requests[0].resolve({ ok: true }); await f.tick();
  assert.equal(f.body.classList.contains('session-immersive-active'), false);
  f.requests[1].resolve({ ok: true }); await f.tick();
  assert.equal(f.button.disabled, false);
});

test('native Escape before the entry reply prevents a stale overlay', async () => {
  const f = fixture(); f.button.listeners.click();
  f.events['preview:immersive-state']({}, { active: false });
  f.requests[0].resolve({ ok: true }); await f.tick();
  assert.equal(f.body.classList.contains('session-immersive-active'), false);
  assert.equal(f.button.disabled, false);
});

test('switching focused session during entry restores the native window', async () => {
  const f = fixture(); f.button.listeners.click(); f.changeSession('b');
  f.requests[0].resolve({ ok: true }); await f.tick();
  assert.deepEqual(f.requests.map(request => request.value), [true, false]);
  assert.equal(f.body.classList.contains('session-immersive-active'), false);
  f.requests[1].resolve({ ok: true }); await f.tick();
  assert.equal(f.button.disabled, false);
});

test('exit remains visibly busy until the native window has restored', async () => {
  const f = fixture(); f.button.listeners.click();
  f.requests[0].resolve({ ok: true }); await f.tick();
  const exiting = f.controller.exit();
  assert.equal(f.body.classList.contains('session-immersive-active'), false);
  assert.equal(f.button.disabled, true, 'navigation cannot advertise another entry before native exit acknowledges');
  f.button.listeners.click();
  assert.equal(f.requests.length, 2, 'a second entry does not race the pending exit');
  f.requests[1].resolve({ ok: true }); await exiting;
  assert.equal(f.button.disabled, false);
});
