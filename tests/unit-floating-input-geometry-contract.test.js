'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'task-presets.css'), 'utf8');

test('floating composer locks its flex footprint before observing visual height', () => {
  const mountStart = renderer.indexOf('function mountFloatingInput');
  const mount = renderer.slice(mountStart, renderer.indexOf('function updateFloatingBarState', mountStart));
  assert.match(mount, /contentStack\.className = 'fi-content-stack'/);
  assert.match(mount, /lockFloatingInputBarGeometry\(bar\);[\s\S]{0,500}observeTerminalPanelChrome\(panel, bar\)/);
});

test('visual-height observation does not change the terminal layout height', () => {
  assert.match(renderer, /function measureFloatingBarVisualHeight\(bar\)/);
  assert.match(renderer, /for \(const child of bar\.children\) observer\.observe\(child\)/);
  assert.match(css, /\.floating-input-bar\.visible\.geometry-locked[\s\S]*flex:\s*0 0 var\(--fi-layout-h\)/);
  assert.match(css, /\.floating-input-bar\.geometry-locked > \.fi-content-stack[\s\S]*position:\s*absolute[\s\S]*bottom:\s*8px/);
});

test('a queued observer from a detached composer cannot erase the current session space', () => {
  const start = renderer.indexOf('function observeTerminalPanelChrome(');
  const source = renderer.slice(start, renderer.indexOf('\n// ── T1', start));
  const values = new Map(), callbacks = [];
  const panel = { style: { setProperty: (key, value) => values.set(key, value) }, querySelector: () => ({ offsetHeight: 30 }) };
  const observe = vm.runInNewContext(source + '\nobserveTerminalPanelChrome', {
    measureFloatingBarVisualHeight: bar => bar.parentNode ? bar.height : 0,
    ResizeObserver: class { constructor(cb) { callbacks.push(cb); } observe() {} disconnect() {} },
  });
  const oldBar = { parentNode: panel, height: 189, children: [] };
  observe(panel, oldBar);
  oldBar.parentNode = null;
  const currentBar = { parentNode: panel, height: 212, children: [] };
  observe(panel, currentBar);
  callbacks[0](); // Old observer notification delivered after switching sessions.
  assert.equal(values.get('--fi-bar-h'), '212px');
  currentBar.height = 230;
  callbacks[1]();
  assert.equal(values.get('--fi-bar-h'), '230px', 'the attached composer still owns layout updates');
});
