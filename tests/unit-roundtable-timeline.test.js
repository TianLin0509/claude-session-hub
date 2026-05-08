'use strict';
// 单元测试 core/roundtable-timeline.js — 方案 F · timeline.md 自动维护
//
// 覆盖场景：
//   1. ensureFile 创建目录 + 写头部（cwd 下）
//   2. ensureFile 路径 fallback 到 hubDataDir
//   3. writeTurn 多轮 append 顺序正确
//   4. 普通轮 vs 摘要轮 标题格式区分
//   5. byStatus 标注（absent/errored/manual_extracted）
//   6. 滚动：12 普通 + 2 摘要 → 主文件保留 10 普通 + 2 摘要 + archive 有 2 普通
//   7. 摘要轮永不滚出 + 摘要在滚动后位置保持

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tl = require('../core/roundtable-timeline');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'tl-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeTurn(n, mode, by, opts = {}) {
  return {
    n,
    mode,
    userInput: opts.userInput || `用户输入 ${n}`,
    by: by || {},
    byStatus: opts.byStatus || null,
    timestamp: opts.timestamp || (Date.now() + n * 1000),
    dispatchMode: opts.dispatchMode || 'all',
    summarizers: opts.summarizers || null,
  };
}

function sidLabelFn(sid) {
  const map = { sid_a: 'Claude', sid_b: 'Gemini', sid_c: 'Codex' };
  return map[sid] || sid;
}

// === 1 ensureFile：cwd 下创建 .arena/timeline-XXX.md + 写头部 ===
function testEnsureFileInCwd() {
  const cwd = tmpDir();
  const hubData = tmpDir();
  const mid = 'm-001';
  const fp = tl.ensureFile(mid, cwd, hubData, '通用圆桌');
  assert.strictEqual(fp, path.join(cwd, '.arena', `timeline-${mid}.md`),
    'should be in cwd/.arena/');
  assert.ok(fs.existsSync(fp), 'file created');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content.startsWith(`# Roundtable Timeline · ${mid}`), 'has title');
  assert.ok(content.includes('场景：通用圆桌'), 'has scene');
  assert.ok(content.includes('滚动策略'), 'has roll policy note');
  assert.ok(content.includes('---'), 'has separator');
  console.log('  ✓ testEnsureFileInCwd');
}

// === 2 ensureFile：无 cwd 退到 hubDataDir/timelines/ ===
function testEnsureFileFallbackToHubData() {
  const hubData = tmpDir();
  const mid = 'm-002';
  // projectCwd 为 null → 走 hubData fallback
  const fp = tl.ensureFile(mid, null, hubData, '投研圆桌');
  assert.strictEqual(fp, path.join(hubData, 'timelines', `timeline-${mid}.md`),
    'should be in hubData/timelines/');
  assert.ok(fs.existsSync(fp), 'file created in fallback location');
  console.log('  ✓ testEnsureFileFallbackToHubData');
}

// === 3 writeTurn 多轮 append 顺序正确 ===
function testWriteTurnSequential() {
  const cwd = tmpDir();
  const hubData = tmpDir();
  const mid = 'm-seq';
  for (let i = 1; i <= 3; i++) {
    tl.writeTurn(mid, makeTurn(i, 'fanout', { sid_a: `Claude 第${i}轮`, sid_b: `Gemini 第${i}轮` }),
      '通用圆桌', cwd, hubData, sidLabelFn);
  }
  const content = tl.readFull(mid, cwd, hubData);
  // 三轮标题都在
  assert.ok(content.includes('## 第 1 轮 · fanout · all'), 'turn 1');
  assert.ok(content.includes('## 第 2 轮 · fanout · all'), 'turn 2');
  assert.ok(content.includes('## 第 3 轮 · fanout · all'), 'turn 3');
  // 顺序正确
  const i1 = content.indexOf('## 第 1 轮');
  const i2 = content.indexOf('## 第 2 轮');
  const i3 = content.indexOf('## 第 3 轮');
  assert.ok(i1 < i2 && i2 < i3, 'turns in order');
  // 内容含 AI 标签 + 全文
  assert.ok(content.includes('### Claude'), 'has Claude label');
  assert.ok(content.includes('Claude 第1轮'), 'has Claude turn 1 text');
  console.log('  ✓ testWriteTurnSequential');
}

// 摘要功能 2026-05-08 整体下线：原 testSummaryTurnTitle 已删
// （_renderTurnSection 不再特殊处理 mode='summary-brief'，新 turnRecord 仅 fanout/debate）

