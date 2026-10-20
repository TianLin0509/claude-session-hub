'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const python = process.env.CLAUDE_HUB_PPT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonReady = spawnSync(python, ['-c', 'import sqlite3;sqlite3.connect(":memory:").execute("create virtual table t using fts5(x)")'], { windowsHide: true }).status === 0;

test('PPT：真实 SQLite 查询与读页保留完整正文；读后索引字节不变，拒绝 organize 和过期引用', { skip: !pythonReady ? '需要 Python 3 + SQLite FTS5' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ppt-'));
  const built = spawnSync(python, [path.join(__dirname, 'fixtures/company-ppt-index.py'), dir], { windowsHide: true, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const db = JSON.parse(built.stdout).db;
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  const before = digest(), a = { dir, now: Date.now, changed() {}, settings: () => ({ ppt: { db, python } }) }, ppt = new PptLibrary(a);
  const status = await ppt.refresh();
  assert.equal(status.available, true); assert.equal(status.files, 1); assert.equal(status.pages, 3);
  const found = await ppt.execute('search', { query: 'SRS 信道估计' });
  assert.equal(found.candidates.length, 1); assert.equal(found.candidates[0].ref.page, 1);
  const read = await ppt.execute('read', { ids: ['1:2'] });
  assert.ok(read.pages[0].text.endsWith('完整页尾标记')); assert.equal(read.pages[0].text_truncated, false);
  assert.equal(read.pages[0].ref.path, path.join(dir, '20261020-SRS素材样例.pptx'));
  const cat = await ppt.execute('catalog', { limit: 1 }); assert.equal(cat.items.length, 1);
  await assert.rejects(ppt.execute('organize', {}), /不能移动/);
  await assert.rejects(ppt.execute('read', { refs: [{ ...found.candidates[0].ref, page_hash: 'changed' }] }), /已变化/);
  assert.equal(digest(), before, '查询和失败路径都不得改索引');
});

test('PPT：没有索引和 Python 启动失败不会伪装成空素材库', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ppt-missing-'));
  const a = { dir, now: Date.now, changed() {}, settings: () => ({ ppt: { db: path.join(dir, 'missing.db') } }) };
  const ppt = new PptLibrary(a);
  assert.equal((await ppt.refresh()).available, false);
  await assert.rejects(ppt.execute('search', { query: 'SRS' }), /索引|Python/);
});
