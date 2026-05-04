'use strict';
// Phase 3 B3.4-B3.6 — codex fresh+ctx instructions 注入路径单测

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildContextInstructions,
  writeContextInstructionsFile,
  DEFAULT_MAX_TURNS,
} = require('../core/codex-fresh-context');

let failed = 0;

// 简易 fake orchestrator
function _fakeOrch(turns) {
  return {
    getState() {
      return { turns: Array.isArray(turns) ? turns : [] };
    },
  };
}

// === case 1: 无任何 turn → 空字符串 ===
function testEmptyTurnsReturnsEmpty() {
  const orch = _fakeOrch([]);
  const text = buildContextInstructions(orch);
  assert.strictEqual(text, '', 'empty turns must return empty string');
}

// === case 2: 1 轮 fanout（无 summary 轮）→ 用 fanout 兜底 ===
function testFallbackToFanoutWhenNoSummaryTurn() {
  const orch = _fakeOrch([
    {
      n: 1, mode: 'fanout',
      userInput: 'why is the sky blue',
      by: {
        'sid-aaaaaaaa-1': 'Rayleigh scattering filters out red wavelengths preferentially.',
        'sid-bbbbbbbb-2': 'Short wavelengths scatter more in atmosphere.',
      },
    },
  ]);
  const text = buildContextInstructions(orch);
  assert.ok(text.length > 0, 'must return non-empty text');
  assert.ok(text.includes('Turn 1'), 'must include turn number');
  assert.ok(text.includes('mode=fanout'), 'must include mode');
  assert.ok(text.includes('Rayleigh scattering'), 'must include AI text');
  assert.ok(text.includes('AI(sid-aaaa'), 'must label AI by short sid');
}

// === case 3: 3 轮 summary → 全部纳入（按预算截断单家）===
function testThreeSummariesAllIncluded() {
  const turns = [];
  for (let i = 1; i <= 3; i++) {
    turns.push({
      n: i, mode: 'summary',
      userInput: `Question round ${i}`,
      by: {
        [`sid-${i}-aaaa`]: `Summary round ${i}: detailed answer here. `.repeat(20),  // 长文本测截断
      },
    });
  }
  const orch = _fakeOrch(turns);
  const text = buildContextInstructions(orch, { perAiBudget: 100 });
  assert.ok(text.includes('Turn 1'), 'turn 1 included');
  assert.ok(text.includes('Turn 2'), 'turn 2 included');
  assert.ok(text.includes('Turn 3'), 'turn 3 included');
  assert.ok(text.includes('truncated'), 'long text must show truncation marker');
  // 每轮 by[sid] 长度被截到 ≤100
  const aiSection = text.split('Turn 1')[1].split('Turn 2')[0];
  // aiSection 含 perAiBudget 截断 + truncated 提示，长度可控
  assert.ok(aiSection.length < 500, 'each turn section bounded by budget');
}

// === case 4: 6 轮 summary → 取最近 3 ===
function testTakesMostRecentNSummaries() {
  const turns = [];
  for (let i = 1; i <= 6; i++) {
    turns.push({
      n: i, mode: 'summary',
      userInput: `Q ${i}`,
      by: { [`sid-${i}-x`]: `Answer ${i}` },
    });
  }
  const orch = _fakeOrch(turns);
  const text = buildContextInstructions(orch, { maxTurns: 3 });
  // 取最近 3 = turns 4, 5, 6
  assert.ok(!text.includes('Answer 1'));
  assert.ok(!text.includes('Answer 2'));
  assert.ok(!text.includes('Answer 3'));
  assert.ok(text.includes('Answer 4'));
  assert.ok(text.includes('Answer 5'));
  assert.ok(text.includes('Answer 6'));
}

// === case 5: 混合 fanout + summary，summary 不足时用全部 ===
function testMixedTurnsFallbackUsesAllRecent() {
  const turns = [
    { n: 1, mode: 'fanout', userInput: 'q1', by: { 'sid-A': 'fanout-A' } },
    { n: 2, mode: 'summary', userInput: 'q2', by: { 'sid-B': 'summary-B' } },
    { n: 3, mode: 'fanout', userInput: 'q3', by: { 'sid-C': 'fanout-C' } },
  ];
  const orch = _fakeOrch(turns);
  // maxTurns=3 但只有 1 个 summary 轮 → 用最近 3 全部
  const text = buildContextInstructions(orch, { maxTurns: 3 });
  assert.ok(text.includes('fanout-A'), 'fanout turn 1 included via fallback');
  assert.ok(text.includes('summary-B'), 'summary turn 2 included');
  assert.ok(text.includes('fanout-C'), 'fanout turn 3 included');
}

