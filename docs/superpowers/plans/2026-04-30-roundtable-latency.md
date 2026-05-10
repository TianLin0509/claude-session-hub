# 圆桌输入延迟优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this small-scope plan) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把圆桌"敲回车 → prompt 出现在三个 PTY 终端"的延迟从 ~8 秒降至 < 200ms（40× 加速）。

**Architecture:** 引入 session 级 `roundtableReady` 缓存：首次通过 `_rtWaitCliReady` 后置为 true，后续 `_rtSendToPty` 走快路径直接 `write(prompt + '\r')`，配合 300ms 活性兜底（写完无 PTY echo → 重置 ready 走冷启动重发）。删除每轮 5-8s 的硬编码 sleep（A/B/C 主因）和 250-1000ms 的 prompt→回车延迟（D 次因）。`_rtWaitCliReady` 轮询间隔从 300ms → 100ms 加速冷启动。

**Tech Stack:** Node.js, Electron IPC, node-pty

**Spec / Analysis Reference:**
- `docs/roundtable-latency-analysis-2026-04-30.html`（含三路独立 AI 分析、瀑布图、风险表、伪代码）

**Visual Reference:** 同上 HTML

---

## Coordination with Resilience Plan

⚠️ **重要**：本 plan 与 `2026-04-30-roundtable-resilience.md`（容错升级方案）改动同一段代码（`main.js:520-560` 附近 + `_rtSendToPty`），<strong>必须协调执行顺序</strong>。

**推荐执行顺序：**

| 顺序 | Plan | 理由 |
|---|---|---|
| 1 | **本 plan（latency）** | 改动量小（~50 行），独立、风险低；先把热路径打通后再做容错重构会更顺 |
| 2 | `2026-04-30-roundtable-resilience.md` | 在已打通的热路径基础上加完成检测 / 软提醒 / 手动提取 |

**冲突点提示：**

- `_rtSendToPty` 函数：本 plan 改造其内部逻辑（去 sleep + 加缓存）；resilience plan 不动该函数本身，只动其调用方（`_rtWaitTurnComplete`）和 transcript-tap。两者基本不冲突。
- `Promise.all` → `Promise.allSettled`：resilience plan Task 3 改动；本 plan 不涉及。
- `_rtWaitCliReady`：本 plan 修改 `pollMs` 常量；resilience plan 不动该函数。无冲突。

如果两个 plan 同批执行，可以并行做 Task 1-3 here + Task 1-2 there（互不依赖），最后一起做 smoke test 与 E2E。

---

## Scope

仅本 plan 范围内：**P0 — 三个延迟主因 + 一个次因 + 一个轮询间隔优化**。

**Out of scope（后续 P1）：**
- orchestrator state.json 异步化（次要，~30ms 收益）
- 会议室创建后的预热（pre-warm）让第 1 轮也变热路径
- buffer-update 节流到 16ms

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| **Modify** | `core/session-manager.js` | 新增 `setRoundtableReady` / `getRoundtableReady` / `getRoundtableLastActivity` API；在 PTY 数据 listener 中更新 `roundtableLastActivity` |
| **Modify** | `main.js:520-560` | `_rtWaitCliReady` 轮询间隔 300→100ms；`_rtSendToPty` 重构为冷热双路径 + 活性兜底 |
| **Create** | `tests/unit-roundtable-fast-path.test.js` | 单元测试：cache hit / cache miss / 活性兜底失败 / 兜底成功 |

---

## Task 1: SessionManager 加 roundtableReady 字段

**Files:**
- Modify: `core/session-manager.js`

**Background:** session-manager 当前不暴露 ready 缓存的 API。需要新增三个方法 + 在 PTY 数据流中维护一个 `roundtableLastActivity` 时间戳（用于活性兜底）。

- [ ] **Step 1: 定位 session 对象的字段定义位置**

阅读 `core/session-manager.js` 找到 session 对象初始化（`spawn` / `createSession` 类似函数）。把字段插在那里（不要散落在多处）。

```bash
grep -n "createSession\|new Map\|sessions.set" core/session-manager.js | head -20
```

- [ ] **Step 2: 添加字段初始化**

在 session 对象创建处加：

```js
session.roundtableReady = false;       // 圆桌快路径缓存
session.roundtableLastActivity = 0;    // 最近一次 PTY 输出时间戳（活性兜底用）
```

- [ ] **Step 3: 在 PTY data listener 中更新 lastActivity**

定位 PTY data event 监听（通常是 `pty.onData(...)` 或 `pty.on('data', ...)`）。在最早的位置加：

```js
pty.onData((chunk) => {
  session.roundtableLastActivity = Date.now();
  // ... 其余原有逻辑
});
```

