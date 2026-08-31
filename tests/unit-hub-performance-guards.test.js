'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { SessionManager, _private } = require('../core/session-manager.js');
const {
  shouldForwardTerminalOutput,
  getTerminalBatchDelay,
  isBackgroundMember,
  LIVE_BATCH_MS,
  BACKGROUND_BATCH_MS,
} = require('../main/terminal-output-policy.js');

test('group Claude plugin isolation no longer overrides the member MCP profile', () => {
  assert.strictEqual(_private.buildGroupChatIsolationFlags(null), '');
  const flags = _private.buildGroupChatIsolationFlags('meeting-1');
  assert.match(flags, /--settings/);
  assert.doesNotMatch(flags, /--strict-mcp-config/);
});

test('group Claude MCP profiles keep mandatory room config while filtering optional globals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-group-mcp-'));
  const homeDir = path.join(root, 'home');
  const hubDataDir = path.join(root, 'hub');
  const roomConfig = path.join(root, 'room-mcp.json');
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx' },
        misc: { command: 'node' },
      },
    }), 'utf8');
    fs.writeFileSync(roomConfig, JSON.stringify({
      mcpServers: { arena_research: { command: 'node' } },
    }), 'utf8');

    const lean = _private.buildClaudeMeetingMcpArgs({
      mcpConfigFile: roomConfig, mcpProfile: 'lean', homeDir, hubDataDir, cwd: root,
    });
    assert.match(lean.args, /--strict-mcp-config/);
    assert.ok(lean.configPaths.includes(roomConfig), 'mandatory room MCP config must survive Lean');
    assert.equal(lean.configPaths.length, 2, 'Lean also supplies its filtered global config');

    const browser = _private.buildClaudeMeetingMcpArgs({
      mcpConfigFile: roomConfig, mcpProfile: 'browser', homeDir, hubDataDir, cwd: root,
    });
    assert.match(browser.args, /--strict-mcp-config/);
    assert.deepStrictEqual(browser.keptServers, ['playwright']);
    assert.ok(browser.configPaths.includes(roomConfig), 'mandatory room MCP config must survive Browser');

    const full = _private.buildClaudeMeetingMcpArgs({
      mcpConfigFile: roomConfig, mcpProfile: 'full', homeDir, hubDataDir, cwd: root,
    });
    assert.match(full.args, /--mcp-config/);
    assert.doesNotMatch(full.args, /--strict-mcp-config/);
    assert.deepStrictEqual(full.configPaths, [roomConfig]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('group Codex sessions disable unmanaged MCP servers and preserve explicit room MCP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-mcp-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      '[mcp_servers.playwright]',
      'command = "npx"',
      '[mcp_servers.playwright.env]',
      'FOO = "bar"',
      '[mcp_servers.ai-team]',
      'command = "node"',
      '[mcp_servers.arena_research]',
      'command = "node"',
    ].join('\n'), 'utf8');
    assert.deepStrictEqual(
      _private.listCodexMcpServerNames(dir),
      ['playwright', 'ai-team', 'arena_research'],
    );
    const args = _private.buildCodexGroupMcpIsolationArgs(dir, 'meeting-1');
    assert.match(args, /mcp_servers\.playwright\.enabled=false/);
    assert.doesNotMatch(args, /ai-team\.enabled=false/);
    assert.doesNotMatch(args, /arena_research\.enabled=false/);
    const browser = _private.buildCodexMcpIsolationArgs(dir, {
      meetingId: 'meeting-1', mcpProfile: 'browser', allowedNames: ['ai-team', 'arena_research'],
    });
    assert.doesNotMatch(browser, /playwright\.enabled=false/, 'Browser profile must survive group isolation');
    assert.strictEqual(_private.buildCodexMcpIsolationArgs(dir, {
      meetingId: 'meeting-1', mcpProfile: 'full', allowedNames: ['ai-team', 'arena_research'],
    }), '');
    assert.strictEqual(_private.buildCodexGroupMcpIsolationArgs(dir, null), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary Codex defaults to None while explicit Lean keeps workspace/profile opt-ins', () => {
  assert.strictEqual(_private.resolveCodexMcpProfile('codex'), 'none');
  assert.strictEqual(_private.resolveCodexMcpProfile('codex-resume'), 'none');
  assert.strictEqual(_private.normalizeCodexMcpProfile(), 'lean');
  assert.strictEqual(_private.normalizeCodexMcpProfile('unknown'), 'lean');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-lean-'));
  const wirelessRoot = path.join(dir, 'Wireless');
  const oldWirelessRoot = process.env.AI_HUB_WIRELESS_ROOT;
  try {
    fs.mkdirSync(wirelessRoot, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      '[mcp_servers.playwright]',
      'command = "npx"',
      '[mcp_servers.superwireless]',
      'command = "python"',
      '[mcp_servers.misc]',
      'command = "node"',
    ].join('\n'), 'utf8');
    process.env.AI_HUB_WIRELESS_ROOT = wirelessRoot;

    const lean = _private.buildCodexMcpIsolationArgs(dir, {
      cwd: path.join(dir, 'ordinary'), mcpProfile: 'lean',
    });
    assert.match(lean, /playwright\.enabled=false/);
    assert.match(lean, /superwireless\.enabled=false/);
    assert.match(lean, /misc\.enabled=false/);

    const none = _private.buildCodexMcpIsolationArgs(dir, {
      cwd: path.join(wirelessRoot, 'experiment'), mcpProfile: 'none',
      allowedNames: ['playwright', 'superwireless'],
    });
    assert.match(none, /playwright\.enabled=false/);
    assert.match(none, /superwireless\.enabled=false/);
    assert.match(none, /misc\.enabled=false/);

    const wireless = _private.buildCodexMcpIsolationArgs(dir, {
      cwd: path.join(wirelessRoot, 'experiment'), mcpProfile: 'lean',
    });
    assert.doesNotMatch(wireless, /superwireless\.enabled=false/);
    assert.match(wireless, /playwright\.enabled=false/);

    const browser = _private.buildCodexMcpIsolationArgs(dir, {
      cwd: path.join(dir, 'ordinary'), mcpProfile: 'browser',
    });
    assert.doesNotMatch(browser, /playwright\.enabled=false/);
    assert.match(browser, /superwireless\.enabled=false/);
    assert.strictEqual(_private.buildCodexMcpIsolationArgs(dir, { mcpProfile: 'full' }), '');
  } finally {
    if (oldWirelessRoot === undefined) delete process.env.AI_HUB_WIRELESS_ROOT;
    else process.env.AI_HUB_WIRELESS_ROOT = oldWirelessRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex room MCP is command-scoped and legacy Chuxin blocks are removable', () => {
  const legacy = [
    '[mcp_servers.chuxin_knowledge]',
    'command = "node"',
    'args = ["chuxin.js"]',
    '[mcp_servers.arena_research]',
    'command = "electron"',
    '[mcp_servers.arena_research.env]',
    'ARENA_MEETING_ID = "old-room"',
    '[projects.test]',
    'trust_level = "trusted"',
  ].join('\n');
  const cleaned = _private.stripCodexMcpEntries(
    legacy, ['chuxin_knowledge', 'arena_research'],
  );
  assert.doesNotMatch(cleaned, /chuxin_knowledge|arena_research|old-room/);
  assert.match(cleaned, /\[projects\.test\]/);

  const args = _private.buildCodexEphemeralMcpArgs([{
    name: 'arena_research',
    command: 'C:\\Hub\\electron.exe',
    args: ['C:\\Hub\\core\\research-mcp-server.js'],
    env: { ARENA_MEETING_ID: 'room-1', ARENA_CHUXIN_ENABLED: '1' },
  }]);
  assert.match(args, /mcp_servers\.arena_research\.command=/);
  assert.match(args, /mcp_servers\.arena_research\.args=/);
  assert.match(args, /ARENA_MEETING_ID=.*room-1/);
  assert.match(args, /ARENA_CHUXIN_ENABLED=.*1/);
});

