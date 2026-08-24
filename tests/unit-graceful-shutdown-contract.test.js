'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'core', 'session-manager.js'), 'utf8');

test('before-quit is deferred until the PTY drain reaches a safe state', () => {
  assert.match(mainSource, /app\.on\('before-quit', \(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*beginGracefulHubShutdown\('before-quit'\)/);
  assert.match(mainSource, /sessionManager\.disposeGracefully\([\s\S]*safeToQuit[\s\S]*app\.quit\(\)/);
});

test('window-all-closed uses the graceful coordinator, not immediate PTY teardown', () => {
  assert.match(mainSource, /app\.on\('window-all-closed',[\s\S]*beginGracefulHubShutdown\('window-all-closed'\)/);
  assert.doesNotMatch(mainSource, /app\.on\('window-all-closed',[\s\S]{0,200}sessionManager\.dispose\(\)/);
});

test('SessionManager resolves shutdown waiters from the existing PTY exit path', () => {
  assert.match(managerSource, /_handlePtyExit\([\s\S]*_shutdownExitWaiters\.get\(sessionId\)[\s\S]*shutdownWaiter\.resolve/);
  assert.match(managerSource, /disposeGracefully\(options = \{\}\)[\s\S]*await Promise\.all\(waits\)/);
});
