# 圆桌单 AI 卡片解耦修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复圆桌中"单 AI 卡片状态被全 AI 整体进度绑死"的两个 bug：B1 详情抽屉看不到本轮 partial、B2 卡片预览滚动条被任意一家心跳打回顶部。

**Architecture:** 把 `panel.innerHTML = _renderRtPanelHtml(...)` 全量重渲改造成「单 slot 局部 patch + diff 短路 + scrollTop 保留」。`_openRtTimeline` 抽屉合并 `_partialBy` 显示本轮实时内容并订阅心跳。改动范围严格控制在 `renderer/meeting-room.js` 一个文件。

**Tech Stack:** Electron renderer (Node.js + Chromium DOM)、IPC（`roundtable-partial-update`）、`outerHTML` 替换、`querySelector` 局部查询、隔离 Hub + CDP E2E 验证。

---

## Bug 锁定（修复前置阅读）

| Bug | 现象 | 根因 | 位置 |
|---|---|---|---|
| **B1 详情抽屉看不到本轮 partial** | 皮卡丘已 settled 但其他家未完时，点 ↗ 抽屉只能看到上一轮 | `_openRtTimeline` 的 `turnsWithAns = state.turns.filter(...)` 只读已落盘历史轮，不合并 `state._partialBy[sid]` | `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1086-1089` |
| **B2 卡片预览滚动条弹回顶部** | 用户在皮卡丘卡片 `.mr-ft-preview`（max-height:80px;overflow-y:auto）里滚动，每次任意一家心跳→滚回顶 | `roundtable-partial-update` IPC handler 用 `panel.innerHTML = _renderRtPanelHtml(cached, meeting)` 整面板重建，三家卡片 DOM 全销毁→scrollTop 归零 | `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1311` |

## File Structure

只改 1 个文件 + 加 1 个测试文件：

| 文件 | 职责 | 改动 |
|---|---|---|
| `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` | 圆桌 panel 渲染 + IPC handler | T1: 抽 `_renderSlotCard`；T2: partial-update 改局部 patch + 抽 `_isPartialUnchanged` / `_bindSlotCardEvents`；T3: `_openRtTimeline` 合并 partial + `_rtTimelineLive` 订阅 |
| `C:\Users\lintian\claude-session-hub\tests\unit-card-streaming-decoupling.test.js` | 纯函数 `_isPartialUnchanged` 单测 | T2 中创建 |

**为什么不抽到独立模块：** `_renderSlotCard` 依赖 `_avatarBySlot`、`_renderPreviewBlocks`、`isSlotParticipatingThisTurn`、`modelShort`、`modelClass`、`_thinkStartTs`、`_cliReadyCache`、`_tabState`、`sessions`、`_KIND_LABELS` 等十余个 IIFE 私有 helper / 全局变量。剥离到独立模块需要重构整个依赖链，与"最小修复"目标冲突。在 IIFE 内新增函数最低风险。

**为什么 T1 不写传统单测：** IIFE 内私有函数对外不暴露，jsdom + window/sessions/ipcRenderer mock 工作量超出最小修复预算。验证手段是「跑现有 unit-meeting-* 套件 + 启动隔离 Hub smoke test 看卡片正常」。T2 唯一可独立测试的 `_isPartialUnchanged` 是纯函数，单独 export 做单测。

---

## Task 1: 抽 `_renderSlotCard` 单卡片渲染函数（T2 / T3 的前置）

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:390-607`（`_renderFusedTabs` 函数体内 slot 循环）

**目的：** 把单 slot 卡片的 HTML 计算抽成独立函数 `_renderSlotCard(slotIndex, ctx)`，让 T2 的 partial-update 局部 patch 可以复用同一份渲染逻辑（避免「主面板渲染 vs partial 局部更新」走两套模板，未来改了一处忘改另一处的失同步 bug）。

**核心约束：**
- **行为完全等价。** 跑现有所有圆桌 unit/E2E 测试不挂、隔离 Hub 启动后卡片视觉与重构前 1:1 一致。
- 不修改任何状态判定逻辑（status / preview / bottomHtml 计算分支）。
- 不动 `_ftHtml` —— 它已经是单卡片 HTML 字符串生成器。

- [ ] **Step 1: 读懂当前 `_renderFusedTabs` 的循环体依赖**

打开 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:390-607`，确认 slot 循环体（line 401-603）依赖以下外部输入：
- 函数参数：`state`、`subs`（实际未用，循环内直接用 `slot.sid`/`slot.label`）、`currentMode`、`partialBy`、`meeting`
- 循环顶层计算：`lastTurn`、`summarizerSlot`、`meetingId`、`focused`、`anyThinking`（write-back）、`slots`
- IIFE 私有 helper：`_avatarBySlot`、`_avatarFallbackBySlot`、`_renderPreviewBlocks`、`isSlotParticipatingThisTurn`、`_ftCtxClass`、`_formatThinkTime`、`_formatTokens`、`_ftHtml`、`_thinkStartTs`、`_markerStatusCache`、`_cliReadyCache`、`_tabState`、`sessions`、`_KIND_LABELS`、`modelShort`、`modelClass`

写一行注释列出依赖。

- [ ] **Step 2: 在 `_renderFusedTabs` 上方插入 `_renderSlotCard` 函数**

位置：`C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:389`（`const _KIND_LABELS = KIND_LABELS;` 之后，`function _renderFusedTabs(...)` 之前）。

把当前 line 401-603 整段循环体原封不动迁过去，包成函数。`anyThinking` 因为是 write-back 副作用变量，改成函数返回值的一部分：

