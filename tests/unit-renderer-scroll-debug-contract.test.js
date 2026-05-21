'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createScrollDebug, installScrollDebug } = require('../renderer/scroll-debug.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-scroll-debug-'));
const logPath = path.join(dir, 'scroll-debug.log');
const logs = [];
const debug = createScrollDebug(logPath, { log: (...args) => logs.push(args.join(' ')) });

assert.strictEqual(debug.isOn(), false, 'scroll debug should start disabled');
debug.log('ignored', { a: 1 });
assert.strictEqual(fs.existsSync(logPath), false, 'disabled logger should not create a log file');

debug.on();
debug.log('wheel', { deltaY: 1 });
assert.strictEqual(debug.isOn(), true, 'on() should enable logging');
assert.match(fs.readFileSync(logPath, 'utf8'), /wheel/,
  'enabled logger should append tagged payloads');

const fakeTerminal = {
  cols: 80,
  rows: 24,
  buffer: { active: { length: 10, baseY: 2, viewportY: 1 } },
  element: null,
};
assert.deepStrictEqual(debug.snap(fakeTerminal, 'abcdef123'), {
  sid: 'abcdef',
  bufLen: 10,
  baseY: 2,
  vpY: 1,
  cols: 80,
  rows: 24,
}, 'snap should keep the existing terminal viewport shape');

const fakeWindow = {};
const installed = installScrollDebug(fakeWindow, dir);
assert.ok(installed && fakeWindow.__scrollDebug === installed,
  'installScrollDebug should attach the debug object to the renderer window');

console.log('Renderer scroll debug contract: ok');
