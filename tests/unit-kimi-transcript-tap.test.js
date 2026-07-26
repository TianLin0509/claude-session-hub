'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KimiTap, extractLatestKimiTurnFromText } = require('../core/kimi-transcript-tap.js');
const { parseKimiWireToTurns } = require('../core/kimi-transcript-parser.js');

function waitFor(predicate, timeoutMs = 2500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function appendRecords(filePath, records) {
  fs.appendFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-tap-'));
  const homeDir = path.join(root, '.kimi-code');
  const workDir = path.join(root, 'workspace');
  const sessionDir = path.join(homeDir, 'sessions', 'work-key', 'kimi-session-1');
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(wirePath, '', 'utf8');

  const tap = new KimiTap({ homeDir, pollMs: 40 });
  const bound = [];
  const prompts = [];
  const completed = [];
  tap.on('session-bound', (event) => bound.push(event));
  tap.on('prompt-submitted', (event) => prompts.push(event));
  tap.on('turn-complete', (event) => completed.push(event));

  tap.registerSession('hub-kimi-1', { cwd: workDir, registeredAt: Date.now() });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'session_index.jsonl'), JSON.stringify({
    sessionId: 'kimi-session-1',
    sessionDir,
    workDir,
  }) + '\n', 'utf8');

  await waitFor(() => bound.length === 1);
  assert.strictEqual(bound[0].kimiSid, 'kimi-session-1');
  assert.strictEqual(bound[0].wirePath, wirePath);

  const records = [
    { type: 'config.update', modelAlias: 'kimi-code/k3' },
    { type: 'turn.prompt', input: [{ type: 'text', text: '请检查后回答' }], origin: { kind: 'user' } },
    { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 } },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-1', part: { type: 'text', text: '我先检查。' } } },
    { type: 'context.append_loop_event', event: { type: 'tool.call', stepUuid: 'step-1', toolCallId: 'call-1', name: 'Bash', args: { command: 'pwd' } } },
    { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-1', finishReason: 'tool_calls' } },
    { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-2', turnId: '0', step: 2 } },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-2', part: { type: 'text', text: '最终回答：检查完成。' } } },
    { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-2', finishReason: 'completed', usage: { inputOther: 1000, inputCacheRead: 3000, inputCacheCreation: 0, output: 200 } } },
  ];
  appendRecords(wirePath, records);

  await waitFor(() => completed.length === 1);
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(prompts[0].text, '请检查后回答');
  assert.strictEqual(completed[0].text, '最终回答：检查完成。');
  assert.deepStrictEqual(tap.getStreamingText('hub-kimi-1'), [{ type: 'text', text: '最终回答：检查完成。' }]);

  const extracted = await tap.extractLatestTurn('hub-kimi-1');
  assert.strictEqual(extracted.text, '最终回答：检查完成。');
  assert.strictEqual(extractLatestKimiTurnFromText(fs.readFileSync(wirePath, 'utf8')).text, '最终回答：检查完成。');

  const turns = parseKimiWireToTurns(wirePath, { limit: 10, fromTail: true });
  assert.deepStrictEqual(turns.map((turn) => [turn.role, turn.text]), [
    ['user', '请检查后回答'],
    ['assistant', '最终回答：检查完成。'],
  ]);
  assert.strictEqual(turns[1].toolCalls[0].name, 'Bash');
  assert.strictEqual(turns[1].model, 'kimi-code/k3');
  assert.deepStrictEqual(turns[1].usage, {
    input_tokens: 4000,
    output_tokens: 200,
    context_tokens: 4000,
    context_window: 1048576,
  });

  const resumeTap = new KimiTap({ homeDir, pollMs: 40 });
  const resumed = [];
  resumeTap.on('turn-complete', (event) => resumed.push(event));
  resumeTap.registerSession('hub-kimi-resume', { cwd: workDir, kimiSid: 'kimi-session-1' });
  await waitFor(() => resumeTap.getDebugSnapshot().bound.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(resumed.length, 0, 'resume must not replay historical completions');

  appendRecords(wirePath, [
    { type: 'turn.prompt', input: [{ type: 'text', text: '继续' }], origin: { kind: 'user' } },
    { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-3', turnId: '1', step: 1 } },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-3', part: { type: 'text', text: '续答成功。' } } },
    { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-3', finishReason: 'completed' } },
  ]);
  await waitFor(() => resumed.length === 1);
  assert.strictEqual(resumed[0].text, '续答成功。');

  tap.dispose();
  resumeTap.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Kimi transcript tap/parser tests passed.');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
