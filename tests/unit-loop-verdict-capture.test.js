'use strict';
/**
 * 评审裁决取文本 —— 守住「代码合对了但引擎判失败」这个根因。
 *
 * 真实事故（2026-09-05 验收实测）：
 *   合并位跑完全套验证、给了 RESULT: PASS、代码也正确合入主干，
 *   但引擎当它「没给裁决」，保守判 fail，连烧三轮报 stopped_max。
 *
 * 根因：ClaudeTap 的 idle timer 在转录静默时提前 emit turn-complete
 *   （评审去跑测试/git 的那几分钟里转录本来就是静默的），
 *   watcher 拿当时那段开场白结算并 resolve，完整回答稍后才 patch 进转录 ——
 *   而引擎早已用短文本判完，还把下一步派给了工作位。
 *
 * 这支测试不依赖真实 CLI：用假 orchestrator 模拟「转录文本随时间变长」。
 */
const assert = require('assert');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');

let pass = 0;
function test(name, fn) { return fn().then(() => { pass++; console.log('  ✓ ' + name); }); }

const SID = 'sid-reviewer';
const TURN = 7;

/** 造一个 orchestrator，其转录文本按 script 给的时间线逐步变长。 */
function fakeEngine(script) {
  const t0 = Date.now();
  const getOrchestrator = () => ({
    getState: () => {
      const elapsed = Date.now() - t0;
      let text = '';
      for (const step of script) if (elapsed >= step.at) text = step.text;
      return { turns: [{ n: TURN, by: { [SID]: text } }] };
    },
  });
  return createLoopEngine({ getOrchestrator, logger: { log() {}, warn() {}, error() {} } });
}

const PREAMBLE = 'Contract read. Main is untouched since the branch was cut. '
  + 'Now the verification I actually care about — the ratchet.';
const FULL = PREAMBLE + '\n\n验完了，也合了。\n\n'
  + 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: dry-run 合出后跑测试 6/6 通过，随后正式合并\nNEXT: 无';

console.log('loop-verdict-capture');

const FAST = { quietMs: 900, capMs: 6000, tickMs: 60 };

