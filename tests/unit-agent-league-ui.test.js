'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('Agent League is a native Chuxin tab, not another iframe product', () => {
  const chuxin = fs.readFileSync(path.join(root, 'renderer', 'chuxin.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  assert.match(chuxin, /require\('\.\/agent-league\.js'\)/);
  assert.match(chuxin, /id: 'league', label: 'Agent 联赛', native: true/);
  assert.match(chuxin, /createAgentLeaguePanel/);
  assert.match(chuxin, /state\.frameView\.style\.display = 'none'/);
  assert.match(chuxin, /returningFromNative/);
  assert.match(chuxin, /setTimeout\(navigate, 50\)/);
  assert.match(index, /agent-league\.css/);
});

test('leaderboard keeps eight compact rows and opens real Session card or PTY views', () => {
  const ui = fs.readFileSync(path.join(root, 'renderer', 'agent-league.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'agent-league.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  for (const channel of ['list', 'create', 'run-day']) {
    assert.match(ui, new RegExp(`leagueChannel\\('${channel}'\\)`));
  }
  for (const action of ['execute-open', 'record-close', 'run-weekly']) {
    assert.match(ui, new RegExp(`runPhase\\(actionEl, '${action}'`));
  }
  assert.match(ui, /DRAFT → HOOK → FINAL/);
  assert.match(ui, /dailyFlowHtml/);
  assert.match(ui, /weeklyHtml/);
  assert.match(ui, /个人 CHECKLIST/);
  assert.match(ui, /查看 \/ 编辑全部提示词/);
  assert.match(ui, /Agent 提示词工作台/);
  assert.match(ui, /leagueChannel\('prompt-files'\)/);
  assert.match(ui, /leagueChannel\('save-prompt-file'\)/);
  assert.match(ui, /受保护的机器状态/);
  assert.match(ui, /待首次运行/);
  assert.match(ui, /leagueChannel\('ensure-session'\)[\s\S]*bridge\.open\(ensured\.session\.id, view, ensured\.session\)/);
  assert.match(ui, /盘前决策已启动/);
  assert.match(ui, /jumpToActionPty/);
  assert.match(ui, /执行并跳转 PTY/);
  assert.match(ui, /data-action="open-card"/);
  assert.match(ui, /data-action="open-pty"/);
  assert.match(css, /\.cxl-ranking\{max-height:464px/);
  assert.match(css, /\.cxl-row\{[^}]*min-height:58px/);
  assert.match(renderer, /__chuxinSessionBridge = \{[\s\S]*async open\(sessionId, view = 'card', preparedSession = null\)/);
  assert.match(renderer, /never race into a second generic dormant resume\/picker/);
  assert.match(renderer, /_chuxinRequestedSessionViews/);
  assert.match(renderer, /Honor that last explicit intent/);
  assert.match(renderer, /\['chuxin-research', 'agent-league', 'agent-league-virtual'\]\.includes\(row\.purpose\)/);
  assert.match(ui, /虚拟实盘调试台/);
  assert.match(ui, /agent-league:virtual-self-test/);
  assert.match(css, /\.cxl-virtual-lab/);
});

test('Agent League sessions remain ordinary visible sidebar sessions', () => {
  const handler = fs.readFileSync(path.join(root, 'main', 'ipc', 'agent-league-handlers.js'), 'utf8');
  const list = fs.readFileSync(path.join(root, 'renderer', 'session-list-renderer.js'), 'utf8');
  assert.match(handler, /sessionPurpose: 'agent-league'/);
  assert.match(handler, /sessionPurpose: 'agent-league-virtual'/);
  assert.match(handler, /hiddenFromSidebar: false/);
  assert.doesNotMatch(list, /purpose\s*!==\s*['"]agent-league/);
});
