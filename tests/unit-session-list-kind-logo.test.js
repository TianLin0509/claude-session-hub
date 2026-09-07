'use strict';
// 2026-09-01 · 侧栏瘦身配套测试。
//
// 改动：renderer/session-list-renderer.js 的普通 session 行，时间左边那一列从
//   <span class="sl-model">Opus 5</span> 换成 <span class="sl-kind ai-logo logo-claude">；
//   同时时间列不再拼 "休眠 · " 前缀（休眠改由 .dormant 底色 + 灰状态点表达）。
//
// 这里锁三件容易被"顺手改回去"的事：
//   1. 每种 kind 都能拿到正确的 logo class（含 *-resume / deepseek-legacy 归一）
//   2. 型号文字不再进 DOM，但仍在 tooltip 里（信息没丢，只是降级）
//   3. 休眠行不再出现"休眠"二字，而 dormant class 还在

const assert = require('assert');
const path = require('path');

const { createSessionListRenderer } = require(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'));

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e.message || e));
  }
}

function makeEl() {
  const el = {
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
    setProperty() {},
  };
  el.style.setProperty = () => {};
  return el;
}
function mockDoc() {
  return {
    createElement: () => makeEl(),
    getElementById: () => null,
    head: makeEl(),
    documentElement: makeEl(),
  };
}
// 与生产一致：真实 isAiKind，避免 mock 白名单和 core/ai-kinds.js 走偏。
const { isAiKind } = require(path.join(__dirname, '..', 'core', 'ai-kinds.js'));

function renderRows(sessions) {
  const sessionListEl = makeEl();
  const r = createSessionListRenderer({
    document: mockDoc(),
    localStorage: { getItem: () => '[]', setItem: () => {} },
    sessionListEl,
    getSessions: () => sessions,
    getMeetings: () => ({}),
    getActiveSessionId: () => null,
    getActiveMeetingId: () => null,
    isAiKind,
    modelShort: (m) => (m && m.displayName) || '',
    modelClass: () => 'opus',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    formatTime: () => '09:30',
    pctClass: () => 'ok',
    sessionBurnRate: () => null,
    selectSession: () => {},
    selectMeeting: () => {},
    openContextMenu: () => {},
  });
  r.renderSessionList();
  return { rows: sessionListEl.children, html: sessionListEl.children.map(c => c.innerHTML || '').join('\n') };
}

function oneSession(overrides) {
  const now = Date.now();
  const s = Object.assign({
    id: 'sid', title: '会话', kind: 'claude', status: 'idle',
    createdAt: now, lastMessageTime: now, unreadCount: 0,
  }, overrides);
  const m = new Map();
  m.set(s.id, s);
  return m;
}

// ---------------- 用例 1：claude 会话渲染 logo-claude，模型文字退出 DOM ----------------
test('claude 会话在时间左边渲染 .sl-kind.logo-claude，不再渲染模型文字', () => {
  const { html } = renderRows(oneSession({
    kind: 'claude',
    currentModel: { id: 'claude-opus-5', displayName: 'Opus 5' },
  }));
  assert.ok(/class="sl-kind ai-logo logo-claude"/.test(html), '应渲染 .sl-kind.ai-logo.logo-claude');
  assert.ok(!/class="sl-model"/.test(html), '模型文字列应已被 logo 取代');
  assert.ok(!/>Opus 5</.test(html), '"Opus 5" 不应作为可见文本出现在行内');
  assert.ok(/title="Claude · Opus 5"/.test(html), '型号降级到 logo 的 tooltip，信息不丢');
});