(async () => {
  await test('结算文本里已有裁决 → 立刻返回，不空等', async () => {
    const eng = fakeEngine([{ at: 0, text: '' }]);
    const t0 = Date.now();
    const out = await eng.__test.awaitVerdictText('m', TURN, SID, FULL, FAST);
    assert(/RESULT:\s*PASS/.test(out));
    assert(Date.now() - t0 < 500, '不该等待，实耗 ' + (Date.now() - t0) + 'ms');
  });

  await test('结算只抓到开场白，完整裁决稍后补进转录 → 等到它（这就是那次事故）', async () => {
    // 结算时只有开场白；600ms 后转录被 patch 成完整回答
    const eng = fakeEngine([{ at: 0, text: PREAMBLE }, { at: 600, text: FULL }]);
    const out = await eng.__test.awaitVerdictText('m', TURN, SID, PREAMBLE, FAST);
    assert(/RESULT:\s*PASS/.test(out), '必须等到补丁后的完整文本，实得：' + out.slice(0, 80));
  });

  await test('文本一直在长就一直等（agent 还在干活），不提前放弃', async () => {
    const eng = fakeEngine([
      { at: 0, text: PREAMBLE },
      { at: 500, text: PREAMBLE + '\n跑测试中…' },
      { at: 1100, text: PREAMBLE + '\n跑测试中…\n跑 git 中…' },
      { at: 1700, text: FULL },
    ]);
    // 每一步间隔都小于 quietMs(900)，所以不会中途放弃
    const out = await eng.__test.awaitVerdictText('m', TURN, SID, PREAMBLE, FAST);
    assert(/RESULT:\s*PASS/.test(out), '文本仍在增长时不该放弃');
  });

  await test('真的不再输出且始终没有裁决 → 在静默期后有界放弃，不挂死', async () => {
    const eng = fakeEngine([{ at: 0, text: PREAMBLE }]);
    const t0 = Date.now();
    const out = await eng.__test.awaitVerdictText('m', TURN, SID, PREAMBLE, FAST);
    const spent = Date.now() - t0;
    assert.strictEqual(out, PREAMBLE);
    assert(spent >= 900, '至少要等满静默期，实耗 ' + spent + 'ms');
    assert(spent < 4000, '不该等到硬上限，实耗 ' + spent + 'ms');
  });

  await test('文本一直增长但永远没有裁决 → 硬上限兜底，不会无限等', async () => {
    const script = [];
    for (let i = 0; i <= 40; i++) script.push({ at: i * 200, text: 'x'.repeat(100 + i * 50) });
    const eng = fakeEngine(script);
    const t0 = Date.now();
    await eng.__test.awaitVerdictText('m', TURN, SID, '', FAST);
    const spent = Date.now() - t0;
    assert(spent < 6000 + 1500, '必须被 capMs 截住，实耗 ' + spent + 'ms');
  });

  await test('被中止时立刻返回，不拖住停止流程', async () => {
    const eng = fakeEngine([{ at: 0, text: PREAMBLE }]);
    let aborted = false;
    setTimeout(() => { aborted = true; }, 200);
    const t0 = Date.now();
    await eng.__test.awaitVerdictText('m', TURN, SID, PREAMBLE,
      Object.assign({}, FAST, { isAborted: () => aborted }));
    assert(Date.now() - t0 < 900, '中止后不该继续等满静默期');
  });

  await test('转录比结算文本短时用结算文本（防被旧/空记录覆盖）', async () => {
    const eng = fakeEngine([{ at: 0, text: '短' }]);
    const out = eng.__test.bestTextSoFar('m', TURN, SID, FULL);
    assert.strictEqual(out, FULL);
  });

  await test('读不到 orchestrator 时安全退化，不抛异常', async () => {
    const eng = createLoopEngine({ logger: { log() {}, warn() {}, error() {} } });
    assert.strictEqual(eng.__test.persistedTurnText('m', TURN, SID), '');
    const out = await eng.__test.awaitVerdictText('m', TURN, SID, FULL, FAST);
    assert(/RESULT:\s*PASS/.test(out));
  });

  await test('缺 turnNum / sid 时不去猜，返回空', async () => {
    const eng = fakeEngine([{ at: 0, text: FULL }]);
    assert.strictEqual(eng.__test.persistedTurnText('m', null, SID), '');
    assert.strictEqual(eng.__test.persistedTurnText('m', TURN, ''), '');
  });

  // ── 工作位那一侧：同一个 idle timer 也会提前结算它 ──────────────────────
  await test('工作位也等：不等它交出 PROGRESS 就派审查，评审看到的是半成品分支', async () => {
    const BUILDER_PREAMBLE = '我先看一下 calc.py 的现状，然后跑一次测试复现。';
    const BUILDER_FULL = BUILDER_PREAMBLE + '\n\n'
      + 'PROGRESS: 给 median 补上空列表检查，改成抛 ValueError\n'
      + 'VERIFIED: 新增 1 条会红的测试，修复后 7 项全过\nRISK: 无\nREPORT: 无';
    const eng = fakeEngine([{ at: 0, text: BUILDER_PREAMBLE }, { at: 600, text: BUILDER_FULL }]);
    const out = await eng.__test.awaitStepText('m', TURN, SID, BUILDER_PREAMBLE,
      eng.__test.hasProgressCard, FAST);
    assert(/PROGRESS:/.test(out), '必须等到 PROGRESS 才算这一步说完');
  });

  await test('两个判据各管各的：有 PROGRESS 不等于有裁决，反之亦然', async () => {
    const eng = fakeEngine([{ at: 0, text: '' }]);
    const { hasProgressCard, hasVerdict } = eng.__test;
    assert.strictEqual(hasProgressCard('PROGRESS: 干完了'), true);
    assert.strictEqual(hasVerdict('PROGRESS: 干完了'), false, '工作位的卡不能被当成裁决');
    assert.strictEqual(hasVerdict('RESULT: PASS'), true);
    assert.strictEqual(hasProgressCard('RESULT: PASS'), false, '裁决不能被当成工作位的卡');
    assert.strictEqual(hasProgressCard('PROGRESS：全角冒号也认'), true);
    assert.strictEqual(hasProgressCard(''), false);
    assert.strictEqual(hasProgressCard(null), false);
  });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 0');
})().catch((e) => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