```javascript
  // T1（2026-05-04 道雪）：抽出单 slot 卡片渲染，让 partial-update IPC handler
  //   能复用同一份模板做局部 patch（不再 panel.innerHTML 全量替换）。
  //   ctx 字段：{ state, currentMode, partialBy, meeting, slots, lastTurn, summarizerSlot,
  //              meetingId, focused }
  // 返回：{ html, anyThinking }（anyThinking 由调用方累加，不再 mutate 闭包变量）
  function _renderSlotCard(slotIndex, ctx) {
    const { state, currentMode, partialBy, meeting, slots, lastTurn, summarizerSlot, meetingId, focused } = ctx;
    const slot = slots[slotIndex];
    if (!slot) return { html: '', anyThinking: false };
    const kind = slot.kind;
    const sub = { sid: slot.sid, label: slot.label };
    const partial = partialBy ? partialBy[sub.sid] : null;
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sub.sid) : null;
    const markerState = _markerStatusCache[sub.sid];
    const isInitializing = s && !_cliReadyCache[sub.sid];
    let status = 'idle';
    let preview = '';
    let anyThinking = false;

    if (isInitializing && !partial && !(currentMode && currentMode !== 'idle') && !lastTurn) {
      status = 'initializing';
    } else if (partial) {
      if (partial.status === 'streaming') {
        status = 'streaming';
        preview = partial.text || '';
        anyThinking = true;
      } else if (partial.status === 'absent') {
        status = 'absent';
        preview = '';
      } else if (partial.status === 'errored') {
        status = 'errored';
        preview = '';
      } else if (partial.status === 'manual_extracted') {
        status = 'manual_extracted';
        preview = partial.text || '';
      } else if (partial.status === 'soft_alert') {
        status = 'soft_alert';
        preview = partial.text || '';
        anyThinking = true;
      } else {
        status = partial.status === 'timeout' ? 'timeout' : 'completed';
        preview = partial.text || '';
      }
    } else if (currentMode && currentMode !== 'idle') {
      if (!isSlotParticipatingThisTurn(meeting, slotIndex)) {
        status = lastTurn && lastTurn.by && lastTurn.by[sub.sid] ? 'completed' : 'idle';
        preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
      } else if (currentMode === 'summary' && summarizerSlot && summarizerSlot !== slot.slotId) {
        status = lastTurn && lastTurn.by[sub.sid] ? 'completed' : 'idle';
        preview = lastTurn ? (lastTurn.by[sub.sid] || '') : '';
      } else {
        status = 'thinking';
        anyThinking = true;
      }
    } else if (lastTurn) {
      const lastStatus = lastTurn.byStatus ? lastTurn.byStatus[sub.sid] : null;
      if (lastStatus === 'errored') {
        status = 'errored';
      } else if (lastStatus === 'absent') {
        status = 'absent';
      } else if (lastStatus === 'manual_extracted') {
        status = 'manual_extracted';
        preview = lastTurn.by[sub.sid] || '';
      } else if (lastTurn.by[sub.sid]) {
        status = 'completed';
        preview = lastTurn.by[sub.sid];
      }
    }

    const isActive = sub.sid === focused;
    const modelName = s && s.currentModel ? (typeof modelShort === 'function' ? modelShort(s.currentModel) : s.currentModel.displayName || '') : '';
    const modelCls = s && s.currentModel && typeof modelClass === 'function' ? modelClass(s.currentModel.id) : '';
    const ctxPct = s && typeof s.contextPct === 'number' ? s.contextPct : null;
    const ctxCls = _ftCtxClass(ctxPct);
    const labelDisplay = slot.displayLabel;

    let statusForLabel = status;
    if (partial && partial.sendStatus === 'stuck') statusForLabel = 'send_stuck';
    const statusLabel = {
      idle: '待命',
      initializing: '创建中…',
      thinking: '思考中',
      streaming: '输出中',
      completed: '已答 ✓',
      timeout: '超时',
      manual_extracted: '已答 ✓ 手动',
      absent: '本轮缺席',
      soft_alert: '等待中…',
      send_stuck: '⚠ 发送卡住，请按发送',
      errored: '错误',
      interrupted: '已中断',
      transport_lost: '连接断开',
    }[statusForLabel] || statusForLabel;
    const tabState = _tabState[sub.sid] || 'idle';
    const newBadge = tabState === 'new-output' && !isActive ? '<span class="mr-ft-new">NEW</span>' : '';

    const blocksFromPartial = (partial && Array.isArray(partial.blocks) && partial.blocks.length > 0)
      ? partial.blocks : null;
    const textFromPartial = (partial && typeof partial.text === 'string' && partial.text)
      ? partial.text : null;
    const textFromHistory = (!partial && lastTurn && lastTurn.by && lastTurn.by[sub.sid])
      ? lastTurn.by[sub.sid] : null;

    let bottomHtml = '';
    if (status === 'thinking') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar slot-${slotIndex + 1}"></div></div>`;
    } else if (status === 'streaming') {
      if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();
      let inner;
      if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        const elapsedSec = _thinkStartTs[meetingId]
          ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
        const elapsedTxt = _formatThinkTime(elapsedSec);
        const liveLen = (partial && typeof partial.cleanBufLen === 'number') ? partial.cleanBufLen : 0;
        const lenTxt = liveLen > 0 ? ` · 已输出约 ${liveLen} 字` : '';
        inner = `<div class="mr-ft-thinking-placeholder">💭 思考中 ${elapsedTxt}${lenTxt}<br><span class="mr-ft-thinking-hint">详情请点击左侧子 session 查看</span></div>`;
      }
      bottomHtml = `<div class="mr-ft-preview streaming mr-ft-preview-md">${inner}<span class="mr-ft-cursor"></span></div>`;
    } else if (blocksFromPartial || textFromPartial || textFromHistory) {
      let inner;
      if (blocksFromPartial) {
        inner = _renderPreviewBlocks(blocksFromPartial, sub.sid);
      } else if (textFromPartial) {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromPartial }], sub.sid);
      } else {
        inner = _renderPreviewBlocks([{ type: 'text', text: textFromHistory }], sub.sid);
      }
      bottomHtml = `<div class="mr-ft-preview mr-ft-preview-md">${inner}</div>`;
    } else {
      bottomHtml = '<div class="mr-ft-preview" style="opacity:0.5;font-style:italic">等待…</div>';
    }

    const aiStats = (state.aiStats && (state.aiStats[sub.sid] || state.aiStats[kind]))
      || { totalThinkSec: 0, totalTokens: 0 };
    let thinkCurrentSec = 0;
    let tokensCurrentN = 0;
    if (status === 'thinking' || status === 'streaming') {
      thinkCurrentSec = _thinkStartTs[meetingId]
        ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
      if (partial && partial.tokens && typeof partial.tokens.total === 'number') {
        tokensCurrentN = partial.tokens.total;
      }
    } else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
      thinkCurrentSec = lastTurn.thinkSecBy[sub.sid] || 0;
      tokensCurrentN = (lastTurn.tokensBy && lastTurn.tokensBy[sub.sid]) || 0;
    }
    const thinkCurrent = _formatThinkTime(thinkCurrentSec);
    const thinkTotal   = _formatThinkTime(aiStats.totalThinkSec || 0);
    const tokensCurrent = _formatTokens(tokensCurrentN);
    const tokensTotal   = _formatTokens(aiStats.totalTokens || 0);

    const sendStuck = !!(partial && partial.sendStatus === 'stuck');
    const html = _ftHtml(
      kind, isActive, sub.sid, labelDisplay, statusLabel, status,
      modelName, modelCls, ctxPct, ctxCls, bottomHtml,
      thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge,
      slotIndex, sendStuck
    );
    return { html, anyThinking };
  }
