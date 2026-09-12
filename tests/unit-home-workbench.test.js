'use strict';
const {nativeSnapshot}=require('./helpers/native-runtime-fixture');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  LONG_TASK_MS,
  buildHomeSnapshot,
  createHomeWorkbench,
} = require('../renderer/home-workbench.js');

test('HUB workbench groups top-level sessions and meetings into actionable lanes', () => {
  const now = Date.UTC(2026, 7, 10, 10, 0, 0);
  const sessions = new Map([
    ['wait', {
      nativeRuntime:nativeSnapshot('waiting',{requests:[{params:{reason:'需要确认提交范围'}}]}),
      id: 'wait', kind: 'codex', title: '等待确认', status: 'idle', isWaiting: true,
      unreadCount: 1, waitingText: '需要确认提交范围', lastMessageTime: now - 60_000,
    }],
    ['run', {
      id: 'run', kind: 'claude', title: '正在实现', status: 'running',
      lastMessageTime: now - 30_000,
    }],
    ['done', {
      id: 'done', kind: 'kimi', title: '已完成报告', status: 'idle', unreadCount: 1,
      lastOutputPreview: '报告已生成', lastMessageTime: now - 10 * 60_000,
    }],
    ['sleep', {
      id: 'sleep', kind: 'gemini', title: '历史研究', status: 'dormant',
      lastMessageTime: now - 2 * 24 * 60 * 60_000,
    }],
    ['child', {
      id: 'child', kind: 'deepseek', title: '群聊成员', status: 'running',
      meetingId: 'meeting-running', hiddenFromSidebar: true,
      lastMessageTime: now - 20_000,
    }],
  ]);
  const meetings = {
    'meeting-running': {
      id: 'meeting-running', title: '多模型审查', status: 'idle', subSessions: ['child'],
      lastMessageTime: now - 20_000,
    },
    'meeting-waiting': {
      id: 'meeting-waiting', title: '投委会', status: 'idle', subSessions: [],
      unreadAnswered: new Set(['a']), lastMessageTime: now - 2 * 60_000,
    },
  };

  const snapshot = buildHomeSnapshot({ sessions, meetings, now });

  assert.deepStrictEqual(snapshot.lanes.waiting.map((item) => item.id), ['wait']);
  assert.deepStrictEqual(snapshot.lanes.running.map((item) => item.id), ['meeting-running', 'run']);
  assert.deepStrictEqual(snapshot.lanes.delivered.map((item) => item.id), ['meeting-waiting', 'done']);
  assert.deepStrictEqual(snapshot.metrics, {
    active: 4,
    waiting: 1,
    unread: 3,
    dormant: 1,
  });
  assert.strictEqual(snapshot.providerActive.codex, 1);
  assert.strictEqual(snapshot.providerActive.claude, 1);
  assert.strictEqual(snapshot.providerActive.deepseek, 1);
  assert.strictEqual(snapshot.providerActive.kimi, 1);
});

test('meeting lanes aggregate child RuntimeTruth waiting and failure states', () => {
  const now = Date.UTC(2026, 7, 10, 10, 0, 0);
  const sessions = new Map([
    ['waiting-child', {
      id: 'waiting-child', kind: 'claude', title: '等待权限', status: 'idle',
      attentionState: 'needs-input', waitingText: 'Allow PowerShell?', meetingId: 'waiting-meeting',
      lastMessageTime: now,
    }],
    ['failed-child', {
      nativeRuntime:nativeSnapshot('failed',{reason:'rate limited'}),
      id: 'failed-child', kind: 'codex', title: '执行失败', status: 'error',
      lastError: 'rate limited', meetingId: 'failed-meeting', lastMessageTime: now,
    }],
  ]);
  const meetings = {
    'waiting-meeting': { id: 'waiting-meeting', title: '等待群聊', status: 'idle', subSessions: ['waiting-child'], lastMessageTime: now },
    'failed-meeting': { id: 'failed-meeting', title: '失败群聊', status: 'idle', subSessions: ['failed-child'], lastMessageTime: now },
  };
  const snapshot = buildHomeSnapshot({ sessions, meetings, now });
  assert.deepStrictEqual(snapshot.lanes.waiting.map(item => item.id), ['waiting-meeting']);
  assert.ok(snapshot.exceptions.some(item => item.targetId === 'failed-meeting' && /rate limited/.test(item.detail)));
});

test('welcome replaces dashboard while retaining shell navigation and shared notification control', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'renderer/home-workbench.js'), 'utf8');
  const controller = source.slice(source.indexOf('function createHomeWorkbench('));
  for (const id of ['btn-new', 'btn-home', 'btn-research', 'home-create-session', 'home-create-group', 'home-notification-slot']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /id="(?:home-card-stack|home-refresh|home-metric-active|home-workspace-launch|btn-chuxin)"/);
  assert.match(renderer, /onCreate: intent => launchCenter.open\(intent\)/);
  assert.doesNotMatch(renderer, /createHomeCardLayout|createProcessReclaimCard|refreshOperationsOverview/);
  assert.doesNotMatch(controller, /setInterval|loadOperations|loadWorkspaces|buildHomeSnapshot\(/,
    'welcome must not poll or build the removed dashboard');
  assert.ok(!html.includes('\uFFFD'));
});

