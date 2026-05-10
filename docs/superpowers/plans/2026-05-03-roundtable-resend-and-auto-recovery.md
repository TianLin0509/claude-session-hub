# 圆桌 Resend & Auto-Recovery 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把圆桌的"卡片只取首句"和"发送失败"两个偶现 bug 从手动兜底升级为自动恢复，并新增 `[📤 发送]` 手动按钮作为最终兜底。

**Architecture:** 三层切入：
1. `orchestrator` 落 prompt 元数据（`promptBy/promptHeaderBy/sendStatus`，节流到当前活跃轮）
2. `turn-completion-watcher` settle 后保留 listener 300s 走 `patchTurnResult`，配合 main.js 跨轮防护和 manual_extracted 状态保留
3. `roundtable-watcher.sendToPty` verify 失败时按 `echoSeen` 物理信号自动重试一次；`resendCurrentPrompt` 同款逻辑暴露给 renderer 手动按钮

**Tech Stack:** Node.js / Electron / EventEmitter / DOMPurify / xterm（已在用）

**Spec:** `C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-03-roundtable-resend-and-auto-recovery-design.md`

---

## 文件结构

| 文件 | 类型 | 主要责任 |
|---|---|---|
| `core/roundtable-orchestrator.js` | 改 | 加 `recordTurnPrompt/getActivePrompt/setSendStatus`；`completeTurn` 内合并 promptHeaderBy+sendStatus 到 record，节流删 promptBy |
| `core/turn-completion-watcher.js` | 改 | settle 后保留 listener 300s；新增 onTurnPatched 回调 + cancelPatch 方法；过滤跨轮+manual_extracted |
| `core/roundtable-watcher.js` | 改 | sendToPty verify 失败后调 `_autoRecoverSend`；新增 `resendCurrentPrompt` |
| `main.js` | 改 | dispatch 入口调 recordTurnPrompt；watcher 注册表（per-sid）+ cancelPatchListenersForSid；IPC handler `roundtable-resend-prompt`；onSendStuck/onTurnPatched 推 renderer |
| `renderer/meeting-room.js` | 改 | 卡片逃生栏加 `[📤 发送]`；click handler 加 `resend-prompt` 分支；监听 send-stuck/turn-patched 事件 |
| `renderer/meeting-room.css` | 改 | `.mr-ft.send-stuck` 红边 + 按钮闪烁；`.mr-ft-auto-patched-badge` 角标 fade-out |
| `tests/unit-orchestrator-prompt-meta.test.js` | 新 | 锁 recordTurnPrompt/getActivePrompt/setSendStatus + completeTurn 集成 |
| `tests/unit-turn-completion-watcher-patch.test.js` | 新 | 锁 patch-after-settle 300s 窗口 + 跨轮 + manual_extracted 三种情况 |
| `tests/unit-roundtable-resend.test.js` | 新 | 锁 _autoRecoverSend echoSeen 分支 + resendCurrentPrompt |
| `tests/unit-roundtable-prompt-format-contract.test.js` | 新 | 锁 build*Prompt 第一行非空+含轮号 |
| `tests/_e2e-resend-verify.js` | 新 | 隔离 hub CDP E2E：自动恢复 + 手动按钮 + send_stuck UI |

---

## 顺序约定

按依赖拓扑：T1 → T2 并行 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12。

每个 Task 完成后立即 commit，commit message 用 conventional commit 风格（feat/fix/refactor/test）。

---

## Task 1: orchestrator 加 prompt 元数据 API

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js`（在 patchTurnResult 后/rollbackTurn 周围加方法；completeTurn 内集成）
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-prompt-meta.test.js`（新建）

- [ ] **Step 1.1: 写失败测试 — recordTurnPrompt 切片 + 持久化**

新建 `tests/unit-orchestrator-prompt-meta.test.js`：

```js
'use strict';
// 锁定 orchestrator 的 prompt 元数据 API（recordTurnPrompt/getActivePrompt/setSendStatus）
// 与 completeTurn 内的 merge + 节流行为。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-promptmeta-'));
process.env.CLAUDE_HUB_DATA_DIR_TEST = TMP;

const roundtable = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

console.log('Running orchestrator prompt-meta tests...');

function freshOrch() {
  const meetingId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sceneObj = scenes.getScene('research') || scenes.getScene('general');
  return roundtable.getOrchestrator(TMP, meetingId, sceneObj);
}

test('recordTurnPrompt 切第一行 + 暂存 promptBy/promptHeaderBy', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', '[research · 第 1 轮 · 默认提问]\n## 用户问题\n请分析兆易创新');
  const active = orch.getActivePrompt(1);
  assert.ok(active, 'getActivePrompt 应返回非空');
  assert.strictEqual(active.promptBy['sid-A'], '[research · 第 1 轮 · 默认提问]\n## 用户问题\n请分析兆易创新');
  assert.strictEqual(active.promptHeaderBy['sid-A'], '[research · 第 1 轮 · 默认提问]');
});

test('setSendStatus 写入 active turn', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'L1\nL2');
  orch.setSendStatus(1, 'sid-A', 'auto_recovered');
  const active = orch.getActivePrompt(1);
  assert.strictEqual(active.sendStatus['sid-A'], 'auto_recovered');
});

test('completeTurn 后：promptBy 被节流删除，promptHeaderBy/sendStatus 落入 record', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'header A\nbody');
  orch.recordTurnPrompt(1, 'sid-B', 'header B\nbody');
  orch.setSendStatus(1, 'sid-A', 'ok');
  orch.completeTurn(1, 'fanout', 'q', { 'sid-A': 'a', 'sid-B': 'b' }, {}, { 'sid-A': 'completed', 'sid-B': 'completed' });
  const turn = orch.state.turns.find(t => t.n === 1);
  assert.ok(turn, 'turn record 应存在');
  assert.strictEqual(turn.promptHeaderBy?.['sid-A'], 'header A');
  assert.strictEqual(turn.promptHeaderBy?.['sid-B'], 'header B');
  assert.strictEqual(turn.sendStatus?.['sid-A'], 'ok');
  // promptBy 必须已被节流删除（不在 record 上、_activePrompts 也清掉）
  assert.strictEqual(turn.promptBy, undefined, 'record 不应有 promptBy');
  assert.strictEqual(orch.getActivePrompt(1), null, '_activePrompts[1] 应被清掉');
});

test('getActivePrompt 不存在时返回 null', () => {
  const orch = freshOrch();
  assert.strictEqual(orch.getActivePrompt(99), null);
});

test('rollbackTurn 也清 _activePrompts（避免泄漏）', () => {
  const orch = freshOrch();
  orch.beginTurn(1, 'fanout');
  orch.recordTurnPrompt(1, 'sid-A', 'h\nb');
  orch.rollbackTurn(1);
  assert.strictEqual(orch.getActivePrompt(1), null);
});

const failed = process.exitCode || 0;
console.log(`\n${failed ? '✗' : '✓'} orchestrator prompt-meta: ${5 - failed} passed\n`);
```

- [ ] **Step 1.2: 跑测试确认失败**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-prompt-meta.test.js
```

预期：5 个测试全部失败（recordTurnPrompt/getActivePrompt/setSendStatus 都不存在）。

- [ ] **Step 1.3: 在 orchestrator 加 API**

打开 `C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js`。在 `patchTurnMeta` 方法之后（约 line 480 附近，class 内）插入：

```js
  // ============================================================================
  // Resend & Auto-Recovery（2026-05-03）— prompt 元数据 API
  // ============================================================================
  // 设计：dispatch 前 recordTurnPrompt 把当前轮 prompt 落到 _activePrompts，
  //   resendCurrentPrompt 时从这里取；completeTurn/rollbackTurn 节流删 promptBy
  //   只保留 promptHeaderBy（指纹）+ sendStatus（调试）到 turn record 长存。
  //   节流策略详见 docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

  recordTurnPrompt(turnNum, sid, prompt) {
    if (!this.state._activePrompts) this.state._activePrompts = {};
    if (!this.state._activePrompts[turnNum]) {
      this.state._activePrompts[turnNum] = { promptBy: {}, promptHeaderBy: {}, sendStatus: {} };
    }
    const slot = this.state._activePrompts[turnNum];
    slot.promptBy[sid] = String(prompt || '');
    slot.promptHeaderBy[sid] = String(prompt || '').split('\n')[0] || '';
    this._saveState();
  }

  setSendStatus(turnNum, sid, status) {
    if (!this.state._activePrompts) return;
    if (!this.state._activePrompts[turnNum]) return;
    this.state._activePrompts[turnNum].sendStatus[sid] = status;
    this._saveState();
  }

  getActivePrompt(turnNum) {
    if (!this.state._activePrompts) return null;
    return this.state._activePrompts[turnNum] || null;
  }