注意：必须在最早处更新，**不能放到处理逻辑之后**——否则一旦中间逻辑抛错或耗时，活性时间戳就不准。

- [ ] **Step 4: 暴露三个 getter/setter**

在 SessionManager 的 public API 区域加：

```js
getRoundtableReady(sid) {
  const s = this.sessions.get(sid);
  return s ? !!s.roundtableReady : false;
}

setRoundtableReady(sid, ready) {
  const s = this.sessions.get(sid);
  if (s) s.roundtableReady = !!ready;
}

getRoundtableLastActivity(sid) {
  const s = this.sessions.get(sid);
  return s ? s.roundtableLastActivity : 0;
}
```

- [ ] **Step 5: Smoke test**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

必须看到 `[hub] hook server listening on 127.0.0.1:...`。

**Acceptance:** session 对象有两个新字段；三个 API 暴露；Hub 能启动。

---

## Task 2: 重写 _rtSendToPty 为冷热双路径 + 活性兜底

**Files:**
- Modify: `main.js:533-560`
- Modify: `main.js:520-531` (poll interval only)

- [ ] **Step 1: 把 `_rtWaitCliReady` 轮询间隔改为 100ms**

`main.js:528`：

```js
// before
await new Promise(r => setTimeout(r, 300));

// after
await new Promise(r => setTimeout(r, 100));
```

注释说明动机：「冷启动加速；轮询本身轻量（仅读 ring buffer），CPU 影响可忽略」。

- [ ] **Step 2: 重写 `_rtSendToPty`**

`main.js:533-560` 全部替换为：

```js
/**
 * 发送 prompt 到 PTY 并发回车
 * - 首次（roundtableReady=false）：走完整 _rtWaitCliReady（marker 轮询，无固定 sleep）
 * - 后续（roundtableReady=true）：直接 write(prompt+'\r')，300ms 活性兜底
 * - 活性兜底失败：重置 ready 走一次冷启动重发
 *
 * 三方共识依据：见 docs/roundtable-latency-analysis-2026-04-30.html
 */
async function _rtSendToPty(sid, prompt, kind) {
  const FAST_PATH_ACTIVITY_WINDOW_MS = 300;

  // === 1. 冷启动：仅首次或 ready 重置后走 ===
  if (!sessionManager.getRoundtableReady(sid)) {
    if (kind === 'claude') {
      // Claude TUI 用 alt-screen，buffer 抓不准 → 仍需短暂等待，但从 8s 降到首次 1.5s
      // 用 buffer 长度阈值（≥1500 字符）作为冷启动 ready 信号（_RT_READY_MARKERS.claude=[]）
      const ready = await _rtWaitCliReady(sid, kind, 60000);
      if (!ready) return false;
    } else {
      const ready = await _rtWaitCliReady(sid, kind, 60000);
      if (!ready) return false;
    }
    sessionManager.setRoundtableReady(sid, true);
  }

  // === 2. 热路径：一次性写入 prompt + 回车 ===
  const beforeWrite = sessionManager.getRoundtableLastActivity(sid);
  sessionManager.writeToSession(sid, prompt + '\r');

  // === 3. 活性兜底：写后 300ms 内若无 PTY echo，视为 session 失活 ===
  await new Promise(r => setTimeout(r, FAST_PATH_ACTIVITY_WINDOW_MS));
  const afterWrite = sessionManager.getRoundtableLastActivity(sid);

  if (afterWrite === beforeWrite) {
    // 没有任何新输出 → 重置 ready 走冷启动 + 重发
    console.warn(`[roundtable] fast-path activity check failed for ${kind}(${sid.slice(0,8)}) — falling back to cold start`);
    sessionManager.setRoundtableReady(sid, false);
    const ready = await _rtWaitCliReady(sid, kind, 60000);
    if (!ready) return false;
    sessionManager.setRoundtableReady(sid, true);
    sessionManager.writeToSession(sid, prompt + '\r');
    // 重试不再做活性检查（避免无限循环），由上层 turn-complete 等待逻辑兜底
  }

  return true;
}
```

**关键变化对照：**

| 项 | Before | After |
|---|---|---|
| Claude 固定 sleep | 8000ms | 仅冷启动用 _rtWaitCliReady（buffer 长度阈值）|
| Gemini 固定 sleep（markers 后） | 8000ms | **删除** |
| Codex 固定 sleep（markers 后） | 5000ms | **删除** |
| 写完到回车 baseDelay+sizeDelay | 250-1000ms | **删除**（合并写入） |
| 第 2 轮起总耗时 | ~8s | ~300ms（仅活性窗口） |

- [ ] **Step 3: 验证调用方仍兼容**

`_rtSendToPty` 仍然返回 `Promise<boolean>`（true=已写入 / false=ready 失败），调用方 `Promise.all` 不需要改动。Resilience plan 后续会改 `Promise.all → Promise.allSettled`，但本 plan 不涉及。