test('welcome handles nested button clicks, reports failure, and permits retry without rebuilding DOM', async (t) => {
  const calls = [], listeners = new Map();
  const root = { style: {}, dataset: {}, isConnected: true, contains: b => b === button,
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const button = { dataset: { homeCreate: 'group' }, disabled: false };
  const error = { hidden: true, textContent: '' };
  const toggle = { parentElement: null };
  let moves = 0;
  const slot = { appendChild: node => { moves++; node.parentElement = slot; } };
  const nodes = { 'empty-state': root, 'home-welcome-error': error, 'home-notification-slot': slot, 'completion-notification-toggle': toggle };
  const controller = createHomeWorkbench({ document: { getElementById: id => nodes[id] }, onCreate: intent => {
    calls.push(intent);
    if (calls.length === 1) throw new Error('test launch failure');
  } });
  t.mock.method(console, 'error', () => {});
  const event = { target: { closest: () => button }, preventDefault() {}, stopPropagation() {} };
  await listeners.get('click')(event);
  assert.strictEqual(error.hidden, false);
  assert.match(error.textContent, /test launch failure/);
  assert.strictEqual(button.disabled, false);
  await listeners.get('click')(event);
  assert.deepStrictEqual(calls, ['group', 'group']);
  assert.strictEqual(error.hidden, true);
  controller.render(); controller.render();
  assert.strictEqual(moves, 1, 'resource ticks must preserve existing DOM and focus');
  root.style.display = 'none'; toggle.parentElement = null; controller.render();
  assert.strictEqual(moves, 1, 'hidden welcome must not move the shared notification');
  controller.dispose(); assert.strictEqual(listeners.size, 0);
});

test('workbench derives P0/P1 operational insights without transcript scans', () => {
  const now = Date.parse('2026-08-09T23:00:00Z'); // 北京时间 2026-08-10 07:00
  const artifactPath = 'C:\\Vibe\\AI\\report.html';
  const sessions = new Map([
    ['long', {
      nativeRuntime:nativeSnapshot('running',{startedAt:now - 22 * 60_000}),
      id: 'long', kind: 'codex', title: '长任务', status: 'running',
      runStartedAt: now - 22 * 60_000,
      lastMessageTime: now - 8 * 60_000,
      contextPct: 93,
    }],
    ['done', {
      id: 'done', kind: 'claude', title: '夜间报告', status: 'idle', unreadCount: 1,
      lastMessageTime: now - 2 * 60 * 60_000,
      lastCompletedAt: now - 2 * 60 * 60_000,
      lastRunDurationMs: 18 * 60_000,
      recentArtifacts: [{ path: artifactPath, timestamp: now - 2 * 60 * 60_000 }],
    }],
    ['failed', {
      id: 'failed', kind: 'kimi', title: '夜间失败任务', status: 'error', unreadCount: 0,
      lastMessageTime: now - 60 * 60_000,
      lastCompletedAt: now - 60 * 60_000,
      lastRunDurationMs: 7 * 60_000,
    }],
    ['slept', {
      id: 'slept', kind: 'claude', title: '已自动休眠的夜间任务', status: 'dormant', unreadCount: 0,
      lastMessageTime: now - 3 * 60 * 60_000,
      lastCompletedAt: now - 3 * 60 * 60_000,
      lastRunDurationMs: 11 * 60_000,
      recentArtifacts: [{ path: 'C:\\Vibe\\AI\\sleep-report.md', timestamp: now - 3 * 60 * 60_000 }],
    }],
  ]);

  const snapshot = buildHomeSnapshot({
    sessions,
    now,
    pathExists: value => value === artifactPath || value.endsWith('sleep-report.md'),
    hubConfig: {
      egress: {
        checkedAt: now,
        alert: { type: 'vpn_unavailable', severity: 'critical', title: 'VPN 不可用', message: '海外出口失败' },
      },
    },
  });

  assert.equal(snapshot.lanes.running[0].longRunning, true);
  assert.ok(snapshot.lanes.running[0].elapsedMs >= LONG_TASK_MS);
  assert.deepStrictEqual(snapshot.contextRisk.map(item => item.id), ['long']);
  assert.equal(snapshot.contextRisk[0].supportsFork, true);
  assert.equal(snapshot.artifacts[0].path, artifactPath);
  assert.equal(snapshot.night.completed, 2);
  assert.equal(snapshot.night.failed, 1);
  assert.equal(snapshot.night.totalDurationMs, 29 * 60_000);
  assert.ok(snapshot.artifacts.some(item => item.name === 'sleep-report.md'));
  assert.ok(snapshot.exceptions.some(item => item.id === 'session-stalled:long'));
  assert.ok(snapshot.exceptions.some(item => item.id === 'session-context:long'));
  assert.equal(snapshot.exceptions[0].id, 'system-egress:vpn_unavailable', 'critical system exception should sort first');
});