```

- [ ] **Step 3: 改 `_renderFusedTabs` 调用 `_renderSlotCard`**

位置：`C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:390-607` 的整体替换。

原 line 401-603 整段循环体替换为：

```javascript
  function _renderFusedTabs(state, subs, currentMode, partialBy, meeting) {
    const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
    const summarizerSlot = state.currentSummarizerSlot || null;
    const tabs = [];
    const meetingId = meeting && meeting.id;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    let anyThinking = false;
    const slots = _getRtSlots(meeting);
    const ctx = { state, currentMode, partialBy, meeting, slots, lastTurn, summarizerSlot, meetingId, focused };
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const { html, anyThinking: t } = _renderSlotCard(slotIndex, ctx);
      if (html) tabs.push(html);
      if (t) anyThinking = true;
    }
    if (!anyThinking && meetingId) delete _thinkStartTs[meetingId];
    return `<div class="mr-ft-strip">${tabs.join('')}</div>`;
  }
```

- [ ] **Step 4: 跑现有单测套件**

Run（在 `C:\Users\lintian\claude-session-hub` 目录）：
```powershell
node --test tests\unit-meeting-store-free-fields.test.js tests\unit-roundtable-free-dispatch.test.js tests\unit-roundtable-free-prompt.test.js tests\unit-meeting-mode-toggle.test.js tests\unit-participants-persistence.test.js
```
Expected: 全部 pass，无 require/syntax error。

- [ ] **Step 5: 隔离 Hub smoke test**

Run（PowerShell 单句、`& exe` 同句、不要 Start-Process — 见 `feedback_hub_isolation_env_pitfall`）：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-decouple-T1"; & "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9241
```
预期：Hub 启动无 syntax/load error。控制台启动日志含 `[hub] hook server listening`。

手工或 CDP（Playwright MCP）操作：
1. 创建一个 free 模式 + 通用场景的圆桌
2. 输入「测试 1」点提问
3. 三家卡片正常显示思考中/输出中/已答状态
4. 视觉与重构前完全一致

通过后退出（关掉窗口）。

- [ ] **Step 6: Commit**

```powershell
git add renderer/meeting-room.js
git commit -m @'
refactor(roundtable): 抽出 _renderSlotCard 单卡片渲染函数

为后续 partial-update 局部 patch（修复 B2 滚动条弹回）做准备。
行为完全等价；anyThinking 副作用改为函数返回值。
'@
```

---

## Task 2: partial-update 改局部 patch + scrollTop 保留 + diff 短路（修复 B2 滚动条弹回）

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\unit-card-streaming-decoupling.test.js`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:900-1059`（新增 `_bindSlotCardEvents` + 拆 `_bindRtPanelEvents`）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1284-1313`（partial-update handler）

**目的：**
1. **diff 短路**：partial 内容/状态/sendStatus/cleanBufLen 完全没变 → 直接 return，0 DOM 操作。皮卡丘 settled 后，所有后续心跳对皮卡丘卡片完全无感知，B2 自然消失。
2. **局部 patch + scrollTop 保留**：变化的那个 slot 用 `outerHTML` 替换；替换前记录该 slot `.mr-ft-preview` 的 scrollTop，替换后恢复。即使是流式增长的家自己，滚动位置也尽量保留。
3. **拆 `_bindSlotCardEvents`**：从 `_bindRtPanelEvents` 拆出与 `.mr-ft` 卡片相关的事件绑定（卡片点击 → focus、↗ 按钮 → openTimeline、`[data-rt-escape]` 按钮组），让局部 patch 后只 rebind 单 slot。

**不动**：
- `refreshRoundtablePanel`（882）、`roundtable-soft-alert`（1351）、`roundtable-send-stuck`（1373）的 `panel.innerHTML = ...` 路径保持不变（低频，不在最小修复范围）。
- 后端 IPC 协议、orchestrator、partial 数据结构完全不动。

- [ ] **Step 1: 写 `_isPartialUnchanged` 单测（先 fail）**

Create: `C:\Users\lintian\claude-session-hub\tests\unit-card-streaming-decoupling.test.js`

```javascript
'use strict';
// 单测 _isPartialUnchanged：partial diff 短路逻辑（T2 / 2026-05-04 道雪）
// 这个纯函数从 renderer/meeting-room.js 暴露成 module.exports 兼容（renderer 既是 IIFE 又能在 Node 测试环境 require）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { _isPartialUnchanged } = require('../renderer/meeting-room.js');

test('null prev / null next：视为相同（避免首次渲染误判变化）', () => {
  assert.equal(_isPartialUnchanged(null, null), true);
});

test('null prev / 有 next：视为变化', () => {
  assert.equal(_isPartialUnchanged(null, { text: 'hi', status: 'streaming' }), false);
});

test('有 prev / null next：视为变化', () => {
  assert.equal(_isPartialUnchanged({ text: 'hi', status: 'streaming' }, null), false);
});

test('text + status + cleanBufLen + sendStatus + tokens.total 全相同：unchanged', () => {
  const prev = { text: 'abc', status: 'streaming', cleanBufLen: 100, sendStatus: undefined, tokens: { total: 50 } };
  const next = { text: 'abc', status: 'streaming', cleanBufLen: 100, sendStatus: undefined, tokens: { total: 50 } };
  assert.equal(_isPartialUnchanged(prev, next), true);
});