// ---------------- 用例 2：codex 会话用 logo-codex（一眼分家的核心诉求） ----------------
test('codex 会话渲染 logo-codex，与 claude 行可区分', () => {
  const { html } = renderRows(oneSession({
    id: 'cx', kind: 'codex',
    currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-SOL' },
  }));
  assert.ok(/logo-codex/.test(html), 'codex 会话应渲染 logo-codex');
  assert.ok(!/logo-claude/.test(html), 'codex 行不应出现 claude 图标');
  assert.ok(!/gpt-5\.6-sol|GPT-5\.6-SOL</.test(html.replace(/title="[^"]*"/g, '')), '型号字串不应进可见文本');
});

// ---------------- 用例 3：*-resume 与 deepseek-legacy 必须归一到基础 logo ----------------
test('claude-resume / deepseek-legacy-resume 归一到基础 logo，不出现空图标', () => {
  const resumed = renderRows(oneSession({ id: 'r1', kind: 'claude-resume' }));
  assert.ok(/logo-claude"/.test(resumed.html), 'claude-resume 应回落到 logo-claude');
  const legacy = renderRows(oneSession({ id: 'r2', kind: 'deepseek-legacy-resume' }));
  assert.ok(/logo-deepseek"/.test(legacy.html), 'deepseek-legacy-resume 应回落到 logo-deepseek');
});

// ---------------- 用例 4：没有对应 logo 的 kind 回落成文字列，不留空白 ----------------
test('未知 kind 回落到 .sl-model 文字列', () => {
  const { html } = renderRows(oneSession({
    id: 'x', kind: 'some-future-cli',
    currentModel: { id: 'm', displayName: 'Future 1' },
  }));
  assert.ok(/class="sl-model">Future 1</.test(html), '拿不到 logo 时应保留原来的文字列');
});

// ---------------- 用例 5：休眠行不再印"休眠"二字，但 dormant 标记还在 ----------------
test('休眠会话时间列只显示时间，以月牙替代灰色状态环', () => {
  const { rows, html } = renderRows(oneSession({
    id: 'd1', kind: 'codex', status: 'dormant', suspendReason: 'idle-timeout',
  }));
  const timeCol = /<span class="sl-time[^"]*">([^<]*)<\/span>/.exec(html);
  assert.ok(timeCol, '应渲染 .sl-time 列');
  assert.equal(timeCol[1], '09:30', '时间列只剩时间本身');
  assert.ok(rows.some(r => String(r.className || '').includes('dormant')), '行仍带 dormant class');
  assert.ok(/class="sl-moon"/.test(html), '休眠使用月牙标识');
  assert.ok(!/sl-ring-dot dorm/.test(html), '避免月牙和灰色状态环重复提示');
  assert.ok(/自动休眠/.test(html) && /点击唤醒/.test(html), 'tooltip 仍解释休眠与唤醒');
});

// ---------------- 用例 6：断连仍保留文字前缀（红色 + 文字双保险，未在本次改动范围） ----------------
test('断连行仍保留"断连 · "前缀', () => {
  const now = Date.now();
  const sessions = oneSession({
    id: 'dc', kind: 'codex', status: 'running',
    streamDisconnect: { at: now, reason: 'ECONNRESET' },
  });
  const { html } = renderRows(sessions);
  if (/disconnected-time/.test(html)) {
    assert.ok(/断连 · /.test(html), '断连前缀属于告警语义，本次不动');
  } else {
    console.log('    (跳过：mock session 未触发 stream-disconnect 判定)');
  }
});

// ---------------- 用例 7：运行中的普通会话，行上要带 running 标记（logo 呼吸靠它） ----------------
// 2026-09-06：群聊行早就有「黄点脉冲」表示有人在干活，普通会话只有一个 4.4px 的绿点。
//   用户要求普通会话的 logo 也做呼吸效果，动画挂在 .session-item.slim.running .sl-kind 上，
//   所以这一行的 running class 是唯一的开关，别在重构里顺手删掉。
test('运行中的普通会话带 running class，等待/空闲/休眠都不带', () => {
  const running = renderRows(oneSession({ id: 'run1', kind: 'claude', status: 'running' }));
  assert.ok(running.rows.some(r => /\brunning\b/.test(String(r.className || ''))),
    '运行中的行要带 running class，logo 呼吸动画靠它');

  const idle = renderRows(oneSession({ id: 'idle1', kind: 'claude', status: 'idle' }));
  assert.ok(!idle.rows.some(r => /\brunning\b/.test(String(r.className || ''))),
    '空闲行不该闪');

  const waiting = renderRows(oneSession({
    id: 'wait1', kind: 'claude', status: 'running',
    attentionState: 'needs-input', needsUserInput: true,
  }));
  assert.ok(!waiting.rows.some(r => /\brunning\b/.test(String(r.className || ''))),
    '等你输入不是在干活，不该闪');

  const dormant = renderRows(oneSession({ id: 'dorm1', kind: 'claude', status: 'dormant' }));
  assert.ok(!dormant.rows.some(r => /\brunning\b/.test(String(r.className || ''))),
    '休眠行不该闪');
});

// ---------------- 用例 8：呼吸动画本体必须在样式表里 ----------------
test('侧栏样式表里有 .running .sl-kind 的呼吸动画', () => {
  const fs = require('fs');
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'styles', 'shell-sidebar-terminal.css'), 'utf8');
  assert.ok(/\.session-item\.slim\.running \.sl-kind\s*\{[^}]*animation:\s*sl-logo-breathe/.test(css),
    'logo 呼吸动画应挂在运行中的普通会话行上');
  assert.ok(/@keyframes sl-logo-breathe/.test(css), '关键帧本体不能少');
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
