# 圆桌讨论容错机制升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决"Gemini 慢响应导致整个圆桌锁死 10 分钟"的卡死 bug；让任一 AI 异常时圆桌仍可推进；为用户提供「手动提取 / 跳过 / 重发」三类逃生通道。

**Architecture:** 引入三层完成信号模型（L1 协议事件 / L2 进程退出 / L3 启发式软提醒）。Gemini 检测从启发式 `tokens.total` 升级为官方 `type:"result"` 事件 + `message_update` 终结行 fallback。废除 600s 强制 watchdog，改用 90s/180s 软提醒 banner（不强制终结）。`Promise.all` 改为 `Promise.allSettled` 解除单家阻塞。新增 IPC 通道 `roundtable-manual-extract` / `roundtable-skip-participant` / `roundtable-resend-participant`，从 transcript JSONL 直读最新一段拼接。状态机从 4 态扩为 8 态。

**Tech Stack:** Node.js, Electron IPC, xterm.js, EventEmitter

**Spec:** `docs/superpowers/specs/2026-04-30-roundtable-resilience-design.md`

**Visual Reference:** `docs/roundtable-resilience-2026-04-30.html`

---

## Scope

本 plan 实施 **P0** 全部内容（根因修复 + 用户逃生）。P1（状态机重构）/ P2（Codex 多 turn 加固）/ P3（协议级 IPC）作为独立后续 plan 提交，不在本 plan 范围内但在文末列出 outline。

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| **Modify** | `core/transcript-tap.js:520-606` | Gemini JSONL tail 增加 `type:"result"` 与 `message_update` 终结行识别 |
| **Modify** | `core/transcript-tap.js`（新增方法） | 暴露 `extractLatestGeminiTurn(hubSessionId, sincePromptTs)` 给手动提取使用 |
| **Modify** | `core/roundtable-orchestrator.js:21` | 删除 `TURN_WATCHDOG_MS` 强制超时；新增 `SOFT_ALERT_T1_MS = 90000` 与 `SOFT_ALERT_T2_MS = 180000` |
| **Create** | `core/turn-completion-watcher.js` | 新模块封装单家 AI 等待逻辑（替代 `_rtWaitTurnComplete`），支持 manual/skip/resend 信号源 |
| **Modify** | `main.js:564-589` | `_rtWaitTurnComplete` 重构为 `turn-completion-watcher` 调用入口 |
| **Modify** | `main.js:676-684` | `Promise.all` → `Promise.allSettled` |
| **Modify** | `main.js`（新增 IPC handlers） | 注册 `roundtable-manual-extract` / `roundtable-skip-participant` / `roundtable-resend-participant` 三个 IPC |
| **Modify** | `renderer/meeting-room.js:194` | `statusLabel` 字典扩展（manual_extracted / absent / soft_alert / errored / interrupted / transport_lost） |
| **Modify** | `renderer/meeting-room.js:160-218` | AI 卡片渲染加 row4 逃生工具栏（条件渲染） |
| **Modify** | `renderer/meeting-room.js:220-235` | `_ftHtml` 增加 corner-badge（manual / absent） |
| **Modify** | `renderer/meeting-room.js:1243` | 推进按钮 disabled 条件改写（`inProgress && !allSettled`） |
| **Modify** | `renderer/meeting-room.js`（新增） | 圆桌主区域 soft-alert banner 渲染 + 事件绑定 |
| **Modify** | `renderer/meeting-room.css`（或对应 CSS） | 新增样式：`.mr-ft-escape-bar`、`.mr-ft-corner-badge`、`.mr-rt-soft-alert-banner` |
| **Create** | `tests/unit-turn-completion-watcher.test.js` | 单元测试：watcher 三种信号源（auto / manual / skip） |
| **Create** | `tests/unit-transcript-tap-gemini-result.test.js` | 单元测试：`type:"result"` 与 `message_update` 行识别 |
| **Create** | `tests/e2e-roundtable-resilience.test.js` | E2E 测试：6 个场景（见 spec §测试要求） |

---

## Task 1: Gemini L1 信号识别（transcript-tap 升级）

**Files:**
- Modify: `core/transcript-tap.js:520-606`
- Create: `tests/unit-transcript-tap-gemini-result.test.js`

**Background:** 当前 `transcript-tap.js:568-570` 仅监听 `obj.tokens.total != null`，是启发式信号。Gemini CLI v0.40+ 的 JSONL 还会写两类更强的信号行：(1) `type:"result"`（headless `--output-format stream-json` 模式）；(2) `message_update` 行（TUI/JSONL 模式标记某条消息已 finalized）。本任务让 transcript-tap 同时识别这三类，任一触发即 emit turn-complete。

- [ ] **Step 1: Write failing test for `type:"result"` recognition**

