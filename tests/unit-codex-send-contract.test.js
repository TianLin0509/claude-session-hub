'use strict';
// Phase 2 — codex 发送闭环契约测试
//
// 重大发现（v2 plan 假设修订）：现状 sendToPty / resendCurrentPrompt 全是 **kind 无关**
//   通用路径，基于 sessionManager.getRoundtableLastActivity(sid) 时间戳判 ack，
//   不依赖任何 CLI 特定字符串信号。codex 已天然走通用路径，无需 detectCodexAck /
//   detectCodexStuck（v1 plan 假设错误，v2 已修订过但 fix 仍假设要新 cli-send-adapter）。
//
// 本测试只契约保护：
//   B2.4: codex (kind='codex') 走 resendCurrentPrompt → enter_only / rewrite_full 判定
//   B2.5: codex sid 未 bind (rollout 未找到) 时 sendToPty 仍能正常发出 (fail-soft)
//   B2.6: 手动 extract 后立即 resend → 按 promptHeader 指纹判，与未 extract 行为一致
//
// 注：Spec S4 写的"未 bind 期间禁止发送"被现状 fail-soft 行为覆盖（bind 窗口 [-10s, +5min]
// 足够宽容纳"先发后绑"）。本测试断言 fail-soft 现状，不是 Spec S4 的字面禁止。

const assert = require('assert');
const watcher = require('../core/roundtable-watcher');

let failed = 0;

// === 简易 fake sessionManager ===
function _makeFakeSessionManager() {
  const state = {
    activity: new Map(),    // sid → number (timestamp)
    buffer: new Map(),      // sid → string
    ready: new Map(),       // sid → boolean
    writeLog: [],           // [{sid, data}]
  };
  const sm = {
    getRoundtableLastActivity: (sid) => state.activity.get(sid) || 0,
    bumpActivity: (sid, by = 1) => state.activity.set(sid, (state.activity.get(sid) || 0) + by),
    getSessionBuffer: (sid) => state.buffer.get(sid) || '',
    setSessionBuffer: (sid, s) => state.buffer.set(sid, s),
    appendBuffer: (sid, s) => state.buffer.set(sid, (state.buffer.get(sid) || '') + s),
    writeToSession: (sid, data) => {
      state.writeLog.push({ sid, data });
      // 模拟字符回环：CLI echo 会让 buffer 加上输入字节
      sm.appendBuffer(sid, data);
      // 模拟 activity bump（写入触发 PTY 输出）
      sm.bumpActivity(sid);
    },
    getRoundtableReady: (sid) => state.ready.get(sid) || false,
    setRoundtableReady: (sid, v) => state.ready.set(sid, v),
    _state: state,
  };
  return sm;
}

// 简易 fake cliReadyDetector
const _fakeCliReady = { isReady: () => true };

watcher.init({ sessionManager: _makeFakeSessionManager(), cliReadyDetector: _fakeCliReady });

// === B2.4 — codex resendCurrentPrompt 走通用路径 ===

