'use strict';

const assert = require('assert');
const ready = require('../core/group-chat-cli-ready-detector.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  assert.deepStrictEqual(
    ready.MARKERS.codex,
    ['Context '],
    'Codex ready markers must not include model ids or generic send text'
  );
  assert.ok(
    ready.BLOCKERS.codex.some(re => re.test('Booting MCP server: playwright (0s - esc to interrupt)')),
    'Codex ready detector should block while MCP servers are still booting'
  );

  const commandSid = 'codex-command-echo';
  ready.cleanup(commandSid);
  const commandEcho = [
    'PS C:\\Users\\lintian> codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol',
    'launching...',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(
    ready.isReady(commandSid, 'codex', commandEcho),
    false,
    'Codex launch command echo containing gpt-5.6-sol should not mark the CLI ready'
  );
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(
    ready.isReady(commandSid, 'codex', commandEcho),
    false,
    'stable command echo should still not mark Codex ready'
  );

  const tuiSid = 'codex-real-tui';
  ready.cleanup(tuiSid);
  const tui = [
    '\x1b[2J\x1b[H',
    'Send a message...',
    '  gpt-5.6-sol medium · Context 91% left · ~',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(
    ready.isReady(tuiSid, 'codex', tui),
    false,
    'first Codex TUI marker hit still waits for the stability window'
  );
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(
    ready.isReady(tuiSid, 'codex', tui),
    true,
    'stable Codex TUI context footer should mark the CLI ready'
  );

  const bootSid = 'codex-booting-mcp';
  ready.cleanup(bootSid);
  const booting = [
    'Booting MCP server: playwright (1s - esc to interrupt)',
    '  gpt-5.6-sol high fast · Context 100% left · ~',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(
    ready.isReady(bootSid, 'codex', booting),
    false,
    'Codex TUI should not be ready while MCP booting blocks input submission'
  );
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(
    ready.isReady(bootSid, 'codex', booting),
    false,
    'stable Codex MCP booting footer should still not mark the CLI ready'
  );

  const kimiLoginSid = 'kimi-login-required';
  ready.cleanup(kimiLoginSid);
  const kimiLogin = [
    'Welcome to Kimi Code!',
    'Run /login or /provider to get started.',
    'Model:     not set, run /login or /provider',
    'context: 0%',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(ready.isReady(kimiLoginSid, 'kimi', kimiLogin), false,
    'Kimi login screen must not accept room prompts');
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(ready.isReady(kimiLoginSid, 'kimi', kimiLogin), false,
    'stable Kimi login screen must remain blocked');

  const kimiReadySid = 'kimi-k3-ready';
  ready.cleanup(kimiReadySid);
  const kimiReady = ['Kimi K3', 'context: 0%', 'x'.repeat(900)].join('\n');
  assert.strictEqual(ready.isReady(kimiReadySid, 'kimi', kimiReady), false,
    'first Kimi statusline hit still waits for stability');
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(ready.isReady(kimiReadySid, 'kimi', kimiReady), true,
    'stable authenticated Kimi K3 statusline should mark CLI ready');

  console.log('Group-chat CLI ready detector: ok');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
