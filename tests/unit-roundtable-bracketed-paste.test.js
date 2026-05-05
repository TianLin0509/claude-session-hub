'use strict';
// 锁定 sendToPty 的 1A bracketed-paste fast-path 行为（2026-05-05 道雪）。
//
// 设计：claude family（claude/deepseek/glm/gpt/kimi/qwen 都跑 claude CLI）走 1A：
//   write '\x1b[200~' + prompt + '\x1b[201~'  → sleep 500ms → write '\r'
//   POST_ENTER_VERIFY_MS 后看 lastActivity 变化判 ok / stuck。
//   verify 失败直接 stuck，不走 _autoRecoverSend（它是 prompt+\r 模式，跟 1A 协议不兼容）。
//
// codex / gemini 协议层不识别 1A（实测 buffer 不显示 paste 内容 + \r 不提交），
//   走旧主路径（PRE_PROMPT_QUIET + paste-detect 静默 + write prompt + \r）。

const assert = require('assert');
const rtWatcher = require('../core/roundtable-watcher.js');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

function makeFakeSm(initialActivity = 100, opts = {}) {
  const writes = [];
  let activity = initialActivity;
  const ready = opts.ready !== undefined ? opts.ready : true;
  return {
    writes,
    writeToSession(sid, data) {
      writes.push({ sid, data });
      if (!opts.mockSilent) activity += String(data).length;
    },
    getRoundtableLastActivity() { return activity; },
    bumpActivity(n) { activity += n; },
    getSessionBuffer() { return opts.bufferText || ''; },
    setRoundtableReady() {},
    getRoundtableReady() { return ready; },
  };
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log(`  ✓ ${name}`),
    e => { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  );
}

console.log('Running bracketed-paste fast-path tests...');

(async () => {

  await test('claude → 1A：写 BP_START+prompt+BP_END，sleep，再写 \\r（共 2 次 write）', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.sendToPty('sid-A', '请回答天空颜色', 'claude');
    assert.ok(r && r.ok, `expected ok=true, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.sendStatus, 'ok');
    assert.strictEqual(sm.writes.length, 2, `期望 2 次 write，实际 ${sm.writes.length}`);
    assert.strictEqual(sm.writes[0].data, BP_START + '请回答天空颜色' + BP_END,
      '第 1 次 write 应是完整的 BP 包（startMarker + prompt + endMarker）');
    assert.strictEqual(sm.writes[1].data, '\r', '第 2 次 write 应是 \\r');
  });

  await test('claude verify 失败（1500ms 内零 echo）→ sendStatus=stuck（不走 _autoRecoverSend）', async () => {
    const sm = makeFakeSm(100, { mockSilent: true });  // write 后 activity 不动 = verify 失败
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const t0 = Date.now();
    const r = await rtWatcher.sendToPty('sid-A', 'hi', 'claude');
    const elapsed = Date.now() - t0;
    assert.ok(r && r.ok, 'ok=true（prompt 已发，应让 watcher 走完整流程）');
    assert.strictEqual(r.sendStatus, 'stuck');
    // 关键：仍然只 2 次 write（不应额外触发 _autoRecoverSend 的 prompt+\r 重发）
    assert.strictEqual(sm.writes.length, 2, '1A 失败应直接 stuck，不重试 prompt+\\r');
    // 2026-05-05 verify 改轮询：跑满 ~1500ms 才标 stuck（之前单点 500ms 太短虚警高）
    assert.ok(elapsed >= 1500, `verify 应跑满 1500ms 轮询窗口，实际 ${elapsed}ms`);
  });

  await test('claude verify 慢启动（800ms 后 activity 变化）→ 早 break，sendStatus=ok', async () => {
    // 模拟 claude TUI 在 \r 后 800ms 才开始 echo（streaming 慢启动），验证轮询窗口
    // 修复了原单点 500ms 的虚警 bug。
    const sm = makeFakeSm(100, { mockSilent: true });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    // 800ms 后模拟 streaming 启动
    const lateActivity = setTimeout(() => sm.bumpActivity(500), 800);
    const t0 = Date.now();
    const r = await rtWatcher.sendToPty('sid-A', 'hi', 'claude');
    const elapsed = Date.now() - t0;
    clearTimeout(lateActivity);
    assert.strictEqual(r.sendStatus, 'ok', '轮询应在 800ms 后检测到 activity 变化早 break');
    // 应该 ~900ms 左右（500ms paste sleep + ~800ms 等到 activity 变化 → break）
    assert.ok(elapsed < 1500, `应早 break，实际 ${elapsed}ms（应远小于 1500ms 上限）`);
  });

  await test('deepseek（跑在 claude CLI）→ 1A 同走', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.sendToPty('sid-A', 'hi', 'deepseek');
    assert.strictEqual(sm.writes.length, 2);
    assert.ok(sm.writes[0].data.startsWith(BP_START), 'deepseek 应走 1A（属于 claude family）');
  });

  await test('claude-resume → 1A 同走（resume 形态也是 claude CLI）', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.sendToPty('sid-A', 'hi', 'claude-resume');
    assert.strictEqual(sm.writes.length, 2);
    assert.ok(sm.writes[0].data.startsWith(BP_START));
  });

  await test('gpt（跑在 claude CLI）→ 1A 同走', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    await rtWatcher.sendToPty('sid-A', 'hi', 'gpt');
    assert.strictEqual(sm.writes.length, 2);
    assert.ok(sm.writes[0].data.startsWith(BP_START));
  });

  await test('codex → 不走 1A（保留旧主路径，第 1 次 write 是裸 prompt 不带 BP marker）', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    // 不 await（旧主路径会 PRE_PROMPT_QUIET 等 1.5s+），只看头几次 write 的形态
    const promise = rtWatcher.sendToPty('sid-A', 'codex prompt', 'codex');
    // 等长一点让 PRE_PROMPT_QUIET（1500ms 静默）通过 + write prompt
    await new Promise(r => setTimeout(r, 2000));
    // 旧路径第 1 次 write 应是裸 prompt 不含 BP_START
    assert.ok(sm.writes.length >= 1, `期望至少 1 次 write，实际 ${sm.writes.length}`);
    assert.ok(!sm.writes[0].data.startsWith(BP_START), 'codex 不应走 1A（buffer 应是裸 prompt 而非 BP 包）');
    assert.strictEqual(sm.writes[0].data, 'codex prompt', 'codex 旧路径第 1 次 write 应是裸 prompt');
    await promise.catch(() => {});
  });

  await test('gemini → 不走 1A（保留旧主路径）', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const promise = rtWatcher.sendToPty('sid-A', 'gemini prompt', 'gemini');
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(sm.writes.length >= 1);
    assert.ok(!sm.writes[0].data.startsWith(BP_START), 'gemini 不应走 1A');
    assert.strictEqual(sm.writes[0].data, 'gemini prompt');
    await promise.catch(() => {});
  });

  console.log('\n✓ bracketed-paste fast-path: tests done\n');
})();