```js
// tests/unit-transcript-tap-gemini-result.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptTap } = require('../core/transcript-tap');

function tmpJsonl(lines) {
  const p = path.join(os.tmpdir(), `gemini-test-${Date.now()}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

async function testResultEventTriggers() {
  const tap = new TranscriptTap();
  let captured = null;
  tap.on('turn-complete', (e) => { captured = e; });

  const sid = 'test-sid-1';
  const file = tmpJsonl([
    { type: 'gemini', content: 'partial answer here' },
    { type: 'result', content: 'partial answer here', stats: { totalTokens: 42 } }
  ]);
  tap._bindGeminiForTest(sid, file); // helper to be added
  await new Promise(r => setTimeout(r, 800));
  assert.ok(captured, 'turn-complete should fire on type:"result"');
  assert.strictEqual(captured.text, 'partial answer here');
  console.log('  ✓ testResultEventTriggers');
}

async function testMessageUpdateTriggers() {
  const tap = new TranscriptTap();
  let captured = null;
  tap.on('turn-complete', (e) => { captured = e; });

  const sid = 'test-sid-2';
  const file = tmpJsonl([
    { type: 'gemini', content: 'hello world' },
    { type: 'message_update', messageId: 'm1', status: 'finalized', content: 'hello world' }
  ]);
  tap._bindGeminiForTest(sid, file);
  await new Promise(r => setTimeout(r, 800));
  assert.ok(captured, 'turn-complete should fire on message_update finalized');
  console.log('  ✓ testMessageUpdateTriggers');
}

async function testTokensTotalStillWorks() {
  const tap = new TranscriptTap();
  let captured = null;
  tap.on('turn-complete', (e) => { captured = e; });

  const sid = 'test-sid-3';
  const file = tmpJsonl([
    { type: 'gemini', content: 'fallback answer', tokens: { total: 17 } }
  ]);
  tap._bindGeminiForTest(sid, file);
  await new Promise(r => setTimeout(r, 800));
  assert.ok(captured, 'tokens.total backward compat should still work');
  console.log('  ✓ testTokensTotalStillWorks');
}

(async () => {
  await testResultEventTriggers();
  await testMessageUpdateTriggers();
  await testTokensTotalStillWorks();
  console.log('All gemini result tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
```

Run: `node tests/unit-transcript-tap-gemini-result.test.js` — expect failure (the new signal types not yet recognized).

- [ ] **Step 2: Implement signal recognition in `transcript-tap.js:568-570`**

Locate the JSONL line handler around line 568. Replace:

```js
// before
if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null
    && typeof obj.content === 'string' && obj.content.trim().length > 0) {
  emitIfComplete(obj.content);
}
```

with multi-signal recognition:

```js
// after
const isResultEvent = obj?.type === 'result' && typeof obj.content === 'string' && obj.content.trim().length > 0;
const isMessageUpdate = obj?.type === 'message_update' && obj.status === 'finalized'
    && typeof obj.content === 'string' && obj.content.trim().length > 0;
const isTokensTotal = obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null
    && typeof obj.content === 'string' && obj.content.trim().length > 0;

if (isResultEvent || isMessageUpdate || isTokensTotal) {
  const source = isResultEvent ? 'result_event'
    : isMessageUpdate ? 'message_update'
    : 'tokens_total';
  emitIfComplete(obj.content, { signalSource: source });
}
```

Update `emitIfComplete` to accept and forward `signalSource` in the event payload (consumers may want to log which signal fired).

- [ ] **Step 3: Add `_bindGeminiForTest` helper**

Add a non-production helper for tests at the bottom of `transcript-tap.js`:

```js
if (process.env.NODE_ENV === 'test' || process.env.HUB_TEST === '1') {
  TranscriptTap.prototype._bindGeminiForTest = function(hubSessionId, jsonlPath) {
    // simplified binding for unit tests
    this._bound.set(hubSessionId, { kind: 'gemini', jsonlPath, lastText: '' });
    // hook up tail here, reusing existing tail logic
  };
}
```

Note: see existing test patterns in `tests/unit-*.test.js` for tap binding conventions if any helper already exists.

- [ ] **Step 4: Re-run unit tests**

```bash
HUB_TEST=1 node tests/unit-transcript-tap-gemini-result.test.js
```

Expect all three sub-tests to pass.

- [ ] **Step 5: Smoke test Hub startup**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Must see `[hub] hook server listening on 127.0.0.1:...`. If `Cannot find module` → run `npm install` per CLAUDE.md.

**Acceptance:** All three unit tests pass. Hub smoke-test passes. No regression on existing `tokens.total` path.

---

## Task 2: 创建 `core/turn-completion-watcher.js`

**Files:**
- Create: `core/turn-completion-watcher.js`
- Create: `tests/unit-turn-completion-watcher.test.js`

**Background:** 把当前内联在 `main.js:564-589` 的 `_rtWaitTurnComplete` 抽出成独立模块，并扩展支持三个新信号源：`onManualExtract` / `onSkip` / `onResend`。新模块以 EventEmitter 风格暴露状态变化（包括 `soft_alert` 90s/180s 节点）。

- [ ] **Step 1: Write failing test for watcher lifecycle**

```js
// tests/unit-turn-completion-watcher.test.js
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');

async function testCompletesOnTurnComplete() {
  const tap = new EventEmitter();
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 's1', label: 'gemini-1',
  });
  const p = w.wait();
  setTimeout(() => tap.emit('turn-complete', { hubSessionId: 's1', text: 'hi' }), 50);
  const r = await p;
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.text, 'hi');
  console.log('  ✓ testCompletesOnTurnComplete');
}

