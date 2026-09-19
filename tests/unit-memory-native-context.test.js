'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NativeContextReader } = require('../core/memory-native-context');
const message = (role, text) => ({ type: 'response_item', timestamp: '2026-09-19T09:56:40Z', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const rules = body => '# AGENTS.md instructions for C:\\project\n\n<INSTRUCTIONS>\n' + body + '\n</INSTRUCTIONS>\n<environment_context>omit</environment_context>';
function setup(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id: 'native-one' } }, ...records].map(JSON.stringify).join('\n') + '\n');
  return { file, session: { kind: 'codex', codexSid: 'native-one', transcriptPath: file }, reader: new NativeContextReader() };
}
test('extracts actual native snapshots without Dream receipts or disk files, ignores ordinary mentions and large tool payloads', async t => {
  const f = setup(t, [message('developer', '## Memory\r\nnative memory\n========= MEMORY_SUMMARY ENDS =========\n<skills>omit</skills>'),
    message('user', rules('original rules')), message('user', 'Please read AGENTS.md'),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'a'.repeat(3 * 1024 * 1024) } }]);
  const result = await f.reader.read(f.session);
  assert.equal(result.entries.length, 2); assert.equal(result.entries[1].line, 3);
  assert.match(result.entries[1].content, /original rules/); assert.doesNotMatch(result.entries[1].content, /environment_context/);
  assert.doesNotMatch(result.entries[0].content, /<skills>/);
  assert.equal(result.stats.keptRecords, 2); assert.ok(result.stats.maxBufferedLineBytes <= 65536);
  assert.equal(await f.reader.read(f.session), result);
  const refreshed = await f.reader.read(f.session, { force: true });
  assert.notEqual(refreshed, result); assert.equal(refreshed.entries.length, 2);
});
test('coalesces reads, incrementally updates latest snapshots and waits for complete trailing records', async t => {
  const f = setup(t, [message('user', rules('old'))]);
  const [a, b] = await Promise.all([f.reader.read(f.session), f.reader.read(f.session)]); assert.equal(a, b);
  const next = JSON.stringify(message('user', rules('new'))), half = Math.floor(next.length / 2);
  fs.appendFileSync(f.file, next.slice(0, half));
  const partial = await f.reader.read(f.session); assert.match(partial.entries[0].content, /old/); assert.ok(partial.warnings.length);
  fs.appendFileSync(f.file, next.slice(half) + '\n');
  const complete = await f.reader.read(f.session); assert.equal(complete.entries.length, 1);
  assert.match(complete.entries[0].content, /new/); assert.equal(complete.entries[0].line, 3);
  assert.equal(complete.stats.keptRecords, 1); assert.equal(complete.warnings.length, 0);
});
test('rejects a different native identity, reports missing/unsupported sources and compaction', async t => {
  const f = setup(t, [message('user', rules('ok')), { type: 'compacted', payload: { replacement_history: ['x'.repeat(1024 * 1024)] } }]);
  await assert.rejects(f.reader.read({ ...f.session, codexSid: 'other' }), /身份不匹配/);
  const result = await f.reader.read(f.session); assert.ok(result.compactedAt); assert.equal(result.stats.keptRecords, 1);
  assert.ok((await f.reader.read({ kind: 'claude' })).warnings.length);
  assert.ok((await f.reader.read({ kind: 'codex' })).warnings.length);
  await assert.rejects(f.reader.read({ ...f.session, transcriptPath: f.file + '.missing' }), { code: 'ENOENT' });
});
test('discarded or truncated transcripts cannot retain stale cached injection', async t => {
  const f = setup(t, [message('user', rules('old'))]); await f.reader.read(f.session);
  fs.writeFileSync(f.file, JSON.stringify({ type: 'session_meta', payload: { id: 'native-one' } }) + '\n');
  assert.equal((await f.reader.read(f.session)).entries.length, 0);
});

test('an in-place rewrite to a larger file must not retain removed injection or trust a cached native identity', async t => {
  const f = setup(t, [message('user', rules('removed rules'))]); await f.reader.read(f.session);
  const rewrite = id => fs.writeFileSync(f.file, [
    { type: 'session_meta', payload: { id } }, message('user', 'ordinary message '.repeat(200)),
  ].map(JSON.stringify).join('\n') + '\n');
  rewrite('native-one');
  assert.equal((await f.reader.read(f.session)).entries.length, 0);
  rewrite('another-native-id');
  await assert.rejects(f.reader.read(f.session), /身份不匹配/);
});
