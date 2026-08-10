'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildHomeSnapshot } = require('../renderer/home-workbench.js');

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

test('home navigation replaces the old top research shortcut and keeps research inside home', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'home-workbench.css'), 'utf8');

  const homeIndex = html.indexOf('id="btn-home"');
  const workbenchIndex = html.indexOf('id="empty-state"');
  const researchIndex = html.indexOf('id="btn-chuxin"');
  assert.ok(homeIndex >= 0, 'top home button should exist');
  assert.ok(workbenchIndex > homeIndex, 'workbench should live in the main panel');
  assert.ok(researchIndex > workbenchIndex, 'research entry should live inside the home workbench');
  assert.match(html, /id="btn-home"[^>]*>[\s\S]*?<span class="btn-label">主页<\/span>/);
  assert.match(html, /id="btn-chuxin"[\s\S]*?<strong>初心投研<\/strong>/);
  assert.match(html, /id="home-notification-slot"/);
  assert.match(renderer, /btnHome\.addEventListener\('click', \(\) => escapeToHome\(\)\)/);
  assert.match(renderer, /homeWorkbench = createHomeWorkbench\(/);
  assert.match(css, /\.home-pulse-grid/);
  assert.ok(!html.includes('\uFFFD'), 'index.html must remain valid UTF-8');
});