test('text 变化 → changed', () => {
  const prev = { text: 'abc', status: 'streaming', cleanBufLen: 100 };
  const next = { text: 'abcd', status: 'streaming', cleanBufLen: 100 };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('status 变化（streaming→completed）→ changed', () => {
  const prev = { text: 'abc', status: 'streaming' };
  const next = { text: 'abc', status: 'completed' };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('cleanBufLen 变化（heartbeat 心跳）→ changed', () => {
  const prev = { text: '', status: 'streaming', cleanBufLen: 100 };
  const next = { text: '', status: 'streaming', cleanBufLen: 200 };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('sendStatus 由 undefined→stuck → changed', () => {
  const prev = { text: 'abc', status: 'streaming' };
  const next = { text: 'abc', status: 'streaming', sendStatus: 'stuck' };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('tokens.total 变化 → changed', () => {
  const prev = { text: 'abc', status: 'streaming', tokens: { total: 50 } };
  const next = { text: 'abc', status: 'streaming', tokens: { total: 60 } };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('blocks 数组按 length + 末块 type/text 比对（轻量比对）', () => {
  const prev = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }] };
  const next = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }] };
  assert.equal(_isPartialUnchanged(prev, next), true);
  const next2 = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'ab' }] };
  assert.equal(_isPartialUnchanged(prev, next2), false);
  const next3 = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
  assert.equal(_isPartialUnchanged(prev, next3), false);
});
```

- [ ] **Step 2: 跑测试看它失败**

Run:
```powershell
node --test tests\unit-card-streaming-decoupling.test.js
```
Expected: FAIL `Cannot find module '_isPartialUnchanged'` 或 `_isPartialUnchanged is not a function`。

- [ ] **Step 3: 在 meeting-room.js IIFE 内定义 `_isPartialUnchanged`，并 export 兼容 Node 测试**

位置：`C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1283`（紧挨 partial-update handler 上方）。

```javascript
  // T2（2026-05-04 道雪）：partial diff 短路 — 内容完全没变就不动 DOM，
  //   修复 B2「皮卡丘已 settled 后小火龙心跳仍打回皮卡丘卡片滚动条」。
  function _isPartialUnchanged(prev, next) {
    if (!prev && !next) return true;
    if (!prev || !next) return false;
    if (prev.text !== next.text) return false;
    if (prev.status !== next.status) return false;
    if (prev.cleanBufLen !== next.cleanBufLen) return false;
    if (prev.sendStatus !== next.sendStatus) return false;
    const pt = prev.tokens && prev.tokens.total;
    const nt = next.tokens && next.tokens.total;
    if (pt !== nt) return false;
    const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
    const nb = Array.isArray(next.blocks) ? next.blocks : null;
    if (!pb && !nb) return true;
    if (!pb || !nb) return false;
    if (pb.length !== nb.length) return false;
    if (pb.length === 0) return true;
    const last = pb.length - 1;
    if (pb[last].type !== nb[last].type) return false;
    if ((pb[last].text || '') !== (nb[last].text || '')) return false;
    return true;
  }
```

文件**末尾** `})();` IIFE 结束之后，加 Node 测试兼容导出：

```javascript
// Node 测试环境兼容（renderer 真实运行时为 IIFE 浏览器环境，typeof module 为 undefined 走不到这）
if (typeof module !== 'undefined' && module.exports) {
  // 让 unit test 能 require 到 _isPartialUnchanged。这种"双模兼容"模式同 core/roundtable-free.js。
  module.exports = { _isPartialUnchanged: (function () {
    // 重复定义一份相同的纯函数（IIFE 内的不可见）— 修改时两处同步。
    return function _isPartialUnchanged(prev, next) {
      if (!prev && !next) return true;
      if (!prev || !next) return false;
      if (prev.text !== next.text) return false;
      if (prev.status !== next.status) return false;
      if (prev.cleanBufLen !== next.cleanBufLen) return false;
      if (prev.sendStatus !== next.sendStatus) return false;
      const pt = prev.tokens && prev.tokens.total;
      const nt = next.tokens && next.tokens.total;
      if (pt !== nt) return false;
      const pb = Array.isArray(prev.blocks) ? prev.blocks : null;
      const nb = Array.isArray(next.blocks) ? next.blocks : null;
      if (!pb && !nb) return true;
      if (!pb || !nb) return false;
      if (pb.length !== nb.length) return false;
      if (pb.length === 0) return true;
      const last = pb.length - 1;
      if (pb[last].type !== nb[last].type) return false;
      if ((pb[last].text || '') !== (nb[last].text || '')) return false;
      return true;
    };
  })() };
}
```

> ⚠ 双份函数体看起来 DRY 违反，但 IIFE 内部变量（`document`、`ipcRenderer`）在 Node require 时不存在 → 把整个 IIFE 移出来代价巨大。`_isPartialUnchanged` 是纯函数无外部依赖 → 复制一份是最低成本路径。两处相同的纯函数体，未来若改 → 测试跑挂会立刻发现不同步。

- [ ] **Step 4: 跑单测确认 pass**

Run:
```powershell
node --test tests\unit-card-streaming-decoupling.test.js
```
Expected: PASS（10 tests）。

- [ ] **Step 5: 拆出 `_bindSlotCardEvents` 函数**

位置：`C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:900` 之前（`_bindRtPanelEvents` 函数上方）。

```javascript
  // T2（2026-05-04 道雪）：单 slot 卡片的事件绑定独立成函数，让 partial-update 局部 patch 后只 rebind 单卡片。
  //   覆盖范围：① 卡片本体 click（focus session）② ↗ 展开按钮 ③ [data-rt-escape] 工具栏按钮组。
  //   不覆盖：history-toggle / soft-alert banner-close / mr-rt-ob-card（这些是 panel 级，由 _bindRtPanelEvents 管）。
  function _bindSlotCardEvents(slotEl, meeting) {
    if (!slotEl) return;
    // 卡片本体 click（mr-ft 自身），focus 该 sid 的 session
    if (slotEl.matches('.mr-ft[data-ft-sid]')) {
      const sid = slotEl.getAttribute('data-ft-sid');
      slotEl.addEventListener('click', () => {
        if (sid) _focusRoundtableSession(meeting, sid);
      });
    }
    // ↗ 展开
    slotEl.querySelectorAll('.mr-ft-expand[data-ft-expand-sid]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-ft-expand-sid');
        const kind = btn.getAttribute('data-ft-expand-kind');
        _openRtTimeline(meeting, sid, kind);
      });
    });
    // 逃生工具栏 [data-rt-escape]
    slotEl.querySelectorAll('[data-rt-escape]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.hasAttribute('disabled')) return;
        const action = btn.getAttribute('data-rt-escape');
        const sid = btn.getAttribute('data-rt-sid');
        const kind = btn.getAttribute('data-rt-kind');
        if (!sid) return;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '...';
        let _btnTextHandledExternally = false;
        try {
          if (action === 'extract') {
            const r = await ipcRenderer.invoke('roundtable-manual-extract', {
              meetingId: meeting.id, sid, sincePromptTs: _rtTurnStartTs[meeting.id] || 0,
            });
            if (!r || !r.ok) {
              console.warn(`[rt-escape] extract failed: ${r?.reason} (${r?.detail || ''})`);
              alert(`提取失败：${r?.reason || 'unknown'}\n\n${r?.detail || ''}`);
            } else {
              const charCount = (r.text || '').length;
              console.log(`[rt-escape] extract ok: ${kind} got ${charCount} chars (mode=${r.mode}, source=${r.source})`);
              btn.style.background = '#2da44e';
              btn.style.color = '#fff';
              btn.textContent = `✓ 已同步 ${charCount}字`;
              _btnTextHandledExternally = true;
              setTimeout(() => {
                btn.style.background = '';
                btn.style.color = '';
                btn.textContent = oldText;
                btn.disabled = false;
              }, 1500);
            }
          } else if (action === 'skip') {
            const r = await ipcRenderer.invoke('roundtable-skip-slot', { meetingId: meeting.id, sid });
            if (!r || !r.ok) {
              alert(`跳过失败：${r?.reason || 'unknown'}`);
            }
          } else if (action === 'resend') {
            const r = await ipcRenderer.invoke('roundtable-resend-slot', { meetingId: meeting.id, sid });
            if (!r || !r.ok) {
              alert(`重新拉起失败：${r?.reason || 'unknown'}`);
            }
          } else if (action === 'resend-prompt') {
            const r = await ipcRenderer.invoke('roundtable-resend-prompt', { meetingId: meeting.id, sid });
            if (!r || !r.ok) {
              alert(`重发 prompt 失败：${r?.reason || 'unknown'}`);
            } else {
              const cachedForResend = _rtPanelState[meeting.id];
              if (cachedForResend && cachedForResend._partialBy && cachedForResend._partialBy[sid]) {
                delete cachedForResend._partialBy[sid].sendStatus;
              }
              refreshRoundtablePanel(meeting);
            }
          }
        } finally {
          if (!_btnTextHandledExternally) {
            btn.disabled = false;
            btn.textContent = oldText;
          }
        }
      });
    });
  }
