'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreviewFindController, findAllOffsets } = require('../renderer/preview-find.js');

test('findAllOffsets is case-insensitive and returns non-overlapping ranges', () => {
  assert.deepEqual(findAllOffsets('Report report REPORT', 'report'), [
    { start: 0, end: 6 },
    { start: 7, end: 13 },
    { start: 14, end: 20 },
  ]);
  assert.deepEqual(findAllOffsets('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test('findAllOffsets handles Chinese text and empty queries', () => {
  assert.deepEqual(findAllOffsets('预览路径与预览全文', '预览'), [
    { start: 0, end: 2 },
    { start: 5, end: 7 },
  ]);
  assert.deepEqual(findAllOffsets('anything', ''), []);
  assert.deepEqual(findAllOffsets('', 'x'), []);
});

test('findAllOffsets preserves original UTF-16 offsets for Unicode case folding and literals', () => {
  const source = 'İx ix a+b a+b';
  assert.deepEqual(findAllOffsets(source, 'x'), [
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ]);
  assert.deepEqual(findAllOffsets(source, 'a+b'), [
    { start: 6, end: 9 },
    { start: 10, end: 13 },
  ]);
  for (const offset of findAllOffsets(source, 'i')) {
    assert.ok(offset.start >= 0 && offset.end <= source.length && offset.start < offset.end);
  }
});

test('Enter cancels pending input debounce instead of resetting navigation', async () => {
  function element() {
    return {
      hidden: false,
      value: '',
      dataset: {},
      attributes: {},
      listeners: {},
      isConnected: true,
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      focus() {},
      select() {},
    };
  }
  const elements = {
    'preview-find-bar': element(),
    'preview-find-input': element(),
    'preview-find-count': element(),
    'preview-find-previous': element(),
    'preview-find-next': element(),
    'preview-find-close': element(),
    'preview-find-toggle': element(),
  };
  const webview = {
    isConnected: true,
    async executeJavaScript(script) {
      if (script.includes('return { matches, found }')) return { matches: 2, found: true };
      return true;
    },
  };
  const previewBody = {
    querySelector(selector) { return selector === 'webview' ? webview : null; },
    getBoundingClientRect() { return { top: 0, bottom: 100, left: 0, right: 100 }; },
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 100,
    clientWidth: 100,
  };
  const document = {
    activeElement: null,
    getElementById(id) { return elements[id] || null; },
  };
  const controller = createPreviewFindController({
    document,
    previewBody,
    getWebview: () => webview,
    debounceMs: 70,
  });
  const input = elements['preview-find-input'];
  input.value = 'marker';
  input.listeners.input();
  const event = { key: 'Enter', shiftKey: false, preventDefault() {} };
  input.listeners.keydown(event);
  input.listeners.keydown(event);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(elements['preview-find-count'].textContent, '2 / 2');
  assert.equal(controller.getState().activeIndex, 1);
});