```bash
grep -n "_rtSendToPty" main.js
```

确认所有调用点的接口未变。

- [ ] **Step 4: Smoke test**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

启动 Hub → 创建通用圆桌 → 等三家 CLI 启动完毕（看到提示符）→ 提交一个 prompt → 在三个面板看到 prompt 文本应该 < 1 秒。

**Acceptance:** 第 1 轮（冷启动）耗时 ≈ CLI 实际 ready 时间（不再加 8s 死等）；第 2 轮起 < 1 秒。Hub 能启动无报错。

---

## Task 3: 单元测试

**Files:**
- Create: `tests/unit-roundtable-fast-path.test.js`

**Background:** 用 mock SessionManager 验证四个分支：cache miss、cache hit 成功、cache hit 失败兜底成功、cache hit 失败兜底也失败。

- [ ] **Step 1: 写测试**

```js
'use strict';
const assert = require('assert');

// Mock SessionManager
function makeMockSm() {
  const state = new Map();
  const writes = [];
  return {
    state, writes,
    getRoundtableReady(sid) { return !!(state.get(sid)?.ready); },
    setRoundtableReady(sid, ready) {
      const s = state.get(sid) || {};
      s.ready = ready;
      state.set(sid, s);
    },
    getRoundtableLastActivity(sid) { return state.get(sid)?.lastActivity || 0; },
    writeToSession(sid, text) { writes.push({ sid, text }); },
    getSessionBuffer(sid) { return state.get(sid)?.buffer || ''; },
    // helper: simulate PTY echo
    simulateEcho(sid) {
      const s = state.get(sid) || {};
      s.lastActivity = Date.now();
      state.set(sid, s);
    },
    // helper: prepare cold-start ready marker
    primeBuffer(sid, text) {
      const s = state.get(sid) || {};
      s.buffer = text;
      state.set(sid, s);
    },
  };
}

// Re-implement the production function inline for testing (or refactor to import).
// For minimal scope, inline — when refactored to module, switch to require.
async function _rtWaitCliReady(sm, sid, kind, maxMs = 5000) {
  const markers = { claude: [], gemini: ['Type your message'], codex: ['gpt-5.5'] }[kind] || [];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const buf = sm.getSessionBuffer(sid) || '';
    if (markers.length === 0) { if (buf.length >= 1500) return true; }
    else if (markers.some(m => buf.includes(m))) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

async function _rtSendToPty(sm, sid, prompt, kind) {
  const ACTIVITY_WINDOW_MS = 100; // shortened for tests
  if (!sm.getRoundtableReady(sid)) {
    const ok = await _rtWaitCliReady(sm, sid, kind);
    if (!ok) return false;
    sm.setRoundtableReady(sid, true);
  }
  const before = sm.getRoundtableLastActivity(sid);
  sm.writeToSession(sid, prompt + '\r');
  await new Promise(r => setTimeout(r, ACTIVITY_WINDOW_MS));
  const after = sm.getRoundtableLastActivity(sid);
  if (after === before) {
    sm.setRoundtableReady(sid, false);
    const ok = await _rtWaitCliReady(sm, sid, kind);
    if (!ok) return false;
    sm.setRoundtableReady(sid, true);
    sm.writeToSession(sid, prompt + '\r');
  }
  return true;
}

async function testCacheMissThenHit() {
  const sm = makeMockSm();
  sm.primeBuffer('s1', 'gemini-3.1 ready\nType your message');
  // first call: cache miss → cold start → write
  setTimeout(() => sm.simulateEcho('s1'), 30); // simulate echo within window
  const r1 = await _rtSendToPty(sm, 's1', 'hello', 'gemini');
  assert.strictEqual(r1, true);
  assert.strictEqual(sm.writes.length, 1);
  assert.strictEqual(sm.getRoundtableReady('s1'), true, 'must be cached after first send');

  // second call: cache hit → fast path
  setTimeout(() => sm.simulateEcho('s1'), 30);
  const r2 = await _rtSendToPty(sm, 's1', 'world', 'gemini');
  assert.strictEqual(r2, true);
  assert.strictEqual(sm.writes.length, 2);
  console.log('  ✓ testCacheMissThenHit');
}

async function testActivityCheckFallsBack() {
  const sm = makeMockSm();
  sm.primeBuffer('s2', 'gemini-3.1 ready\nType your message');
  // prime ready
  sm.setRoundtableReady('s2', true);
  sm.simulateEcho('s2');
  // Now: do NOT echo within window → must fall back to cold-start retry
  const r = await _rtSendToPty(sm, 's2', 'hi', 'gemini');
  assert.strictEqual(r, true);
  // expected: 2 writes (initial + retry); ready re-cached
  assert.strictEqual(sm.writes.length, 2, 'fallback should produce a second write');
  assert.strictEqual(sm.getRoundtableReady('s2'), true);
  console.log('  ✓ testActivityCheckFallsBack');
}

async function testColdStartFails() {
  const sm = makeMockSm();
  // no buffer → markers never appear → cold start times out
  const r = await _rtSendToPty(sm, 's3', 'hi', 'gemini');
  assert.strictEqual(r, false);
  assert.strictEqual(sm.writes.length, 0);
  console.log('  ✓ testColdStartFails');
}

(async () => {
  await testCacheMissThenHit();
  await testActivityCheckFallsBack();
  await testColdStartFails();
  console.log('All fast-path tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run**

```bash
node tests/unit-roundtable-fast-path.test.js
```

三个 sub-test 全过。

**Note:** 这版测试是 inline 实现的（不 import 真实 main.js，因为 main.js 不是模块化的）。如果未来把 `_rtSendToPty` 抽成模块，把测试切换到 import 真实实现。

**Acceptance:** 三个测试通过。覆盖 cache miss / cache hit / 活性兜底 / 冷启动失败 四个分支。

---

## Verification Checklist (run before declaring complete)

- [ ] Hub smoke test: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20`
- [ ] 单元测试通过: `node tests/unit-roundtable-fast-path.test.js`
- [ ] **手动 E2E（关键，必须人工确认）**：
  1. 启动 Hub
  2. 创建通用圆桌
  3. 等三家 CLI 都看到提示符（首次 ready）
  4. 提交 prompt "你好"
  5. **掐表**：从回车到三个面板都看到 prompt 文本，应 < 1 秒
  6. 提交第二个 prompt
  7. **再掐表**：应 < 500ms
  8. （可选）按 Ctrl+C 在 Gemini 面板里中断 CLI 进程，再提交 prompt
  9. 验证活性兜底起作用：会自动重试，最终成功（耗时和首次差不多）
