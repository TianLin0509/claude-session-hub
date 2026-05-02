'use strict';
// 锁住圆桌"快路径"重写：
// - session-manager 的 roundtableReady / roundtableLastActivity 缓存 + 三个 API 行为正确
// - main.js _rtSendToPty 不再有 8000/5000 ms 硬 sleep；首次冷启动会写 ready=true；
//   活性兜底失败会写 ready=false 让调用方 skip
// - main.js _rtWaitCliReady 轮询从 300ms 缩到 100ms
// - 大 prompt 加固（2026-05-01 第二次修，bug 重现于 debate/summary）：废固定 300ms 窗口，
//   改为 PTY 安静期自适应等待（FAST_PATH_QUIET_MS=250 / FAST_PATH_MAX_WAIT_MS=3000），
//   防止 3500+ 字 prompt 的 \r 落进 Codex paste 缓冲被吃掉。
//
// 背景：原 _rtSendToPty 每轮都重收 Claude 8s / Gemini 8s / Codex 5s 的 CLI 初始化等待，
// 导致圆桌每轮要 ~8 秒才能让三家看到 prompt。设计修正后 CLI 首次 ready 缓存到 sid 上，
// 第 2-N 轮直接走快路径（分两次 write：prompt → 安静期等待 → '\r'）。
//
// 不在本单测覆盖：_rtSendToPty 的实际异步行为（需要 spawn PTY，留给隔离 Hub 实例 E2E）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { SessionManager } = require('../core/session-manager');

function testInitialReadyIsFalse() {
  // session 一创建出来 roundtableReady 必须是 false（首次走冷启动），不能是 true。
  const sm = new SessionManager();
  // 绕过 createSession（不 spawn PTY），直接塞 fake entry 验 API。
  sm.sessions.set('sid-A', { info: { id: 'sid-A' }, pty: null, pendingTimers: [], ringBuffer: '', roundtableReady: false, roundtableLastActivity: 0 });
  assert.strictEqual(sm.getRoundtableReady('sid-A'), false, 'initial ready must be false');
  assert.strictEqual(sm.getRoundtableLastActivity('sid-A'), 0, 'initial lastActivity must be 0');
  console.log('  ✓ testInitialReadyIsFalse');
}

function testReadyToggle() {
  // setRoundtableReady(true/false) 应能正确读回；不存在的 sid 返回 false（不抛）。
  const sm = new SessionManager();
  sm.sessions.set('sid-B', { info: { id: 'sid-B' }, pty: null, pendingTimers: [], ringBuffer: '', roundtableReady: false, roundtableLastActivity: 0 });
  sm.setRoundtableReady('sid-B', true);
  assert.strictEqual(sm.getRoundtableReady('sid-B'), true, 'after set(true) must read true');
  sm.setRoundtableReady('sid-B', false);
  assert.strictEqual(sm.getRoundtableReady('sid-B'), false, 'after set(false) must read false');
  // 不存在的 sid：getter 返回 false，setter 静默 no-op，不抛。
  assert.strictEqual(sm.getRoundtableReady('sid-not-exist'), false, 'getter on missing sid returns false');
  sm.setRoundtableReady('sid-not-exist', true); // must not throw
  console.log('  ✓ testReadyToggle');
}

function testLastActivityUpdatedByRingBuffer() {
  // 通过 _appendToRingBuffer（PTY data listener 内部调的同一函数）写入数据，
  // 但 lastActivity 是在 onData 回调里更新的，不是 _appendToRingBuffer 里。
  // 所以这条测试用直接写 entry 字段验 API 即可，不依赖 PTY 集成。
  const sm = new SessionManager();
  const entry = { info: { id: 'sid-C' }, pty: null, pendingTimers: [], ringBuffer: '', roundtableReady: false, roundtableLastActivity: 0 };
  sm.sessions.set('sid-C', entry);
  assert.strictEqual(sm.getRoundtableLastActivity('sid-C'), 0, 'initial lastActivity = 0');
  // 模拟 PTY data listener 触发后 entry 被更新
  entry.roundtableLastActivity = 1234567890;
  assert.strictEqual(sm.getRoundtableLastActivity('sid-C'), 1234567890, 'reads back the updated timestamp');
  console.log('  ✓ testLastActivityUpdatedByRingBuffer');
}