// === case 6: includeUserInput=false 时不含用户输入 ===
function testIncludeUserInputFalseSkipsUserInput() {
  const orch = _fakeOrch([
    { n: 1, mode: 'summary', userInput: 'SECRET QUESTION', by: { 'sid-A': 'answer' } },
  ]);
  const text = buildContextInstructions(orch, { includeUserInput: false });
  assert.ok(!text.includes('SECRET QUESTION'), 'userInput must not appear');
  assert.ok(text.includes('answer'), 'AI text still present');
}

// === case 7: sidLabelFn 自定义标签 ===
function testCustomSidLabelFn() {
  const orch = _fakeOrch([
    { n: 1, mode: 'summary', userInput: '', by: { 'sid-A': 'first', 'sid-B': 'second' } },
  ]);
  const text = buildContextInstructions(orch, {
    sidLabelFn: (sid) => sid === 'sid-A' ? '⚡ Pikachu' : (sid === 'sid-B' ? '🔥 Charmander' : null),
  });
  assert.ok(text.includes('⚡ Pikachu'));
  assert.ok(text.includes('🔥 Charmander'));
}

// === case 8: byMap 含空字符串/非 string → 跳过 ===
function testSkipsEmptyOrInvalidByEntries() {
  const orch = _fakeOrch([
    {
      n: 1, mode: 'summary',
      userInput: 'q', by: {
        'sid-empty': '',
        'sid-spaces': '   ',
        'sid-num': 12345,        // 非 string
        'sid-good': 'real text',
      },
    },
  ]);
  const text = buildContextInstructions(orch);
  assert.ok(text.includes('real text'));
  assert.ok(!text.includes('12345'));
  // 空字符串被 trim 跳过，不会 emit AI(sid-empty) section
  // （我们只能 indirect 验证：sid-empty 不该出现 truncation 之类）
}

// === case 9: writeContextInstructionsFile 落盘 + 内容正确 ===
async function testWriteContextInstructionsFile() {
  const tmpDir = path.join(os.tmpdir(), `codex-ctx-test-${Date.now()}`);
  const orch = _fakeOrch([
    { n: 1, mode: 'summary', userInput: 'q1', by: { 'sid-A': 'answer-1' } },
  ]);

  try {
    const fp = await writeContextInstructionsFile(orch, { outDir: tmpDir, meetingId: 'meet-1' });
    assert.ok(fp, 'must return path');
    assert.ok(fs.existsSync(fp), 'file must exist');
    const content = fs.readFileSync(fp, 'utf8');
    assert.ok(content.includes('answer-1'));
    assert.ok(content.includes('Turn 1'));
    assert.ok(path.basename(fp).startsWith('codex-ctx-meet-1-'));
    assert.ok(path.basename(fp).endsWith('.md'));
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

// === case 10: writeContextInstructionsFile 空历史 → null ===
async function testWriteFileEmptyOrchestratorReturnsNull() {
  const tmpDir = path.join(os.tmpdir(), `codex-ctx-test-empty-${Date.now()}`);
  const orch = _fakeOrch([]);
  try {
    const fp = await writeContextInstructionsFile(orch, { outDir: tmpDir });
    assert.strictEqual(fp, null, 'empty turns → null path');
    // outDir 不应被创建（我们 mkdir 在 buildContextInstructions 之后实际 write 之前）
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// === case 11: writeFile 缺少 outDir → throw ===
async function testWriteFileWithoutOutDirThrows() {
  let threw = null;
  try {
    await writeContextInstructionsFile(_fakeOrch([{ n: 1, mode: 'summary', userInput: '', by: { x: 'y' } }]), {});
  } catch (e) { threw = e; }
  assert.ok(threw, 'must throw without outDir');
  assert.ok(threw.message.includes('outDir'));
}

// === case 12: 默认 maxTurns 常量校验 ===
function testDefaultMaxTurnsConstant() {
  assert.strictEqual(DEFAULT_MAX_TURNS, 3, 'Spec S5 specifies N=3');
}

// === runner ===

const tests = [
  testEmptyTurnsReturnsEmpty,
  testFallbackToFanoutWhenNoSummaryTurn,
  testThreeSummariesAllIncluded,
  testTakesMostRecentNSummaries,
  testMixedTurnsFallbackUsesAllRecent,
  testIncludeUserInputFalseSkipsUserInput,
  testCustomSidLabelFn,
  testSkipsEmptyOrInvalidByEntries,
  testWriteContextInstructionsFile,
  testWriteFileEmptyOrchestratorReturnsNull,
  testWriteFileWithoutOutDirThrows,
  testDefaultMaxTurnsConstant,
];

(async () => {
  for (const t of tests) {
    try {
      const r = t();
      if (r && typeof r.then === 'function') await r;
      console.log('  ✓', t.name);
    } catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.stack || e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