```

> ⚠ **重要**：上面 `[data-rt-escape]` 的 `try { ... }` 内部代码必须与 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:948-1047` 现有 handler 字节级一致（同样的 4 个分支：extract / skip / resend / resend-prompt）。直接从原 `_bindRtPanelEvents` 复制过来。

然后改 `_bindRtPanelEvents`（line 900）：删除 `panel.querySelectorAll('.mr-ft[data-ft-sid]')`、`panel.querySelectorAll('.mr-ft-expand[data-ft-expand-sid]')`、`panel.querySelectorAll('[data-rt-escape]')` 三段（被 `_bindSlotCardEvents` 覆盖），改为遍历每个 slot 调用：

```javascript
  function _bindRtPanelEvents(panel, meeting) {
    const toggle = panel.querySelector('#mr-rt-history-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        _rtHistoryExpanded = !_rtHistoryExpanded;
        refreshRoundtablePanel(meeting);
      });
    }
    // T2（2026-05-04 道雪）：每个 slot 卡片走 _bindSlotCardEvents（同一函数 partial 局部 rebind 复用）
    panel.querySelectorAll('.mr-ft[data-ft-sid]').forEach(slotEl => {
      _bindSlotCardEvents(slotEl, meeting);
    });
    const hasThinking = panel.querySelector('.mr-rt-think-elapsed');
    if (hasThinking && !_thinkTimer) {
      const mid = meeting.id;
      _thinkTimer = setInterval(() => {
        const ts = _thinkStartTs[mid];
        if (!ts) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const els = document.querySelectorAll('.mr-rt-think-elapsed');
        if (els.length === 0) { clearInterval(_thinkTimer); _thinkTimer = null; return; }
        const sec = Math.round((Date.now() - ts) / 1000);
        els.forEach(el => { el.textContent = `已 ${sec}s`; });
      }, 1000);
    } else if (!hasThinking && _thinkTimer) {
      clearInterval(_thinkTimer); _thinkTimer = null;
    }
    panel.querySelectorAll('.mr-rt-ob-card[data-ob-q]').forEach(card => {
      card.addEventListener('click', () => {
        const q = card.getAttribute('data-ob-q');
        const input = document.getElementById('mr-input-box');
        if (input && q) { input.textContent = q; input.focus(); _placeCaretAtEnd(input); }
      });
    });
    const banner = panel.querySelector('#mr-rt-soft-alert-banner');
    if (banner) {
      banner.querySelectorAll('[data-rt-banner-close]').forEach(btn => {
        btn.addEventListener('click', () => {
          banner.style.display = 'none';
          banner.innerHTML = '';
        });
      });
    }
  }
```

- [ ] **Step 6: 改 partial-update handler 走局部 patch**

替换 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1284-1313`：

```javascript
  // Roundtable 单家 partial-update：T2（2026-05-04 道雪）局部 patch + diff 短路 + scrollTop 保留
  //   修复 B2 滚动条弹回：旧版 panel.innerHTML 全量重渲，三家卡片 DOM 全销毁→
  //   皮卡丘 settled 后小火龙心跳仍把皮卡丘 .mr-ft-preview 的 scrollTop 拍回 0。
  ipcRenderer.on('roundtable-partial-update', (_event, { meetingId, sid, status, text, thinkSec, tokens, blocks, source, cleanBufLen }) => {
    const meeting = meetingData[meetingId];
    if (!_isPanelCapableMeeting(meeting) || meetingId !== activeMeetingId) return;
    const cached = _rtPanelState[meetingId];
    if (!cached) {
      // 首次：直接 refresh（拉 state），下次 partial 才有 cached 走局部路径
      refreshRoundtablePanel(meeting);
      return;
    }
    if (!cached._partialBy) cached._partialBy = {};
    const next = {
      text: text || '',
      status: status || 'completed',
      thinkSec: typeof thinkSec === 'number' ? thinkSec : undefined,
      tokens: tokens || undefined,
      blocks: Array.isArray(blocks) ? blocks : undefined,
      source: source || undefined,
      cleanBufLen: typeof cleanBufLen === 'number' ? cleanBufLen : undefined,
    };
    const prev = cached._partialBy[sid];
    // T2 short-circuit：内容完全无变化（高频心跳常见）→ 直接 return，0 DOM 操作
    if (_isPartialUnchanged(prev, next)) return;
    // 保留 sendStatus（不在 partial-update 推送，由 send-stuck handler 维护）
    next.sendStatus = prev && prev.sendStatus;
    cached._partialBy[sid] = next;

    // T2 局部 patch：找到该 sid 的 slot DOM，outerHTML 替换；其他两个 slot 完全不动
    const panel = _ensureRtPanel();
    const slotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (!slotEl) {
      // 兜底：DOM 找不到该 slot（panel 还没渲染过）→ 全量重渲
      panel.innerHTML = _renderRtPanelHtml(cached, meeting);
      _bindRtPanelEvents(panel, meeting);
      return;
    }
    // T2 scrollTop 保留：替换前记录 .mr-ft-preview 的滚动位置（即使是流式增长的家自己，也尽量保留）
    const prevPreview = slotEl.querySelector('.mr-ft-preview');
    const savedScrollTop = prevPreview ? prevPreview.scrollTop : 0;
    // 计算新 HTML
    const slots = _getRtSlots(meeting);
    const slotIndex = slots.findIndex(slot => slot && slot.sid === sid);
    if (slotIndex < 0) return;
    const lastTurn = cached.turns.length > 0 ? cached.turns[cached.turns.length - 1] : null;
    const summarizerSlot = cached.currentSummarizerSlot || null;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    const ctx = {
      state: cached, currentMode: cached.currentMode || 'idle', partialBy: cached._partialBy,
      meeting, slots, lastTurn, summarizerSlot, meetingId: meeting.id, focused,
    };
    const { html } = _renderSlotCard(slotIndex, ctx);
    if (!html) return;
    // outerHTML 替换该 slot（其他卡片 DOM 节点完全不被打扰）
    slotEl.outerHTML = html;
    // 重新查找新节点（outerHTML 替换后旧引用已失效）
    const newSlotEl = panel.querySelector(`.mr-ft[data-ft-sid="${sid}"]`);
    if (newSlotEl) {
      _bindSlotCardEvents(newSlotEl, meeting);
      // 恢复 scrollTop
      const newPreview = newSlotEl.querySelector('.mr-ft-preview');
      if (newPreview && savedScrollTop > 0) newPreview.scrollTop = savedScrollTop;
    }
    // 应用 pilot 视觉（红框）— 与全量 refreshRoundtablePanel 保持一致
    if (meeting.mode !== 'free') {
      const pilotSlotForVisual = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
        ? meeting.pilotSlot : null;
      const dispatchModeForVisual = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
        ? meeting.dispatchMode : 'all';
      requestAnimationFrame(() => {
        _applyPilotCardVisual(meeting, pilotSlotForVisual, dispatchModeForVisual);
      });
    }
  });
