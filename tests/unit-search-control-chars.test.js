'use strict';

// 2026-08-28：在真实生产索引（2.6GB / 3925 会话 / 335778 文档）上跑边缘用例时抓到的
// 最坏路径 —— 含 NUL 的查询词让 FTS5 抛错，而兜底的顺序扫描按 scopeList=null
// 扫了整张 docs 表（229MB），用了 **7339ms**。
//
// 两条修法：
//   1) 查询侧剔掉控制字符（它们不可能是有意义的检索内容）
//   2) FTS 被拒时的兜底扫描同样收窄到 title/user/assistant
// 修完同一个查询 421ms。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const DEL = String.fromCharCode(127);

function makeSource(key, title, docs) {
  return {
    key, signature: `sig-${key}`, searchable: true,
    session: {
      key, provider: 'codex', nativeFamily: 'codex', kind: 'codex', title,
      cwd: 'C:\\x', projectLabel: 'x', model: 'm', updatedAt: Date.now(),
      hubSessionId: `hub-${key}`, nativeSessionId: `n-${key}`, meetingId: null,
      transcriptPath: null, codexSessionsRoot: null, codexProfile: null, turnCount: docs.length,
    },
    docs: [
      { id: 'title', eventId: 'title', scope: 'title', role: 'title', text: title, ordinal: -1, timestamp: Date.now() },
      ...docs.map((d, i) => ({
        id: `${key}-${i}`, eventId: `${key}-${i}`, scope: d.scope, role: d.scope,
        speaker: '我', text: d.text, ordinal: i, timestamp: Date.now(),
      })),
    ],
  };
}

function freshIndex(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ctrl-'));
  const index = new SqliteSessionSearchIndex(path.join(root, 'x.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return index;
}

test('控制字符被剔掉，剩下的词照常匹配', (t) => {
  const index = freshIndex(t);
  index.replaceSource(makeSource('s1', '控制字符会话', [
    { scope: 'user', text: 'CTRLPROBE 正常内容' },
    { scope: 'tool', text: '工具里也有 CTRLPROBE' },
  ]));

  assert.equal(index.search({ query: `CTRLPROBE${NUL}` }).totalSessions, 1, '尾部 NUL 不该影响匹配');
  assert.equal(index.search({ query: `${NUL}CTRLPROBE` }).totalSessions, 1, '头部 NUL 不该影响匹配');
  assert.equal(index.search({ query: `CTRL${NUL}PROBE` }).totalSessions, 1,
    '中间的 NUL 剔掉后应当拼成 CTRLPROBE');
  assert.equal(index.search({ query: `CTRLPROBE${SOH}${DEL}` }).totalSessions, 1);
});

test('纯控制字符等价于空查询', (t) => {
  const index = freshIndex(t);
  index.replaceSource(makeSource('s1', '会话', [{ scope: 'user', text: '内容' }]));
  for (const q of [NUL, SOH, DEL, `${NUL}${SOH}${DEL}`]) {
    const r = index.search({ query: q });
    assert.equal(r.totalSessions, 0, `${JSON.stringify(q)} 应当返回空`);
    assert.deepEqual(r.results, []);
  }
});

test('制表符与换行仍然是分词空白，不能一起剔掉', (t) => {
  const index = freshIndex(t);
  index.replaceSource(makeSource('both', '两个词', [
    { scope: 'user', text: 'ALPHAA 出现在这里' },
    { scope: 'assistant', text: 'BETAA 出现在那里' },
  ]));
  assert.equal(index.search({ query: 'ALPHAA\tBETAA' }).totalSessions, 1, '制表符应当当作分隔符');
  assert.equal(index.search({ query: 'ALPHAA\nBETAA' }).totalSessions, 1, '换行同理');
});

test('FTS 被拒时的兜底扫描必须收窄 scope（否则就是整张 229MB 表）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-sqlite-index.js'), 'utf8');
  assert.match(src, /const fallbackScopes = scopeList \|\| \(ftsRejected \? SHORT_TERM_SCOPES : null\);/,
    'FTS 抛错后退回顺序扫描时，必须限制在短词那三档');
  assert.match(src, /ftsRejected = true;/, '要记下 FTS 是被拒了还是词太短');
});

test('正文里夹着 NUL 时不崩（FTS 会在 NUL 处截断，这是已知且不影响真实语料）', (t) => {
  const index = freshIndex(t);
  index.replaceSource(makeSource('s1', '带控制字符的正文', [
    { scope: 'user', text: `前${NUL}后 KEEPBODY` },
  ]));
  // 实测：本机真实索引 335778 条文档里**含 NUL 的是 0 条**，所以这只是退化输入的
  // 兜底。SQLite 的 FTS5 会把带内嵌 NUL 的文本在 NUL 处截断，NUL 之后的内容进不了
  // 倒排表 —— 因此这里只断言「不抛异常、不超时」，不断言一定能搜到。
  assert.doesNotThrow(() => index.search({ query: 'KEEPBODY' }));
  assert.doesNotThrow(() => index.search({ query: '前' }));
  assert.doesNotThrow(() => index.search({ query: '前后' }));
  // NUL 之前的内容仍然可以靠短词的顺序扫描找到
  assert.equal(index.search({ query: '前' }).totalSessions, 1, '短词走 instr，不受 FTS 截断影响');
});

console.log('unit-search-control-chars OK');
