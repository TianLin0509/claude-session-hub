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
  // BLOCKERS 条目可以是 RegExp，也可以是 { re, transient } —— transient 表示"瞬时进度行"，
  //   只有在就绪页脚没有在它之后重绘过时才生效（2026-07-29 B3 修复，见下方 booting 用例）。
  const blockerRe = (entry) => (entry && entry.re) ? entry.re : entry;
  assert.ok(
    ready.BLOCKERS.codex.some(e => blockerRe(e).test('Booting MCP server: playwright (0s - esc to interrupt)')),
    'Codex ready detector should still recognise the MCP booting banner'
  );
  assert.ok(
    ready.BLOCKERS.codex.filter(e => e && e.transient).length === 2,
    'Booting MCP server / esc to interrupt 必须标为 transient（它们是会永久留在 ring buffer 里的进度行）'
  );
  assert.ok(
    ready.BLOCKERS.codex.some(e => !(e && e.transient) && blockerRe(e).test('Do you trust the contents of this directory?')),
    'trust 模态框必须保持非 transient（静止模态框不会被后续重绘冲掉，老语义照旧）'
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

  // === MCP booting（2026-07-29 道雪 B3 语义修正）===
  // 旧契约：ring buffer 末 2000 字符里只要出现过 'Booting MCP server' 就永远不 ready。
  // 实测（artifacts/codex-ready-verdict.json）：Codex 起完 MCP 后**只重绘输入框+页脚**，
  //   那行 `• Booting MCP server: ai-team (0s • esc to interrupt)` 留在 buffer 里不再被冲走，
  //   PTY 随后彻底静默（bufLen 4961 连续 230s 不变）→ 旧契约让 Codex 永久 not-ready，
  //   群聊发送阶段等满 60s 后把 Codex 静默跳过（B3 现场）。
  // 新契约：
  //   ① 真在 booting（每秒刷计时器 → buffer 一直变）→ 静默期门拦住，仍 not ready；
  //   ② 已经 boot 完（buffer 静止 + 页脚在 boot 行之后重绘过）→ ready；
  //   ③ boot/busy 行是**最后**出现的（页脚之后没再重绘）→ 仍 not ready。
  const bootTickSid = 'codex-booting-mcp-ticking';
  ready.cleanup(bootTickSid);
  let bootTick = [
    'Booting MCP server: playwright (0s - esc to interrupt)',
    '  gpt-5.6-sol high fast · Context 100% left · ~',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(ready.isReady(bootTickSid, 'codex', bootTick), false,
    'Codex TUI should not be ready on the first MCP booting frame');
  for (let i = 1; i <= 4; i += 1) {
    await sleep(600);
    // 真在 booting 时计时器每秒重绘整屏 → buffer 持续变长
    bootTick += `\nBooting MCP server: playwright (${i}s - esc to interrupt)\n  gpt-5.6-sol high fast · Context 100% left · ~`;
    assert.strictEqual(ready.isReady(bootTickSid, 'codex', bootTick), false,
      'MCP 真在 booting（计时器仍在刷新）时必须继续判 not ready');
  }

  const bootDoneSid = 'codex-booting-mcp-finished';
  ready.cleanup(bootDoneSid);
  const bootDone = [
    'Booting MCP server: playwright (1s - esc to interrupt)',
    '> Implement {feature}',
    '  gpt-5.6-sol high fast · Context 100% left · ~',
    'x'.repeat(900),
  ].join('\n');
  assert.strictEqual(ready.isReady(bootDoneSid, 'codex', bootDone), false,
    'first hit still waits for the stability window');
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(ready.isReady(bootDoneSid, 'codex', bootDone), true,
    'MCP 已经起完（PTY 静止 + 页脚在 boot 行之后重绘过）时必须判 ready —— 历史残留不得永久拦路');

  const bootLastSid = 'codex-blocker-is-newest';
  ready.cleanup(bootLastSid);
  const bootLast = [
    '  gpt-5.6-sol high fast · Context 100% left · ~',
    'x'.repeat(900),
    'Booting MCP server: playwright (1s - esc to interrupt)',
  ].join('\n');
  assert.strictEqual(ready.isReady(bootLastSid, 'codex', bootLast), false,
    'blocker 出现在页脚之后（还没重绘回输入框）时必须继续 not ready');
  await sleep(ready.STABLE_MS + 50);
  assert.strictEqual(ready.isReady(bootLastSid, 'codex', bootLast), false,
    'stable-but-blocked buffer 仍然 not ready');

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