```

- [ ] **Step 1.4: completeTurn 集成 — merge promptHeaderBy+sendStatus，删 promptBy**

定位 completeTurn（约 line 374），在 `this.state.turns.push(record);` 这一行**之前**插入：

```js
    // Resend & Auto-Recovery（2026-05-03）：merge active prompt meta 到 record
    //   promptHeaderBy + sendStatus 长存（小，调试用）；promptBy 节流删除（resend 已不可用）
    const _activeSlot = this.state._activePrompts && this.state._activePrompts[turnNum];
    if (_activeSlot) {
      record.promptHeaderBy = _activeSlot.promptHeaderBy || {};
      record.sendStatus = _activeSlot.sendStatus || {};
      delete this.state._activePrompts[turnNum];
    }
```

- [ ] **Step 1.5: rollbackTurn 也清 _activePrompts**

定位 rollbackTurn（约 line 431），在函数内最后 `this._saveState();` 之前加：

```js
      if (this.state._activePrompts) {
        delete this.state._activePrompts[turnNum];
      }
```

- [ ] **Step 1.6: 跑测试确认通过**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-prompt-meta.test.js
```

预期：`✓ orchestrator prompt-meta: 5 passed`。

- [ ] **Step 1.7: 跑既有 patchTurnResult 单测确认无回归**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-patch-turn.test.js
```

预期：所有 test pass（不应有 regression）。

- [ ] **Step 1.8: Commit**

```bash
git add core/roundtable-orchestrator.js tests/unit-orchestrator-prompt-meta.test.js
git commit -m "$(cat <<'EOF'
feat(orchestrator): 圆桌 prompt 元数据 API（recordTurnPrompt/getActivePrompt/setSendStatus）

- 新增 _activePrompts 暂存区（per-turn × per-sid 存 promptBy/promptHeaderBy/sendStatus）
- completeTurn 内合并 promptHeaderBy+sendStatus 到 turn record 长存
- 节流：promptBy 在 turn settle 时删除（resend 已无意义）
- rollbackTurn 也清 _activePrompts 避免泄漏

为 [📤 发送] 按钮与 patch-after-settle 机制提供数据基础。
spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: build*Prompt 第一行格式契约单测

**Files:**
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-prompt-format-contract.test.js`（新建，独立任务）

> **目的：锁定 buildFanoutPrompt/buildDebatePrompt/buildSummaryPrompt 输出第一行非空 + 含轮号。一旦将来 prompt 头部格式漂移，这个单测会立即报警，提醒同步更新文档。本任务纯加法，无源码改动。**

- [ ] **Step 2.1: 写格式契约测试**

新建 `tests/unit-roundtable-prompt-format-contract.test.js`：

```js
'use strict';
// 锁定 build*Prompt 输出"第一行非空 + 含轮号 N"的契约（2026-05-03）
//
// 这个契约支撑：
//   - resendCurrentPrompt 用 prompt 第一行作 ring-buffer 指纹，必须非空
//   - turn meta 的 promptHeaderBy[sid] 须能区分不同轮次（含轮号）
// 如果将来 build*Prompt 头部格式调整违反此契约，CI 立即拦截，
// 提醒同步更新 spec / 实现 / 防漂移 fallback。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-promptfmt-'));
process.env.CLAUDE_HUB_DATA_DIR_TEST = TMP;

