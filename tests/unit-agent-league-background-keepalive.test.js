'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'agent-league.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'main', 'ipc', 'agent-league-handlers.js'), 'utf8');

test('closing a Hub with automatic league keepalive hides the window instead of draining PTYs', () => {
  assert.match(mainSource, /shouldKeepAgentLeagueInBackground\(\)[\s\S]*ensureAgentLeagueTray\(\)[\s\S]*mainWindow\.hide\(\)/);
  assert.match(mainSource, /new Tray\(icon\)/);
  assert.match(mainSource, /退出此 Hub（未完成任务可由其他 Hub 接班）/);
  assert.match(mainSource, /tray-explicit-quit/);
});

test('the background preference is explicit in schedule IPC and Agent League UI', () => {
  assert.match(handlerSource, /keepAliveOnClose:[\s\S]*previous\.keepAliveOnClose !== false/);
  assert.match(rendererSource, /data-action="toggle-background"/);
  assert.match(rendererSource, /关闭窗口后联赛继续运行，可从托盘重新打开/);
});

test('explicit shutdown freezes league dispatch before SessionManager drains PTYs', () => {
  const handoffIndex = mainSource.indexOf('agentLeagueBridge.beginHandoff(reason)');
  const drainIndex = mainSource.indexOf('sessionManager.disposeGracefully');
  assert(handoffIndex > 0 && drainIndex > handoffIndex);
});
