'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { SessionManager, _private } = require('../core/session-manager.js');
const { shouldForwardTerminalOutput } = require('../main/terminal-output-policy.js');

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
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'solo'), true);
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'member'), false);
  manager.focusedSessionId = 'member';
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'member'), true);
  assert.strictEqual(shouldForwardTerminalOutput(manager, 'missing'), true);
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
