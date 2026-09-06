'use strict';
// 2026-09-06 事故复现：AI 群聊开发场景（串行工作流 Claude → Codex）里，Claude 只写了一句
//   「我先读 `.agents/AUTHOR.md` 和两张截图，弄清合同与现状，再在 worktree 里改。」
//   就被群聊判定为「已答」（53 字），工作流随即放行 Codex 那一步。
//
// 真相：那条 assistant entry 在 transcript 里写着 stop_reason='tool_use'，Claude 还要接着
//   干活。落盘的 attempt 记录显示结算信号是 signalSource='claude_auto_extract_final_answer'
//   —— 不是 provider 发的完成事件，而是 Hub 自己每 2s 读一次 transcript 猜出来的。
//   旧判据只问「这段文字是不是比本轮 prompt 新」，从不问「这轮结束了没有」。
//
// 本测试锁定的不变量：
//   1. stop_reason='tool_use'   → partial_commentary（自动路径不得结算）
//   2. stop_reason 缺失/流式中  → partial_commentary
//   3. stop_reason='end_turn'   → final_answer（真答完才放行）
//   4. text 一直照常返回：手动「一键提取/同步」是用户主动要现有内容，不受终态限制

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { TranscriptTap } = require('../core/transcript-tap');
const { isClaudeTurnStopReasonTerminal } = require('../core/claude-transcript-parser');

const PREAMBLE = '我先读 `.agents/AUTHOR.md` 和两张截图，弄清合同与现状，再在 worktree 里改。';
const REAL_ANSWER = 'PROGRESS：已加路径选择框。VERIFIED：跑了单测。RISK：无。REPORT：PASS。';

function assistantLine(text, stopReason, ts) {
  const message = { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] };
  if (stopReason !== undefined) message.stop_reason = stopReason;
  return JSON.stringify({ type: 'assistant', uuid: `u-${ts}`, timestamp: new Date(ts).toISOString(), message }) + '\n';
}

async function withTap(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-finality-'));
  const jsonlPath = path.join(dir, 'session.jsonl');
  const tap = new TranscriptTap();
  try {
    await fn({ tap, jsonlPath });
  } finally {
    try { tap.dispose(); } catch {}
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

async function run() {
  // 判据函数本身
  assert.strictEqual(isClaudeTurnStopReasonTerminal('tool_use'), false, 'tool_use 不是终态');
  assert.strictEqual(isClaudeTurnStopReasonTerminal(null), false, 'null（流式中）不是终态');
  assert.strictEqual(isClaudeTurnStopReasonTerminal(undefined), false, 'undefined 不是终态');
  assert.strictEqual(isClaudeTurnStopReasonTerminal(''), false, '空串不是终态');
  for (const r of ['end_turn', 'max_tokens', 'refusal', 'stop_sequence']) {
    assert.strictEqual(isClaudeTurnStopReasonTerminal(r), true, `${r} 应是终态`);
  }

  const promptAt = Date.now() - 60_000;

  await withTap(async ({ tap, jsonlPath }) => {
    // ① 事故现场：只有一条 tool_use 开场白
    await fs.promises.writeFile(jsonlPath, assistantLine(PREAMBLE, 'tool_use', promptAt + 2000), 'utf8');
    await tap.notifyClaudeStop('sid-1', jsonlPath, { watchOnly: true });

    let got = await tap.extractLatestTurn('sid-1', promptAt);
    assert.ok(got, '应当仍能提取到文本（手动同步要用）');
    assert.strictEqual(got.text, PREAMBLE, '文本照常返回，手动路径不受影响');
    assert.strictEqual(got.stopReason, 'tool_use');
    assert.strictEqual(got.extractMode, 'partial_commentary',
      '事故复现点：stop_reason=tool_use 的开场白绝不能标成 final_answer');

    // ② Claude 真答完，追加终态 entry
    await fs.promises.appendFile(jsonlPath, assistantLine(REAL_ANSWER, 'end_turn', promptAt + 40_000), 'utf8');
    got = await tap.extractLatestTurn('sid-1', promptAt);
    assert.strictEqual(got.extractMode, 'final_answer', 'stop_reason=end_turn 才算答完');
    assert.ok(got.text.includes(REAL_ANSWER), '终态文本必须包含真正的答案');
    assert.ok(got.text.includes(PREAMBLE), '同一轮的开场白与最终答案应合并为一条 turn');
  });

  await withTap(async ({ tap, jsonlPath }) => {
    // ③ 流式中途：stop_reason 字段还没写出来
    await fs.promises.writeFile(jsonlPath, assistantLine('正在思考…', undefined, promptAt + 1000), 'utf8');
    await tap.notifyClaudeStop('sid-2', jsonlPath, { watchOnly: true });
    const got = await tap.extractLatestTurn('sid-2', promptAt);
    assert.strictEqual(got.extractMode, 'partial_commentary', '尚未 finalize 不能算答完');
  });

  console.log('  ✓ Claude 自动提取终态判定（stop_reason 门禁）');
}

run().then(() => console.log('claude auto-extract finality ok')).catch(e => {
  console.error(e.stack || e);
  process.exit(1);
});
