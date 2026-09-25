'use strict';
// PTY Claude 按 Esc 中断时没有 Stop hook；transcript 里的中断标记是唯一的语义证据。
// 2026-09-25 真机状态矩阵实测：漏掉它，Hub 会一直显示「正在工作」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptTap } = require('../core/transcript-tap');

test('an interrupt marker appended to the live transcript ends the turn as aborted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interrupt-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '跑个长任务' } }) + '\n');
  const tap = new TranscriptTap();
  t.after(() => { tap.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const aborted = [];
  tap.on('turn-aborted', ev => aborted.push(ev));
  await tap.watchClaudeTranscript('hub-1', file, { newTurn: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(),
    message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }], stop_reason: 'tool_use' } }) + '\n');
  const at = new Date().toISOString();
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u2', timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n');
  const end = Date.now() + 5000;
  while (!aborted.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].hubSessionId, 'hub-1');
  assert.equal(aborted[0].signalSource, 'claude-interrupt-marker');
  assert.equal(aborted[0].abortedAt, Date.parse(at));
});