// === 5 byStatus 各种状态标注 ===
function testByStatusLabels() {
  const cwd = tmpDir();
  const mid = 'm-status';
  tl.writeTurn(mid, makeTurn(1, 'fanout',
    { sid_a: 'OK 文本', sid_b: '', sid_c: 'extracted text' },
    { byStatus: { sid_a: 'completed', sid_b: 'absent', sid_c: 'manual_extracted' } }),
    '通用圆桌', cwd, null, sidLabelFn);
  const content = tl.readFull(mid, cwd, null);
  assert.ok(content.includes('### Claude\n'), 'completed: clean header');
  assert.ok(content.includes('### Gemini（本轮未参与）'), 'absent label');
  assert.ok(content.includes('### Codex（手动提取）'), 'manual_extracted label');
  // 也测 errored
  tl.writeTurn(mid, makeTurn(2, 'fanout',
    { sid_a: '' }, { byStatus: { sid_a: 'errored' } }),
    '通用圆桌', cwd, null, sidLabelFn);
  const content2 = tl.readFull(mid, cwd, null);
  assert.ok(content2.includes('### Claude（本轮错误）'), 'errored label');
  console.log('  ✓ testByStatusLabels');
}

// === 6 滚动：12 fanout/debate → 主文件保留 10 个最近 + archive 2 个最早 ===
//   摘要功能 2026-05-08 整体下线：原 12 普通 + 2 摘要 测试场景已简化为纯 fanout
//   _parseTurnSections 仍按 isSummary 解析历史 timeline 中的 summary 行（向后兼容）
function testRollingArchive() {
  const cwd = tmpDir();
  const mid = 'm-roll';

  for (let n = 1; n <= 12; n++) {
    tl.writeTurn(mid, makeTurn(n, 'fanout', { sid_a: `txt-${n}` }), '通用圆桌', cwd, null, sidLabelFn);
  }

  const main = tl.readFull(mid, cwd, null);
  const sections = tl._parseTurnSections(main);
  assert.ok(sections, 'should have parsed sections');
  const ns = sections.turns.filter(t => !t.isSummary);
  assert.strictEqual(ns.length, 10, `main file should have 10 turns, got ${ns.length}`);
  // 轮号最小的应该是 3（不是 1 / 2）
  const turnNs = ns.map(t => t.n).sort((a, b) => a - b);
  assert.strictEqual(turnNs[0], 3, `oldest should be turn 3, got ${turnNs[0]}`);

  // archive 应该含轮 1, 2
  const archivePath = tl.getArchivePath(tl.getTimelinePath(mid, cwd, null));
  assert.ok(fs.existsSync(archivePath), 'archive file created');
  const archiveContent = fs.readFileSync(archivePath, 'utf-8');
  assert.ok(archiveContent.includes('## 第 1 轮'), 'archive has turn 1');
  assert.ok(archiveContent.includes('## 第 2 轮'), 'archive has turn 2');
  assert.ok(!archiveContent.includes('## 第 3 轮'), 'archive should NOT have turn 3');

  console.log('  ✓ testRollingArchive');
}

// 摘要功能 2026-05-08 整体下线：原 testSummaryNeverArchived 已删
// （新 turn 不再产生 summary-brief 模式；_parseTurnSections 仍能解析旧 timeline 文件中的摘要行）

// === 8 _parseTurnSections 解析正确 ===
function testParseTurnSections() {
  const sample = `# Roundtable Timeline · m-x

> 头部信息
---

## 第 1 轮 · fanout · all
- 时间：T1

### Claude
hello

## 第 2 轮 · 摘要 by Claude（五元组）
- 时间：T2

### Claude
sum
`;
  const parsed = tl._parseTurnSections(sample);
  assert.ok(parsed, 'parsed not null');
  assert.strictEqual(parsed.turns.length, 2, '2 turns');
  assert.strictEqual(parsed.turns[0].n, 1);
  assert.strictEqual(parsed.turns[0].isSummary, false);
  assert.strictEqual(parsed.turns[1].n, 2);
  assert.strictEqual(parsed.turns[1].isSummary, true, 'summary turn flagged');
  assert.ok(parsed.header.includes('# Roundtable Timeline'), 'header captured');
  console.log('  ✓ testParseTurnSections');
}

console.log('Running roundtable-timeline unit tests...');
let failed = 0;
const tests = [
  testEnsureFileInCwd,
  testEnsureFileFallbackToHubData,
  testWriteTurnSequential,
  testByStatusLabels,
  testRollingArchive,
  testParseTurnSections,
];
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    if (e.stack) console.error('    ', e.stack.split('\n').slice(1, 4).join('\n     '));
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