async function testManualExtract() {
  const tap = new EventEmitter();
  const w = createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 's2', label: 'gemini-1' });
  const p = w.wait();
  setTimeout(() => w.manualExtract('manually pulled text'), 50);
  const r = await p;
  assert.strictEqual(r.status, 'manual_extracted');
  assert.strictEqual(r.text, 'manually pulled text');
  console.log('  ✓ testManualExtract');
}

async function testSkip() {
  const tap = new EventEmitter();
  const w = createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 's3', label: 'gemini-1' });
  const p = w.wait();
  setTimeout(() => w.skip(), 30);
  const r = await p;
  assert.strictEqual(r.status, 'absent');
  assert.strictEqual(r.text, '');
  console.log('  ✓ testSkip');
}

async function testSoftAlertFiresAndDoesNotResolve() {
  const tap = new EventEmitter();
  const events = [];
  const w = createTurnCompletionWatcher({
    transcriptTap: tap, hubSessionId: 's4', label: 'gemini-1',
    softAlertT1Ms: 200, softAlertT2Ms: 400, // shortened for test
    onSoftAlert: (level) => events.push(level),
  });
  const p = w.wait();
  // do not trigger anything; wait 500ms
  await new Promise(r => setTimeout(r, 500));
  assert.deepStrictEqual(events, ['t1', 't2']);
  // promise still pending
  let resolved = false;
  p.then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(resolved, false, 'must NOT auto-resolve on soft alert');
  // now skip to clean up
  w.skip();
  await p;
  console.log('  ✓ testSoftAlertFiresAndDoesNotResolve');
}

