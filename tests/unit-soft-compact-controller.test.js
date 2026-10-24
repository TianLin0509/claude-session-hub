'use strict';
// 软压缩：Stop 时看到回复末尾的标记才发 /compact；/compact 经 PreCompact 确认；
// 压缩结束（SessionStart source=compact）后，带 -continue 的才发「继续」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSoftCompactController, findMarker, readClaudeContextTokens, CONTINUE_PROMPT } = require('../main/soft-compact-controller');

function setup({ session = {}, busy = false, finalText = null, sendResult = null, tokens = 700_000 } = {}) {
  const manager = new EventEmitter();
  manager.getSession = id => ({ id, kind: 'claude', agentRuntime: 'pty', ...session });
  const writes = [], notices = [];
  const controller = createSoftCompactController({
    sessionManager: manager,
    sendToPty: async (sessionId, text, kind, options) => {
      writes.push({ sessionId, text, options });
      if (sendResult) return sendResult;
      if (text === '/compact') {
        manager.emit('claude-local-command-ack', { sessionId, command: 'compact', phase: 'start', cycleId: 'p1', args: '', trigger: 'manual' });
        return { ok: (await options.localCommandObserver.wait(500)).ok };
      }
      return { ok: true, status: 'confirmed' };
    },
    readFinalText: async () => finalText,
    readContextTokens: async () => tokens,
    minTokens: 540_000,
    isBusy: () => busy,
    notify: (sessionId, message, level) => notices.push({ sessionId, message, level }),
    logger: { log() {}, warn() {} },
    settleMs: 5,
  });
  controller.start();
  const endCompact = sessionId => manager.emit('claude-local-command-ack', { sessionId, command: 'compact', phase: 'end', cycleId: 'p1' });
  return { manager, controller, writes, notices, endCompact };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('标记只认回复末尾', () => {
  assert.equal(findMarker('做完了。\n\n[[hub:compact-continue]]'), 'continue');
  assert.equal(findMarker('等你回复。\n[[hub:compact]]\n'), 'wait');
  assert.equal(findMarker('普通回复'), null);
  assert.equal(findMarker('[[hub:compact]]' + '后面还有很长的正文。'.repeat(80)), null);
});

test('带 -continue：压缩确认后，等压缩结束再发继续', async () => {
  const { controller, writes, notices, endCompact } = setup({ finalText: '阶段 2 完成。\n[[hub:compact-continue]]' });
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), 'continue');
  assert.deepEqual(writes.map(w => w.text), ['/compact']);
  assert.equal(writes[0].options.requireReady, false);
  assert.ok(controller.isCompacting('s1'));
  endCompact('s1');
  await flush();
  assert.deepEqual(writes.map(w => w.text), ['/compact', CONTINUE_PROMPT]);
  assert.ok(!controller.isCompacting('s1'));
  assert.match(notices.at(-1).message, /读进展卡接着做/);
});

test('不带 -continue：只压缩，不发继续', async () => {
  const { controller, writes, notices, endCompact } = setup({ finalText: '请确认方案。\n[[hub:compact]]' });
  assert.equal(await controller.onStop('s1', {}), null, '没有 transcript 时读 Stop 自带的开头片段；这里也没有标记');
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), 'wait');
  endCompact('s1');
  await flush();
  assert.deepEqual(writes.map(w => w.text), ['/compact']);
  assert.match(notices.at(-1).message, /已自动压缩/);
});

test('transcript 读不到时退回 Stop 自带的回复', async () => {
  const { controller, writes } = setup({ finalText: null });
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl', lastAssistantMessage: '好。\n[[hub:compact]]' }), 'wait');
  assert.deepEqual(writes.map(w => w.text), ['/compact']);
});

test('没有标记、用户已发新消息、群聊成员、非 PTY 会话都不压缩', async () => {
  for (const options of [
    { finalText: '普通回复' },
    { finalText: '[[hub:compact]]', busy: true },
    { finalText: '[[hub:compact]]', session: { meetingId: 'm1' } },
    { finalText: '[[hub:compact]]', session: { agentRuntime: 'native' } },
    { finalText: '[[hub:compact]]', session: { kind: 'codex' } },
  ]) {
    const { controller, writes } = setup(options);
    assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), null, JSON.stringify(options));
    assert.equal(writes.length, 0, JSON.stringify(options));
    assert.ok(!controller.isCompacting('s1'));
  }
});

test('压缩中再次 Stop 不重复发；别的会话的压缩结束不触发继续', async () => {
  const { controller, writes, endCompact } = setup({ finalText: '[[hub:compact-continue]]' });
  await controller.onStop('s1', { transcriptPath: 'x.jsonl' });
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), null);
  endCompact('s2');
  await flush();
  assert.deepEqual(writes.map(w => w.text), ['/compact']);
});

test('/compact 未获确认：清掉状态并提示手动压缩，不发继续', async () => {
  const { controller, writes, notices, endCompact } = setup({ finalText: '[[hub:compact-continue]]', sendResult: { ok: false, message: 'stuck' } });
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), null);
  assert.ok(!controller.isCompacting('s1'));
  assert.equal(notices.at(-1).level, 'warning');
  endCompact('s1');
  await flush();
  assert.equal(writes.length, 1);
});

test('压缩完成后冷却期内再出现标记不再压缩', async () => {
  const { controller, writes, endCompact } = setup({ finalText: '[[hub:compact-continue]]' });
  await controller.onStop('s1', { transcriptPath: 'x.jsonl' });
  endCompact('s1');
  await flush();
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), null);
  assert.deepEqual(writes.map(w => w.text), ['/compact', CONTINUE_PROMPT]);
});

test('上下文不到软线九成时忽略标记（压缩后 AI 仍留标记的回归）', async () => {
  for (const tokens of [85_708, 539_999, null]) {
    const { controller, writes } = setup({ finalText: '等合并通知。\n[[hub:compact-continue]]', tokens });
    assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), null, String(tokens));
    assert.equal(writes.length, 0, String(tokens));
    assert.ok(!controller.isCompacting('s1'));
  }
  const { controller, writes } = setup({ finalText: '[[hub:compact-continue]]', tokens: 540_000 });
  assert.equal(await controller.onStop('s1', { transcriptPath: 'x.jsonl' }), 'continue');
  assert.deepEqual(writes.map(w => w.text), ['/compact']);
});

test('上下文读数取最后一条主线 assistant 的 usage 合计，跳过子 Agent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-compact-tokens-'));
  const file = path.join(dir, 't.jsonl');
  const usage = (n, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { usage: { input_tokens: n, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 } } });
  fs.writeFileSync(file, [usage(1000), JSON.stringify({ type: 'user', message: { content: 'hi' } }), usage(5000), usage(9, { isSidechain: true }), '{坏行', ''].join('\n'));
  assert.equal(await readClaudeContextTokens(file), 5111);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  assert.equal(await readClaudeContextTokens(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
