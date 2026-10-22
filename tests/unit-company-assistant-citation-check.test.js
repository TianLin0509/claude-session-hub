'use strict';
// Hub 自动核对回答里的出处（v3.1.2）：模型没走 ppt_library op=report 时，
// 回答里写的「文件名 + 第 N 页」由 Hub 按索引里的文稿和页数核对；只核对存在性，不判断内容。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { extractCitations, checkCitations, renderCitationCheck } = require('../core/company-assistant/citation-check');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const python = process.env.CLAUDE_HUB_PPT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonReady = spawnSync(python, ['-c', 'import sqlite3;sqlite3.connect(":memory:").execute("create virtual table t using fts5(x)")'], { windowsHide: true }).status === 0;

test('出处解析：同一行「文件名 + 第 N 页」才算引用；表格、加粗、路径、P 页码都能认，跨行不合并', () => {
  const text = [
    '| 20261020-SRS素材样例.pptx · 第 2 页 | 讲候选权重 |',
    '**另一个 20261020-干扰消除.pptx** 第 3 页有图',
    '- C:\\素材\\20261020-调度.pptx P12 讲调度',
    '20261020-跨行.pptx',
    '第 4 页',
  ].join('\n');
  const got = extractCitations(text).map(x => `${x.name}:${x.page}`);
  assert.deepEqual(got, ['20261020-SRS素材样例.pptx:2', '20261020-干扰消除.pptx:3', '20261020-调度.pptx:12'], '跨行的文件和页码不合并');
  assert.deepEqual(extractCitations('没有页码的文件名 20261020-X.pptx'), []);
  assert.deepEqual(extractCitations('第 2 页但没有文件名'), []);
});

test('核对：索引里有这份文稿且页数够算一致；文稿不在索引、页码超出页数分别报出来', () => {
  const docs = new Map([
    ['c:/p/20261020-srs素材样例.pptx', { name: '20261020-SRS素材样例.pptx', path: 'C:/P/20261020-SRS素材样例.pptx', pages: 3 }],
    ['c:/p/20261020-调度.pptx', { name: '20261020-调度.pptx', path: 'C:/P/20261020-调度.pptx', pages: 10 }],
  ]);
  const r = checkCitations([
    { name: '20261020-SRS素材样例.pptx', page: 2 },
    { name: '20261020-调度.pptx', page: 11 },
    { name: '20261020-不存在.pptx', page: 1 },
  ], docs);
  assert.equal(r.total, 3); assert.equal(r.verified, 1);
  assert.deepEqual(r.problems.map(p => `${p.name}:${p.reason}:${p.pageCount || ''}`), ['20261020-调度.pptx:out-of-range:10', '20261020-不存在.pptx:missing:']);
  const note = renderCitationCheck(r);
  assert.match(note, /引用了 3 页，其中 1 页和素材索引对得上/);
  assert.match(note, /20261020-调度\.pptx · 第 11 页：索引里这份文稿只有 10 页/);
  assert.match(note, /20261020-不存在\.pptx · 第 1 页：本次索引里没有这份文稿/);
  assert.match(note, /没有判断页面内容是否支持结论/);
  assert.equal(renderCitationCheck({ total: 0 }), '', '没有引用时一句都不加');
});

test('核对：回答里多写了前缀（编号、说明词）时按包含关系认出来；太短的名字不模糊匹配', () => {
  const docs = new Map([['c:/p/srs.pptx', { name: '20261020-SRS素材样例.pptx', path: 'C:/P/20261020-SRS素材样例.pptx', pages: 5 }]]);
  assert.equal(checkCitations([{ name: '20261020-SRS素材样例.pptx', page: 1 }], docs).verified, 1);
  assert.equal(checkCitations([{ name: '推荐20261020-SRS素材样例.pptx', page: 1 }], docs).verified, 1, '多写了前缀也能认');
  const short = new Map([['c:/p/a.pptx', { name: 'a.pptx', path: 'C:/P/a.pptx', pages: 5 }]]);
  assert.equal(checkCitations([{ name: 'ba.pptx', page: 1 }], short).problems[0].reason, 'missing', '短名字不做模糊匹配');
});

test('接入：索引状态里记下每份文稿的页数；回答里引用了存在的页和超出的页，Hub 自动加核对' , { skip: !pythonReady ? '需要 Python 3 + SQLite FTS5' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cite-'));
  const built = spawnSync(python, [path.join(__dirname, 'fixtures/company-ppt-index.py'), dir], { windowsHide: true, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const db = JSON.parse(built.stdout).db;
  const a = { dir, now: Date.now, changed() {}, settings: () => ({ ppt: { db, python } }) };
  const ppt = new PptLibrary(a);
  await ppt.refresh();
  const note = await ppt.citationNote('推荐 20261020-SRS素材样例.pptx · 第 2 页；另见 20261020-SRS素材样例.pptx 第 9 页');
  assert.match(note, /引用了 2 页，其中 1 页和素材索引对得上/);
  assert.match(note, /第 9 页：索引里这份文稿只有 3 页/);
  assert.equal(await ppt.citationNote('这页讲 SRS 信道估计。'), '', '没有具体出处就不加');
});

test('接入：没有索引时什么都不加，不把「核对不了」写成「引用有错」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cite-none-'));
  const a = { dir, now: Date.now, changed() {}, settings: () => ({ ppt: { db: path.join(dir, 'missing.db') } }) };
  const ppt = new PptLibrary(a);
  assert.equal(await ppt.citationNote('20261020-X.pptx 第 2 页'), '');
});
