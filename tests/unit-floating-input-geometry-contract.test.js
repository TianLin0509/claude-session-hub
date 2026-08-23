'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