```

- [ ] **Step 7: 跑现有单测套件 + 新单测确认无回归**

Run:
```powershell
node --test tests\unit-meeting-store-free-fields.test.js tests\unit-roundtable-free-dispatch.test.js tests\unit-roundtable-free-prompt.test.js tests\unit-meeting-mode-toggle.test.js tests\unit-participants-persistence.test.js tests\unit-card-streaming-decoupling.test.js
```
Expected: 全部 pass。

- [ ] **Step 8: 隔离 Hub E2E 验证 B2 滚动条不弹回**

启动隔离 Hub（`& exe` 同句、不要 Start-Process）：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-decouple-T2"; & "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9242
```

操作（手工或 CDP）：
1. 创建 free 圆桌（3 家 claude-sonnet-4-5）
2. 输入「写一个超长的回答（要求至少 500 字以上分多段）」点提问
3. 等其中一家先答完（看到「已答 ✓」状态）
4. 在已答完的卡片预览区滚动，观察 30 秒
5. **预期**：滚动位置稳定不弹回顶部（哪怕其他家仍在 streaming）。
6. 同时打开 DevTools console，看 `[roundtable]` 日志确认 partial-update 心跳确实在到达。

通过后退出。

- [ ] **Step 9: Commit**

```powershell
git add renderer/meeting-room.js tests/unit-card-streaming-decoupling.test.js
git commit -m @'
fix(roundtable): partial-update 改局部 patch + diff 短路修复 B2 滚动条弹回

旧版 panel.innerHTML 全量重渲：任意一家心跳→三家卡片 DOM 全销毁→
皮卡丘 settled 后用户在皮卡丘卡片滚动看，每次小火龙心跳都把
.mr-ft-preview 的 scrollTop 拍回 0。

新版：
- _isPartialUnchanged 短路：内容完全没变直接 return（高频心跳零 DOM 操作）
- outerHTML 局部 patch：只替换变化的那个 slot DOM
- scrollTop 保留：替换前记录、替换后恢复
- 拆出 _bindSlotCardEvents：局部 rebind 单卡片事件

不动后端 IPC、不动 refreshRoundtablePanel/soft-alert/send-stuck（低频路径）。
'@
```

---

## Task 3: `_openRtTimeline` 合 partial + 抽屉实时订阅（修复 B1 详情看不到最新）

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1072-1161`（`_openRtTimeline` 函数体）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1284-1313`（partial-update handler 加抽屉同步）

**目的：**
1. 抽屉打开时把 `_partialBy[sid]` 合进 turnsList 头部作为「实时」轮次（n = `lastTurn.n + 1` 或 `state.turnNum + 1`），用户点 ↗ 立刻能看到本轮 partial。
2. 抽屉打开期间记录 `_rtTimelineLive = { sid, mid }`，partial-update 同 sid 命中时 mutate 抽屉 `.mr-rt-tl-body`（不重建 overlay），保留用户在抽屉里的滚动位置。
3. 关抽屉时清 `_rtTimelineLive`。
4. 用户切到非 live tab → 不再实时同步（看历史合理）。

- [ ] **Step 1: 在 IIFE 内顶部加 `_rtTimelineLive` 状态**

位置：`C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1167` 附近（其他 `_rtPanelState` 等顶层 state 旁）。

```javascript
  // T3（2026-05-04 道雪）：抽屉实时订阅状态。打开时设 { sid, mid }，关时清 null。
  //   partial-update handler 命中同 sid + 用户当前 active 的是 live tab 时，更新抽屉内容。
  let _rtTimelineLive = null;
```

- [ ] **Step 2: 改 `_openRtTimeline` 合并 partial + 注册 live**