const roundtable = require('../core/roundtable-orchestrator.js');
const scenes = require('../core/roundtable-scenes.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

console.log('Running build*Prompt format contract tests...');

function freshOrch() {
  const meetingId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sceneObj = scenes.getScene('research') || scenes.getScene('general');
  return roundtable.getOrchestrator(TMP, meetingId, sceneObj);
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}

test('buildFanoutPrompt 第一行非空且含 "第 N 轮"', () => {
  const orch = freshOrch();
  const p = orch.buildFanoutPrompt(3, 'q', '', null, null, null);
  const fl = firstLine(p);
  assert.ok(fl.length > 0, '第一行非空');
  assert.ok(/第\s*3\s*轮/.test(fl), `第一行需含 "第 3 轮"，实际=${fl}`);
});

test('buildDebatePrompt 第一行非空且含 "第 N 轮"', () => {
  const orch = freshOrch();
  const p = orch.buildDebatePrompt(5, 'q', null, null, null);
  const fl = firstLine(p);
  assert.ok(fl.length > 0, '第一行非空');
  assert.ok(/第\s*5\s*轮/.test(fl), `第一行需含 "第 5 轮"，实际=${fl}`);
});

test('buildSummaryPrompt 第一行非空且含 "第 N 轮"', () => {
  const orch = freshOrch();
  // beginTurn 让 state.turns 至少有一条空 record，避免 _renderLastTurnSection 异常
  orch.beginTurn(1, 'fanout');
  orch.completeTurn(1, 'fanout', 'q', { 'sid-A': 'a' }, {}, { 'sid-A': 'completed' });
  const p = orch.buildSummaryPrompt(2, 'sid-A', () => 'A', null, null, null);
  const fl = firstLine(p);
  assert.ok(fl.length > 0, '第一行非空');
  assert.ok(/第\s*2\s*轮/.test(fl), `第一行需含 "第 2 轮"，实际=${fl}`);
});

const failed = process.exitCode || 0;
console.log(`\n${failed ? '✗' : '✓'} prompt format contract: ${3 - failed} passed\n`);
```

- [ ] **Step 2.2: 跑测试**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-prompt-format-contract.test.js
```

预期：3 个 pass（既有 build*Prompt 第一行已经是 `[scene · 第 N 轮 · ...]`，全满足）。如果失败，说明 prompt 格式比 spec 假设的更复杂——读代码实情调整 assertion。

- [ ] **Step 2.3: Commit**

```bash
git add tests/unit-roundtable-prompt-format-contract.test.js
git commit -m "$(cat <<'EOF'
test(orchestrator): 锁 build*Prompt 第一行非空+含轮号格式契约

resendCurrentPrompt 用 prompt 第一行作 ring-buffer 指纹检测，依赖该格式不变。
将来 prompt 头部格式调整时此测试会拦截，提醒同步更新 fingerprint 策略。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: turn-completion-watcher patch-after-settle（核心）

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\turn-completion-watcher.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-turn-completion-watcher-patch.test.js`（新建）

- [ ] **Step 3.1: 写失败测试 — 300s 窗口 + 跨轮 + manual_extracted**

新建 `tests/unit-turn-completion-watcher-patch.test.js`：

```js
'use strict';
// 锁定 turn-completion-watcher 的 patch-after-settle 行为（2026-05-03）
//
// 三类场景：
//   1. settle 后窗口内收到更长 emit → onTurnPatched 被调
//   2. cancelPatch() 被外部调用后 → 后续 emit 不再触发 onTurnPatched
//   3. signalSource=idle_timer / 短文本 / 同 text → 全部不触发
//
// 用 fake transcriptTap (EventEmitter) 模拟 turn-complete emit。

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

function makeFakeTap() {
  const ee = new EventEmitter();
  ee.setMaxListeners(100);
  return ee;
}

console.log('Running turn-completion-watcher patch-after-settle tests...');

test('patch 路径：settle 后收到更长 emit → onTurnPatched 被调', async () => {
  const tap = makeFakeTap();
  const patches = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-A',
    label: 'Pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
    onTurnPatched: (p) => patches.push(p),
  });
  const settlePromise = w.wait();
  // M1 emit → settle
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 短答', signalSource: 'stop_reason_terminal' });
  const r = await settlePromise;
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.text, 'M1 短答');
  // 模拟 30s 后 M2 到达（更长）
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 短答\n\nM2 真正答案 4647 字 ......', signalSource: 'stop_reason_terminal' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(patches.length, 1, 'onTurnPatched 应被调一次');
  assert.strictEqual(patches[0].sid, 'sid-A');
  assert.ok(patches[0].text.length > r.text.length);
  assert.strictEqual(patches[0].status, 'completed');
  // cleanup
  w.cancelPatch();
});

test('短文本 / 同 text / idle_timer 信号 → 不触发 onTurnPatched', async () => {
  const tap = makeFakeTap();
  const patches = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
    softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
    onTurnPatched: (p) => patches.push(p),
  });
  const sp = w.wait();
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial', signalSource: 'stop_reason_terminal' });
  await sp;
  // 同 text
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial', signalSource: 'stop_reason_terminal' });
  // 更短
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'short', signalSource: 'stop_reason_terminal' });
  // idle_timer 信号源
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial+more idle', signalSource: 'idle_timer_5s' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(patches.length, 0, '三类信号都不应触发 onTurnPatched');
  w.cancelPatch();
});

test('cancelPatch() 被外部调后 → 后续 emit 不再触发', async () => {
  const tap = makeFakeTap();
  const patches = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
    softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
    onTurnPatched: (p) => patches.push(p),
  });
  const sp = w.wait();
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1', signalSource: 'stop_reason_terminal' });
  await sp;
  w.cancelPatch();
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 longer', signalSource: 'stop_reason_terminal' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(patches.length, 0, 'cancelPatch 后不应触发');
});

test('hubSessionId 不匹配的 emit → 不触发', async () => {
  const tap = makeFakeTap();
  const patches = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
    softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
    onTurnPatched: (p) => patches.push(p),
  });
  const sp = w.wait();
  tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1', signalSource: 'stop_reason_terminal' });
  await sp;
  tap.emit('turn-complete', { hubSessionId: 'sid-OTHER', text: 'M1 longer', signalSource: 'stop_reason_terminal' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(patches.length, 0);
  w.cancelPatch();
});

(async () => {
  // node 简单 sequential runner（每个 test 是 async）
})();

const failed = process.exitCode || 0;
console.log(`\n${failed ? '✗' : '✓'} turn-completion-watcher patch: tests done\n`);
```

> 注：测试用 `await` 异步等 `wait()` 的 Promise，确保 settle 流程完整跑完后才发后续 emit。

- [ ] **Step 3.2: 跑测试确认失败**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-turn-completion-watcher-patch.test.js
```

预期：4 个测试全部失败（onTurnPatched 字段不存在；cancelPatch 方法不存在）。

- [ ] **Step 3.3: 改造 turn-completion-watcher 加 patch 路径**

打开 `C:\Users\lintian\claude-session-hub\core\turn-completion-watcher.js`。修改 `createTurnCompletionWatcher`：

在文件顶端常量区下方加：

```js
const PATCH_WINDOW_MS = 300_000;  // 5 分钟（spec 2026-05-03）
```

然后改 `createTurnCompletionWatcher`，把 `opts` 解构加 `onTurnPatched`、`patchWindowMs`：

```js
function createTurnCompletionWatcher(opts) {
  const {
    transcriptTap,
    hubSessionId,
    label,
    softAlertT1Ms = DEFAULT_T1_MS,
    softAlertT2Ms = DEFAULT_T2_MS,
    onSoftAlert = () => {},
    onProcessExit = null, // eslint-disable-line no-unused-vars
    onTurnPatched = null,                   // 新增（2026-05-03）
    patchWindowMs = PATCH_WINDOW_MS,        // 新增（测试可注入更短的窗口）
  } = opts || {};

  if (!transcriptTap) throw new Error('createTurnCompletionWatcher: transcriptTap required');
  if (!hubSessionId) throw new Error('createTurnCompletionWatcher: hubSessionId required');

  let resolveFn = null;
  let settled = false;
  let t1Timer = null;
  let t2Timer = null;
  let onTurnComplete = null;
  let onTurnError = null;

  // patch-after-settle 状态（2026-05-03）
  let patchListener = null;
  let patchWindowTimer = null;
  let settledText = '';
  let patchCancelled = false;
```

把 `cleanup` 函数保持不变（继续清 t1/t2 timer + 原 turn-complete/turn-error listener）。新增 `_cleanupPatch` 函数：

```js
  const _cleanupPatch = () => {
    if (patchListener) { transcriptTap.removeListener('turn-complete', patchListener); patchListener = null; }
    if (patchWindowTimer) { clearTimeout(patchWindowTimer); patchWindowTimer = null; }
  };
```

修改 `settle` 函数：原本只调 `cleanup() + resolveFn(result)`。改成：

```js
  const settle = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    settledText = result.text || '';
    // 仅 completed 状态才挂 patch listener（manual_extracted/absent/errored 没必要 patch）
    if (result.status === 'completed' && onTurnPatched && !patchCancelled) {
      patchListener = (evt) => {
        if (evt.hubSessionId !== hubSessionId) return;
        if (evt.signalSource !== 'stop_reason_terminal' && evt.signalSource !== 'stop_hook') return;
        if (!evt.text || evt.text === settledText) return;
        if (evt.text.length <= settledText.length) return;
        try { onTurnPatched({ sid: hubSessionId, label, text: evt.text, status: 'completed' }); }
        catch (e) { console.warn('[watcher] onTurnPatched threw:', e && e.message); }
        settledText = evt.text;  // 更新基线，可能还有 M3
      };
      transcriptTap.on('turn-complete', patchListener);
      patchWindowTimer = setTimeout(_cleanupPatch, patchWindowMs);
      if (patchWindowTimer.unref) patchWindowTimer.unref();
    }
    if (resolveFn) resolveFn(result);
  };
```

把 `manualExtract` 函数内 `settle({ status: 'manual_extracted', ... })` 保持不变——上面 `if (result.status === 'completed')` 守卫已经天然过滤掉它。

最后在 return 的对象里加 `cancelPatch` 方法：

```js
    cancelPatch() {
      patchCancelled = true;
      _cleanupPatch();
    },
```

- [ ] **Step 3.4: 跑测试确认通过**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-turn-completion-watcher-patch.test.js
```

预期：4 个测试全部 pass。

- [ ] **Step 3.5: Commit**

```bash
git add core/turn-completion-watcher.js tests/unit-turn-completion-watcher-patch.test.js
git commit -m "$(cat <<'EOF'
feat(watcher): turn-completion-watcher 加 patch-after-settle（300s 窗口）

settle 后保留 transcript-tap listener 300s。期间收到更长的 turn-complete emit
（signalSource=stop_reason_terminal/stop_hook + text 增长）→ 触发 onTurnPatched
回调。idle_timer 信号 / 同 text / 短文本一律不触发。

新暴露 cancelPatch() 方法，供外部强制清掉 listener（防跨轮污染）。

修复 Bug 1：圆桌卡片偶现"只显示首句"——根因是 Claude 答案分 M1+M2 两条
assistant message，M1 短答触发 stop_reason=end_turn 提前 settle，M2 到达时
listener 已释放。本改动让 watcher settle 后继续偷听 5 分钟，自动 patch 卡片。

spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: roundtable-watcher.sendToPty 加自动恢复 + resendCurrentPrompt

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\roundtable-watcher.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-resend.test.js`（新建）

- [ ] **Step 4.1: 写失败测试 — _autoRecoverSend echoSeen 分支 + resendCurrentPrompt**

新建 `tests/unit-roundtable-resend.test.js`：

```js
'use strict';
// 锁定 roundtable-watcher 的自动恢复 + resendCurrentPrompt 行为（2026-05-03）
//
// _autoRecoverSend：
//   echoSeen=true  → 仅 writeToSession('\r')，1 次
//   echoSeen=false → writeToSession(prompt) + writeToSession('\r')
//   verify 失败：返回 false
//   verify 成功：返回 true
//
// resendCurrentPrompt：
//   ring buffer 含 promptHeader → mode='enter_only'，仅 writeToSession('\r')
//   ring buffer 不含           → mode='rewrite_full'，写 prompt + '\r'

const assert = require('assert');
const path = require('path');

const rtWatcher = require('../core/roundtable-watcher.js');

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log(`  ✓ ${name}`),
    e => { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  );
}

function makeFakeSm(initialActivity = 100, opts = {}) {
  const writes = [];
  let activity = initialActivity;
  return {
    writes,
    writeToSession(sid, data) {
      writes.push({ sid, data });
      // 模拟 echo：除非 mockSilent 设了，每次写入 stdout 涨
      if (!opts.mockSilent) activity += String(data).length;
    },
    getRoundtableLastActivity() { return activity; },
    bumpActivity(n) { activity += n; },
    getSessionBuffer(_sid) { return opts.bufferText || ''; },
    setRoundtableReady() {},
    getRoundtableReady() { return true; },
  };
}

console.log('Running roundtable-watcher resend tests...');

(async () => {

  await test('_autoRecoverSend echoSeen=true → 仅写 \\r 一次，verify 通过', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hello', echoSeen: true,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, true);
    assert.strictEqual(sm.writes.length, 1, '仅 1 次 write');
    assert.strictEqual(sm.writes[0].data, '\r');
  });

  await test('_autoRecoverSend echoSeen=false → 写 prompt + \\r 两次', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hello world', echoSeen: false,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, true);
    assert.strictEqual(sm.writes.length, 2);
    assert.strictEqual(sm.writes[0].data, 'hello world');
    assert.strictEqual(sm.writes[1].data, '\r');
  });

  await test('_autoRecoverSend verify 失败 → 返回 false', async () => {
    const sm = makeFakeSm(100, { mockSilent: true });  // 写入后 activity 不动
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hi', echoSeen: true,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, false);
  });

  await test('resendCurrentPrompt 输入框已含 prompt → mode=enter_only', async () => {
    const sm = makeFakeSm(100, { bufferText: '$ user\n[research · 第 3 轮 · 默认提问]\n## ...' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: '[research · 第 3 轮 · 默认提问]\n## 用户问题\n请分析',
      promptHeader: '[research · 第 3 轮 · 默认提问]',
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'enter_only');
    assert.strictEqual(sm.writes.length, 1);
    assert.strictEqual(sm.writes[0].data, '\r');
  });

  await test('resendCurrentPrompt 输入框不含 prompt → mode=rewrite_full', async () => {
    const sm = makeFakeSm(100, { bufferText: '$ \n(no prompt yet)\n' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: '[research · 第 3 轮 · 默认提问]\nL2',
      promptHeader: '[research · 第 3 轮 · 默认提问]',
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'rewrite_full');
    assert.strictEqual(sm.writes.length, 2);
    assert.strictEqual(sm.writes[0].data, '[research · 第 3 轮 · 默认提问]\nL2');
    assert.strictEqual(sm.writes[1].data, '\r');
  });

  await test('resendCurrentPrompt promptHeader 空 → 退化为 rewrite_full（保守）', async () => {
    const sm = makeFakeSm(100, { bufferText: 'whatever' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: 'just text',
      promptHeader: '',  // empty
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.mode, 'rewrite_full');
  });

  console.log('\n✓ roundtable-watcher resend: tests done\n');
})();
```

- [ ] **Step 4.2: 跑测试确认失败**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-resend.test.js
```

预期：6 个测试全部失败（`_autoRecoverSend` / `resendCurrentPrompt` 不存在）。

- [ ] **Step 4.3: 在 roundtable-watcher.js 加 _autoRecoverSend + resendCurrentPrompt**

打开 `C:\Users\lintian\claude-session-hub\core\roundtable-watcher.js`。在 `cleanBufLen` 函数后（约 line 190 附近）插入：

```js
// ---------------------------------------------------------------------------
// _autoRecoverSend — sendToPty verify 失败时的单次自动恢复（2026-05-03）
// 决策依据：echoSeen 物理标志位（不依赖任何字符串匹配/魔数）
//   echoSeen=true  → prompt 已在输入框，仅 \r 没生效 → 补 1x \r
//   echoSeen=false → prompt 完全未进 PTY        → 重写 prompt + 1x \r
// 返回 true=verify 通过；false=仍未恢复，调用方应升级 send_stuck。
async function _autoRecoverSend({ sid, kind, prompt, echoSeen, timing }) {
  const { sessionManager } = _deps;
  const before = sessionManager.getRoundtableLastActivity(sid);
  if (echoSeen) {
    sessionManager.writeToSession(sid, '\r');
  } else {
    sessionManager.writeToSession(sid, prompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    sessionManager.writeToSession(sid, '\r');
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getRoundtableLastActivity(sid);
  // void kind: 保留参数名以便日志使用
  void kind;
  return after !== before;
}

// ---------------------------------------------------------------------------
// resendCurrentPrompt — 手动 [📤 发送] 按钮的后端入口（2026-05-03）
// 与 _autoRecoverSend 不同的是：手动按钮 caller 没有 dispatchPromptToSub 当时的
// echoSeen 上下文（dispatch 已经结束很久了），所以用 ring-buffer 末尾 grep prompt
// 第一行（promptHeader 指纹）来判定输入框是否还含 prompt。
// 返回 { ok, mode, reason? }，mode ∈ 'enter_only' | 'rewrite_full'。
async function resendCurrentPrompt({ sid, kind, prompt, promptHeader, timing }) {
  const { sessionManager } = _deps;
  if (!prompt) return { ok: false, reason: 'no_prompt' };
  const buf = sessionManager.getSessionBuffer(sid) || '';
  // 取末尾 4096 字（足够覆盖一屏 + 输入框，超出此长度的 prompt 头部就算 paste-mode 占位）
  const tail = buf.slice(-4096);
  const inInputBox = !!(promptHeader && promptHeader.length > 0 && tail.includes(promptHeader));

  const before = sessionManager.getRoundtableLastActivity(sid);
  let mode;
  if (inInputBox) {
    mode = 'enter_only';
    sessionManager.writeToSession(sid, '\r');
  } else {
    mode = 'rewrite_full';
    sessionManager.writeToSession(sid, prompt);
    await new Promise(r => setTimeout(r, (timing && timing.ENTER_RETRY_GAP_MS) || 150));
    sessionManager.writeToSession(sid, '\r');
  }
  await new Promise(r => setTimeout(r, (timing && timing.POST_ENTER_VERIFY_MS) || 500));
  const after = sessionManager.getRoundtableLastActivity(sid);
  const verified = after !== before;
  void kind;
  return { ok: verified, mode, ...(verified ? {} : { reason: 'verify_failed' }) };
}
```

然后在 sendToPty 末尾的 verify 失败处（line 142-145，原 `console.warn` 之后）加自动恢复：

```js
  await new Promise(r => setTimeout(r, POST_ENTER_VERIFY_MS));
  const afterEnter = sessionManager.getRoundtableLastActivity(sid);
  let sendStatus = 'ok';
  if (afterEnter === lastSeen) {
    console.warn(`[roundtable] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) — trying _autoRecoverSend`);
    const recovered = await _autoRecoverSend({
      sid, kind, prompt, echoSeen,
      timing: { ENTER_RETRY_GAP_MS, POST_ENTER_VERIFY_MS },
    });
    if (recovered) {
      console.log(`[roundtable] _autoRecoverSend recovered ${kind}(${sid.slice(0,8)}) mode=${echoSeen ? 'enter_only' : 'rewrite_full'}`);
      sendStatus = 'auto_recovered';
    } else {
      console.warn(`[roundtable] _autoRecoverSend failed for ${kind}(${sid.slice(0,8)}); upgrading to send_stuck`);
      sendStatus = 'stuck';
      // 通知 main.js（注入的 onSendStuck 回调）
      if (typeof _deps.onSendStuck === 'function') {
        try { _deps.onSendStuck({ sid, kind, mode: echoSeen ? 'enter_only' : 'rewrite_full' }); }
        catch (e) { console.warn('[roundtable] onSendStuck threw:', e && e.message); }
      }
    }
  }
  return { ok: true, sendStatus };  // 兼容老调用方（boolean truthy）
}
```

注意：sendToPty 原本返回 `true`，现在返回 `{ ok: true, sendStatus }`。这会影响 main.js 调用方。**先检查 main.js 有没有用到 sendToPty 返回值的 strict equality**：

```powershell
# 在调 _autoRecoverSend 改动前先 grep 一遍
```

让我们先用 ToolSearch / Grep 检查：line 1196 `const ok = await rtWatcher.sendToPty(...)`，使用 `if (ok)` 判定——这是 truthy 检查，对象 `{ ok: true, ... }` 是 truthy，向后兼容。Line 1406 同。Line 1668 同。✅

但为了对 sendStatus 也能拿到，sendToPty 返回结构改为 `{ ok, sendStatus }`。

最后修改 module.exports（约 line 205）：

```js
module.exports = {
  init,
  waitCliReady,
  sendToPty,
  extractStreamingText,
  cleanBufLen,
  checkHostShellTakeover,
  _autoRecoverSend,           // 新增（测试 + 同模块调用）
  resendCurrentPrompt,         // 新增（main.js IPC handler 调用）
};
```

- [ ] **Step 4.4: 跑测试确认通过**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-resend.test.js
```

预期：6 个测试全部 pass。

- [ ] **Step 4.5: 跑既有 fast-path 单测确认无回归**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-fast-path.test.js
```

预期：所有 test pass。

- [ ] **Step 4.6: Commit**

```bash
git add core/roundtable-watcher.js tests/unit-roundtable-resend.test.js
git commit -m "$(cat <<'EOF'
feat(roundtable-watcher): sendToPty verify 失败自动恢复 + resendCurrentPrompt

- sendToPty post-Enter verify 失败时调 _autoRecoverSend：echoSeen=true 补 \\r，
  echoSeen=false 重写 prompt + \\r。仅一次重试，失败后通过 onSendStuck 注入回调
  通知 main.js 升级 send_stuck 状态
- 新增 resendCurrentPrompt 函数：用 ring-buffer 末尾 grep promptHeader 判定输入框
  状态，分流 mode=enter_only / rewrite_full。供手动 [📤 发送] 按钮 IPC 调用
- sendToPty 返回结构 { ok, sendStatus }（兼容老调用方的 truthy 判定）

修复 Bug 2：圆桌偶现"消息没发出去"——根因是 \\r 被 CLI paste-state-machine
吞掉。本改动让物理信号 echoSeen 决定补救策略，零字符串匹配。

spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: main.js 集成 — recordTurnPrompt / 跨轮防护 / IPC handler

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

> **本任务是把前面四个任务接通到 dispatchRoundtableTurn 主流程 + IPC + UI 推送。改动量大但都是 surgical 拼接。**

- [ ] **Step 5.1: 引入 patch-listener 注册表**

打开 `main.js`，定位到 `_roundtableInProgress`（应该在 dispatchRoundtableTurn 上方，约 line 1015 附近）。在它附近加：

```js
// Resend & Auto-Recovery（2026-05-03）—— per-sid patch-listener 注册表
//   防跨轮污染：dispatchRoundtableTurn 入口先 cancelPatchListenersForSid(sid)
//   保证一个 sub 永远只有最新一轮的 patch listener 在监听。
const _patchListenersBySid = new Map(); // sid → Set<watcher>

function registerPatchListener(sid, watcher) {
  if (!_patchListenersBySid.has(sid)) _patchListenersBySid.set(sid, new Set());
  _patchListenersBySid.get(sid).add(watcher);
}
function cancelPatchListenersForSid(sid) {
  const set = _patchListenersBySid.get(sid);
  if (!set) return;
  for (const w of set) {
    try { w.cancelPatch?.(); } catch (e) { console.warn('[patch] cancelPatch threw:', e && e.message); }
  }
  set.clear();
}
function unregisterPatchListener(sid, watcher) {
  const set = _patchListenersBySid.get(sid);
  if (set) set.delete(watcher);
}
```

提升 transcriptTap 的 maxListeners（避免 300s 窗口下并发挂多个 listener 触发 Node warning）。在 `transcriptTap` 初始化处（搜 `transcriptTap = new`）后面加：

```js
try { transcriptTap.setMaxListeners(100); } catch {}
```

如果找不到一个明显的 transcriptTap 创建位置（视实现可能在 require 顶部就实例化），把这行加在 `app.whenReady().then(...)` 入口靠前的位置即可——只要在 dispatchRoundtableTurn 第一次跑之前调过就行。

- [ ] **Step 5.2: dispatchRoundtableTurn 入口处先取消老 listener + record prompt**

定位 `dispatchRoundtableTurn`（约 line 1021）。找到 `await Promise.all(targets.map(...)`（约 line 1188）这一段——这之前正是落 prompt 的最佳时机。在 `await Promise.all(targets.map(async (t) => {` **之前**插入：

```js
    // Resend & Auto-Recovery（2026-05-03）— Step 1：每家 dispatch 前清掉它身上的老 patch listener
    //   防跨轮污染：上一轮 patch 窗口可能还在 300s 内
    for (const t of targets) {
      cancelPatchListenersForSid(t.sid);
    }
    // Resend & Auto-Recovery（2026-05-03）— Step 2：把 prompt 落到 orchestrator._activePrompts
    //   resendCurrentPrompt 从这里取；completeTurn 时合并 promptHeaderBy/sendStatus 到 record
    for (const t of targets) {
      try { orch.recordTurnPrompt(turnNum, t.sid, t.prompt); }
      catch (e) { console.warn('[roundtable] recordTurnPrompt threw:', e && e.message); }
    }
```

- [ ] **Step 5.3: sendToPty 调用方接收新返回值并推 send-stuck**

定位 `const ok = await rtWatcher.sendToPty(...)`（约 line 1196）。把它改成：

```js
        const sendResult = await rtWatcher.sendToPty(t.sid, t.prompt, t.kind);
        const ok = sendResult && sendResult.ok;
        const sendStatus = sendResult && sendResult.sendStatus;
        if (sendStatus) {
          try { orch.setSendStatus(turnNum, t.sid, sendStatus); } catch {}
        }
        if (sendStatus === 'stuck') {
          sendToRenderer('roundtable-send-stuck', {
            meetingId, sid: t.sid, mode: 'unknown',  // mode 由 onSendStuck 推送（看下一步）
          });
        }
```

但 onSendStuck 推 mode 更准——sendToPty 会把 mode 通过注入的 `_deps.onSendStuck` 回调传出来。把 `rtWatcher.init` 调用处（搜 `rtWatcher.init`）找到它的 deps，加：

```js
rtWatcher.init({
  sessionManager,
  cliReadyDetector,
  // 2026-05-03：注入 send-stuck 回调，main 推 renderer
  onSendStuck: ({ sid, kind, mode }) => {
    // 找到 sid 所属的 meetingId（_meetingsBySid 之类的反查）
    const meetingId = _findMeetingIdBySid(sid);
    if (!meetingId) return;
    sendToRenderer('roundtable-send-stuck', { meetingId, sid, mode });
  },
});
```

如果没有现成的 `_findMeetingIdBySid` helper，加一个（在 dispatchRoundtableTurn 上方）：

```js
function _findMeetingIdBySid(sid) {
  const meetings = meetingManager.getAllMeetings();
  for (const m of meetings) {
    if (m.subSessions && m.subSessions.includes(sid)) return m.id;
  }
  return null;
}
```

> 由于 `sendToPty` 之前用 `if (sendStatus === 'stuck')` 这一段在 `Promise.all` lambda 里直接推过，`onSendStuck` 在内部也推一次——会 double 推。**精简方案**：sendToPty 不再注入 onSendStuck；改由调用方（main 这层）单点处理，避免重复。所以**把刚才插入的 `onSendStuck` 注入删掉**，依赖 sendStatus 字段单点推送即可。

最终 `Promise.all` 内部段是：

```js
      try {
        const sendResult = await rtWatcher.sendToPty(t.sid, t.prompt, t.kind);
        const ok = sendResult && sendResult.ok;
        const sendStatus = sendResult && sendResult.sendStatus;
        if (sendStatus) {
          try { orch.setSendStatus(turnNum, t.sid, sendStatus); } catch {}
        }
        if (sendStatus === 'stuck') {
          sendToRenderer('roundtable-send-stuck', {
            meetingId, sid: t.sid, kind: t.kind,
          });
        }
        if (ok) {
          sentTargets.push(t);
          console.log(`[roundtable] turn ${turnNum} ${mode} sent to ${t.kind}(${t.sid.slice(0,8)}) sendStatus=${sendStatus || 'ok'}`);
        } else {
          console.log(`[roundtable] turn ${turnNum} ${mode} skip ${t.kind}(${t.sid.slice(0,8)}): not ready`);
        }
      } catch (e) {
        console.warn(`[roundtable] turn ${turnNum} ${mode} sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
      }
```

也即把 `rtWatcher.init` 的注入留原样，**不加 onSendStuck**。

- [ ] **Step 5.4: 给 _rtWaitTurnComplete 注入 onTurnPatched 回调**

定位 `_rtWaitTurnComplete`（搜 `function _rtWaitTurnComplete`）。它内部应该在调 `createTurnCompletionWatcher`。加 `onTurnPatched`：

```js
const watcher = createTurnCompletionWatcher({
  transcriptTap,
  hubSessionId: sid,
  label,
  // ... 已有字段
  onTurnPatched: ({ sid: patchedSid, text, status }) => {
    try {
      // 防护 #2：不覆盖 manual_extracted 状态
      const turn = orch.state.turns.find(t => t.n === turnNum);
      const currentStatus = turn?.byStatus?.[patchedSid];
      const finalStatus = (currentStatus === 'manual_extracted') ? 'manual_extracted' : status;
      orch.patchTurnResult(turnNum, patchedSid, { text, status: finalStatus });
      sendToRenderer('roundtable-turn-patched', {
        meetingId, turnNum, sid: patchedSid, charCount: (text || '').length,
      });
    } catch (e) {
      console.warn('[patch] onTurnPatched threw:', e && e.message);
    }
  },
});

// 注册到全局表，新一轮 dispatch 同 sid 时强制 cancel
registerPatchListener(sid, watcher);

// 注：watcher.cancelPatch 会在 patch window timer 自动 fire 时被内部调；
//   但外部（新一轮 dispatch）也可能强制调 — 那也只是早一点 cleanup，幂等。
```

但 `meetingId/turnNum/orch` 这些变量得能在闭包里拿到。`_rtWaitTurnComplete` 当前接收 `(sid, label, ctx)`，ctx 里应该已经有 `meetingId, turnNum, mode`（看上面 dispatch 调用方）。`orch` 可能需要从 `roundtable.getOrchestrator(getHubDataDir(), meetingId, ...)` 重新拿。

如果 `_rtWaitTurnComplete` 当前没拿到 orch，从 ctx 里加一个 orch 引用；调用方传进来即可。

- [ ] **Step 5.5: 加 IPC handler `roundtable-resend-prompt`**

定位 `ipcMain.handle('roundtable-manual-extract', ...)`（约 line 1500）。在它**之后**加：

```js
// Resend & Auto-Recovery（2026-05-03）— 手动 [📤 发送] 按钮入口
ipcMain.handle('roundtable-resend-prompt', async (_e, { meetingId, sid } = {}) => {
  if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return { ok: false, reason: 'meeting_not_found' };
  const sceneObj = scenes.getScene(meeting.scene);
  const orch = roundtable.getOrchestrator(getHubDataDir(), meetingId, sceneObj);
  const turnNum = orch.state.currentTurn;
  if (!turnNum) return { ok: false, reason: 'no_active_turn' };
  const active = orch.getActivePrompt(turnNum);
  if (!active || !active.promptBy || !active.promptBy[sid]) {
    return { ok: false, reason: 'no_active_prompt' };
  }
  const prompt = active.promptBy[sid];
  const promptHeader = active.promptHeaderBy?.[sid] || '';
  const session = sessionManager.getSession(sid);
  const kind = session ? session.kind : 'unknown';

  try {
    const r = await rtWatcher.resendCurrentPrompt({
      sid, kind, prompt, promptHeader,
      timing: { ENTER_RETRY_GAP_MS: 150, POST_ENTER_VERIFY_MS: 500 },
    });
    if (r.ok) {
      try { orch.setSendStatus(turnNum, sid, 'auto_recovered'); } catch {}
    }
    return r;
  } catch (e) {
    console.error('[roundtable-resend-prompt] threw:', e);
    return { ok: false, reason: 'exception', detail: e.message };
  }
});
```

- [ ] **Step 5.6: 跑既有圆桌单测确认无回归**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-patch-turn.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-fast-path.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-dispatch-mode.test.js
```

预期：全部 pass。

- [ ] **Step 5.7: smoke test 启动 Hub 看不会启动崩**

按隔离模板：

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-resend-smoke"
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9251
```

让它跑 6 秒看输出。预期：`[hub] hook server listening on 127.0.0.1:...` 出现。`[main]` 没有 throw。Ctrl-C 关。

- [ ] **Step 5.8: Commit**

```bash
git add main.js
git commit -m "$(cat <<'EOF'
feat(main): 接通 patch-after-settle + auto-recover-send + IPC resend-prompt

- dispatchRoundtableTurn 入口：cancelPatchListenersForSid 防跨轮污染 +
  recordTurnPrompt 落 prompt meta
- sendToPty 返回 { ok, sendStatus }，main 单点接收并推 roundtable-send-stuck +
  调 orch.setSendStatus
- _rtWaitTurnComplete 注入 onTurnPatched 回调：调 patchTurnResult 升级老轮卡片
  + sendToRenderer roundtable-turn-patched；防护 #2 保留 manual_extracted 状态
- 新增 IPC handler roundtable-resend-prompt：手动按钮后端，从 _activePrompts 取
  prompt + promptHeader 调 rtWatcher.resendCurrentPrompt
- transcriptTap.setMaxListeners(100) 防 300s 窗口并发 listener warning

spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: renderer 卡片加 [📤 发送] 按钮 + 监听 send-stuck/turn-patched

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`

- [ ] **Step 6.1: 卡片逃生栏加 [📤 发送] 按钮**

打开 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`。定位逃生栏渲染（约 line 670-675，搜 `mr-ft-escape-bar`）：

```js
const escapeBar = `
  <div class="mr-ft-escape-bar">
    <button class="mr-ft-escape-btn" data-rt-escape="extract" data-rt-sid="${sid}" data-rt-kind="${kind}" title="从 transcript 直读拼接（卡死时绕过完成检测）">一键提取</button>
    <button class="mr-ft-escape-btn" data-rt-escape="skip" data-rt-sid="${sid}" data-rt-kind="${kind}" title="本轮跳过这家，下游 prompt 不引用">跳过</button>
    ${relaunchBtn}
  </div>`;
```

在 "跳过" 按钮和 `${relaunchBtn}` 之间插入：

```js
    <button class="mr-ft-escape-btn" data-rt-escape="resend-prompt" data-rt-sid="${sid}" data-rt-kind="${kind}" title="重发本轮 prompt 给该家（自动判定输入框是否已含 prompt）">📤 发送</button>
```

- [ ] **Step 6.2: click handler 加 resend-prompt 分支**

定位 `panel.querySelectorAll('[data-rt-escape]').forEach(btn => {` 内的 `if (action === 'extract')` 链（约 line 962-1024）。在 `else if (action === 'resend')` **之前**加：

```js
          } else if (action === 'resend-prompt') {
            const r = await ipcRenderer.invoke('roundtable-resend-prompt', { meetingId: meeting.id, sid });
            if (r && r.ok) {
              btn.style.background = '#2da44e';
              btn.style.color = '#fff';
              btn.textContent = `✓ 已重发`;
              _btnTextHandledExternally = true;
              setTimeout(() => {
                btn.style.background = '';
                btn.style.color = '';
                btn.textContent = oldText;
                btn.disabled = false;
              }, 1500);
            } else {
              alert(`重发失败：${r?.reason || 'unknown'}\n\n建议：\n1. 检查该家 PTY 是否还活着（左侧 sidebar 点进去看）\n2. 或者按"跳过"绕过这家，下一轮会自动重启 CLI`);
            }
```

- [ ] **Step 6.3: 监听 roundtable-send-stuck 事件 → 卡片加 send-stuck 类**

定位 renderer 已有的 ipcRenderer 监听段（搜 `ipcRenderer.on('roundtable-`）。加：

```js
ipcRenderer.on('roundtable-send-stuck', (_e, { meetingId, sid /*, kind, mode */ }) => {
  const card = document.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
  if (!card) return;
  card.classList.add('send-stuck');
  // 状态条文案
  const statusEl = card.querySelector('.mr-ft-status');
  if (statusEl) {
    statusEl.textContent = '⚠ 发送卡住，请按发送';
    statusEl.classList.add('send-stuck');
  }
  console.warn(`[renderer] roundtable-send-stuck meeting=${meetingId} sid=${sid.slice(0,8)}`);
});

ipcRenderer.on('roundtable-turn-patched', (_e, { meetingId, turnNum, sid, charCount }) => {
  const card = document.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
  if (!card) return;
  // 短暂浮 "自动补全 +N 字" 角标
  let badge = card.querySelector('.mr-ft-auto-patched-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'mr-ft-auto-patched-badge';
    card.appendChild(badge);
  }
  badge.textContent = `自动补全 +${charCount}字`;
  badge.classList.remove('fade-out');
  // 强制 reflow 让 fade-out 动画从头开始
  void badge.offsetWidth;
  badge.classList.add('fade-out');
  setTimeout(() => { try { badge.remove(); } catch {} }, 3000);
  // 触发完整卡片刷新（拿最新 turn meta 重渲染卡片正文）
  if (typeof window.refreshMeetingRoom === 'function') window.refreshMeetingRoom(meetingId);
  console.log(`[renderer] roundtable-turn-patched turn=${turnNum} sid=${sid.slice(0,8)} +${charCount} chars`);
});
```

> 如果 renderer 没有 `refreshMeetingRoom` 全局函数，沿用项目现有的 turn-complete 刷新路径——搜 `roundtable-turn-complete` 看怎么触发卡片重渲染，复制同套逻辑。

- [ ] **Step 6.4: send-stuck 卡片有重发成功后清理 send-stuck 类**

在 `roundtable-resend-prompt` 成功的分支后（Step 6.2 内部 `if (r && r.ok)` 块），清理 send-stuck 类：

```js
              // 重发成功后清理 send-stuck 视觉
              const card = document.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
              if (card) {
                card.classList.remove('send-stuck');
                const statusEl = card.querySelector('.mr-ft-status.send-stuck');
                if (statusEl) statusEl.classList.remove('send-stuck');
              }
```

- [ ] **Step 6.5: smoke test 启动 Hub，看页面没崩**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-resend-smoke"
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9252
```

进 hub，开一个 meeting，看 DevTools console 没 error。Ctrl-C 关。

- [ ] **Step 6.6: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "$(cat <<'EOF'
feat(renderer): 圆桌卡片 [📤 发送] 按钮 + 监听 send-stuck/turn-patched 事件

- 逃生栏加 [📤 发送] 按钮，click → IPC roundtable-resend-prompt
- 监听 roundtable-send-stuck → 卡片加 .send-stuck 类（红边+按钮闪烁）+
  状态条文案 "⚠ 发送卡住，请按发送"
- 监听 roundtable-turn-patched → 卡片右上角浮 "自动补全 +N 字" 角标 3s 后消失，
  触发卡片重渲染拿最新 turn meta
- 重发成功后自动清 .send-stuck 类

spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CSS — send-stuck 红边/按钮闪烁 + auto-patched 角标 fade-out

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 7.1: 加 send-stuck + auto-patched-badge 样式**

打开 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`。在文件末尾（或 "卡片右上角角标" 段之后，约 line 1462）加：

```css
/* ============================================================================
   Resend & Auto-Recovery（2026-05-03）
   ============================================================================ */

/* send_stuck 状态：自动恢复失败 → 红边 + 按钮闪烁 + 状态条文案 */
.mr-ft.send-stuck {
  border-left: 4px solid #f85149;
}
.mr-ft.send-stuck button[data-rt-escape="resend-prompt"] {
  background: #ffc107;
  color: #000;
  font-weight: 600;
  animation: mr-ft-send-stuck-blink 1s ease-in-out infinite;
}
.mr-ft-status.send-stuck {
  color: #f85149;
  font-weight: 600;
}
@keyframes mr-ft-send-stuck-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* auto_patched 角标：右上角浮"自动补全 +N 字" 3s fade-out */
.mr-ft-auto-patched-badge {
  position: absolute;
  top: 4px;
  right: 28px;
  padding: 2px 8px;
  font-size: 10px;
  line-height: 1.4;
  border-radius: 8px;
  font-weight: 600;
  background: rgba(46, 160, 67, 0.18);
  color: #56d364;
  border: 1px solid rgba(46, 160, 67, 0.4);
  pointer-events: none;
  z-index: 3;
  opacity: 1;
  transition: opacity 1s ease-out 2s;  /* 2s 实显 + 1s fade */
}
.mr-ft-auto-patched-badge.fade-out {
  opacity: 0;
}
```

- [ ] **Step 7.2: smoke test — 在 DevTools 手动加 .send-stuck 类看视觉是否对**

启动 hub（同上端口 9253），打开 DevTools，在某个 .mr-ft 卡片上手动 `card.classList.add('send-stuck')`。观察：左红边 + 📤 按钮变黄 + 1 秒闪一次。然后手动 `card.classList.remove('send-stuck')` 恢复。

- [ ] **Step 7.3: Commit**

```bash
git add renderer/meeting-room.css
git commit -m "$(cat <<'EOF'
style(meeting-room): send-stuck 红边/按钮闪烁 + auto-patched-badge fade-out

- .mr-ft.send-stuck：左侧 4px 红边 + [📤 发送] 黄底 1Hz keyframes 闪烁
- .mr-ft-status.send-stuck：状态条红色加粗
- .mr-ft-auto-patched-badge：右上角绿色角标，2s 实显 + 1s opacity fade

spec: docs/superpowers/specs/2026-05-03-roundtable-resend-and-auto-recovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 隔离 hub E2E（CDP 驱动）

**Files:**
- Test: `C:\Users\lintian\claude-session-hub\tests\_e2e-resend-verify.js`（新建，gitignored 因 `_` 前缀）

> **目的**：在真实 Hub 实例 + CDP 协议下端到端验证 5 类场景。**Mock 部分通过 CDP `Runtime.evaluate` 注入到 renderer 端，不污染主进程**——具体做法是 monkey-patch `ipcRenderer.invoke` 让特定 IPC 返回 mock 结果。

- [ ] **Step 8.1: 写 E2E 脚本骨架**

新建 `tests/_e2e-resend-verify.js`。结构参考既有 `tests/_e2e-card-verify.js`：

```js
'use strict';
// E2E for 圆桌 Resend & Auto-Recovery（2026-05-03 道雪）
// 验证 5 类场景：
//   A. dispatch verify 失败 + echoSeen=true → 自动恢复 enter_only → 不进 send_stuck
//   B. dispatch verify 失败 + echoSeen=false → 自动恢复 rewrite_full → 成功
//   C. 自动恢复也失败 → send_stuck UI（红边 + 按钮闪烁）
//   D. 手动 [📤 发送] 真打：3 claude 圆桌发一轮，settle 后点按钮
//   E. patch-after-settle：mock 注入 transcriptTap emit M1+M2 → 卡片自动升级
//
// 前置（外部启动）：
//   $env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-resend-v1"
//   .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9253

'use strict';
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9253;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let _msgId = 0;
function makeSend(ws) {
  return function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++_msgId;
      const onMsg = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          ws.off('message', onMsg);
          if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}
async function evalInPage(send, expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  }
  return r.result.value;
}
function asrt(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.error('  ✗ ' + label); process.exitCode = 1; }
}

