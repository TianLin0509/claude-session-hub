// tests/roundtable-memory.test.js
// 阶段 0 unit test for core/roundtable-memory/store.js
// Phase 4（2026-05-08）：identity 现在是家族级（claude/gpt/...），makeIdentity 内部走 canonicalAiKind
// Phase 3 历史（2026-05-07）：identity = aiKind+model 派生，phase 4 已退化为家族级
// 覆盖 append/dedup/parse/search/list + 边界 + identity helper。

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const store = require('../core/roundtable-memory/store.js');

const PROJECT_CWD = TEMP;
const SCENE = 'general';
// Phase 4：测试常量 IDENTITY 改为家族字符串。store API 仍接受任意 [a-z0-9_-]+ identity 字符串
//   作为存储 key（用于直接调用），但 makeIdentity 派生时强制 canonical 到家族。
const IDENTITY = 'claude';

(async () => {
  // ---------------------------------------------------------------------
  // T1: append create
  // ---------------------------------------------------------------------
  const r1 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    kind: 'preference', key: 'conclusion-first',
    content: '用户喜欢结论先行', source: 'self',
  });
  assert.strictEqual(r1.ok, true, 'append create ok');
  assert.strictEqual(r1.action, 'create', 'first append → create');
  assert.ok(fs.existsSync(r1.file), 'memory file created');
  const fp = r1.file;
  const text1 = fs.readFileSync(fp, 'utf-8');
  assert.ok(text1.includes('preference:conclusion-first'));
  assert.ok(text1.includes('[scope: scene]'));
  assert.ok(text1.includes('[source: self]'));
  assert.ok(text1.includes('用户喜欢结论先行'));
  console.log('PASS T1 append create');

  // T2: append second different key
  const r2 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    kind: 'observation', key: 'risk-averse',
    content: '用户决策时重视下行风险', source: 'self',
  });
  assert.strictEqual(r2.action, 'create');
  const list2 = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY });
  assert.strictEqual(list2.results.length, 2, 'two entries');
  assert.strictEqual(list2.results[0].key, 'preference:conclusion-first');
  assert.strictEqual(list2.results[1].key, 'observation:risk-averse');
  console.log('PASS T2 append second key');

  // T3: dedup
  const r3 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    kind: 'preference', key: 'conclusion-first',
    content: '用户喜欢结论先行（多次确认）', source: 'self',
  });
  assert.strictEqual(r3.action, 'update');
  assert.strictEqual(r3.entry.recall, 1);
  const list3 = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY });
  assert.strictEqual(list3.results.length, 2);
  const updated = list3.results.find(e => e.key === 'preference:conclusion-first');
  assert.strictEqual(updated.recall, 1);
  assert.ok(updated.content.includes('多次确认'));
  console.log('PASS T3 dedup same key');

  // T4: parse round-trip
  const sample = {
    date: '2026-05-06', scope: 'scene', source: 'explicit',
    recall: 5, last: '2026-05-04',
    key: 'fact:main-language', content: 'Python 是用户主语言',
  };
  const headerLine = store.renderHeader(sample);
  const parsed = store.parseEntry(headerLine, sample.content);
  assert.strictEqual(parsed.date, sample.date);
  assert.strictEqual(parsed.scope, sample.scope);
  assert.strictEqual(parsed.source, sample.source);
  assert.strictEqual(parsed.recall, sample.recall);
  assert.strictEqual(parsed.last, sample.last);
  assert.strictEqual(parsed.key, sample.key);
  assert.strictEqual(parsed.content, sample.content);
  console.log('PASS T4 render/parse round-trip');

  // T5: search hit + bump recall
  const before = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY })
    .results.find(e => e.key === 'preference:conclusion-first').recall;
  const sr = store.searchMemory({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    query: '结论', limit: 5,
  });
  assert.strictEqual(sr.ok, true);
  assert.strictEqual(sr.results.length, 1);
  assert.strictEqual(sr.results[0].key, 'preference:conclusion-first');
  const after = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY })
    .results.find(e => e.key === 'preference:conclusion-first').recall;
  assert.strictEqual(after, before + 1);
  console.log('PASS T5 search hit + bump recall');

  // T6: search miss
  const sr2 = store.searchMemory({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    query: 'this-string-definitely-not-in-memory-xxx',
  });
  assert.strictEqual(sr2.ok, true);
  assert.strictEqual(sr2.results.length, 0);
  console.log('PASS T6 search miss');

  // T7: list filter by kind
  const onlyPref = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'preference' });
  assert.strictEqual(onlyPref.results.length, 1);
  assert.strictEqual(onlyPref.results[0].key, 'preference:conclusion-first');
  const onlyObs = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'observation' });
  assert.strictEqual(onlyObs.results.length, 1);
  console.log('PASS T7 list filter by kind');

  // T8: edge cases
  const e1 = store.appendMemoryEntry({ scene: SCENE, identity: IDENTITY, kind: 'preference', key: 'a', content: 'x' });
  assert.strictEqual(e1.ok, false);
  assert.match(e1.error, /projectCwd/);
  const e2 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'bogus', key: 'a', content: 'x' });
  assert.strictEqual(e2.ok, false);
  assert.match(e2.error, /invalid kind/);
  const e3 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'preference', key: 'a', content: 'x', source: 'invalid' });
  assert.strictEqual(e3.ok, false);
  assert.match(e3.error, /invalid source/);
  const e4 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'preference', key: '', content: 'x' });
  assert.strictEqual(e4.ok, false);
  assert.match(e4.error, /key/);
  const e5 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'preference', key: 'k', content: '   ' });
  assert.strictEqual(e5.ok, false);
  assert.match(e5.error, /content/);
  const e6 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY, kind: 'preference', key: 'k', content: 'c', scope: 'cross' });
  assert.strictEqual(e6.ok, false);
  assert.match(e6.error, /scope/);
  // Phase 3：identity 校验
  const e7 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: '../etc/passwd', kind: 'preference', key: 'k', content: 'c' });
  assert.strictEqual(e7.ok, false);
  assert.match(e7.error, /invalid identity/);
  const e8 = store.appendMemoryEntry({ projectCwd: PROJECT_CWD, scene: SCENE, identity: '_profile', kind: 'preference', key: 'k', content: 'c' });
  assert.strictEqual(e8.ok, false);
  assert.match(e8.error, /invalid identity/);
  console.log('PASS T8 edge cases');

  // T9: scope='scene' explicit
  const r9 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: IDENTITY,
    kind: 'fact', key: 'main-lang', content: 'Python', scope: 'scene', source: 'explicit',
  });
  assert.strictEqual(r9.ok, true);
  assert.strictEqual(r9.action, 'create');
  console.log('PASS T9 scope=scene explicit');

  // T10: per-family isolation —— claude vs gemini 家族互不干扰（Phase 4 核心）
  //   IDENTITY='claude' 已写 3 条；新写 'gemini' 1 条；验证两家族 .md 独立
  const r10 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: SCENE, identity: 'gemini',
    kind: 'preference', key: 'no-mock', content: '不要 mock 数据库', source: 'self',
  });
  assert.strictEqual(r10.ok, true);
  const claudeFam = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: 'claude' });
  const geminiFam = store.listMemory({ projectCwd: PROJECT_CWD, scene: SCENE, identity: 'gemini' });
  assert.strictEqual(claudeFam.results.length, 3, 'claude family has 3 entries');
  assert.strictEqual(geminiFam.results.length, 1, 'gemini family has 1 entry');
  assert.notStrictEqual(
    store.memoryFile(PROJECT_CWD, SCENE, 'claude'),
    store.memoryFile(PROJECT_CWD, SCENE, 'gemini'),
  );
  console.log('PASS T10 per-family isolation');

  // T11: per-scene isolation
  const r11 = store.appendMemoryEntry({
    projectCwd: PROJECT_CWD, scene: 'research', identity: IDENTITY,
    kind: 'fact', key: 'data-source', content: '5 层兜底数据源', source: 'self',
  });
  assert.strictEqual(r11.ok, true);
  const generalOpus = store.listMemory({ projectCwd: PROJECT_CWD, scene: 'general', identity: IDENTITY });
  const researchOpus = store.listMemory({ projectCwd: PROJECT_CWD, scene: 'research', identity: IDENTITY });
  assert.strictEqual(generalOpus.results.length, 3);
  assert.strictEqual(researchOpus.results.length, 1);
  assert.ok(r11.file.includes('rooms' + path.sep + 'research'));
  console.log('PASS T11 per-scene isolation');

  // T12（Phase 4）: makeIdentity 走家族 canonical（model 仅日志，不影响 identity）
  assert.strictEqual(store.makeIdentity('claude', 'claude-opus-4-7'), 'claude', 'opus 4.7 → claude family');
  assert.strictEqual(store.makeIdentity('claude', 'claude-sonnet-4-6'), 'claude', 'sonnet 4.6 → claude family（家族共享）');
  assert.strictEqual(store.makeIdentity('gemini', 'gemini-3-pro'), 'gemini');
  assert.strictEqual(store.makeIdentity('codex', 'gpt-5.2-codex'), 'gpt', 'codex canonical → gpt family');
  assert.strictEqual(store.makeIdentity('gpt', 'gpt-5.5'), 'gpt', 'packy-gpt → gpt family');
  assert.strictEqual(store.makeIdentity('claude-resume', null), 'claude', 'resume → claude');
  assert.strictEqual(store.makeIdentity('claude', null), 'claude');
  assert.strictEqual(store.makeIdentity('CLAUDE', 'Claude Opus 4.7'), 'claude', 'sanitize lowercase + canonical');
  assert.strictEqual(store.makeIdentity(null, null), 'unknown');
  // [Phase 4 三路评审防御] caller 误传带 model 后缀的 aiKind 时，前缀提取兜底到家族
  assert.strictEqual(store.makeIdentity('gemini-2.0-flash', null), 'gemini', 'family prefix extraction');
  assert.strictEqual(store.makeIdentity('claude-3-5-sonnet', null), 'claude', 'family prefix extraction');
  assert.strictEqual(store.makeIdentity('mistral', null), 'mistral', 'unknown family stays as-is (warn already)');
  console.log('PASS T12 makeIdentity (Phase 4 family canonical + 前缀提取防御)');

  // T13（Phase 3）: isValidIdentity guards
  assert.strictEqual(store.isValidIdentity('claude-opus-4-7'), true);
  assert.strictEqual(store.isValidIdentity('_profile'), false, 'reject _profile');
  assert.strictEqual(store.isValidIdentity('pending-foo'), false, 'reject pending-*');
  assert.strictEqual(store.isValidIdentity('../etc'), false, 'reject path traversal');
  assert.strictEqual(store.isValidIdentity(''), false);
  assert.strictEqual(store.isValidIdentity('A'.repeat(100)), false, 'reject too long');
  console.log('PASS T13 isValidIdentity (Phase 3)');

  // T14（Phase 4）: listAllIdentities scans memDir, excludes _profile
  //   现在 memDir 下应该有 claude.md 和 gemini.md（前面 T1-T11 创建）
  const memDir = path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, 'memory');
  fs.writeFileSync(path.join(memDir, '_profile.md'), '# profile\n', 'utf-8');
  fs.writeFileSync(path.join(memDir, 'pending-claude.json'), '{"items":[]}', 'utf-8');
  const ids = store.listAllIdentities(PROJECT_CWD, SCENE);
  assert.ok(ids.includes('claude'), 'has claude family');
  assert.ok(ids.includes('gemini'), 'has gemini family');
  assert.ok(!ids.includes('_profile'), 'excludes _profile');
  console.log('PASS T14 listAllIdentities (Phase 4 family-named)');

  console.log('\nALL PASS · roundtable-memory.test.js');
  console.log('temp dir:', TEMP);
})().catch((e) => {
  console.error('FAIL:', e.stack || e);
  process.exit(1);
});
