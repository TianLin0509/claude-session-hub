'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'agent-league.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'main', 'ipc', 'agent-league-handlers.js'), 'utf8');

test('window close always drains the Hub instead of keeping an invisible owner', () => {
  assert.doesNotMatch(mainSource, /shouldKeepAgentLeagueInBackground|ensureAgentLeagueTray|new Tray\(/);
  assert.match(mainSource, /beginGracefulHubShutdown\('window-close-requested'\)/);
  assert.doesNotMatch(rendererSource, /toggle-background|toggleBackground/);
  assert.match(handlerSource, /keepAliveOnClose: false/);
});

test('explicit shutdown freezes league dispatch before SessionManager drains PTYs', () => {
  const handoffIndex = mainSource.indexOf('agentLeagueBridge.beginHandoff(reason)');
  const drainIndex = mainSource.indexOf('sessionManager.disposeGracefully');
  assert(handoffIndex > 0 && drainIndex > handoffIndex);
});