- [ ] 没有看到 console.error 报错（warn 是允许的——活性兜底失败时会 warn）
- [ ] 现有 `@debate` / `@summary` / 群策群力 流程仍能正常推进
- [ ] 私聊路径未受影响（不应改动私聊代码）
- [ ] 版本号在 UI 上更新（per CLAUDE.md 铁律）
- [ ] 改动 ≥ 3 文件 → 跑 `/post-refactor-verify`

---

## Rollback Plan

改动很集中（一个新模块字段 + 一个函数重写 + 一个常量），单 PR 即可整体 revert。如需 feature flag：

```js
const USE_FAST_PATH = process.env.HUB_RT_FAST_PATH !== '0';
async function _rtSendToPty(sid, prompt, kind) {
  if (!USE_FAST_PATH) return _rtSendToPty_v1(sid, prompt, kind);  // 旧实现保留
  // ... 新实现
}
```

只在生产出现问题时启用 flag 回退。

---

## Out of Scope (future P1)

- **orchestrator state.json 异步化**：`fs.writeFileSync` → `fs.promises.writeFile` + 不 await。收益约 30ms。
- **会议室创建后预热（pre-warm）**：在三个 sid 创建完毕、CLI 还在启动时就异步跑一轮 `_rtWaitCliReady` + `setRoundtableReady(true)`，让用户的第一个 prompt 也走快路径。
- **buffer-update 节流**：`pty.onData` 触发 `roundtableLastActivity = Date.now()` 节流到 16ms（一帧），避免高频 PTY 输出导致活性检查过于敏感。

如本 plan 落地后实测仍想再压一压冷启动延迟，可起新 plan：`2026-05-XX-roundtable-prewarm.md`。

---

## Quick Reference for Executing Worker

**Analysis source:** `docs/roundtable-latency-analysis-2026-04-30.html` — 三路 AI 独立分析报告，含瀑布图、根因表、伪代码、风险矩阵。

**Key files to keep open:**
- `main.js`（focus: 510-560）
- `core/session-manager.js`

**Project rules（必读）：**
- `CLAUDE.md` 铁律：node_modules 半坏防护 / 测试必须真实执行 / 版本号可见化 / 改 ≥ 3 文件后 `/post-refactor-verify`
- 不要在主工作目录跑 `npm run dist`
- 中文交互；代码/变量保持英文；路径输出绝对路径

**Key insight (do not lose this in implementation):**
> 这三条 sleep 是「冷启动税」被错误地每轮重收。CLI 的初始化（TUI alt-screen / OAuth / MCP server spawn）是<strong>持久且不可逆</strong>的——一旦完成不会回到未初始化状态。所以 sleep 只该做一次，不该每轮做。

---

**End of Plan.**