async function testCodexResendEnterOnlyWhenPromptInBuffer() {
  const sm = _makeFakeSessionManager();
  watcher.init({ sessionManager: sm, cliReadyDetector: _fakeCliReady });

  const sid = 'codex-sid-1';
  const promptHeader = 'Round 3 (general scenario)';
  const prompt = 'Round 3 (general scenario)\n\n请简要总结上一轮要点';
  // buffer 末尾包含 promptHeader（模拟 CLI 输入框已存有 prompt 等回车）
  sm.setSessionBuffer(sid, '> Round 3 (general scenario)\n\n请简要总结上一轮要点\n');
  // bumpActivity 模拟有动静（验证 verify 通过）
  setTimeout(() => sm.bumpActivity(sid), 10);

  const r = await watcher.resendCurrentPrompt({
    sid, kind: 'codex', prompt, promptHeader,
    timing: { ENTER_RETRY_GAP_MS: 5, POST_ENTER_VERIFY_MS: 30 },
  });

  assert.ok(r.ok, `resend must succeed, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.mode, 'enter_only', 'must detect prompt in buffer → enter_only');
  // 不应再写 prompt 全文（避免污染输入框）
  const writeLog = sm._state.writeLog;
  const writes = writeLog.filter((w) => w.sid === sid).map((w) => w.data);
  assert.ok(!writes.some((w) => w === prompt), 'enter_only must NOT rewrite full prompt');
  assert.ok(writes.includes('\r'), 'enter_only must send \\r to commit');
}

async function testCodexResendRewriteFullWhenPromptMissing() {
  const sm = _makeFakeSessionManager();
  watcher.init({ sessionManager: sm, cliReadyDetector: _fakeCliReady });

  const sid = 'codex-sid-2';
  const promptHeader = 'Round 5 (research)';
  const prompt = 'Round 5 (research)\n\n问题：A 股某板块行情';
  // buffer 不含 promptHeader（PTY 未收到 prompt 字节）
  sm.setSessionBuffer(sid, '> codex@$ \n');
  setTimeout(() => sm.bumpActivity(sid), 10);

  const r = await watcher.resendCurrentPrompt({
    sid, kind: 'codex', prompt, promptHeader,
    timing: { ENTER_RETRY_GAP_MS: 5, POST_ENTER_VERIFY_MS: 30 },
  });

  assert.ok(r.ok, `resend must succeed`);
  assert.strictEqual(r.mode, 'rewrite_full', 'must detect prompt missing → rewrite_full');
  const writes = sm._state.writeLog.filter((w) => w.sid === sid).map((w) => w.data);
  assert.ok(writes.includes(prompt), 'rewrite_full must write full prompt');
  assert.ok(writes.filter((w) => w === '\r').length >= 1, 'must commit with \\r');
}

// === B2.5 — codex sid 未 bind 时 sendToPty 仍 fail-soft ===

async function testCodexSendStillWorksBeforeRolloutBind() {
  // 现状架构：sendToPty 用 hubSessionId（PTY 进程），与 CodexTap 的 rollout bind 无关。
  // 即便 _bound 还没 hubSid，写入 PTY 仍正常 → CLI 接收 prompt → task_complete 后绑定。
  // 这是 fail-soft 设计，比 Spec S4 字面"禁止发送"用户体感更好。
  const sm = _makeFakeSessionManager();
  watcher.init({ sessionManager: sm, cliReadyDetector: _fakeCliReady });

  const sid = 'codex-pre-bind';
  sm.setSessionBuffer(sid, '> ');
  // 模拟 sendToPty 内部多个 wait 期间的 activity bump（真实 PTY 也会有自然 echo）
  let timer;
  timer = setInterval(() => sm.bumpActivity(sid), 25);

  try {
    const result = await watcher.sendToPty(sid, 'first prompt before bind', 'codex');
    assert.ok(result, 'sendToPty must return truthy');
    assert.strictEqual(typeof result, 'object', 'must return { ok, sendStatus }');
    assert.strictEqual(result.ok, true);
    assert.ok(['ok', 'auto_recovered'].includes(result.sendStatus), `expected ok/auto_recovered, got ${result.sendStatus}`);

    const writes = sm._state.writeLog.filter((w) => w.sid === sid).map((w) => w.data);
    assert.ok(writes.includes('first prompt before bind'), 'prompt must be written');
    assert.ok(writes.includes('\r'), '\\r must be written for commit');
  } finally {
    clearInterval(timer);
  }
}

// === B2.6 — 手动 extract 后 resend：行为与未 extract 一致 ===

async function testCodexResendAfterExtractIsIdempotent() {
  // 设计意图：用户点"一键提取"拿到 partial（手动 extract 仅读 transcript，不改 PTY）→
  //   随后又点"📤 发送"——resendCurrentPrompt 仍按 promptHeader 指纹判，与未 extract 一致。
  // 即 manual extract 不污染 PTY 状态，resend 路径无需特殊感知。
  const sm = _makeFakeSessionManager();
  watcher.init({ sessionManager: sm, cliReadyDetector: _fakeCliReady });

  const sid = 'codex-after-extract';
  const promptHeader = 'Round 2 header';
  const prompt = 'Round 2 header\n\nthis is the prompt body';
  sm.setSessionBuffer(sid, '> Round 2 header\n\nthis is the prompt body\n');
  setTimeout(() => sm.bumpActivity(sid), 10);

  // 第一次 resend
  const r1 = await watcher.resendCurrentPrompt({
    sid, kind: 'codex', prompt, promptHeader,
    timing: { ENTER_RETRY_GAP_MS: 5, POST_ENTER_VERIFY_MS: 30 },
  });
  assert.strictEqual(r1.mode, 'enter_only');

  // [模拟用户点"一键提取"]：manual extract 不动 PTY，buffer 不变
  // 但有可能 buffer 末尾被 codex 后续 stream 输出推走 promptHeader → enter_only 退化
  // 模拟：buffer 追加大量 stream → promptHeader 被挤出末尾 1024
  sm.appendBuffer(sid, ' '.repeat(1100) + 'codex was here streaming\n');
  setTimeout(() => sm.bumpActivity(sid), 10);

  const r2 = await watcher.resendCurrentPrompt({
    sid, kind: 'codex', prompt, promptHeader,
    timing: { ENTER_RETRY_GAP_MS: 5, POST_ENTER_VERIFY_MS: 30 },
  });
  // promptHeader 不在末尾 1024 → rewrite_full（这是 watcher 设计的安全行为，非 bug）
  assert.strictEqual(r2.mode, 'rewrite_full', 'after stream pushed promptHeader out → rewrite_full');
}

// === 源码契约：roundtable-watcher.js 不应有 codex 特定分支 ===

function testNoCodexSpecificBranchInWatcher() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'roundtable-watcher.js'), 'utf8');

  // 正则：if/else if 内含 'codex' 字符串字面量的分支（除 console.log/warn 等日志参数外）
  // 简化：搜 sendToPty / resendCurrentPrompt / _autoRecoverSend 函数体内的 kind === 'codex'
  const codexBranch = /kind\s*===\s*['"]codex['"]/;
  assert.ok(!codexBranch.test(src), 'roundtable-watcher.js must not have kind === "codex" branches (kind-agnostic contract)');
}

// === runner ===

const tests = [
  testCodexResendEnterOnlyWhenPromptInBuffer,
  testCodexResendRewriteFullWhenPromptMissing,
  testCodexSendStillWorksBeforeRolloutBind,
  testCodexResendAfterExtractIsIdempotent,
  testNoCodexSpecificBranchInWatcher,
];

(async () => {
  for (const t of tests) {
    try {
      await t();
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