(async () => {
  await testCompletesOnTurnComplete();
  await testManualExtract();
  await testSkip();
  await testSoftAlertFiresAndDoesNotResolve();
  console.log('All watcher tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Implement `core/turn-completion-watcher.js`**

```js
// core/turn-completion-watcher.js
'use strict';

const SOFT_ALERT_T1_MS = 90000;
const SOFT_ALERT_T2_MS = 180000;

function createTurnCompletionWatcher(opts) {
  const {
    transcriptTap, hubSessionId, label,
    softAlertT1Ms = SOFT_ALERT_T1_MS,
    softAlertT2Ms = SOFT_ALERT_T2_MS,
    onSoftAlert = () => {},
    onProcessExit = null, // optional L2 signal source
  } = opts;

  let resolveFn = null;
  let settled = false;
  let t1Timer = null, t2Timer = null;

  const cleanup = () => {
    if (t1Timer) clearTimeout(t1Timer);
    if (t2Timer) clearTimeout(t2Timer);
    transcriptTap.removeListener('turn-complete', onTurnComplete);
    transcriptTap.removeListener('turn-error', onTurnError);
  };

  const settle = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveFn(result);
  };

  const onTurnComplete = (evt) => {
    if (evt.hubSessionId !== hubSessionId) return;
    settle({
      sid: hubSessionId, label,
      status: 'completed',
      text: evt.text || '',
      signalSource: evt.signalSource || 'unknown',
      completedAt: evt.completedAt || Date.now(),
    });
  };

  const onTurnError = (evt) => {
    if (evt.hubSessionId !== hubSessionId) return;
    settle({
      sid: hubSessionId, label,
      status: 'errored',
      text: '',
      reason: evt.reason || 'unknown',
    });
  };

  return {
    wait() {
      return new Promise((resolve) => {
        resolveFn = resolve;
        transcriptTap.on('turn-complete', onTurnComplete);
        transcriptTap.on('turn-error', onTurnError);
        t1Timer = setTimeout(() => onSoftAlert('t1'), softAlertT1Ms);
        t2Timer = setTimeout(() => onSoftAlert('t2'), softAlertT2Ms);
      });
    },
    manualExtract(text) {
      settle({
        sid: hubSessionId, label,
        status: 'manual_extracted',
        text: text || '',
        signalSource: 'manual',
      });
    },
    skip() {
      settle({
        sid: hubSessionId, label,
        status: 'absent',
        text: '',
      });
    },
    isSettled() { return settled; },
  };
}

module.exports = { createTurnCompletionWatcher, SOFT_ALERT_T1_MS, SOFT_ALERT_T2_MS };
```

- [ ] **Step 3: Run tests**

```bash
node tests/unit-turn-completion-watcher.test.js
```

All four sub-tests pass.

**Acceptance:** Module exports `createTurnCompletionWatcher`. Tests pass. No `setTimeout` for forced timeout / settle exists in the module — settling only happens on turn-complete, turn-error, manualExtract, or skip.

---

## Task 3: 重构 `main.js` orchestrator 调用点

**Files:**
- Modify: `main.js:564-589` (`_rtWaitTurnComplete`)
- Modify: `main.js:676-684` (Promise.all → allSettled)
- Modify: `core/roundtable-orchestrator.js:21` (constants update)

- [ ] **Step 1: Replace `TURN_WATCHDOG_MS` constant**

In `core/roundtable-orchestrator.js:21`:

```js
// before
const TURN_WATCHDOG_MS = 600000; // 10 min

// after
const SOFT_ALERT_T1_MS = 90000;  // 90s — first soft alert
const SOFT_ALERT_T2_MS = 180000; // 180s — escalated soft alert
// no forced watchdog — turn never auto-terminates without an L1/L2/manual/skip signal
```

Export both constants (the orchestrator's `wait` call site needs them, and so do future tests).

- [ ] **Step 2: Refactor `_rtWaitTurnComplete` in `main.js`**

Locate around `main.js:564-589`. Replace the inline implementation with a call to the new watcher module:

```js
const { createTurnCompletionWatcher } = require('./core/turn-completion-watcher');

function _rtWaitTurnComplete(sid, label, callbacks) {
  const watcher = createTurnCompletionWatcher({
    transcriptTap,
    hubSessionId: sid,
    label,
    onSoftAlert: (level) => {
      sendToRenderer('roundtable-soft-alert', { sid, label, level });
      // also propagate per-participant partial state for UI
      sendToRenderer('roundtable-partial-update', { sid, status: 'soft_alert', alertLevel: level });
    },
  });
  // store reference so the IPC handlers (Task 4) can call manualExtract/skip on it
  _activeWatchers.set(sid, watcher);
  return watcher.wait().finally(() => _activeWatchers.delete(sid));
}

const _activeWatchers = new Map(); // module-level
```

Remove the old `setTimeout(... , watchdogMs)` block entirely.

- [ ] **Step 3: Change `Promise.all` to `Promise.allSettled` at `main.js:676-684`**

```js
// before
const results = await Promise.all(sentTargets.map(t =>
  _rtWaitTurnComplete(t.sid, t.label, ...)
));

// after
const settled = await Promise.allSettled(sentTargets.map(t =>
  _rtWaitTurnComplete(t.sid, t.label)
));
const results = settled.map((r, i) => {
  if (r.status === 'fulfilled') return r.value;
  // promise itself rejected (should be rare since watcher only resolves) — treat as errored
  return { sid: sentTargets[i].sid, label: sentTargets[i].label, status: 'errored', text: '' };
});
```

- [ ] **Step 4: Update downstream consumers of `results`**

Search for any code that expected `status` to be only `'completed'` / `'timeout'`. Update to handle: `completed`, `manual_extracted`, `absent`, `errored`. Common locations:
- Roundtable history persistence (state writeback)
- Prompt builder for `@debate` / `@summary` / 群策群力 — must skip `absent` and `errored` participants
- Renderer state sync via `sendToRenderer`

Search command (Bash, not Grep tool — quick check):
```bash
grep -n "status === 'timeout'\|status === \"timeout\"\|'completed'" main.js core/*.js renderer/meeting-room.js
```

- [ ] **Step 5: Smoke test Hub startup**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

**Acceptance:** Hub starts. Manual click-through: create roundtable → submit prompt → all three AIs complete → next round permitted. No regression on happy path.

---

## Task 4: IPC handlers — manual-extract / skip / resend

**Files:**
- Modify: `main.js` (new IPC handlers)
- Modify: `core/transcript-tap.js` (new method `extractLatestGeminiTurn`)

- [ ] **Step 1: Implement `extractLatestGeminiTurn` in transcript-tap.js**

Add a new method to `TranscriptTap`:

```js
/**
 * Read latest gemini turn directly from JSONL, without requiring tokens.total / type:"result".
 * Used by manual extract escape hatch.
 * @param {string} hubSessionId
 * @param {number} sincePromptTs - epoch ms; only consider gemini lines whose ts >= this value
 * @returns {Promise<{ text: string, lineCount: number, source: 'manual' }|null>}
 */
async extractLatestGeminiTurn(hubSessionId, sincePromptTs) {
  const entry = this._bound.get(hubSessionId);
  if (!entry || entry.kind !== 'gemini' || !entry.jsonlPath) return null;

  const fs = require('fs/promises');
  let raw;
  try { raw = await fs.readFile(entry.jsonlPath, 'utf8'); }
  catch (e) { return null; }

  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const collected = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'gemini') continue;
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp
              : typeof obj.ts === 'number' ? obj.ts
              : null;
    if (ts !== null && ts < sincePromptTs) continue; // skip prior turns
    if (typeof obj.content === 'string' && obj.content.trim()) {
      collected.push(obj.content);
    }
  }
  if (collected.length === 0) return null;
  // dedupe consecutive identical chunks (some Gemini versions write streaming + final identical line)
  const deduped = collected.filter((s, i) => i === 0 || s !== collected[i - 1]);
  const text = deduped.join('').trim();
  return { text, lineCount: deduped.length, source: 'manual' };
}
```

Note: the exact timestamp field name in Gemini JSONL must be verified. If neither `timestamp` nor `ts` exists, fall back to "all gemini lines after the last `type:"user"` line" — adjust accordingly during implementation.

- [ ] **Step 2: Register IPC handlers in main.js**

Add near other roundtable IPC registrations:

```js
ipcMain.handle('roundtable-manual-extract', async (_evt, { meetingId, sid, sincePromptTs }) => {
  const watcher = _activeWatchers.get(sid);
  if (!watcher) return { ok: false, reason: 'no_active_watcher' };
  const extracted = await transcriptTap.extractLatestGeminiTurn(sid, sincePromptTs);
  if (!extracted || !extracted.text) {
    return { ok: false, reason: 'no_text_in_transcript' };
  }
  watcher.manualExtract(extracted.text);
  return { ok: true, text: extracted.text, lineCount: extracted.lineCount };
});

ipcMain.handle('roundtable-skip-participant', async (_evt, { meetingId, sid }) => {
  const watcher = _activeWatchers.get(sid);
  if (!watcher) return { ok: false, reason: 'no_active_watcher' };
  watcher.skip();
  return { ok: true };
});

ipcMain.handle('roundtable-resend-participant', async (_evt, { meetingId, sid }) => {
  // Implementation: cancel current watcher (skip), then re-dispatch the prompt to that one AI only.
  // Reuse existing single-target dispatch path; details depend on current orchestrator API.
  const watcher = _activeWatchers.get(sid);
  if (watcher) watcher.skip(); // settle the old watcher first
  // TODO: invoke single-target re-dispatch (refer to existing dispatch path in orchestrator)
  return { ok: true };
});
```

**Note for resend**: the actual re-dispatch logic depends on the orchestrator's existing API. Inspect `core/roundtable-orchestrator.js` for a per-target dispatch method; if not present, factor one out. Keep this sub-task minimal — if cleanly factoring takes more than 30 min, log a TODO and ship resend as P0.5 in a follow-up.

- [ ] **Step 3: Document the IPC contract**

Add JSDoc above each handler describing arg shape and return shape (this is the contract the renderer relies on). The renderer (Task 5) will call `ipcRenderer.invoke('roundtable-manual-extract', {...})`.

- [ ] **Step 4: Smoke test**

Hub startup + open DevTools console + manually invoke:

```js
await window.electron.ipcRenderer.invoke('roundtable-manual-extract', {
  meetingId: '<...>', sid: '<gemini-sid>', sincePromptTs: Date.now() - 60000
});
```

Should return `{ ok: true, text: '...' }` if Gemini has any content in its transcript.

**Acceptance:** Three IPC handlers registered. Manual invocation from DevTools returns expected shape. Hub smoke-test passes.

---

## Task 5: 渲染器 UI — 逃生工具栏 + 软提醒 banner + 状态扩展

**Files:**
- Modify: `renderer/meeting-room.js:160-218` (card render)
- Modify: `renderer/meeting-room.js:194` (statusLabel)
- Modify: `renderer/meeting-room.js:220-235` (`_ftHtml` corner badge)
- Modify: `renderer/meeting-room.js:1243-1269` (button disabled logic)
- Modify: `renderer/meeting-room.js` (new banner rendering)
- Modify: corresponding CSS file (search for `.mr-ft` styles)

- [ ] **Step 1: Extend `statusLabel` dictionary**

`renderer/meeting-room.js:194`:

```js
const statusLabel = {
  idle: '待命',
  thinking: '思考中',
  streaming: '输出中',
  completed: '已答 ✓',
  manual_extracted: '已答 ✓',
  absent: '本轮缺席',
  soft_alert: '等待中',
  errored: '错误',
  interrupted: '已中断',
  transport_lost: '连接断开',
  // legacy 'timeout' kept for backward-compat with existing state files
  timeout: '超时',
}[status] || status;
```

- [ ] **Step 2: Map partial-update events to new states**

Search for `'roundtable-partial-update'` listener in renderer. Currently only handles `streaming`/`completed`/`timeout`. Extend to map:
- `partial.status === 'soft_alert'` + `partial.alertLevel === 't1'|'t2'` → set status `soft_alert`, render banner
- `partial.status === 'manual_extracted'` → set state, show 蓝 corner badge
- `partial.status === 'absent'` → set state, show 灰 corner badge
- `partial.status === 'errored'` → set state, show 红字

Also add a new IPC listener for `'roundtable-soft-alert'` to render the banner (separately from per-card state).

- [ ] **Step 3: Render escape toolbar (row4) in card**

Modify `_ftHtml` (around line 220-235) or the card builder:

```js
// pseudo-code; merge into existing builder
const showEscapeBar = ['submitted', 'streaming', 'tool_running', 'soft_alert', 'thinking'].includes(status);
const escapeBar = showEscapeBar ? `
  <div class="mr-ft-escape-bar">
    <button class="mr-ft-escape-btn primary" data-action="manual-extract" data-sid="${sid}" title="从 transcript 直接读取最新一段作为本轮回答">📋 手动提取</button>
    <button class="mr-ft-escape-btn" data-action="view-transcript" data-sid="${sid}" title="打开 transcript 文件查看原始内容">📄 transcript</button>
    <button class="mr-ft-escape-btn" data-action="skip-participant" data-sid="${sid}" title="跳过本轮，本家回答留空">⏭ 跳过</button>
    <button class="mr-ft-escape-btn" data-action="resend-participant" data-sid="${sid}" title="重新发送本轮 prompt 给该 AI">🔄 重发</button>
  </div>
` : '';
```

CSS (add to `renderer/meeting-room.css` or wherever `.mr-ft` lives):

```css
.mr-ft-escape-bar { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.mr-ft-escape-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 3px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; }
.mr-ft-escape-btn:hover { background: rgba(96,165,250,0.10); border-color: var(--info); }
.mr-ft-escape-btn.primary { background: rgba(96,165,250,0.15); border-color: var(--info); color: var(--info); }
```

- [ ] **Step 4: Wire button click handlers**

Add event delegation in the meeting-room renderer (likely where existing button clicks are bound):

```js
el.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mr-ft-escape-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const sid = btn.dataset.sid;
  const meetingId = currentMeetingId; // grab from context
  const sincePromptTs = getCurrentTurnPromptTs(meetingId, sid); // helper to find the timestamp

  if (action === 'manual-extract') {
    btn.disabled = true; btn.textContent = '⏳ 提取中...';
    const result = await window.electron.ipcRenderer.invoke('roundtable-manual-extract', { meetingId, sid, sincePromptTs });
    if (!result.ok) {
      alert(`提取失败：${result.reason}`);
      btn.disabled = false; btn.textContent = '📋 手动提取';
    }
    // on success, partial-update will arrive via the watcher → no need to refresh manually
  } else if (action === 'skip-participant') {
    if (!confirm('确认跳过本家本轮回答？')) return;
    await window.electron.ipcRenderer.invoke('roundtable-skip-participant', { meetingId, sid });
  } else if (action === 'view-transcript') {
    // open transcript file with default editor
    await window.electron.ipcRenderer.invoke('open-transcript', { sid });
  } else if (action === 'resend-participant') {
    if (!confirm('重新发送本轮 prompt 给该 AI？(原回答将被丢弃)')) return;
    await window.electron.ipcRenderer.invoke('roundtable-resend-participant', { meetingId, sid });
  }
});
```

- [ ] **Step 5: Render soft-alert banner**

Add a new container in the roundtable area markup (likely near `_renderRtHistory` or above the AI cards):

```html
<div class="mr-rt-soft-alert" id="mr-rt-soft-alert" style="display:none;">
  <div class="mr-rt-soft-alert-msg"></div>
  <div class="mr-rt-soft-alert-actions">
    <button class="mr-rt-soft-alert-btn primary" data-action="extract">一键提取</button>
    <button class="mr-rt-soft-alert-btn" data-action="wait60">再等 60s</button>
    <button class="mr-rt-soft-alert-btn" data-action="skip">跳过本家</button>
    <button class="mr-rt-soft-alert-close">✕</button>
  </div>
</div>
```

IPC listener:

```js
window.electron.ipcRenderer.on('roundtable-soft-alert', (_e, { sid, label, level }) => {
  const banner = document.getElementById('mr-rt-soft-alert');
  const msg = banner.querySelector('.mr-rt-soft-alert-msg');
  const t = level === 't1' ? '90s' : '180s';
  msg.innerHTML = `⏱ <strong>${escapeHtml(label)} 已 ${t} 未确认结束</strong> — 可能正在深度推理；如已看到完整回答，可手动提取。`;
  banner.dataset.sid = sid;
  banner.style.display = 'flex';
  if (level === 't2') banner.classList.add('escalated'); else banner.classList.remove('escalated');
});
```

CSS:

```css
.mr-rt-soft-alert { background: rgba(251,191,36,0.10); border: 1px solid var(--warn); border-radius: 6px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin: 12px 0; }
.mr-rt-soft-alert.escalated { border-color: var(--danger); background: rgba(248,113,113,0.10); }
```

- [ ] **Step 6: Update button-disabled logic**

`renderer/meeting-room.js:1243`:

```js
// before
const debateDisabled = (turns < 1 || inProgress) ? 'disabled' : '';

// after
const allParticipantsSettled = participants.every(p =>
  ['completed', 'manual_extracted', 'absent', 'errored', 'interrupted'].includes(p.state)
);
const debateDisabled = (turns < 1 || (inProgress && !allParticipantsSettled)) ? 'disabled' : '';
```

(Same change for summary and 群策群力 buttons.)

- [ ] **Step 7: Add corner badges (manual / absent)**

In `_ftHtml` (line 220-235), add corner-badge rendering:

```js
const cornerBadge = (() => {
  if (status === 'manual_extracted') return '<div class="mr-ft-corner-badge manual">手动</div>';
  if (status === 'absent') return '<div class="mr-ft-corner-badge absent">缺席</div>';
  return '';
})();
return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
  ${cornerBadge}
  <button class="mr-ft-expand" ...>↗</button>
  ...
</div>`;
```

CSS:

```css
.mr-ft-corner-badge { position: absolute; top: -1px; right: -1px; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 0 7px 0 6px; letter-spacing: 0.05em; }
.mr-ft-corner-badge.manual { background: var(--info); color: var(--bg); }
.mr-ft-corner-badge.absent { background: var(--text-2); color: var(--bg); }
```

- [ ] **Step 8: Smoke test**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Manual: open Hub → start a roundtable → submit prompt → verify cards render with new style → no console errors.

**Acceptance:** Cards render escape toolbar in pending states. Banner appears at 90s/180s in mock test. Buttons remain enabled when one AI is stuck. Corner badges show on manual/absent states.

---

## Task 6: 下游 prompt builder — 过滤 `absent` / `errored` 家

**Files:**
- Modify: prompt builder for `@debate`, `@summary`, 群策群力 (locate via grep)

**Background:** When a participant is `absent` (skipped) or `errored`, downstream prompts must NOT reference its empty content. Currently the builder probably just iterates all participants — need to filter.

- [ ] **Step 1: Locate prompt builders**

```bash
grep -rn "debate\|summary\|群策群力" core/ main.js | head -40
```

Likely in `core/roundtable-orchestrator.js` or `core/prompt-builder.js`.

- [ ] **Step 2: Add filter**

Wherever the builder iterates `lastTurn.by[sid]`, skip sids whose state is `absent` or `errored`. Example pattern:

```js
const validParticipants = participants.filter(p =>
  ['completed', 'manual_extracted'].includes(p.state) && p.text && p.text.trim()
);
```

Add a UX-facing note in the prompt itself when participants are missing:

```
注意：本轮 Gemini 因故未参与，仅 Claude 与 Codex 的回答可供参考。
```

- [ ] **Step 3: Add safeguard — disallow skipping last participant**

In the IPC `roundtable-skip-participant` handler:

```js
const stillActive = countActiveWatchers(meetingId);
if (stillActive <= 1) return { ok: false, reason: 'cannot_skip_last' };
```

- [ ] **Step 4: E2E manual smoke**

Roundtable with 3 AIs; mock skip Gemini → trigger @debate; verify the prompt sent to Claude/Codex doesn't include Gemini's empty content; visible "Gemini 缺席" mention in prompt body.

**Acceptance:** Filtering verified by reading IPC payload in DevTools. Last-participant safeguard tested.

---

## Task 7: E2E 测试

**Files:**
- Create: `tests/e2e-roundtable-resilience.test.js`

**Background:** Per project CLAUDE.md, E2E must run against a real Hub instance via CDP (Chrome DevTools Protocol) with `CLAUDE_HUB_DATA_DIR` env isolation + junctioned `node_modules`. Reference: `_setup_hub_worktree` + `_start_hub` in `C:\Users\lintian\.ai-team\tests\test_e2e_critical.py`.

**Six scenarios required (per spec §测试要求):**
1. Happy path — three AIs all complete naturally
2. Gemini slow (30s) — auto-completes via new `type:"result"` signal, no banner
3. Gemini stuck (mocked: never writes result) — 90s banner appears, manual extract → `manual_extracted` → next round permitted
4. Gemini skip — `absent` → debate prompt excludes Gemini → roundtable proceeds
5. Codex multi-turn — first `task_complete` followed by new `turn_start` within 3s → no false turn-complete (this is P2 territory but smoke check it; full coverage in P2 plan)
6. Three-way error — all three errored → roundtable enters errored-all state allowing user to resend whole turn

- [ ] **Step 1: Set up E2E fixture**

Use the existing junction-based pattern. Use Playwright MCP for UI driving (per user's `feedback_playwright_cdp.md`).

```js
// tests/e2e-roundtable-resilience.test.js (Node + Playwright via MCP)
// Skeleton — adapt to project's existing E2E framework
```

Actual E2E framework choice: check `tests/` directory for existing E2E tests. If project uses `playwright` directly, use that. If uses MCP-driven approach, follow that pattern.

- [ ] **Step 2: Implement each scenario**

For scenarios that require mocking (e.g., scenario 3 "Gemini never writes result"), use a mock Gemini binary or env-controlled fixture session JSONL files. Don't actually wait 90s in the test — inject a shortened `softAlertT1Ms` via a test-only env var.

- [ ] **Step 3: Run E2E**

```bash
# example invocation; adjust to project's runner
node tests/e2e-roundtable-resilience.test.js
```

Per project CLAUDE.md: "测试通过 = 代码真实执行产出正确结果". Each scenario must produce screenshots + assertions on actual UI state.

**Acceptance:** All six scenarios pass. Screenshots saved to `C:\Users\lintian\.claude-session-hub\images\` per project convention.

---

## Verification Checklist (run before declaring P0 complete)

- [ ] `npm install` clean (no warnings about peer deps)
- [ ] Hub smoke test: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20` shows hook server listening
- [ ] All unit tests pass: `node tests/unit-transcript-tap-gemini-result.test.js && node tests/unit-turn-completion-watcher.test.js`
- [ ] E2E: scenarios 1-6 pass with screenshots
- [ ] Manual UI walk-through: create roundtable → submit prompt → verify three AI cards render → submit a "make Gemini stuck" prompt → wait 90s → verify banner → click manual extract → verify state flips to manual_extracted → click @debate → verify it dispatches
- [ ] Version bump in `package.json` + visible in UI (per `CLAUDE.md` 铁律：版本号可见化)
- [ ] No regression on existing flows: `@debate` / `@summary` / 群策群力 / 历史轮次面板 / 私聊
- [ ] CSS works in dark theme; corner badges visible on all backgrounds
- [ ] Run `/post-refactor-verify` if commit ≥ 3 files (per project CLAUDE.md hook)

---

## Rollback Plan

If P0 ships but causes regression:

1. **Feature flag fallback**: wrap `Promise.allSettled` change behind `HUB_ROUNDTABLE_RESILIENCE_V2 = '0'` env var. Set to `'0'` to fall back to old `Promise.all`.
2. **Revert plan**: changes are localized to: `transcript-tap.js`, `roundtable-orchestrator.js`, `main.js`, `meeting-room.js`, `meeting-room.css`. A single revert PR can roll all back.
3. **Partial rollback**: if only the UI changes regress (banner causes layout issues), keep backend changes (which fix the actual bug) and revert UI cosmetics.

---

## Out of Scope (future plans)

- **P1 — 状态机重构 + L2 信号**: extract participant state into a single `ParticipantState` enum, listen on PTY exit events, distinguish `errored` / `interrupted` / `transport_lost`. Future plan: `2026-05-XX-roundtable-state-machine.md`.
- **P2 — Codex 多 turn 加固**: 3-second debounce after `task_complete` to avoid false-positive on multi-turn agent loops; handle `last_agent_message:null` (issue #13769) as `errored` not `completed`. Future plan: `2026-05-XX-codex-multiturn-hardening.md`.
- **P3 — 协议级 IPC**: migrate Gemini to `--acp` JSON-RPC over stdio; migrate Codex to `app-server` JSON-RPC. Abstract `ProviderTransport` interface; file-tail becomes legacy fallback. Future plan: `2026-05-XX-protocol-ipc.md`.

---

## Appendix: Quick Reference for Executing Worker

**Spec to read first:** `docs/superpowers/specs/2026-04-30-roundtable-resilience-design.md`

**Visual aid:** `docs/roundtable-resilience-2026-04-30.html`

**Key files to keep open:**
- `core/transcript-tap.js`
- `core/roundtable-orchestrator.js`
- `main.js` (focus: 564-589, 676-684, 1444)
- `renderer/meeting-room.js` (focus: 160-235, 194, 1243-1269)

**Project rules (do not skip):**
- `CLAUDE.md` 铁律：node_modules 半坏防护 / 并行测试 Hub 实例 / E2E 真实执行 / 版本号可见化
- 改动 ≥ 3 文件后必须运行 `/post-refactor-verify`
- 不要在主工作目录跑 `npm run dist`

**Communication:**
- 中文交互；代码/变量保持英文
- 路径输出绝对路径
- 截图必须附绝对路径

---

**End of Plan.**