替换 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1072-1161`：

```javascript
  // ---- AI 时间线浮层 ----------------------------------------------------
  // 点击任意卡片 → 打开右侧抽屉，顶部 Tab 列轮次（最新在最左 = 默认 active），点 Tab 切换内容。
  // T3（2026-05-04 道雪）：合并 _partialBy[sid] 作为「实时」虚拟轮次（如果有内容）；
  //   抽屉打开期间订阅 partial-update 实时更新内容（修复 B1 看不到本轮 partial）。
  function _openRtTimeline(meeting, sid, kind) {
    const state = _rtPanelState[meeting.id];
    if (!state || !Array.isArray(state.turns)) return;

    const labelDisplay = _KIND_LABELS[kind] || kind;
    const subs = _getRtSubInfo(meeting);
    const sub = subs[kind];
    const headerLabel = sub && sub.label ? sub.label : labelDisplay;
    const slotIdxTl = (meeting && Array.isArray(meeting.subSessions))
      ? Math.max(0, meeting.subSessions.indexOf(sid))
      : 0;
    const slotClsTl = `slot-${slotIdxTl + 1}`;

    // 收集该 sid 有回答的轮次，按 turn n 倒序（最新在最左）
    const historyTurns = state.turns
      .filter(t => (t.by || {})[sid])
      .sort((a, b) => b.n - a.n);

    // T3：本轮 partial 合并（皮卡丘 settled 但小火龙未完时，本轮没 turn-complete → 用户在抽屉看不到本轮内容）
    const partial = (state._partialBy || {})[sid];
    const liveText = (partial && (partial.text || (Array.isArray(partial.blocks) && partial.blocks.length > 0)))
      ? (partial.text || '') : null;
    const turnsWithAns = [...historyTurns];
    let liveTurn = null;
    if (liveText !== null) {
      const baseTurnN = (historyTurns[0] && historyTurns[0].n) || (state.turnNum || 0);
      liveTurn = {
        n: baseTurnN + 1,
        mode: state.currentMode || 'fanout',
        by: { [sid]: liveText },
        userInput: '',  // partial 阶段没有标准化的 userInput；留空避免 stale
        _live: true,
        _partialStatus: partial.status,
        _partialBlocks: Array.isArray(partial.blocks) ? partial.blocks : null,
      };
      turnsWithAns.unshift(liveTurn);
    }

    let overlay = document.getElementById('mr-rt-timeline-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mr-rt-timeline-overlay';
      overlay.className = 'mr-rt-tl-overlay';
      document.body.appendChild(overlay);
    }

    const renderTurnBody = (turn) => {
      if (!turn) return '<div class="mr-rt-tl-empty">该 AI 还没有可显示的历史回答。</div>';
      // T3：_live 走 partial blocks（如有）→ markdown text → 占位
      let bodyHtml;
      if (turn._live) {
        if (turn._partialBlocks && turn._partialBlocks.length > 0) {
          bodyHtml = _renderPreviewBlocks(turn._partialBlocks, sid);
        } else if (turn.by[sid]) {
          bodyHtml = _renderMarkdown(turn.by[sid]);
        } else {
          bodyHtml = '<div class="mr-rt-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
        }
        // 加流式光标
        bodyHtml += '<span class="mr-ft-cursor"></span>';
      } else {
        const text = (turn.by || {})[sid] || '';
        bodyHtml = _renderMarkdown(text);
      }
      const userIn = (turn.userInput || '').trim();
      const userBlock = userIn
        ? `<div class="mr-rt-tl-user">用户输入：${escapeHtml(userIn.slice(0, 400))}${userIn.length > 400 ? '…' : ''}</div>`
        : '';
      const decisionTag = turn.decisionTitle
        ? `<div class="mr-rt-tl-decision-row">📌 决策标题：${escapeHtml(turn.decisionTitle)}</div>`
        : '';
      return `${decisionTag}${userBlock}<div class="mr-rt-tl-body">${bodyHtml}</div>`;
    };

    const tabsHtml = turnsWithAns.map((t, i) => {
      const modeLabel = { fanout: '提问', debate: '辩论', summary: '综合' }[t.mode] || t.mode;
      const isLatest = i === 0;
      const liveTag = t._live ? '<span class="mr-rt-tl-tab-latest" style="background:#22863a">实时</span>' : '';
      const latestTag = (isLatest && !t._live) ? '<span class="mr-rt-tl-tab-latest">最新</span>' : '';
      return `<button type="button" class="mr-rt-tl-tab ${isLatest ? 'active' : ''}" data-tab-idx="${i}" data-tab-live="${t._live ? '1' : '0'}" title="第 ${t.n} 轮 · ${escapeHtml(modeLabel)}">
        <span class="mr-rt-tl-tab-turn">第 ${t.n} 轮</span>
        <span class="mr-rt-tl-tab-mode ${escapeHtml(t.mode)}">${escapeHtml(modeLabel)}</span>
        ${liveTag}${latestTag}
      </button>`;
    }).join('');

    const hasAnyTab = turnsWithAns.length > 0;

    overlay.innerHTML = `
      <div class="mr-rt-tl-backdrop" data-rt-tl-close="1"></div>
      <aside class="mr-rt-tl-drawer mr-rt-tl-${slotClsTl}" role="dialog" aria-label="${escapeHtml(headerLabel)} 时间线">
        <header class="mr-rt-tl-drawer-head">
          <span class="mr-rt-tl-drawer-title">${escapeHtml(headerLabel)} · 历史回答</span>
          <span class="mr-rt-tl-drawer-meta">共 ${turnsWithAns.length} 轮</span>
          <button type="button" class="mr-rt-tl-close" data-rt-tl-close="1" aria-label="关闭">×</button>
        </header>
        ${hasAnyTab ? `<nav class="mr-rt-tl-tabs" role="tablist">${tabsHtml}</nav>` : ''}
        <div class="mr-rt-tl-content" id="mr-rt-tl-content">${renderTurnBody(turnsWithAns[0])}</div>
      </aside>
    `;
    overlay.style.display = 'block';

    // T3：注册 live 订阅（仅当有 liveTurn 且默认 active 是它时）
    _rtTimelineLive = (liveTurn && turnsWithAns[0] && turnsWithAns[0]._live)
      ? { sid, mid: meeting.id, kind } : null;

    const contentEl = overlay.querySelector('#mr-rt-tl-content');
    overlay.querySelectorAll('.mr-rt-tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.mr-rt-tl-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
        const isLive = btn.getAttribute('data-tab-live') === '1';
        if (contentEl) {
          contentEl.innerHTML = renderTurnBody(turnsWithAns[idx]);
          contentEl.scrollTop = 0;
        }
        // T3：用户切走 live tab → 解订阅；切回 live tab → 重订阅
        _rtTimelineLive = (isLive && liveTurn) ? { sid, mid: meeting.id, kind } : null;
      });
    });

    const closeAll = () => {
      overlay.style.display = 'none';
      document.removeEventListener('keydown', escHandler);
      _rtTimelineLive = null;  // T3：关抽屉清订阅
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') closeAll(); };
    overlay.querySelectorAll('[data-rt-tl-close]').forEach(el => {
      el.addEventListener('click', closeAll);
    });
    document.addEventListener('keydown', escHandler);
  }