test('terminal output policy drops background meeting redraws only', () => {
  const sessions = new Map([
    ['solo', { id: 'solo', meetingId: null }],
    ['member', { id: 'member', meetingId: 'meeting-1' }],
  ]);
  const manager = { focusedSessionId: null, getSession: id => sessions.get(id) || null };
  // 2026-07-29：未聚焦成员从「完全不转发」改成「降频转发」。
  // 旧断言把 member → false 锁成了正确行为，而那正是「PTY 滚不上去 / 渲染卡住」的根因：
  // 未聚焦期间 xterm 一个字节都收不到，scrollback 无从累积。现在任何会话都转发，
  // 差别只在合并延迟。
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'solo'), true);
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'member'), true,
    '未聚焦成员的输出也必须转发，只是降频');

  assert.strictEqual(getTerminalBatchDelay(manager, 'solo'), LIVE_BATCH_MS, '独立会话永远实时');
  assert.strictEqual(getTerminalBatchDelay(manager, 'member'), BACKGROUND_BATCH_MS, '未聚焦成员降频');
  assert.strictEqual(isBackgroundMember(manager, 'member'), true);

  manager.focusedSessionId = 'member';
  assert.strictEqual(getTerminalBatchDelay(manager, 'member'), LIVE_BATCH_MS, '聚焦后恢复实时');
  assert.strictEqual(isBackgroundMember(manager, 'member'), false);
  assert.strictEqual(getTerminalBatchDelay(manager, 'missing'), LIVE_BATCH_MS, '未知会话按实时处理');
  assert.ok(BACKGROUND_BATCH_MS > LIVE_BATCH_MS && BACKGROUND_BATCH_MS <= 500,
    '后台合并窗口要明显大于实时，但不能大到让用户切过去时感觉延迟');
});

