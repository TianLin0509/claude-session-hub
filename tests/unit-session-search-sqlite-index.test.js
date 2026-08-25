'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');

function source(key, provider, title, docs, updatedAt = Date.now()) {
  return {
    key,
    signature: `sig-${key}`,
    searchable: true,
    session: {
      key, provider, nativeFamily: provider, kind: provider, title,
      cwd: `C:\\${provider}-repo`, projectLabel: `${provider}-repo`, model: `${provider}-model`,
      updatedAt, hubSessionId: `hub-${key}`, nativeSessionId: `native-${key}`,
      meetingId: null, transcriptPath: `C:\\transcripts\\${key}.jsonl`, turnCount: docs.length,
    },
    docs: docs.map((doc, index) => ({
      id: doc.id || `doc-${index}`, eventId: doc.id || `doc-${index}`,
      scope: doc.scope, role: doc.scope, speaker: doc.speaker || provider,
      text: doc.text, ordinal: index, timestamp: updatedAt + index,
    })),
  };
}

test('SQLite trigram index supports CJK, cross-document terms, filters and preview', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-sqlite-'));
  const dbPath = path.join(root, 'search.sqlite');
  const index = new SqliteSessionSearchIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  index.replaceSource(source('codex-1', 'codex', '昨日之我 内存排查', [
    { id: 'u1', scope: 'user', text: '搜索为什么会闪退' },
    { id: 'a1', scope: 'assistant', text: '根因是全文索引占用大量内存' },
  ]));
  index.replaceSource(source('claude-1', 'claude', '其他会话', [
    { id: 'u2', scope: 'user', text: '普通问题' },
    { id: 'a2', scope: 'assistant', text: '普通回答' },
  ]));

  const cjk = index.search({ query: '内存排查' });
  assert.equal(cjk.totalSessions, 1);
  assert.equal(cjk.results[0].sessionKey, 'codex-1');

  const crossDoc = index.search({ query: '搜索 全文索引' });
  assert.equal(crossDoc.totalSessions, 1);
  assert.equal(crossDoc.results[0].matchCount, 2);

  const filtered = index.search({ query: '普通', providers: ['codex'] });
  assert.equal(filtered.totalSessions, 0);

  const preview = index.preview({ sessionKey: 'codex-1', eventId: 'a1', query: '全文索引' });
  assert.equal(preview.session.provider, 'codex');
  assert.equal(preview.context.some(item => item.isMatch && /全文索引/.test(item.text)), true);
  assert.equal(index.getStats().storage, 'sqlite-fts5');
});

test('SQLite index persists sources and prunes stale sessions without in-memory rebuild', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-sqlite-persist-'));
  const dbPath = path.join(root, 'search.sqlite');
  let index = new SqliteSessionSearchIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  index.replaceSource(source('keep', 'codex', '保留会话', [{ scope: 'assistant', text: 'PERSIST_MARKER' }]));
  index.replaceSource(source('drop', 'claude', '删除会话', [{ scope: 'assistant', text: 'DROP_MARKER' }]));
  index.close();

  index = new SqliteSessionSearchIndex(dbPath);
  assert.equal(index.search({ query: 'PERSIST_MARKER' }).totalSessions, 1);
  index.pruneSources(new Set(['keep']));
  assert.equal(index.search({ query: 'DROP_MARKER' }).totalSessions, 0);
  assert.deepStrictEqual([...index.getSourceSignatures().keys()], ['keep']);
});

test('a corrupt cache is quarantined and rebuilt instead of permanently breaking search', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-sqlite-corrupt-'));
  const dbPath = path.join(root, 'search.sqlite');
  fs.writeFileSync(dbPath, 'this is not a sqlite database', 'utf8');
  const index = new SqliteSessionSearchIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.equal(index.getStats().recoveredCorruptDatabase, true);
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('search.sqlite.corrupt-')), true);
  index.replaceSource(source('rebuilt', 'codex', '重建成功', [{ scope: 'assistant', text: 'REBUILT_MARKER' }]));
  assert.equal(index.search({ query: 'REBUILT_MARKER' }).totalSessions, 1);
});

test('duplicate transcript event ids keep the first record without discarding the whole source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-sqlite-duplicate-'));
  const index = new SqliteSessionSearchIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const duplicated = source('duplicate', 'codex', '重复事件', [
    { id: 'same-event', scope: 'assistant', text: 'FIRST_DUPLICATE_MARKER' },
    { id: 'same-event', scope: 'assistant', text: 'SECOND_DUPLICATE_MARKER' },
  ]);
  assert.doesNotThrow(() => index.replaceSource(duplicated));
  assert.equal(index.search({ query: 'FIRST_DUPLICATE_MARKER' }).totalSessions, 1);
  assert.equal(index.search({ query: 'SECOND_DUPLICATE_MARKER' }).totalSessions, 0);
});
