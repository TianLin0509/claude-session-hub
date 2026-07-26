'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

assert.ok(!html.includes('btn-remote-hub'), 'desktop remote Hub button should not be rendered');
assert.ok(!html.includes('remote-panel'), 'desktop remote Hub panel should not be rendered');
assert.ok(!html.includes('remote-mode.js'), 'desktop remote Hub renderer script should not load');
assert.ok(!styles.includes('remote-mode.css'), 'desktop remote Hub CSS should not load');
assert.ok(!main.includes('startRemoteClient'), 'desktop remote Hub client should not auto-start');
assert.ok(!main.includes('startMobileBridge'), 'mobile bridge should not auto-start');
assert.ok(!main.includes('hub-update-check'), 'remote Hub update IPC should not be registered');
assert.ok(!main.includes('hub-update-apply'), 'remote Hub update IPC should not be registered');

console.log('Remote mode removed contract: ok');