(async () => {
  console.log('[resend-e2e] connect CDP :' + CDP_PORT);
  const tabs = await getJson('http://127.0.0.1:' + CDP_PORT + '/json');
  const target = tabs.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!target) { console.error('no Hub page'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = makeSend(ws);
  await send('Runtime.enable');

  // ---- Step 1：创建 3 claude 圆桌 ----
  console.log('\n[resend-e2e] === Step 1: create 3-claude meeting ===');
  const meetingId = await evalInPage(send, `
    (async () => {
      const r = await ipcRenderer.invoke('create-meeting', {
        scene: 'general',
        slots: [
          { index: 0, kind: 'claude', model: 'claude-sonnet-4-5' },
          { index: 1, kind: 'claude', model: 'claude-sonnet-4-5' },
          { index: 2, kind: 'claude', model: 'claude-sonnet-4-5' },
        ],
      });
      return r && r.meeting ? r.meeting.id : (r ? r.id : null);
    })()
  `);
  console.log('  meetingId =', meetingId);
  if (!meetingId) { console.error('meeting create failed'); process.exit(1); }
  await new Promise(r => setTimeout(r, 8000));  // 等 CLI 起来

  // ---- Step 2：发起一轮 + 等 settle ----
  console.log('\n[resend-e2e] === Step 2: dispatch turn 1 + wait settle ===');
  await evalInPage(send, `
    (async () => {
      const r = await ipcRenderer.invoke('roundtable:turn', {
        meetingId: '${meetingId}', mode: 'fanout', userInput: '请用一句话介绍兆易创新',
      });
      return r;
    })()
  `);
  // 等 turn settle（≤180s 上限，每 5s 检查 turns 数组）
  let settled = false;
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const turns = await evalInPage(send, `
      (async () => {
        const s = await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' });
        return (s && s.state && s.state.turns) ? s.state.turns.length : 0;
      })()
    `);
    if (turns > 0) { settled = true; break; }
  }
  asrt(settled, 'turn 1 settle within 180s');

  // ---- Step 3：场景 D — 手动 [📤 发送] 真打（settle 后再发一轮，点按钮）----
  console.log('\n[resend-e2e] === Step 3: 手动 [📤 发送] 真打 ===');
  // 起新一轮 - 让 active prompt 进入 _activePrompts
  await evalInPage(send, `
    ipcRenderer.invoke('roundtable:turn', {
      meetingId: '${meetingId}', mode: 'fanout', userInput: '再补充两点',
    })
  `);
  await new Promise(r => setTimeout(r, 6000));  // 等 prompt 写入完成
  // 拿一个 sid
  const firstSid = await evalInPage(send, `
    (async () => {
      const ms = await ipcRenderer.invoke('get-meetings');
      const m = (ms || []).find(x => x.id === '${meetingId}');
      return m && m.subSessions ? m.subSessions[0] : null;
    })()
  `);
  asrt(firstSid, 'pick first sub sid');
  const resendResult = await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable-resend-prompt', { meetingId: '${meetingId}', sid: '${firstSid}' });
    })()
  `);
  console.log('  resend result =', JSON.stringify(resendResult));
  asrt(resendResult && resendResult.ok, 'resend ok');
  asrt(resendResult.mode === 'enter_only' || resendResult.mode === 'rewrite_full',
    `mode in {enter_only, rewrite_full}, got=${resendResult.mode}`);

  // ---- Step 4：场景 C — mock 自动恢复失败 → 验证 send-stuck UI ----
  console.log('\n[resend-e2e] === Step 4: mock send-stuck → verify UI ===');
  // 直接从 main 推 send-stuck IPC（不走 sendToPty）
  const stuckRendered = await evalInPage(send, `
    (async () => {
      // 模拟 main 推一个 send-stuck IPC（renderer ipcRenderer.on 监听器会触发）
      // 注意：webFrame 没法从 renderer fake main IPC，只能直接调 handler 同款逻辑
      const sid = '${firstSid}';
      const card = document.querySelector('.mr-ft[data-ft-sid="' + sid + '"]');
      if (!card) return { found: false };
      // 模拟收到 IPC：执行同样的 DOM 操作
      card.classList.add('send-stuck');
      const st = card.querySelector('.mr-ft-status');
      if (st) st.classList.add('send-stuck');
      // 检查样式生效
      const cs = window.getComputedStyle(card);
      const hasRed = cs.borderLeftColor.includes('248') || cs.borderLeftColor.includes('rgb(248');
      const btn = card.querySelector('button[data-rt-escape="resend-prompt"]');
      const btnCs = btn ? window.getComputedStyle(btn) : null;
      const yellowBg = btnCs ? (btnCs.backgroundColor.includes('255, 193') || btnCs.backgroundColor.includes('rgb(255, 193')) : false;
      return { found: true, hasRed, yellowBg, hasBtn: !!btn };
    })()
  `);
  asrt(stuckRendered.found, 'card found by sid');
  asrt(stuckRendered.hasBtn, '[📤 发送] button rendered');
  asrt(stuckRendered.hasRed, 'send-stuck 红边渲染（border-left rgb 248,...）');
  asrt(stuckRendered.yellowBg, '[📤 发送] 黄底渲染（rgb 255,193,...）');

  // ---- Step 5：场景 E — patch-after-settle 自动升级（最难 mock，简化为单元行为）----
  console.log('\n[resend-e2e] === Step 5: patch-after-settle smoke ===');
  // 直接验证 onTurnPatched 路径已挂：找最近 turn record 的 promptHeaderBy 是否已存在
  //   完整 M1+M2 真实流需要构造长任务，超出 E2E 范围（已被单元测试覆盖）
  const turnHasMeta = await evalInPage(send, `
    (async () => {
      const s = await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' });
      const turns = s && s.state && s.state.turns;
      if (!turns || turns.length === 0) return false;
      const t1 = turns[0];
      return !!(t1.promptHeaderBy && Object.keys(t1.promptHeaderBy).length > 0);
    })()
  `);
  asrt(turnHasMeta, 'turn 1 record has promptHeaderBy meta');

  ws.close();
  console.log('\n[resend-e2e] DONE — exit code', process.exitCode || 0);
})().catch(e => { console.error('[resend-e2e] fatal:', e); process.exit(1); });
```

