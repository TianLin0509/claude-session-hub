'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCodexRuntime, latestTerminalFrame } = require('../core/night-guard-runtime.js');

test('runtime inspector distinguishes Codex prompt, host shell and missing PTY', async () => {
  const manager = {
    getSessionBuffer(id) {
      if (id === 'missing') return null;
      if (id === 'shell') return 'PS C:\\work> ';
      if (id === 'idle') return 'Working... esc to interrupt\n\x1b[2J\x1b[H›\nContext 91% left\n';
      if (id === 'claude-idle') return 'Working... esc to interrupt\n\x1b[2J\x1b[H❯\n? for shortcuts\n';
      return 'Working... esc to interrupt\n';
    },
  };
  assert.equal((await inspectCodexRuntime(manager, 'idle')).state, 'idle');
  assert.equal((await inspectCodexRuntime(manager, 'running')).state, 'running');
  assert.equal((await inspectCodexRuntime(manager, 'shell')).state, 'host-shell');
  assert.equal((await inspectCodexRuntime(manager, 'missing')).state, 'missing');
  assert.match(latestTerminalFrame('old\x1b[2Jnew'), /new$/);
});

test('provider-aware runtime inspector recognizes a Claude Code input box', async () => {
  const { inspectNightGuardRuntime } = require('../core/night-guard-runtime.js');
  const manager = { getSessionBuffer: () => 'Working... esc to interrupt\n\x1b[2J\x1b[H❯\n? for shortcuts\n' };
  const result = await inspectNightGuardRuntime(manager, 'claude', 'claude');
  assert.equal(result.state, 'idle');
  assert.equal(result.reason, 'claude-input-ready');
});
