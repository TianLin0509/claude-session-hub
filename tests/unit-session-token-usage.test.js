'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexUsage, ClaudeUsageLedger } = require('../core/session-token-usage.js');
const { SessionTokenUsageService } = require('../main/usage/session-token-usage-service.js');
const { compactCount, modelEffort, detailsHtml } = require('../renderer/session-details.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 4500) throw new Error('usage update timeout'); await wait(25); }
}
const claude = (id, output = 10) => ({ type: 'assistant', message: { id, usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } });
const codex = (total = 1000, output = 100) => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, total_token_usage: { input_tokens: total - output, output_tokens: output, total_tokens: total, cached_input_tokens: 50, reasoning_output_tokens: 20 } } } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-usage-'));
  const values = new Map();
  const errors = [];
  const service = new SessionTokenUsageService({ publish: (id, usage) => values.set(id, usage), logger: { warn: (...args) => errors.push(args) } });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'session.jsonl');
  const write = records => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  const append = record => fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return { root, file, write, append, service, values, errors };
}

test('Codex uses cumulative total; cache and reasoning remain subsets', () => {
  const usage = codexUsage({ inputTokens: 900, outputTokens: 100, totalTokens: 1000, cachedInputTokens: 800, reasoningOutputTokens: 60 });
  assert.equal(usage.total, 1000); assert.equal(usage.output, 100);
  assert.equal(codexUsage({ totalTokens: -1, inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(codexUsage({ totalTokens: 10, inputTokens: NaN, outputTokens: 1 }), null);
});
test('Claude shared response ids, incremental blocks and replay are counted once', () => {
  const ledger = new ClaudeUsageLedger();
  assert.equal(ledger.accept(claude('m1')).total, 360);
  assert.equal(ledger.accept(claude('m1', 20)).total, 370);
  assert.equal(ledger.accept(claude('m1', 5)).total, 370);
  const usage = ledger.accept(claude('m2'));
  assert.equal(usage.total, 730); assert.equal(usage.output, 30); assert.equal(usage.input, 700);
  assert.equal(ledger.accept({ ...claude('subagent'), isSidechain: true }), null);
  assert.equal(ledger.accept(claude(null)), null);
  assert.equal(ledger.accept(claude('m2')).partial, true);
});
test('formatting and model effort meet the requested second line; unknown is not zero', () => {
  assert.equal(compactCount(1280000), '1.28M'); assert.equal(compactCount(64000), '64k');
  assert.equal(compactCount(null), '—'); assert.equal(compactCount(0), '0');
  assert.equal(modelEffort({ currentModel: { id: 'gpt-6-astra' }, effort: 'high' }, () => 'fallback'), 'Astra High');
  const html = detailsHtml({ id: 'a', sessionUsage: { total: 1280000, output: 64000 } }, { escapeHtml: String, modelShort: () => '' });
  assert.match(html, /累计 1.28M\/64k/); assert.doesNotMatch(html, /tok/);
});
test('real Codex JSONL append, partial lines and duplicate snapshots never inflate totals', async t => {
  const f = fixture(t); f.write([codex()]);
  f.service.bind({ id: 'a', kind: 'codex', transcriptPath: f.file });
  await until(() => f.values.get('a')?.total === 1000);
  f.append(codex()); await wait(650); assert.equal(f.values.get('a').output, 100);
  const bytes = JSON.stringify(codex(2000, 200)); fs.appendFileSync(f.file, bytes.slice(0, 51));
  await wait(650); assert.equal(f.values.get('a').total, 1000);
  fs.appendFileSync(f.file, bytes.slice(51) + '\n');
  await until(() => f.values.get('a')?.total === 2000);
  f.append(codex()); await wait(650); assert.equal(f.values.get('a').total, 2000);
});
test('Claude history rebuild and restored snapshot stay equal across restart', async t => {
  const f = fixture(t); f.write([claude('m1'), claude('m1', 20), claude('m2')]);
  const session = { id: 'a', kind: 'claude', transcriptPath: f.file };
  f.service.bind(session); await until(() => f.values.get('a')?.total === 730);
  const saved = f.values.get('a'); f.service.remove('a'); f.values.clear();
  f.service.bind({ ...session, sessionUsage: saved }); await until(() => f.values.get('a')?.total === 730);
  f.append(claude('m3')); await until(() => f.values.get('a')?.total === 1090);
  assert.equal(f.values.get('a').output, 40);
});
test('rebinding another transcript resets usage and stops the old watcher', async t => {
  const f = fixture(t); f.write([codex()]);
  f.service.bind({ id: 'a', kind: 'codex', transcriptPath: f.file });
  await until(() => f.values.get('a')?.total === 1000);
  const other = path.join(f.root, 'other.jsonl'); fs.writeFileSync(other, JSON.stringify(codex(500, 50)) + '\n');
  f.service.bind({ id: 'a', kind: 'codex', transcriptPath: other, sessionUsage: f.values.get('a') });
  await until(() => f.values.get('a')?.total === 500);
  f.append(codex(4000, 400)); await wait(650); assert.equal(f.values.get('a').total, 500);
});
test('missing files retain saved values visibly stale; valid later data recovers', async t => {
  const f = fixture(t);
  f.service.bind({ id: 'a', kind: 'codex', transcriptPath: f.file, sessionUsage: { total: 1000, output: 100, sourcePath: f.file } });
  await until(() => f.values.get('a')?.stale === true); assert.ok(f.errors.length > 0);
  f.write([codex(2000, 200)]); await until(() => f.values.get('a')?.total === 2000);
  assert.equal(f.values.get('a').stale, undefined);
});
test('native snapshots and independent sessions are not accumulated together', t => {
  const f = fixture(t);
  const total = { totalTokens: 1000, inputTokens: 900, outputTokens: 100 };
  f.service.native({ id: 'a' }, total); f.service.native({ id: 'a' }, total); f.service.native({ id: 'b' }, total);
  assert.equal(f.values.get('a').total, 1000); assert.equal(f.values.get('b').total, 1000);
});
