'use strict';

// Live transcripts are re-indexed incrementally: only appended bytes are
// scanned and only changed rows are rewritten. These tests lock in that the
// result is indistinguishable from indexing the same files from scratch.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionSearchEngine } = require('../core/session-search-engine.js');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');
const { AppendScanCache } = require('../core/search-append-scan-cache.js');
const { JsonlByteScanner } = require('../core/jsonl-byte-scanner.js');
const { createCodexLineFilter } = require('../core/codex-rollout-reader.js');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout.js');

const line = obj => `${JSON.stringify(obj)}\n`;
const claudeFilter = prefix => (prefix.includes('"type":"tool_result"') ? false : null);

function fullScan(filePath, lineFilter) {
  const out = [];
  const scanner = new JsonlByteScanner((record, lineIndex) => out.push({ record, lineIndex }), { lineFilter, maxPrefixBytes: 64 * 1024 });
  scanner.push(fs.readFileSync(filePath));
  scanner.end({ flushFinal: true });
  return out;
}

// Databases must be closed before their directory can be removed on Windows.
function tempRoot(t, name, closers = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-search-incremental-${name}-`));
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('append scan cache returns exactly what a full scan returns across appends, partial lines, truncation and rewrites', t => {
  const root = tempRoot(t, 'cache');
  const file = path.join(root, 'live.jsonl');
  const cache = new AppendScanCache({ minFileBytes: 0 });
  const check = label => assert.deepEqual(cache.readRecords(file, 'k', { lineFilter: claudeFilter }), fullScan(file, claudeFilter), label);

  fs.writeFileSync(file, line({ type: 'user', uuid: 'a', message: { content: 'first' } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } }));
  check('initial');
  assert.equal(cache.entries.size, 0, 'a file read once (initial build) is not retained');
  check('second read arms the cache');
  assert.equal(cache.stats.fullScans, 2);
  assert.equal(cache.entries.size, 1);

  fs.appendFileSync(file, line({ type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'second' }] } }));
  const before = cache.stats.scannedBytes;
  check('after append');
  assert.equal(cache.stats.appendScans, 1);
  assert.ok(cache.stats.scannedBytes - before < 200, 'only the appended line is read');

  // A writer caught mid-line: the partial row is parsed like a full scan would, but not cached.
  const tail = line({ type: 'user', uuid: 'c', message: { content: 'third' } });
  fs.appendFileSync(file, tail.slice(0, 20));
  check('partial trailing line');
  fs.appendFileSync(file, tail.slice(20));
  check('partial line completed');
  fs.appendFileSync(file, tail.trimEnd());
  check('complete JSON without newline yet');
  fs.appendFileSync(file, '\n' + line({ type: 'user', uuid: 'd', message: { content: 'fourth' } }));
  check('newline arrives after a parsable unterminated line');

  fs.truncateSync(file, fs.statSync(file).size - 30);
  check('truncated below the cached offset');

  const content = fs.readFileSync(file, 'utf8').replace('first', 'FIRST');
  fs.writeFileSync(file, content);
  check('same-size rewrite at the head');
  fs.writeFileSync(file, line({ type: 'user', uuid: 'z', message: { content: 'replaced' } }));
  check('file replaced by a shorter one');
  assert.ok(cache.stats.invalidations >= 2);
});

test('append scan cache honours its memory budget and the Codex chunk-boundary role check', t => {
  const root = tempRoot(t, 'budget');
  const files = [0, 1, 2].map(i => path.join(root, `f${i}.jsonl`));
  for (const file of files) fs.writeFileSync(file, line({ type: 'user', message: { content: 'y'.repeat(600) } }));
  const cache = new AppendScanCache({ minFileBytes: 0, maxEntryKeptBytes: 1000, maxTotalKeptBytes: 1300 });
  for (const file of files) for (let i = 0; i < 2; i += 1) cache.readRecords(file, 'k', { lineFilter: claudeFilter });
  assert.ok(cache.keptBytes <= 1300);
  assert.equal(cache.entries.size, 2, 'oldest entry evicted');
  fs.appendFileSync(files[2], line({ type: 'user', message: { content: 'z'.repeat(600) } }));
  assert.equal(cache.readRecords(files[2], 'k', { lineFilter: claudeFilter }).length, 2);
  assert.equal(cache.entries.has(`k\0${files[2]}`), false, 'an entry over its own budget is not kept');

  // A chunk ending between "type":"message" and "role":"user" must not drop the prompt.
  const filter = createCodexLineFilter('search');
  const prefix = '{"timestamp":"t","type":"response_item","payload":{"type":"message",';
  assert.equal(filter(prefix, { prefixBytes: prefix.length, maxPrefixBytes: 65536 }), null);
  assert.equal(filter(prefix + '"role":"user"', { prefixBytes: prefix.length + 13, maxPrefixBytes: 65536 }), true);
  assert.equal(filter(prefix + '"role":"assistant"', { prefixBytes: prefix.length + 18, maxPrefixBytes: 65536 }), false);
});

const docRows = index => index.db.prepare(`SELECT source_key, session_key, event_id, scope, role, speaker, text, normalized_text, ordinal, timestamp
  FROM docs ORDER BY session_key, event_id`).all();
const sessionRows = index => index.db.prepare('SELECT * FROM sessions ORDER BY key').all();
const sourceRows = index => index.db.prepare('SELECT key, signature, stale, searchable, updated_at FROM sources ORDER BY key').all();
const ftsHits = (index, term) => index.db.prepare(`SELECT count(*) n FROM docs_fts WHERE docs_fts MATCH ?`).get(`"${term}"`).n;

test('in-place source update leaves the same rows as a full replacement and keeps unchanged rowids', t => {
  const closers = [];
  const root = tempRoot(t, 'diff', closers);
  const a = new SqliteSessionSearchIndex(path.join(root, 'a.sqlite'));
  const b = new SqliteSessionSearchIndex(path.join(root, 'b.sqlite'));
  closers.push(() => a.close(), () => b.close());
  const source = docs => ({ key: 's1', signature: `sig-${docs.length}`, searchable: true,
    session: { key: 's1', provider: 'claude', title: 'TITLE_DIFF_MARKER', updatedAt: 100 + docs.length, turnCount: docs.length }, docs });
  const v1 = [
    { id: 'u1', scope: 'user', role: 'user', speaker: '我', text: 'KEEP_MARKER 保持不变', ordinal: 0, timestamp: 1 },
    { id: 'a1', scope: 'assistant', role: 'assistant', text: 'CHANGE_MARKER_OLD', ordinal: 1, timestamp: 2 },
    { id: 'a1:tool:0', scope: 'tool', role: 'tool', text: 'Bash ls', ordinal: 1.001, timestamp: 2 },
    { id: 'gone', scope: 'assistant', role: 'assistant', text: 'GONE_MARKER', ordinal: 2, timestamp: 3 },
  ];
  const v2 = [
    v1[0],
    { ...v1[1], text: 'CHANGE_MARKER_NEW' },
    v1[2],
    { id: 'dup', scope: 'user', role: 'user', text: 'DUP_FIRST_MARKER', ordinal: 3, timestamp: 4 },
    { id: 'dup', scope: 'user', role: 'user', text: 'DUP_SECOND_MARKER', ordinal: 4, timestamp: 5 },
    { id: 'title', scope: 'title', text: 'ignored parser title' },
    { id: 'empty', scope: 'assistant', text: '' },
  ];
  a.replaceSource(source(v1));
  const keepId = a.db.prepare("SELECT id FROM docs WHERE event_id='u1'").get().id;
  a.replaceSource(source(v2));
  b.replaceSource(source(v2));
  assert.deepEqual(docRows(a), docRows(b));
  assert.deepEqual(sessionRows(a), sessionRows(b));
  assert.deepEqual(sourceRows(a), sourceRows(b));
  assert.equal(a.db.prepare("SELECT id FROM docs WHERE event_id='u1'").get().id, keepId, 'unchanged row is not rewritten');
  for (const [term, n] of [['change_marker_new', 1], ['change_marker_old', 0], ['gone_marker', 0], ['dup_first_marker', 1], ['dup_second_marker', 0], ['keep_marker', 1]]) {
    assert.equal(ftsHits(a, term), n, term);
  }
  a.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')");
  assert.equal(a.search({ query: '保持不变' }).totalSessions, 1);

  // Becoming unsearchable or changing session identity still uses the full path.
  a.replaceSource({ ...source(v2), searchable: false });
  b.replaceSource({ ...source(v2), searchable: false });
  assert.deepEqual(docRows(a), docRows(b));
  assert.deepEqual(sourceRows(a), sourceRows(b));
});

function engineOptions(root, databasePath) {
  return { databasePath, claudeRoots: [path.join(root, 'claude')], codexRoots: [path.join(root, 'codex')],
    kimiRoots: [], geminiRoots: [], meetingDir: path.join(root, 'meetings'), transcriptDir: path.join(root, 'md', path.basename(databasePath)) };
}

test('appending to live Claude and Codex transcripts indexes only the new content and matches a rebuild from scratch', { timeout: 30_000 }, async t => {
  const closers = [];
  const root = tempRoot(t, 'engine', closers);
  const claudeFile = path.join(root, 'claude', 'C--live', 'live-claude.jsonl');
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-11T01:00:00Z', message: { content: 'CLAUDE_OLD_MARKER 旧问题' } })
    + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-11T01:00:05Z', message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'CLAUDE_OLD_ANSWER' }] } }));
  const sid = '11111111-2222-7333-8444-666666666666';
  const rollout = new FakeCodexRollout({ sessionsRoot: path.join(root, 'codex'), cwd: 'C:\\live', sid });
  await rollout.start();
  await rollout.writeRaw({ timestamp: '2026-10-11T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'CODEX_OLD_MARKER' } });
  await rollout.writeRaw({ timestamp: '2026-10-11T01:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'CODEX_OLD_ANSWER' } });
  await rollout.close();
  const snapshot = { sessions: [], meetings: [] };

  const live = new SessionSearchEngine(engineOptions(root, path.join(root, 'live.sqlite')));
  live._appendScanCache = new AppendScanCache({ minFileBytes: 0 });
  closers.push(() => live.close());
  await live.refresh(snapshot, { immediate: true });
  const oldIds = new Map(live.index.db.prepare('SELECT event_id, id FROM docs').all().map(r => [r.event_id, r.id]));

  const rebuildMatches = async label => {
    const fresh = new SessionSearchEngine(engineOptions(root, path.join(root, `fresh-${label}.sqlite`)));
    try {
      await fresh.refresh(snapshot, { immediate: true });
      assert.deepEqual(docRows(live.index), docRows(fresh.index), `${label}: docs`);
      assert.deepEqual(sessionRows(live.index), sessionRows(fresh.index), `${label}: sessions`);
      assert.deepEqual(sourceRows(live.index), sourceRows(fresh.index), `${label}: sources`);
    } finally { fresh.close(); }
    live.index.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')");
  };
  const hits = async query => (await live.search({ query })).totalSessions;

  for (let round = 0; round < 3; round += 1) {
    fs.appendFileSync(claudeFile,
      line({ type: 'user', uuid: `u-new-${round}`, timestamp: `2026-10-11T01:0${round + 1}:00Z`, message: { content: `CLAUDE_NEW_MARKER_${round}` } })
      + line({ type: 'user', uuid: `r-${round}`, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out'.repeat(1000) }] } })
      + line({ type: 'assistant', uuid: `a-new-${round}`, timestamp: `2026-10-11T01:0${round + 1}:05Z`, message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: `CLAUDE_NEW_ANSWER_${round}` }] } }));
    fs.appendFileSync(rollout.rolloutPath,
      line({ timestamp: `2026-10-11T01:0${round + 1}:00.000Z`, type: 'event_msg', payload: { type: 'user_message', message: `CODEX_NEW_MARKER_${round}` } })
      + line({ timestamp: `2026-10-11T01:0${round + 1}:00.500Z`, type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'b'.repeat(4000) } })
      + line({ timestamp: `2026-10-11T01:0${round + 1}:01.000Z`, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `CODEX_NEW_ANSWER_${round}` } }));
    await live.refresh(snapshot, { immediate: true });
    for (const marker of [`CLAUDE_NEW_MARKER_${round}`, `CLAUDE_NEW_ANSWER_${round}`, `CODEX_NEW_MARKER_${round}`, `CODEX_NEW_ANSWER_${round}`, 'CLAUDE_OLD_MARKER', 'CODEX_OLD_MARKER', 'CODEX_OLD_ANSWER']) {
      assert.equal(await hits(marker), 1, `round ${round}: ${marker}`);
    }
  }
  assert.ok(live._appendScanCache.stats.appendScans >= 4, JSON.stringify(live._appendScanCache.stats));
  const keptIds = live.index.db.prepare("SELECT event_id, id FROM docs WHERE event_id IN ('u1')").all();
  assert.deepEqual(keptIds.map(r => r.id), [oldIds.get('u1')], 'old Claude prompt row is reused, not rewritten');
  await rebuildMatches('appended');
  const md = fs.readdirSync(engineOptions(root, path.join(root, 'live.sqlite')).transcriptDir)
    .map(name => fs.readFileSync(path.join(engineOptions(root, path.join(root, 'live.sqlite')).transcriptDir, name), 'utf8')).join('\n');
  assert.match(md, /CLAUDE_NEW_ANSWER_2/);
  assert.match(md, /CODEX_NEW_ANSWER_2/);

  // Truncation (e.g. a rewound transcript) drops the removed content.
  const claudeText = fs.readFileSync(claudeFile, 'utf8');
  fs.writeFileSync(claudeFile, claudeText.slice(0, claudeText.indexOf('{"type":"user","uuid":"u-new-1"')));
  await live.refresh(snapshot, { immediate: true });
  assert.equal(await hits('CLAUDE_NEW_MARKER_1'), 0);
  assert.equal(await hits('CLAUDE_NEW_MARKER_0'), 1);
  assert.equal(await hits('CLAUDE_OLD_MARKER'), 1);
  await rebuildMatches('truncated');

  // A deleted transcript leaves the index.
  fs.rmSync(claudeFile);
  await live.refresh(snapshot, { immediate: true });
  assert.equal(await hits('CLAUDE_OLD_MARKER'), 0);
  assert.equal(await hits('CODEX_NEW_MARKER_2'), 1);
  await rebuildMatches('deleted');
});