```

- [ ] **Step 3: partial-update handler 加抽屉同步分支**

在 Task 2 已经改造过的 `roundtable-partial-update` handler **末尾**（return 前），追加抽屉同步：

位置：紧贴 `_applyPilotCardVisual` 那个 `if` 块结束后（line ~1340 在 T2 改完之后的位置）。

```javascript
    // T3（2026-05-04 道雪）：抽屉实时订阅 — 用户打开 ↗ 看本 sid 的实时 tab 时，
    //   不重建 overlay，仅 mutate `.mr-rt-tl-body` innerHTML，保留用户的滚动位置。
    if (_rtTimelineLive && _rtTimelineLive.sid === sid && _rtTimelineLive.mid === meetingId) {
      const overlay = document.getElementById('mr-rt-timeline-overlay');
      if (overlay && overlay.style.display !== 'none') {
        const tlBody = overlay.querySelector('.mr-rt-tl-body');
        if (tlBody) {
          let inner;
          if (Array.isArray(next.blocks) && next.blocks.length > 0) {
            inner = _renderPreviewBlocks(next.blocks, sid);
          } else if (next.text) {
            inner = _renderMarkdown(next.text);
          } else {
            inner = '<div class="mr-rt-tl-empty" style="opacity:.6">💭 思考中…等待 AI 输出</div>';
          }
          // T3 滚动保留：mutate innerHTML 时记录旧 scrollTop，在父容器（.mr-rt-tl-content）层面恢复
          const tlContent = overlay.querySelector('#mr-rt-tl-content');
          const savedScroll = tlContent ? tlContent.scrollTop : 0;
          tlBody.innerHTML = inner;
          if (tlContent && savedScroll > 0) tlContent.scrollTop = savedScroll;
        }
      }
    }
```

- [ ] **Step 4: 跑现有所有单测确认无回归**

Run:
```powershell
node --test tests\unit-meeting-store-free-fields.test.js tests\unit-roundtable-free-dispatch.test.js tests\unit-roundtable-free-prompt.test.js tests\unit-meeting-mode-toggle.test.js tests\unit-participants-persistence.test.js tests\unit-card-streaming-decoupling.test.js
```
Expected: 全部 pass。

- [ ] **Step 5: 隔离 Hub E2E 验证 B1 + B2 联合**

启动隔离 Hub（`& exe` 同句、不要 Start-Process）：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-decouple-T3"; & "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9243
```

操作场景 1（B1 验证）：
1. 创建 free 圆桌（3 家 claude-sonnet-4-5）
2. 输入「写一个超长的多段回答，至少 600 字」点提问
3. 等其中一家先答完（看到「已答 ✓」），其他还在 streaming
4. 点该家卡片右上角 ↗
5. **预期**：抽屉打开第一个 tab 标「实时」+「绿色徽章」，正文显示该家本轮已经流出来的内容（不是上一轮）。
6. 让其他家继续 streaming → 用户在抽屉的 active live tab 中应该看到内容**没有**变化（因为该家已 settled），但抽屉本身不重建、不闪烁。
7. 再次点提问发起第二轮，未答完时点该家 ↗，**预期**：第一个 tab 是「实时」实时显示新一轮 partial 增长；切到第二个 tab（标「最新」）应是上一轮的完整答案。

操作场景 2（B2 验证 + T3 不破坏 T2）：
1. 同一会议，回到主面板
2. 选已答完的卡片，在预览区滚动到中段，等 30 秒（其他家仍在 streaming）
3. **预期**：滚动位置不弹回顶部（T2 仍生效）

通过后退出。

- [ ] **Step 6: Commit**

```powershell
git add renderer/meeting-room.js
git commit -m @'
fix(roundtable): _openRtTimeline 合并 partial + 抽屉实时订阅修复 B1

旧版抽屉只读 state.turns（已落盘历史轮）→ 皮卡丘 settled 但其他家未完时，
本轮没 turn-complete → 用户点 ↗ 看不到本轮内容（永远显示上一轮）。

新版：
- 打开抽屉时合并 _partialBy[sid]，作为「实时」虚拟轮次顶部展示
- _rtTimelineLive 状态记录订阅，partial-update 命中时 mutate 抽屉 .mr-rt-tl-body
- 用户切非 live tab → 解订阅；关抽屉 / Esc → 清订阅
- 抽屉滚动位置在 partial 推送时通过父容器 scrollTop 保留
'@
```

---

## Self-Review

**1. Spec coverage:**
- B1 详情抽屉看不到本轮 partial → Task 3 ✓
- B2 卡片预览滚动条弹回顶部 → Task 2 ✓
- 单 AI 卡片状态被全 AI 进度绑死 → Task 1（解耦渲染）+ Task 2（diff 短路 + 局部 patch）✓

**2. Placeholder scan:**
- 所有 step 都有完整代码或确切命令 ✓
- 没有 "TODO / TBD / 类似 Task N" 占位 ✓
- 测试代码完整给出 ✓

**3. Type consistency:**
- `_renderSlotCard(slotIndex, ctx)` 在 T1 定义、T2 复用 ✓
- `_isPartialUnchanged(prev, next)` 单测与实现签名一致 ✓
- `_bindSlotCardEvents(slotEl, meeting)` T2 定义、`_bindRtPanelEvents` 内调用一致 ✓
- `_rtTimelineLive = { sid, mid, kind }` T3 三处使用（_openRtTimeline 注册 / 切 tab 重设 / partial-update 命中）字段一致 ✓
- ctx 对象字段 `{ state, currentMode, partialBy, meeting, slots, lastTurn, summarizerSlot, meetingId, focused }` 在 T1 `_renderFusedTabs` / T2 partial-update handler 两处构造一致 ✓

**4. 风险控制：**
- 不动后端 / IPC 协议 / state 持久化 ✓
- 不动 pilot / free / scene 任何业务逻辑 ✓
- T2 局部 patch 失败有 fallback：`slotEl` 找不到 / `slotIndex < 0` 时回退到全量重渲（`refreshRoundtablePanel` 的等价路径）✓
- T3 抽屉订阅生命周期完整：open → 注册；切 tab → 重新评估；close / Esc → 清 ✓
- 每个 task 单文件 commit（不触发 refactor-guard 的 ≥3 文件门）；T2 含 1 个新测试文件，仍 ≤ 2 文件 ✓

---

## 不在本 plan 内（明确暂缓）

- Fix C：`roundtable-soft-alert` / `roundtable-send-stuck` handler 的全量重渲改造（低频，不阻塞修复 B1+B2）
- Fix D：完整 5 场景隔离 Hub CDP E2E 自动化套件（用户选 B 最小修复，本 plan 用启动 Hub 手工/CDP 操作验证）
- 后端流式协议改造、orchestrator 重构、其他 panel 级状态独立化

---

**Plan 完成。**
