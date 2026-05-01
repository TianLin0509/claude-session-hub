'use strict';
// pilot-mode Task 4（2026-05-01）— pilot-recap-builder 单测：
//   1. splitByTurn 每轮一段 + 标题取用户问题前 30 字
//   2. splitBySmart 按 LLM 给的目录切；目录为空回落到 splitByTurn
//   3. splitBySmart 段数上限 10 + 下限不超过 turn 数
//   4. build 写 md 文件 + 把 mdLineStart/mdLineEnd 回填到 segments
//   5. rebuildMd 与 build 同结果（接口对称）

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const builder = require('../core/pilot-recap-builder.js');

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log(`  ✓ ${name}`),
                    e => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Running pilot-recap-builder tests...');

(async () => {
  test('splitByTurn — each turn one segment with Q-prefix title', () => {
    const turns = [
      { ts: 1, userInput: '美股科技股怎么看？', response: 'A1' },
      { ts: 2, userInput: '我重点关注 AI 半导体', response: 'A2' },
    ];
    const segs = builder.splitByTurn(turns);
    assert.strictEqual(segs.length, 2);
    assert.match(segs[0].title, /^Q: 美股科技股怎么看/);
    assert.deepStrictEqual(segs[0].turnRange, [0, 1]);
    assert.deepStrictEqual(segs[1].turnRange, [1, 2]);
    assert.strictEqual(segs[0].mode, 'turn');
  });

  test('splitByTurn — empty input returns []', () => {
    assert.deepStrictEqual(builder.splitByTurn([]), []);
    assert.deepStrictEqual(builder.splitByTurn(null), []);
  });

  test('_shortTitleForTurn falls back to AI answer when user input too short', () => {
    const t = { userInput: 'ok', response: '建议买入 NVDA AVGO 三家美股 AI 半导体' };
    const title = builder._shortTitleForTurn(t);
    assert.match(title, /Q: ok · A:/);
    assert.match(title, /建议买入/);
  });

  test('splitBySmart — uses LLM titles, evenly distributes turns', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ ts: i, userInput: `Q${i + 1}`, response: `A${i + 1}` }));
    const titles = ['市场宏观', '半导体', '电池'];
    const segs = builder.splitBySmart(turns, titles);
    assert.strictEqual(segs.length, 3);
    assert.strictEqual(segs[0].title, '市场宏观');
    assert.deepStrictEqual(segs[0].turnRange, [0, 2]);
    assert.deepStrictEqual(segs[2].turnRange, [4, 6]);
    assert.ok(segs.every(s => s.mode === 'smart'));
  });

  test('splitBySmart — empty titles falls back to splitByTurn', () => {
    const turns = [{ ts: 1, userInput: 'q', response: 'a' }];
    const segs = builder.splitBySmart(turns, []);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].mode, 'turn');
  });

  test('splitBySmart — caps segments at 10', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ ts: i, userInput: `q${i}`, response: `a${i}` }));
    const titles = Array.from({ length: 15 }, (_, i) => `topic${i}`);
    const segs = builder.splitBySmart(turns, titles);
    assert.ok(segs.length <= 10);
    // 覆盖完整 turn 范围
    const lastSeg = segs[segs.length - 1];
    assert.strictEqual(lastSeg.turnRange[1], 30, 'last segment must cover up to 30 turns');
  });

  test('splitBySmart — caps N at turns.length when fewer turns than titles', () => {
    const turns = [
      { ts: 1, userInput: 'q1', response: 'a1' },
      { ts: 2, userInput: 'q2', response: 'a2' },
    ];
    const titles = ['t1', 't2', 't3', 't4'];
    const segs = builder.splitBySmart(turns, titles);
    assert.ok(segs.length <= 2, 'N cannot exceed turns.length');
  });

  await test('build — writes md + backfills mdLineStart/End on segments', async () => {
    const turns = [
      { ts: Date.parse('2026-05-01T10:00:00Z'), userInput: '问题1', response: '答案1' },
      { ts: Date.parse('2026-05-01T10:01:00Z'), userInput: '问题2', response: '答案2' },
    ];
    const segs = builder.splitByTurn(turns);
    const tmp = path.join(os.tmpdir(), `pilot-recap-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    await builder.build(tmp, turns, segs, { pilotKind: 'claude', pilotSlot: 0 });
    const md = fs.readFileSync(tmp, 'utf8');
    assert.match(md, /主驾期会话历史 · Slot 1 \(claude\)/);
    assert.match(md, /## 段落 1 ·/);
    assert.match(md, /\*\*用户\*\*: 问题1/);
    assert.match(md, /\*\*claude\*\*: 答案1/);
    // 行号回填
    assert.ok(segs[0].mdLineStart > 0);
    assert.ok(segs[0].mdLineEnd >= segs[0].mdLineStart);
    assert.ok(segs[1].mdLineStart > segs[0].mdLineEnd);
    // 验证：从 mdLineStart 读到 mdLineEnd 应包含 segment 1 的内容
    const allLines = md.split('\n');
    const seg1Lines = allLines.slice(segs[0].mdLineStart - 1, segs[0].mdLineEnd).join('\n');
    assert.match(seg1Lines, /第 1 轮/);
    assert.match(seg1Lines, /<!-- segment 1 start -->/);
    fs.unlinkSync(tmp);
  });

  await test('rebuildMd — same as build (used for A/B mode switch)', async () => {
    const turns = [{ ts: 1, userInput: 'q', response: 'a' }];
    const segs1 = builder.splitByTurn(turns);
    const tmp1 = path.join(os.tmpdir(), `recap1-${Date.now()}.md`);
    const tmp2 = path.join(os.tmpdir(), `recap2-${Date.now()}.md`);
    await builder.build(tmp1, turns, segs1, { pilotKind: 'codex', pilotSlot: 1 });
    const segs2 = builder.splitByTurn(turns);
    await builder.rebuildMd(tmp2, turns, segs2, { pilotKind: 'codex', pilotSlot: 1 });
    assert.strictEqual(fs.readFileSync(tmp1, 'utf8'), fs.readFileSync(tmp2, 'utf8'));
    fs.unlinkSync(tmp1);
    fs.unlinkSync(tmp2);
  });

  console.log('All passed.');
})();
