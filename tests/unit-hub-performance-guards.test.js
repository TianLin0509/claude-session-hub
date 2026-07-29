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

test('group Claude sessions isolate inherited MCP servers', () => {
  assert.strictEqual(_private.buildGroupChatIsolationFlags(null), '');
  const flags = _private.buildGroupChatIsolationFlags('meeting-1');
  assert.match(flags, /--strict-mcp-config/);
  assert.match(flags, /--settings/);
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
    assert.strictEqual(_private.buildCodexGroupMcpIsolationArgs(dir, null), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('renderer keeps xterms lazy, bounded and snapshot-hydrated', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const meeting = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const created = renderer.slice(renderer.indexOf("ipcRenderer.on('session-created'"), renderer.indexOf("ipcRenderer.on('session-meta-updated'"));
  assert.doesNotMatch(created, /getOrCreateTerminal\(session\.id\)/);
  assert.match(renderer, /MAX_TERMINAL_CACHE_SIZE\s*=\s*4/);
  assert.match(renderer, /hydrateTerminalFromSnapshot/);
  assert.match(renderer, /get-session-buffer-snapshot/);
  assert.match(renderer, /usesLazySerialWake/);
  assert.match(meeting, /await _ensureWorkflowMembersReady\(m, targetMemberIds\)/);
  assert.match(main, /meeting-terminal-activity/);
  assert.match(main, />= 500/);
});

test('restored terminals force a full renderer-surface repaint', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const helperStart = renderer.indexOf('function refreshTerminalRendererSurface');
  const helperEnd = renderer.indexOf('// --- DOM refs ---', helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  const showStart = renderer.indexOf('function showTerminal');
  const showEnd = renderer.indexOf('// \u521d\u5fc3\u6295\u7814', showStart);
  const show = renderer.slice(showStart, showEnd);
  assert.match(helper, /cached\.terminal\.refresh\(0, lastRow\)/);
  assert.match(show, /fitAndResizeTerminal\(sessionId, cached, \{ force: true \}\);\s*refreshTerminalRendererSurface\(cached\);/);
});

test('streaming card refresh requests only the newest turn', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const matches = src.match(/parseOpts:\s*\{\s*limit:\s*1,\s*fromTail:\s*true\s*\}/g) || [];
  assert.ok(matches.length >= 2, 'streaming and silence-fallback reloads must avoid full 50-turn parses');
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
