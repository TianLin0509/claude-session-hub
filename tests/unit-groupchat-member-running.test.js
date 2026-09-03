'use strict';
// 2026-07-28 用户反馈：群聊里单独点进 Codex 的 CLI 布置任务，Codex 已经在跑，
//   但 (1) 成员状态点还是绿色（就绪），(2) 该群聊没有被归到侧栏的「运行中」分区。
//
// 根因：renderer.js 的 onPromptSubmittedFromTranscriptEvent 第一行就 `if (meetingId) return`，
//   把群聊成员的开工信号整条丢掉。而 codex/kimi 的 running 只能由 transcript 事件驱动
//   —— terminal-activity-monitor.js 明确关掉了它们的 byte-burst 判定（TUI 打字整屏重绘
//   >200B 会误判成 agent 在跑）。claude 走 hook 路径没有这层早退，所以只有 codex/kimi 不亮灯。
//
// 这里两条腿都测：
//   A. 侧栏渲染行为（真实调用 createSessionListRenderer）—— 成员状态点 + 分区归属
//   B. renderer.js 两个 transcript 事件处理器的源码契约 —— 早退不得再挡在状态更新前面

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createSessionListRenderer } = require(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'));
const {
  GC_WORKING_FRESH_MS,
  hasFreshGroupChatWork,
  isGroupChatMemberRunning,
} = require(path.join(__dirname, '..', 'core', 'groupchat-running-state.js'));
const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

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

// --- 与 unit-session-list-renderer-mini-ctx 同款的极简 DOM mock ---
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

function render({ sessions, meetings, activeMeetingId = null }) {
  const sessionListEl = makeEl();
  const r = createSessionListRenderer({
    document: { createElement: () => makeEl(), getElementById: () => null, head: makeEl(), documentElement: makeEl() },
    localStorage: { getItem: () => '[]', setItem: () => {} },
    sessionListEl,
    getSessions: () => sessions,
    getMeetings: () => meetings,
    getActiveSessionId: () => null,
    getActiveMeetingId: () => activeMeetingId,
    isAiKind: (k) => ['claude', 'codex', 'kimi', 'gemini', 'deepseek'].includes(k),
    modelShort: () => '',
    modelClass: () => 'opus',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    formatTime: () => '00:00',
    pctClass: () => 'ok',
    sessionBurnRate: () => null,
    selectSession: () => {},
    selectMeeting: () => {},
    openContextMenu: () => {},
  });
  r.renderSessionList();
  // 分区标题和会话卡都是 sessionListEl 的直接子节点，按顺序拼起来即可判断归属。
  return sessionListEl.children.map(c => c.innerHTML || '').join('\n');
}

// 一个三成员群聊：claude / codex / kimi，可指定各自 status。
function groupChat(statuses, extra = {}) {
  const sessions = new Map();
  const kinds = ['claude', 'codex', 'kimi'];
  kinds.forEach((kind, i) => {
    sessions.set('sid-' + kind, {
      id: 'sid-' + kind, title: 'AI-' + kind, kind,
      status: statuses[i], contextPct: 10 + i,
      ...(extra.subs || {}),
    });
  });
  const meetings = {
    m1: {
      id: 'm1', title: '英雄大厅轻量化实现', subSessions: kinds.map(k => 'sid-' + k),
      groupChat: true, status: 'idle',
      lastMessageTime: Date.now(), createdAt: Date.now(),
      ...(extra.meeting || {}),
    },
  };
  return { sessions, meetings };
}

// 「运行中」分区标题出现在该群聊卡片之前，即视为归入运行中。
function sectionOf(html, needle) {
  const lines = html.split('\n');
  let current = null;
  for (const line of lines) {
    const m = line.match(/<span>(⚠ 等你响应|运行中|⚠ 运行异常|✓ 已完成未读|最近)<\/span>/);
    if (m) { current = m[1]; continue; }
    if (line.includes(needle)) return current;
  }
  return null;
}

console.log('Running unit-groupchat-member-running tests...');

// ---------- A. 侧栏行为 ----------

test('成员自己在跑时，它的状态点是运行中（黄色脉冲）而不是就绪（绿色）', () => {
  const { sessions, meetings } = groupChat(['idle', 'running', 'idle']);
  const html = render({ sessions, meetings });
  const codexDot = html.match(/mini-jump-status-dot ([a-z-]+)"[^>]*><\/span>\s*<span class="mini-jump-text">codex/)
    || html.match(/mini-st-\w+/g);
  assert.ok(/mini-st-thinking/.test(html),
    '正在跑的 codex 成员必须渲染 mini-st-thinking（黄色脉冲），实际: ' + (codexDot || []).join(','));
  // 另外两个 idle 成员仍是就绪绿点
  assert.strictEqual((html.match(/mini-st-ready/g) || []).length, 2,
    'claude / kimi 仍是 idle，应各保留一个 mini-st-ready');
});

test('群聊里任意一个成员在跑，该群聊就归到侧栏「运行中」分区', () => {
  const { sessions, meetings } = groupChat(['idle', 'running', 'idle']);
  const html = render({ sessions, meetings });
  assert.strictEqual(sectionOf(html, '英雄大厅轻量化实现'), '运行中',
    '只要有成员在跑，群聊就该进「运行中」，而不是沉到「最近」');
});

test('三个成员都空闲时群聊不进运行中', () => {
  const { sessions, meetings } = groupChat(['idle', 'idle', 'idle']);
  const html = render({ sessions, meetings });
  assert.ok(!/mini-st-thinking/.test(html), '没人在跑就不该有运行中状态点');
  assert.notStrictEqual(sectionOf(html, '英雄大厅轻量化实现'), '运行中');
});

test('群聊父项优先显示等待和运行，不会被部分完成未读覆盖', () => {
  const waitingCase = groupChat(['idle', 'idle', 'idle'], {
    meeting: { unreadAnswered: new Set(['sid-codex']) },
  });
  waitingCase.sessions.get('sid-claude').attentionState = 'needs-input';
  waitingCase.sessions.get('sid-claude').waitingText = 'Allow PowerShell?';
  const waitingHtml = render(waitingCase);
  assert.strictEqual(sectionOf(waitingHtml, '英雄大厅轻量化实现'), '⚠ 等你响应');
  assert.match(waitingHtml, /sl-state wait[^>]*>等你/);

  const runningCase = groupChat(['running', 'idle', 'idle'], {
    meeting: { unreadAnswered: new Set(['sid-codex']) },
  });
  const runningHtml = render(runningCase);
  assert.strictEqual(sectionOf(runningHtml, '英雄大厅轻量化实现'), '运行中');
  assert.match(runningHtml, /sl-state run[^>]*>运行中/);
  assert.doesNotMatch(runningHtml, /sl-state unread[^>]*>已答/);
});

test('群聊成员失败会聚合到父项异常分区', () => {
  const fixture = groupChat(['idle', 'error', 'idle']);
  fixture.sessions.get('sid-codex').lastError = 'rate limited';
  const html = render(fixture);
  assert.strictEqual(sectionOf(html, '英雄大厅轻量化实现'), '⚠ 运行异常');
  assert.match(html, /mini-st-error/);
  assert.match(html, /sl-state error[^>]*>异常/);
});

test('只有运行异常而没有运行中时，普通会话仍显示「最近」分区标题', () => {
  const fixture = groupChat(['idle', 'error', 'idle']);
  fixture.sessions.get('sid-codex').lastError = 'stream disconnected';
  fixture.sessions.set('recent-session', {
    id: 'recent-session',
    kind: 'claude',
    title: '普通最近会话',
    status: 'idle',
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
  });
  const html = render(fixture);
  assert.strictEqual(sectionOf(html, '英雄大厅轻量化实现'), '⚠ 运行异常');
  assert.strictEqual(sectionOf(html, '普通最近会话'), '最近',
    '运行异常本身也是特殊分区，后续普通项目必须重新用「最近」标题分隔');
});

test('折叠群聊会聚合显示成员的 cwd / memory 告警', () => {
  const { sessions, meetings } = groupChat(['idle', 'idle', 'idle']);
  sessions.get('sid-claude').memoryLinkWarning = '错链：没有指向规范库';
  const html = render({ sessions, meetings });
  assert.ok(html.includes('⚠'), '群聊父行必须有可见告警图标');
  assert.ok(html.includes('记忆未接入规范库'), '父行或成员 tooltip 必须解释记忆告警');
  assert.ok(html.includes('AI-claude'), '聚合告警必须指出具体成员，不能只报群聊有问题');
});

test('成员被 Ctrl+C 打断（自己 idle）时，无时间戳的旧 gcWorking 不会继续亮灯', () => {
  const { sessions, meetings } = groupChat(['idle', 'idle', 'idle'], {
    subs: { gcWorking: true },
  });
  const html = render({ sessions, meetings });
  assert.ok(!/mini-st-thinking/.test(html), '会话自己说 idle 就以会话为准');
  assert.notStrictEqual(sectionOf(html, '英雄大厅轻量化实现'), '运行中');
});

test('成员 PTY 短暂 idle 时，新鲜 watcher 心跳仍点亮成员和群聊父项', () => {
  const { sessions, meetings } = groupChat(['idle', 'idle', 'idle']);
  const claude = sessions.get('sid-claude');
  claude.gcWorking = true;
  claude._gcWorkingLastTs = Date.now();
  const html = render({ sessions, meetings });
  assert.strictEqual((html.match(/mini-st-thinking/g) || []).length, 1,
    '只有正在发言的 Claude 应显示黄色脉冲');
  assert.strictEqual(sectionOf(html, '英雄大厅轻量化实现'), '运行中',
    '新鲜 watcher 必须让群聊父项归入运行中');
});

test('watcher 心跳过期后即使 gcWorking 残留，idle 成员也会自动熄灯', () => {
  const now = Date.now();
  const stale = {
    id: 'sid-claude', status: 'idle', gcWorking: true,
    _gcWorkingLastTs: now - GC_WORKING_FRESH_MS - 1,
  };
  assert.strictEqual(hasFreshGroupChatWork(stale, now), false);
  assert.strictEqual(isGroupChatMemberRunning(stale, now), false);
});

test('休眠或错误是硬终态，不会被延迟到达的新鲜心跳重新点亮', () => {
  const now = Date.now();
  for (const status of ['dormant', 'errored', 'error']) {
    assert.strictEqual(isGroupChatMemberRunning({
      status, gcWorking: true, _gcWorkingLastTs: now,
    }, now), false, `${status} 不应显示运行中`);
  }
});

test('成员状态未知（既非 idle 也非 running）时仍尊重 gcWorking', () => {
  const sessions = new Map();
  sessions.set('sid-codex', { id: 'sid-codex', title: 'AI-codex', kind: 'codex', gcWorking: true });
  const meetings = {
    m1: {
      id: 'm1', title: '群聊X', subSessions: ['sid-codex'], groupChat: true,
      status: 'idle', lastMessageTime: Date.now(), createdAt: Date.now(),
    },
  };
  const html = render({ sessions, meetings });
  assert.strictEqual(sectionOf(html, '群聊X'), '运行中',
    '会话自身没有明确状态时，群聊调度的 gcWorking 仍是有效信号');
});

test('renderer 同时监听真实目标名单、心跳和轮次完成三条状态事件', () => {
  assert.match(RENDERER_SRC, /ipcRenderer\.on\('groupchat-turn-targets'/,
    'prompt 发出后应立即点亮真实目标，不能等第一段文字');
  assert.match(RENDERER_SRC,
    /groupchat-turn-targets[\s\S]{0,1200}_setGroupChatMemberWorking\(sub, targetSids\.has\(sid\),/,
    '真实目标与未点名成员必须用同一个状态收敛函数');
  assert.match(RENDERER_SRC,
    /groupchat-partial-update[\s\S]{0,1000}_setGroupChatMemberWorking\(sub, nextWorking,/,
    'streaming 心跳必须续期 watcher 新鲜度');
  assert.match(RENDERER_SRC,
    /groupchat-turn-complete[\s\S]{0,1100}_setGroupChatMemberWorking\(s, false,/,
    '轮次完成必须立即熄灯');
});

// ---------- B. renderer.js 事件处理器契约 ----------

function bodyOf(name) {
  const start = RENDERER_SRC.indexOf(`function ${name}(payload) {`);
  assert.notStrictEqual(start, -1, `找不到 ${name}`);
  // 取到下一个顶层函数声明为止，够覆盖整个函数体。
  const rest = RENDERER_SRC.slice(start + 10);
  const end = rest.indexOf('\nfunction ');
  return rest.slice(0, end === -1 ? rest.length : end);
}

test('开工事件不再把群聊成员整条早退掉', () => {
  const body = bodyOf('onPromptSubmittedFromTranscriptEvent');
  assert.ok(!/^\s*if \(meetingId\) return;/m.test(body.split('const session =')[0]),
    'meetingId 早退不得挡在会话状态更新之前——否则群聊成员永远不会被标成运行中');
  assert.ok(/if \(meetingId\) \{[\s\S]{0,200}markCodexCardWorking\(/.test(body),
    '群聊分支必须调用 markCodexCardWorking，这是 codex/kimi 唯一的开工信号来源');
});

test('收工事件配对收尾，群聊成员不会一直卡在运行中', () => {
  const body = bodyOf('onReplyCompleteFromTranscriptEvent');
  assert.ok(/clearCodexCardWorking\(hubSessionId\)[\s\S]{0,900}if \(meetingId\) \{/.test(body),
    '群聊分支 return 前必须已统一清掉 cardWorking');
  assert.ok(/applyReplyCompleted\(session,[\s\S]{0,360}keepRunning: backgroundActive/.test(body),
    '必须通过有序 reducer 把 status 收回 idle，且后台 Agent 活跃时保持 running');
});

test('群聊自己的卡片/未读流水线仍然不被这两个处理器接管', () => {
  // 只认领「会话在不在干活」，其余照旧交给 meeting-room.js —— 群聊分支必须 return。
  for (const name of ['onPromptSubmittedFromTranscriptEvent', 'onReplyCompleteFromTranscriptEvent']) {
    const body = bodyOf(name);
    // 行尾必须容忍 CRLF：git core.autocrlf=true 下工作区是 CRLF 而 blob 是 LF，
    // 写死 \n 的多行正则会在工作区版本上失配。这里修断言本身，不强制改全仓 EOL；
    // 其余源码断言多用 \s*\n / [\s\S]*?\n，本就能吞掉 \r，不能据此算成 17 个同类炸弹。
    assert.ok(/if \(meetingId\) \{[\s\S]*?\r?\n    return;\r?\n  \}/.test(body),
      `${name} 的群聊分支必须 return，不能继续走未读/通知逻辑`);
    assert.ok(!/if \(meetingId\)[\s\S]{0,300}unreadCount/.test(body),
      `${name} 不该在群聊分支里动未读计数`);
  }
});

console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