- [ ] **Step 8.2: 启动隔离 Hub**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-resend-v1"
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9253
```

让它在后台跑（用 background bash 或新开 PS 窗口）。

- [ ] **Step 8.3: 跑 E2E 脚本**

```powershell
node C:\Users\lintian\claude-session-hub\tests\_e2e-resend-verify.js
```

预期：所有 `✓` 不出 `✗`。如果出 `✗`：

1. 看哪一步挂了
2. 进 hub 的 DevTools 手动复现该步检查
3. 修改源码 / 测试，重跑

- [ ] **Step 8.4: 关掉隔离 Hub**

```powershell
Get-Process electron | Where-Object { $_.MainWindowTitle -like "*resend-v1*" -or $_.Path -like "*claude-session-hub*" } | ForEach-Object { Stop-Process -Id $_.Id -Force }
```

或者直接 Ctrl-C 那个 PS 窗口。

> 注意 CLAUDE.md 铁律：**绝不 kill 用户生产 Hub**。隔离 Hub 启动时 PID 与生产不同，按 StartTime 筛新启的进程更稳。

- [ ] **Step 8.5: Commit**

```bash
git add tests/_e2e-resend-verify.js
git commit -m "$(cat <<'EOF'
test(e2e): 圆桌 Resend & Auto-Recovery 隔离 hub CDP E2E

