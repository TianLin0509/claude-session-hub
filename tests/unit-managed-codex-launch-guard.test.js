'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');

function managedSession({ kind = 'codex', ringBuffer = 'PS C:\\work> ' } = {}) {
  const writes = [];
  return {
    writes,
    session: {
      info: {
        id: 'managed',
        kind,
        cwd: 'C:\\work',
        currentModel: { id: 'gpt-5.6-sol' },
        effort: 'max',
        contextMax: 1_000_000,
        codexSpeedTier: 'fast',
        mcpProfile: 'none',
      },
      ringBuffer,
      pty: { write: data => writes.push(data), kill() {} },
      pendingTimers: new Set(),
      codexMcpEntries: [],
    },
  };
}

test('bare codex at a fallen-back host shell relaunches through the managed command builder', () => {
  const manager = new SessionManager();
  const fixture = managedSession();
  manager.sessions.set('managed', fixture.session);
  let relaunched = null;
  manager.relaunchCli = sessionId => {
    relaunched = sessionId;
    fixture.writes.push('<full-managed-command>');
    return true;
  };

  for (const ch of 'codex') manager.writeToSession('managed', ch);
  manager.writeToSession('managed', '\r');

  assert.strictEqual(relaunched, 'managed');
  assert.deepStrictEqual(fixture.writes, ['c', 'o', 'd', 'e', 'x', '\x15', '<full-managed-command>']);
  assert.strictEqual(manager.getLastWrite().target, 'managed-relaunch');
});

test('managed replacement preserves model, fast, 1M request and None MCP isolation', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-managed-codex-'));
  const manager = new SessionManager();
  try {
    fs.writeFileSync(path.join(configDir, 'config.toml'), [
      '[mcp_servers.superran]',
      'command = "python"',
      '[mcp_servers.playwright]',
      'command = "npx"',
    ].join('\n'), 'utf8');
    const fixture = managedSession();
    fixture.session.info.codexSessionsRoot = path.join(configDir, 'sessions');
    manager.sessions.set('managed', fixture.session);

    manager.writeToSession('managed', 'codex\r');

    const command = fixture.writes.join('');
    assert.match(command, /codex --dangerously-bypass-approvals-and-sandbox --model gpt-5\.6-sol/);
    assert.match(command, /model_reasoning_effort="max"/);
    assert.match(command, /features\.fast_mode=true/);
    assert.match(command, /service_tier="fast"/);
    assert.match(command, /model_context_window=1000000/);
    assert.match(command, /mcp_servers\.superran\.enabled=false/);
    assert.match(command, /mcp_servers\.playwright\.enabled=false/);
    const audit = manager.getManagedLaunchAudit('managed');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].trigger, 'bare-codex-guard');
    assert.equal(audit[0].contextRequested, 1_000_000);
    assert.equal(audit[0].mcpProfile, 'none');
    assert.equal(audit[0].mcpDisabled, true);
    assert.match(audit[0].commandSha256, /^[0-9a-f]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(audit[0], 'command'), false);
  } finally {
    manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('normal host-shell commands and Codex TUI input are not intercepted', () => {
  const manager = new SessionManager();
  const shell = managedSession();
  manager.sessions.set('managed', shell.session);
  manager.relaunchCli = () => { throw new Error('must not relaunch'); };
  manager.writeToSession('managed', 'Get-Date\r');
  assert.deepStrictEqual(shell.writes, ['Get-Date\r']);

  const tui = managedSession({ ringBuffer: '› Ask Codex to do anything\n' });
  manager.sessions.set('tui', tui.session);
  manager.writeToSession('tui', 'codex\r');
  assert.deepStrictEqual(tui.writes, ['codex\r']);
});

test('bracketed paste of bare codex is guarded when Enter arrives separately', () => {
  const manager = new SessionManager();
  const fixture = managedSession();
  manager.sessions.set('managed', fixture.session);
  let relaunched = false;
  manager.relaunchCli = () => { relaunched = true; return true; };

  manager.writeToSession('managed', '\x1b[200~codex\x1b[201~');
  manager.writeToSession('managed', '\r');

  assert.strictEqual(relaunched, true);
  assert.deepStrictEqual(fixture.writes, ['\x1b[200~codex\x1b[201~', '\x15']);
});
