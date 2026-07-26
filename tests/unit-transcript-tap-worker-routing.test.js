'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptTap } = require('../core/transcript-tap.js');

test('manual transcript extraction routes Claude, Codex and Kimi through parser service', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-transcript-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const parserService = {
    async parse(kind, transcriptPath, opts) {
      calls.push({ kind, transcriptPath, opts });
      if (kind === 'claude') return { turns: [{ role: 'assistant', text: 'claude answer', tsEnd: 2000 }] };
      if (kind === 'codex') return { turns: [
        { role: 'user', text: 'question', ts: 1000 },
        { role: 'assistant', text: 'codex answer', tsEnd: 2000, stopReason: 'task_complete' },
      ] };
      return { turns: [{ role: 'assistant', text: 'kimi answer', tsEnd: 2000 }] };
    },
  };
  const tap = new TranscriptTap({ parserService });
  t.after(() => tap.dispose());

  const claudePath = path.join(root, 'claude.jsonl');
  fs.writeFileSync(claudePath, '', 'utf8');
  tap.registerSession('claude-hub', 'claude', { transcriptPath: claudePath });
  assert.equal((await tap.extractLatestTurn('claude-hub')).text, 'claude answer');

  const codexPath = path.join(root, 'codex.jsonl');
  fs.writeFileSync(codexPath, '', 'utf8');
  tap._codex._bound.set('codex-hub', { rolloutPath: codexPath, lastText: null });
  const codex = await tap.extractLatestTurn('codex-hub');
  assert.equal(codex.text, 'codex answer');
  assert.equal(codex.extractMode, 'final_answer');

  const kimiPath = path.join(root, 'wire.jsonl');
  fs.writeFileSync(kimiPath, '', 'utf8');
  tap.registerSession('kimi-hub', 'kimi', { transcriptPath: kimiPath, sessionDir: root });
  assert.equal((await tap.extractLatestTurn('kimi-hub')).text, 'kimi answer');

  assert.deepEqual(calls.map(call => call.kind), ['claude', 'codex', 'kimi']);
});
