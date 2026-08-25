'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  LONG_TASK_MS,
  buildHomeSnapshot,
} = require('../renderer/home-workbench.js');

test('HUB workbench groups top-level sessions and meetings into actionable lanes', () => {
  const now = Date.UTC(2026, 7, 10, 10, 0, 0);
  const sessions = new Map([
    ['wait', {
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

test('shell keeps one launcher plus Home and Research navigation while retaining the home research card', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const workbench = fs.readFileSync(path.join(root, 'renderer', 'home-workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'home-workbench.css'), 'utf8');

  const launchIndex = html.indexOf('id="btn-new"');
  const homeIndex = html.indexOf('id="btn-home"');
  const topResearchIndex = html.indexOf('id="btn-research"');
  const workbenchIndex = html.indexOf('id="empty-state"');
  const researchIndex = html.indexOf('id="btn-chuxin"');
  assert.ok(launchIndex >= 0, 'single top launcher should exist');
  assert.ok(homeIndex >= 0, 'top home button should exist');
  assert.ok(launchIndex < homeIndex && homeIndex < topResearchIndex,
    'top navigation order should be launcher, Home, Research');
  assert.ok(workbenchIndex > topResearchIndex, 'workbench should live in the main panel');
  assert.ok(researchIndex > workbenchIndex, 'research entry should live inside the home workbench');
  assert.match(html, /id="btn-home"[^>]*>[\s\S]*?<span class="btn-label">主页<\/span>/);
  assert.match(html, /id="btn-research"[^>]*>[\s\S]*?<span class="btn-label">投研<\/span>/);
  assert.match(html, /id="btn-chuxin"[\s\S]*?<strong>初心投研<\/strong>/);
  assert.match(html, /id="home-notification-slot"/);
  assert.match(renderer, /btnHome\.addEventListener\('click', \(\) => escapeToHome\(\)\)/);
  assert.match(renderer, /homeWorkbench = createHomeWorkbench\(/);
  assert.match(html, /四模型用量/);
  assert.match(html, /改动审阅收件箱/);
  assert.match(html, /id="operations-review-modal"/);
  assert.match(html, /本机与服务器/);
  assert.match(html, /id="cfg-aliyun-health-url"/);
  assert.doesNotMatch(html, /Session 流水线/);
  assert.doesNotMatch(workbench, /renderLane|home-lane-running|home-flow-item/);
  assert.doesNotMatch(workbench, /\b(?:fs\.)?(?:statSync|readFileSync)\s*\(/, 'home render must not block on filesystem I/O');
  assert.match(workbench, /function setHtml\(id, html\)/, 'frequent resource ticks should reuse unchanged list DOM');
  assert.doesNotMatch(html, /趋势快照|本机采样/);
  assert.doesNotMatch(workbench, /usage-trend-store|home-trend-spark|趋势积累/);
  assert.match(workbench, /usageWindowMarkup\('5h'/);
  assert.match(workbench, /usageWindowMarkup\('7d'/);
  assert.match(css, /\.home-usage-windows/);
  assert.match(css, /\.home-pulse-grid/);
  assert.ok(!html.includes('\uFFFD'), 'index.html must remain valid UTF-8');
});

test('workbench derives P0/P1 operational insights without transcript scans', () => {
  const now = new Date('2026-08-10T07:00:00').getTime();
  const artifactPath = 'C:\\Vibe\\AI\\report.html';
  const sessions = new Map([
    ['long', {
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
