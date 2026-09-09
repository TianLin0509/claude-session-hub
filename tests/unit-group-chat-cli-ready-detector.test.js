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

  // 2026-09-08：MCP 启动中确实不能发 —— 但判据从「buffer 里出现过启动文本」
  // 换成了「启动文本是不是最新的信号」。原因是 PTY 是追加流、清屏只是控制序列，
  // 那句 `Booting MCP server` 会永远留在 buffer 里；合并位在真实链路上撞到
  // Codex 已经显示输入框、Hub 却永久判未就绪，开题连着两次 cli_not_ready。
  //
  // 真正在启动时这条判据照样拦得住：Codex 的启动行带秒数计时（1s / 2s / …），
  // buffer 每秒都在变，静默门本来就过不去。下面按真实形状写。
  const bootSid = 'codex-booting-mcp';
  ready.cleanup(bootSid);
  const bootingFrame = (sec) => [
    `Booting MCP server: playwright (${sec}s - esc to interrupt)`,
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(
    ready.isReady(bootSid, 'codex', bootingFrame(1)),
    false,
    'Codex TUI should not be ready while MCP booting blocks input submission'
  );
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(
    ready.isReady(bootSid, 'codex', bootingFrame(2)),
    false,
    '启动行还在滚秒数 → buffer 一直在变，静默门过不去，仍然未就绪'
  );

  // 启动早就结束、那句话只是留在滚动历史里：输入框标记更新，就该放行。
  const bootedSid = 'codex-booted-scrollback';
  ready.cleanup(bootedSid);
  const booted = [
    'Booting MCP server: playwright (1s - esc to interrupt)',
    'x'.repeat(900),
    '  gpt-5.6-sol high fast · Context 100% left · ~/repo',
  ].join('\n');
  assert.strictEqual(ready.isReady(bootedSid, 'codex', booted), false, '首次调用先记录静默基线');
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(
    ready.isReady(bootedSid, 'codex', booted),
    true,
    '启动文本已经被输入框盖掉、屏幕也稳定了 → 必须判就绪，否则永远发不出去'
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