function testCreateSessionInitialFields() {
  // 真实路径验证：createSession 构造的内部 entry 必须带 roundtableReady=false、roundtableLastActivity=0。
  // 不 spawn 真 PTY 风险大（pty.spawn 同步），改为读 source 静态确认初始字段写法。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf-8');
  assert.ok(
    /this\.sessions\.set\([^)]*roundtableReady:\s*false[^)]*roundtableLastActivity:\s*0/.test(src.replace(/\s+/g, ' ')),
    'session-manager createSession must set roundtableReady=false / roundtableLastActivity=0 on the internal entry'
  );
  // PTY data listener 必须更新 lastActivity（最早处）
  assert.ok(
    /ptyProcess\.onData\([^)]*\)\s*=>\s*\{[\s\S]*?roundtableLastActivity\s*=\s*Date\.now\(\)/.test(src),
    'pty.onData listener must update entry.roundtableLastActivity = Date.now()'
  );
  console.log('  ✓ testCreateSessionInitialFields');
}

function testMainJsHasFastPathContract() {
  // _rtSendToPty 必须删除三条硬 sleep（8000 / 8000 / 5000）+ prompt→'\r' 中间 delay。
  // 必须使用 getRoundtableReady / setRoundtableReady / getRoundtableLastActivity 三个 API。
  // 必须用"安静期自适应"等待（FAST_PATH_QUIET_MS + FAST_PATH_MAX_WAIT_MS），
  //   不能再用固定 300ms 窗口（对 3500+ 字大 prompt 不够，Codex paste-detect 还没 fire）。
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

  // 锁住函数本体（从 `async function _rtSendToPty` 到下一个 `function _rtExtractStreamingText` 之前）
  const startIdx = src.indexOf('async function _rtSendToPty');
  const endIdx = src.indexOf('function _rtExtractStreamingText', startIdx);
  assert.ok(startIdx >= 0, '_rtSendToPty function must exist');
  assert.ok(endIdx > startIdx, '_rtExtractStreamingText must follow _rtSendToPty (used as end anchor)');
  const fnBody = src.slice(startIdx, endIdx);

  // 三条硬 sleep 不能再出现在 _rtSendToPty 函数体里
  assert.ok(!/setTimeout\(\s*r\s*,\s*8000\s*\)/.test(fnBody), '_rtSendToPty must not contain setTimeout 8000ms');
  assert.ok(!/setTimeout\(\s*r\s*,\s*5000\s*\)/.test(fnBody), '_rtSendToPty must not contain setTimeout 5000ms');
  // 老版 baseDelay 250 / 500 + sizeDelay 也必须没了
  assert.ok(!/baseDelay/.test(fnBody), '_rtSendToPty must not contain baseDelay (legacy prompt→\\r delay)');
  assert.ok(!/sizeDelay/.test(fnBody), '_rtSendToPty must not contain sizeDelay (legacy prompt→\\r delay)');
  // 老版固定 300ms 窗口必须废弃（对大 prompt 不够）
  assert.ok(!/FAST_PATH_ACTIVITY_WINDOW_MS/.test(fnBody), '_rtSendToPty must not use legacy fixed FAST_PATH_ACTIVITY_WINDOW_MS=300 (replaced by quiet-period adaptive wait)');

  // 必须用三个新 API
  assert.ok(/getRoundtableReady\(sid\)/.test(fnBody), '_rtSendToPty must call getRoundtableReady(sid)');
  assert.ok(/setRoundtableReady\(sid,\s*true\)/.test(fnBody), '_rtSendToPty must call setRoundtableReady(sid, true) on cold-path success');
  assert.ok(/setRoundtableReady\(sid,\s*false\)/.test(fnBody), '_rtSendToPty must call setRoundtableReady(sid, false) on activity-check failure');
  assert.ok(/getRoundtableLastActivity\(sid\)/.test(fnBody), '_rtSendToPty must read getRoundtableLastActivity(sid) for activity check');

  // 安静期自适应等待的两个常量（值锁定为 250 / 3000，与 paste-detect timer 经验值匹配）
  assert.ok(/FAST_PATH_QUIET_MS\s*=\s*250/.test(fnBody), '_rtSendToPty must define FAST_PATH_QUIET_MS = 250 (PTY quiet duration before sending Enter)');
  assert.ok(/FAST_PATH_MAX_WAIT_MS\s*=\s*3000/.test(fnBody), '_rtSendToPty must define FAST_PATH_MAX_WAIT_MS = 3000 (upper bound for very large prompts)');

  // prompt 和 '\r' **必须分两次 write**（TUI alt-screen 把紧贴字符当粘贴事件，紧贴的 \r 不触发 Enter）。
  // 历史 bug 重现于 2026-04-30，commit 5c17e34 之前就是分两次 write 的设计。
  assert.ok(/writeToSession\(sid,\s*prompt\)/.test(fnBody), 'must write prompt alone (without \\r) first');
  assert.ok(/writeToSession\(sid,\s*['"]\\r['"]\)/.test(fnBody), 'must write \\r in a separate call');
  assert.ok(!/writeToSession\(sid,\s*prompt\s*\+\s*['"]\\r['"]\)/.test(fnBody), 'must NOT merge prompt+\\r into single write (TUI paste-vs-Enter ambiguity)');

  // 兜底必须 fail-safe：**不重发 prompt**
  // （第一次 write 已把字符送进 PTY stdin，重发会让 CLI 收到 prompt+prompt+\r 双重输入）。
  // 锁住"prompt 在函数体里只 write 一次"的不变式。
  const promptWriteCount = (fnBody.match(/writeToSession\(sid,\s*prompt\)/g) || []).length;
  assert.strictEqual(promptWriteCount, 1, '_rtSendToPty must write prompt exactly once (fail-safe: no resend on activity failure to avoid double-prompt to CLI stdin)');

  // 关键契约（2026-05-02 用户血泪反馈）：零 echo 时 **\r 必须发出去**。
  //   旧版本错误地在 lastSeen===beforeWrite 时 return false 不发 \r，导致用户的 prompt
  //   字符已经在 PTY stdin 但 Enter 提交没发出 → 卡在 CLI 输入框需要手按 Enter。
  //   新契约：echo 正常发 1 次 \r；零 echo 兜底分 ENTER_RETRY_TRIES 次发 \r（间隔 ENTER_RETRY_GAP_MS）。
  //   多发 \r 安全（输入框有 prompt 时首个 \r 提交，后续落入空输入框被 CLI 忽略），不会污染 prompt 内容。
  assert.ok(/ENTER_RETRY_TRIES\s*=\s*[2-9]/.test(fnBody),
    '_rtSendToPty must define ENTER_RETRY_TRIES >= 2 for zero-echo fallback (must commit Enter even when CLI not echoing back)');
  assert.ok(/ENTER_RETRY_GAP_MS\s*=\s*\d+/.test(fnBody),
    '_rtSendToPty must define ENTER_RETRY_GAP_MS for spacing fallback Enters');
  // 锁住"零 echo 时仍 write \r"的代码模式：循环里写 \r
  assert.ok(/for\s*\([^)]+ENTER_RETRY_TRIES[\s\S]{0,200}?writeToSession\(sid,\s*['"]\\r['"]\)/.test(fnBody),
    '_rtSendToPty must write \\r in a loop bounded by ENTER_RETRY_TRIES on zero-echo path');
  // 反向：禁止"零 echo 时 return false 跳过 \r"的旧 bug 模式
  assert.ok(!/lastSeen\s*===\s*beforeWrite[\s\S]{0,200}return\s+false/.test(fnBody),
    '_rtSendToPty MUST NOT early-return false on zero-echo (regression guard: prompt already in PTY stdin, \\r MUST be sent — see 2026-05-02 user blood-tear feedback)');

  console.log('  ✓ testMainJsHasFastPathContract');
}

function testRtWaitCliReadyPollIs100ms() {
  // _rtWaitCliReady 内部轮询从 300ms 缩到 100ms。
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const startIdx = src.indexOf('async function _rtWaitCliReady');
  const endIdx = src.indexOf('async function _rtSendToPty', startIdx);
  assert.ok(startIdx >= 0, '_rtWaitCliReady function must exist');
  assert.ok(endIdx > startIdx, '_rtSendToPty must follow _rtWaitCliReady (used as end anchor)');
  const fnBody = src.slice(startIdx, endIdx);
  assert.ok(/setTimeout\(\s*r\s*,\s*100\s*\)/.test(fnBody), '_rtWaitCliReady must poll every 100ms');
  assert.ok(!/setTimeout\(\s*r\s*,\s*300\s*\)/.test(fnBody), '_rtWaitCliReady must not poll every 300ms (legacy)');
  console.log('  ✓ testRtWaitCliReadyPollIs100ms');
}

function testFastPathColdToHotSequence() {
  // 流程级模拟：手工调用三个 API，模拟 _rtSendToPty 的内部状态机走一遍。
  // - 第 1 次：cache miss → setRoundtableReady(true) → 走快路径
  // - 第 2 次：cache hit → 跳过冷启动 → 走快路径
  // - 第 3 次：零 echo 兜底 → setRoundtableReady(false) 让下轮重新冷启动；
  //           **本轮 \r 仍发出去**（2026-05-02 修订：旧版本在零 echo 时 return false 不发 \r，
  //           导致 prompt 字符已在 PTY stdin 但 Enter 没提交，用户卡在子 session 输入框需手按 Enter）
  // - 第 4 次（恢复）：cache miss → 重新走冷启动 → setRoundtableReady(true)
  const sm = new SessionManager();
  const entry = { info: { id: 'sid-D' }, pty: null, pendingTimers: [], ringBuffer: '', roundtableReady: false, roundtableLastActivity: 0 };
  sm.sessions.set('sid-D', entry);

  // 第 1 次：冷启动后置 ready
  assert.strictEqual(sm.getRoundtableReady('sid-D'), false, 'turn 1: cache miss');
  sm.setRoundtableReady('sid-D', true);
  assert.strictEqual(sm.getRoundtableReady('sid-D'), true, 'turn 1: ready after cold init');

  // 第 2 次：cache hit
  assert.strictEqual(sm.getRoundtableReady('sid-D'), true, 'turn 2: cache hit, no cold init');

  // 第 3 次：write 前 lastActivity 快照，模拟 PTY 没回 echo（lastActivity 不变）
  entry.roundtableLastActivity = 100;
  const before = sm.getRoundtableLastActivity('sid-D');
  // ... 模拟"安静期等待"完成后 ...
  const after = sm.getRoundtableLastActivity('sid-D');
  assert.strictEqual(after, before, 'turn 3: no PTY echo → activity unchanged');
  // 零 echo 兜底：仅重置 ready 让下轮冷启动重对齐；本轮 \r 仍多发兜底（不在状态机模拟范围）
  sm.setRoundtableReady('sid-D', false);
  assert.strictEqual(sm.getRoundtableReady('sid-D'), false, 'turn 3 zero-echo: ready reset for next-turn cold restart (current turn still commits \\r — see testMainJsHasFastPathContract regression guard)');

  // 第 4 次：cache miss 后自动走冷启动恢复
  assert.strictEqual(sm.getRoundtableReady('sid-D'), false, 'turn 4: cache miss again → cold init triggered');
  sm.setRoundtableReady('sid-D', true);
  assert.strictEqual(sm.getRoundtableReady('sid-D'), true, 'turn 4: ready restored after natural cold restart on next turn');
  console.log('  ✓ testFastPathColdToHotSequence');
}

console.log('Running roundtable fast-path tests...');
testInitialReadyIsFalse();
testReadyToggle();
testLastActivityUpdatedByRingBuffer();
testCreateSessionInitialFields();
testMainJsHasFastPathContract();
testRtWaitCliReadyPollIs100ms();
testFastPathColdToHotSequence();
console.log('All passed.');