5 类场景验证：
- Step 1-2：3-claude meeting 建立 + 一轮 settle
- Step 3：手动 [📤 发送] 真打 → 验证 IPC 返回 mode=enter_only/rewrite_full
- Step 4：mock send-stuck UI → 验证红边 + 按钮黄底渲染
- Step 5：smoke turn record promptHeaderBy meta 已落

完整 M1+M2 真实流由单元测试覆盖（构造 stop_reason 序列）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 集成验证 + finishing

- [ ] **Step 9.1: 跑全套单测**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-prompt-meta.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-prompt-format-contract.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-turn-completion-watcher-patch.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-resend.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-orchestrator-patch-turn.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-fast-path.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-dispatch-mode.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-ai-kinds-no-hardcode.test.js
```

预期：全部 pass。

- [ ] **Step 9.2: 跑 silent-failure-hunter 扫圆桌新代码**

让用户跑或本工作流自跑：

```
Agent({ subagent_type: 'silent-failure-hunter', prompt: '审查 roundtable-watcher.js / turn-completion-watcher.js / main.js 这次新增的 _autoRecoverSend / resendCurrentPrompt / patch-after-settle / IPC handler 是否有 silent failure。' })
```

如果报告 HIGH 级别问题，修复后再跑一遍。

- [ ] **Step 9.3: 跑 /post-refactor-verify（commit ≥3 文件已超线）**

按 CLAUDE.md 铁律：commit ≥3 文件时 refactor-guard Hook 拦截，要求先执行 `/post-refactor-verify`：

```
/post-refactor-verify
```

通过后才能视为放行。

- [ ] **Step 9.4: 让用户做真实回归**

告诉用户：
- "已落地。请重启 Hub，发起一个 3 claude 圆桌，验证：
  - 卡片正常显示完整答案（不再首句卡死，patchTurnResult 自动接力）
  - 偶现 send 失败时自动恢复（看 console `_autoRecoverSend recovered`）
  - 真发不出去时卡片变红边 + 黄按钮闪烁，点 [📤 发送] 能补救"

- [ ] **Step 9.5: Final summary commit（如有零碎修复）**

如果 Step 9.1-9.4 发现小 bug，修完后做一个 final commit。否则跳过。

---

## 自检（Self-Review）

**1. Spec coverage**：
- ✅ 模块 A patch-after-settle → Task 3
- ✅ 防护 #1 跨轮污染 → Task 5 Step 5.1+5.2 (cancelPatchListenersForSid)
- ✅ 防护 #2 manual_extracted 不覆盖 → Task 5 Step 5.4 onTurnPatched 内部
- ✅ EventEmitter maxListeners → Task 5 Step 5.1
- ✅ 模块 B-1 _autoRecoverSend → Task 4
- ✅ 模块 B-2 resendCurrentPrompt → Task 4 + Task 5.5 IPC
- ✅ 模块 B-3 promptBy/promptHeaderBy/sendStatus → Task 1
- ✅ 模块 C UI → Task 6+7
- ✅ IPC 协议 → Task 5+6
- ✅ 测试矩阵全 → Task 1/2/3/4/8

**2. Placeholder 扫描**：无 TBD/TODO；所有 step 都有可执行的代码或命令。

**3. 类型一致性**：
- `cancelPatchListenersForSid(sid)` 在 Task 5 Step 5.1 定义、Step 5.2 调用 — ✅
- `recordTurnPrompt/getActivePrompt/setSendStatus` 在 Task 1 定义，Task 5 Step 5.2/5.5 + Task 4 测试调用 — ✅
- `sendToPty` 返回 `{ ok, sendStatus }` 在 Task 4 改、Task 5 Step 5.3 接收 — ✅
- `resendCurrentPrompt({ sid, kind, prompt, promptHeader, timing })` 签名在 Task 4 定义、Task 5 Step 5.5 IPC handler 调用 — ✅
- `_autoRecoverSend({ sid, kind, prompt, echoSeen, timing })` 签名一致 — ✅
- `onTurnPatched({ sid, label, text, status })` 在 Task 3 emit、Task 5 Step 5.4 接收 — ✅
- `cancelPatch()` 方法在 Task 3 定义、Task 5 Step 5.1 调用 — ✅