test('session ring-buffer snapshot carries the output sequence used for dedup', () => {
  const manager = new SessionManager();
  manager.sessions.set('s1', { ringBuffer: 'tail' });
  manager._outputSeq = 17;
  assert.deepStrictEqual(manager.getSessionBufferSnapshot('s1'), { text: 'tail', seq: 17 });
  assert.strictEqual(manager.getSessionBufferSnapshot('missing'), null);
});

test('recoverable session suspend kills the PTY but preserves the dormant identity', () => {
  const manager = new SessionManager();
  let killed = 0;
  const fakePty = { kill: () => { killed += 1; } };
  let suspendedEvent = null;
  manager.onSessionSuspended = (...args) => { suspendedEvent = args; };
  manager.sessions.set('codex-1', {
    info: { id: 'codex-1', kind: 'codex', codexSid: 'native-1', status: 'idle' },
    pty: fakePty,
    pendingTimers: [],
    startedAt: 1,
    lastInputAt: 0,
    lastOutputAt: 0,
    suspendRequestedAt: 0,
  });
  const result = manager.suspendSession('codex-1', { now: 1000 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(killed, 1);
  assert.strictEqual(manager.sessions.get('codex-1').suspendRequestedAt, 1000);
  assert.strictEqual(manager._handlePtyExit('codex-1', fakePty, { exitCode: 0 }), true);
  assert.strictEqual(manager.sessions.has('codex-1'), false);
  assert.strictEqual(suspendedEvent[0], 'codex-1');
  assert.strictEqual(suspendedEvent[2].status, 'dormant');
  assert.strictEqual(suspendedEvent[2].codexSid, 'native-1');
  assert.strictEqual(suspendedEvent[2].suspendReason, 'manual');

  manager.sessions.set('unbound', {
    info: { id: 'unbound', kind: 'claude', status: 'idle' },
    pty: { kill: () => { throw new Error('must not kill'); } },
    pendingTimers: [],
    startedAt: 1,
  });
  assert.strictEqual(manager.suspendSession('unbound').error, 'native-session-id-missing');
});

test('user close means recoverable suspend even while the session is running', () => {
  const manager = new SessionManager();
  let killed = 0;
  manager.sessions.set('busy-codex', {
    info: { id: 'busy-codex', kind: 'codex', codexSid: 'native-busy', status: 'running' },
    pty: { kill: () => { killed += 1; } },
    pendingTimers: [],
    startedAt: 1,
    lastInputAt: 2,
    lastOutputAt: 3,
    suspendRequestedAt: 0,
    suspendReason: null,
  });

  const result = manager.closeSessionRecoverably('busy-codex');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, 'suspended');
  assert.strictEqual(result.recoverable, true);
  assert.strictEqual(killed, 1);
  assert.strictEqual(manager.sessions.get('busy-codex').suspendReason, 'user-close');

  let closedShell = null;
  manager.onSessionClosed = sessionId => { closedShell = sessionId; };
  manager.sessions.set('plain-shell', {
    info: { id: 'plain-shell', kind: 'powershell', status: 'idle' },
    pty: null,
    pendingTimers: [],
    suspendRequestedAt: 0,
  });
  const shellResult = manager.closeSessionRecoverably('plain-shell');
  assert.deepStrictEqual(shellResult, {
    ok: true, sessionId: 'plain-shell', action: 'closed', recoverable: false,
  });
  assert.strictEqual(closedShell, 'plain-shell');
});

test('bulk suspend only requests old standalone unpinned background sessions', () => {
  const manager = new SessionManager();
  const now = 10 * 60 * 60 * 1000;
  const killed = [];
  const add = (id, info, startedAt) => manager.sessions.set(id, {
    info: { id, kind: 'codex', codexSid: `native-${id}`, status: 'idle', ...info },
    pty: { kill: () => killed.push(id) },
    pendingTimers: [],
    startedAt,
    lastInputAt: 0,
    lastOutputAt: 0,
    suspendRequestedAt: 0,
  });
  add('old', {}, now - _private.DEFAULT_IDLE_SUSPEND_MS - 1);
  add('recent', {}, now - 60 * 1000);
  add('pinned', { pinned: true }, now - _private.DEFAULT_IDLE_SUSPEND_MS - 1);
  add('meeting', { meetingId: 'm1' }, now - _private.DEFAULT_IDLE_SUSPEND_MS - 1);
  add('focused', {}, now - _private.DEFAULT_IDLE_SUSPEND_MS - 1);
  manager.focusedSessionId = 'focused';

  const result = manager.suspendIdleSessions({ now });
  assert.deepStrictEqual(result.requested, ['old']);
  assert.deepStrictEqual(killed, ['old']);
  assert.strictEqual(result.skipped['recently-active'], 1);
  assert.strictEqual(result.skipped.pinned, 1);
  assert.strictEqual(result.skipped['meeting-member'], 1);
  assert.strictEqual(result.skipped.focused, 1);
});

test('automatic suspend can hibernate idle meeting members while protecting active work', () => {
  const manager = new SessionManager();
  const now = 8 * 60 * 60 * 1000;
  const killed = [];
  const add = id => manager.sessions.set(id, {
    info: { id, kind: 'codex', codexSid: `native-${id}`, status: 'idle', meetingId: 'm1' },
    pty: { kill: () => killed.push(id) },
    pendingTimers: [],
    startedAt: now - _private.DEFAULT_IDLE_SUSPEND_MS - 1,
    lastInputAt: 0,
    lastOutputAt: 0,
    suspendRequestedAt: 0,
    suspendReason: null,
  });
  add('idle-member');
  add('active-member');

  const result = manager.suspendIdleSessions({
    now,
    excludeMeeting: false,
    excludeSessionIds: new Set(['active-member']),
    reason: 'idle-timeout',
  });

  assert.deepStrictEqual(result.requested, ['idle-member']);
  assert.deepStrictEqual(killed, ['idle-member']);
  assert.strictEqual(result.skipped['active-task'], 1);
  assert.strictEqual(manager.sessions.get('idle-member').suspendReason, 'idle-timeout');
});

test('renderer keeps xterms lazy, session-lifecycle retained and snapshot-hydrated', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const meeting = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  const workflowEngine = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'loop-engine.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const created = renderer.slice(renderer.indexOf("ipcRenderer.on('session-created'"), renderer.indexOf("ipcRenderer.on('session-meta-updated'"));
  assert.doesNotMatch(created, /getOrCreateTerminal\(session\.id\)/);
  assert.match(renderer, /TERMINAL_CACHE_POLICY\s*=\s*'session-lifecycle'/);
  assert.doesNotMatch(renderer, /MAX_TERMINAL_CACHE_SIZE|evictTerminalCacheFor/);
  assert.match(renderer, /ipcRenderer\.on\('session-suspended',[\s\S]{0,5000}disposeCachedTerminal\(sessionId\)/,
    'automatic/manual suspend must release the xterm at the session lifecycle boundary');
  assert.match(renderer, /hydrateTerminalFromSnapshot/);
  assert.match(renderer, /get-session-buffer-snapshot/);
  assert.match(renderer, /function unloadGpuRenderer\(cached\)/);
  assert.match(renderer, /suspendInactiveTerminalRenderers\(sessionId\)/,
    'session switching should release only hidden renderer surfaces');
  const unloadStart = renderer.indexOf('function unloadGpuRenderer');
  const unloadEnd = renderer.indexOf('function suspendInactiveTerminalRenderers', unloadStart);
  assert.doesNotMatch(renderer.slice(unloadStart, unloadEnd), /terminal\.dispose\(/,
    'surface suspension must never dispose the live xterm/buffer');
  assert.match(renderer, /usesLazySerialWake/);
  assert.match(meeting, /ipcRenderer\.invoke\('serial:start'/,
    'renderer must delegate serial work instead of holding eager PTY wake loops');
  assert.match(workflowEngine, /await ensureMemberReady\(meeting, memberId\)/);
  assert.match(workflowEngine, /resumeSession\(\{ \.\.\.session, hubId:/,
    'main workflow engine must lazily resume each provider with full Session metadata');
  assert.match(main, /meeting-terminal-activity/);
  assert.match(main, />= 500/);
});

test('sidebar status transitions are coalesced and committed atomically', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
  const home = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'home-workbench.js'), 'utf8');
  assert.match(sidebar, /createDocumentFragment/);
  assert.match(sidebar, /sessionListEl\.replaceChildren\(fragment\)/,
    'a category jump should produce one live DOM commit');
  const completeStart = renderer.indexOf('function onReplyCompleteFromTranscriptEvent');
  const completeEnd = renderer.indexOf('\nfunction onPromptSubmittedFromTranscriptEvent', completeStart);
  const promptEnd = renderer.indexOf('\n// Hook-server health indicator', completeEnd);
  assert.match(renderer.slice(completeStart, completeEnd), /scheduleSessionListRender\(\)/);
  assert.match(renderer.slice(completeEnd, promptEnd), /scheduleSessionListRender\(\)/);
  assert.match(renderer, /createTerminalActivityMonitor\(\{[\s\S]*?renderSessionList:\s*scheduleSessionListRender,/,
    'PTY-driven status transitions must use the sidebar coalescer too');
  assert.match(home, /if \(!options\.force && !isVisible\(\)\) return state\.snapshot/,
    'hidden home workbench must not rebuild alongside every sidebar state event');
});

test('restored terminals force a full renderer-surface repaint', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const helperStart = renderer.indexOf('function refreshTerminalRendererSurface');
  const helperEnd = renderer.indexOf('// --- DOM refs ---', helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  const showStart = renderer.indexOf('function showTerminal');
  const showEnd = renderer.indexOf('// \u521d\u5fc3\u6295\u7814', showStart);
  const show = renderer.slice(showStart, showEnd);
  const viewStart = renderer.indexOf('function applyViewMode');
  const viewEnd = renderer.indexOf("document.addEventListener('click'", viewStart);
  const view = renderer.slice(viewStart, viewEnd);
  assert.match(helper, /cached\.terminal\.refresh\(0, lastRow\)/);
  assert.match(helper, /function scheduleVisibleTerminalRecovery/);
  assert.match(helper, /requestAnimationFrame\(\(\) => recover\(true\)\)/,
    'surface recovery needs a second visible frame for delayed layout/compositor attach');
  assert.match(show, /fitAndResizeTerminal\(sessionId, cached, \{ force: true, forcePtyResize \}\);[\s\S]{0,120}refreshTerminalRendererSurface\(cached\);/);
  assert.match(renderer, /cached\._hydrating\s*&&\s*!forcePtyResize/,
    'snapshot replay must not race a live TUI resize/redraw');
  assert.match(renderer, /forcePtyResize:\s*true/,
    'hydration completion must request one authoritative live TUI redraw');
  assert.match(show, /scheduleVisibleTerminalRecovery\(sessionId, cached/,
    'reattaching a cached/resumed terminal must repaint even when geometry is unchanged');
  assert.match(view, /mode === 'pty'[\s\S]{0,320}scheduleVisibleTerminalRecovery\(activeSessionId, cached/,
    'card -> PTY must repaint a compositor-discarded Canvas surface');
});

test('streaming card refresh requests only the newest turn', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function requestCardIncrementalRefresh');
  const end = src.indexOf('function noteCardTerminalOutput', start);
  const block = src.slice(start, end);
  assert.match(block, /parseOpts:\s*\{\s*limit:\s*1,\s*fromTail:\s*true\s*\}/,
    'the shared streaming/settle refresh path must avoid full 50-turn parses');
  assert.match(src, /CARD_STREAM_SETTLE_RETRY_MS\s*=\s*\[1000,\s*2500,\s*6000\]/,
    'late writeback recovery must stay finite rather than polling forever');
  assert.match(block, /requestCardIncrementalRefresh\(sessionId/,
    'settle retries must reuse the same bounded refresh path');
});

test('meeting room CLI-ready polling cannot overlap slow IPC probes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  assert.match(src, /let _cliReadyPollInFlight = null;/);
  assert.match(src, /if \(_cliReadyPollInFlight\) return _cliReadyPollInFlight;/);
  assert.match(src, /_cliReadyPollInFlight = null;/);
});

test('Codex terminal chunk rendering coalesces bottom pinning per frame', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const scheduleStart = src.indexOf('function scheduleCodexBottomPin');
  const scheduleEnd = src.indexOf('function updateCodexFollowBottomFromUserScroll', scheduleStart);
  const schedule = src.slice(scheduleStart, scheduleEnd);
  const writeStart = src.indexOf('function writeTerminalChunk');
  const writeEnd = src.indexOf('async function hydrateTerminalFromSnapshot', writeStart);
  const write = src.slice(writeStart, writeEnd);
  assert.match(schedule, /if \(cached\._codexBottomPinRaf\) return;/);
  assert.match(schedule, /cached\._codexBottomPinRaf = requestAnimationFrame/);
  assert.match(src, /cancelAnimationFrame\(cached\._codexBottomPinRaf\)/);
  assert.match(write, /cached\.terminal\.write\(filtered \+ '\\x1b\[\?25l'\)/);
  assert.doesNotMatch(write, /cached\.terminal\.write\('\\x1b\[\?25l'\)/);
});

test('card path linking parses each text node only once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function wrapPathLinksInElement');
  const end = src.indexOf('window.wrapPathLinksInElement', start);
  const body = src.slice(start, end);
  const calls = body.match(/collectPathCandidates\(/g) || [];
  assert.strictEqual(calls.length, 1);
  assert.match(body, /targets\.push\(\{ textNode: node, text, candidates \}\)/);
});
