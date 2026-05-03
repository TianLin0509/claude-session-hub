# 圆桌自由模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有圆桌"主驾模式"基础上**新增并存**一种"自由模式"，用参与者勾选取代主驾/副驾概念；pilot 路径完全不动。

**Architecture:** 新建 `core/roundtable-free.js` 集中 free 模式所有逻辑（dispatch + prompt 三模板）。`meeting.mode + meeting.participants` 双字段标识模式与勾选状态，老 meeting `mode` 缺失时视为 pilot。Free 模式 turn record 写**派生 dispatchMode**（数量映射 all/pilot/observer），让现有 `roundtable-injection.js` 同组跳过算法零修改。

**Tech Stack:** Node.js + Electron, plain assert + console.log 测试，PowerShell 5.1 命令风格，Playwright CDP E2E。

**Spec:** `C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-04-roundtable-free-mode-design.md`

---

## File Structure

### 新建（6 个文件）

```
C:\Users\lintian\claude-session-hub\
  core\roundtable-free.js                            # ~250 行 dispatch + prompt
  tests\unit-meeting-store-free-fields.test.js       # T1
  tests\unit-roundtable-free-dispatch.test.js        # T2
  tests\unit-roundtable-free-prompt.test.js          # T3
  tests\unit-meeting-mode-toggle.test.js             # T4 一半
  tests\unit-participants-persistence.test.js        # T4 另一半
  tests\_e2e-free-mode-verify.js                     # T8（gitignored）
```

### 修改（4 个文件）

```
C:\Users\lintian\claude-session-hub\
  core\meeting-store.js          # T1 加 mode/participants 字段持久化 + 兜底
  main.js                        # T4 新 IPC handler / T5 dispatchRoundtableTurn 入口分支 + 默认 mode='free'
  renderer\meeting-room.js       # T6 mode toggle + free 头像勾选区 / T7 状态行/输入框/辩论按钮分支
  renderer\meeting-room.css      # T7 样式
```

### 零改动（关键收益）

```
core\roundtable-injection.js              # dispatchMode 派生方案让算法零改
core\roundtable-orchestrator.js           # pilot 路径完全不动（仅 main.js 入口加分支）
core\roundtable-watcher.js
core\roundtable-scenes.js                 # pilot prompt 模板
tests\unit-roundtable-injection-matrix.test.js
tests\unit-pilot-dispatch-mode.test.js
tests\unit-roundtable-slot-participation.test.js
```

---

## Task 总览

| Task | 范围 | 主要文件 |
|---|---|---|
| T1 | meeting-store.js mode/participants 字段持久化 + 兜底 | core/meeting-store.js |
| T2 | roundtable-free.js dispatch（deriveTargetSids + derivePilotCompatDispatchMode） | core/roundtable-free.js |
| T3 | roundtable-free.js prompt 三模板 + 第一行契约 | core/roundtable-free.js |
| T4 | main.js 两个新 IPC handler（set-meeting-mode + set-participants） | main.js |
| T5 | main.js dispatchRoundtableTurn 入口分支接通 free 模式 + 新建默认 mode='free' | main.js |
| T6 | renderer mode toggle + free 头像勾选区 | renderer/meeting-room.js |
| T7 | renderer 状态行 / 输入框 / 辩论按钮分支 + CSS | renderer/meeting-room.{js,css} |
| T8 | 隔离 Hub CDP E2E 5 场景验证 | tests/_e2e-free-mode-verify.js |
| T9 | 集成验证 + silent-failure 扫描 + finishing | （多文件） |

---

## Task 1：meeting-store.js mode/participants 字段持久化

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-store.js` (saveMeetingFile + loadMeetingFile)
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-meeting-store-free-fields.test.js`

**关键设计**：SCHEMA_VERSION 不动，新字段缺失时兜底默认。`mode` 缺失 → `'pilot'`（兼容老 meeting）；`participants` 缺失 → `null`（首次进 free 模式时 main.js 初始化 [0,1,2]）。

- [ ] **Step 1：写失败测试**

创建 `C:\Users\lintian\claude-session-hub\tests\unit-meeting-store-free-fields.test.js`：

```js
'use strict';
// 测 meeting-store.js 新增 mode/participants 字段往返持久化 + 兜底

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 测试用临时数据目录
const TEST_DIR = path.join(os.tmpdir(), `hub-test-meeting-store-${Date.now()}`);
process.env.CLAUDE_HUB_DATA_DIR = TEST_DIR;

// data-dir 缓存解决，必须在 process.env 设置后 require
const store = require('../core/meeting-store');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

function testFreshSaveAndLoad() {
  store.saveMeetingFile('m1', { mode: 'free', participants: [0, 2] });
  const loaded = store.loadMeetingFile('m1');
  assert.strictEqual(loaded.mode, 'free');
  assert.deepStrictEqual(loaded.participants, [0, 2]);
}

function testLegacyMeetingDefaultsToPilot() {
  // 模拟老 meeting：手工写一个无 mode/participants 字段的 JSON
  const dir = path.join(TEST_DIR, 'meetings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'm-legacy.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'm-legacy',
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
    pilotSlot: null,
    dispatchMode: 'all',
    savedAt: Date.now(),
  }));
  // 用 saveMeetingFile 重写一次（loadMeetingFile 不做兜底，兜底在 main.js 读取后做）
  // 我们的契约：saveMeetingFile 写时 mode 缺失则默认 'pilot'，participants 缺失则 null
  store.saveMeetingFile('m-legacy-resaved', {});
  const re = store.loadMeetingFile('m-legacy-resaved');
  assert.strictEqual(re.mode, 'pilot', 'mode default pilot');
  assert.strictEqual(re.participants, null, 'participants default null');
}

function testInvalidModeFallsBackToPilot() {
  store.saveMeetingFile('m-bad', { mode: 'invalid', participants: [0] });
  const re = store.loadMeetingFile('m-bad');
  assert.strictEqual(re.mode, 'pilot', 'invalid mode → pilot');
}

function testInvalidParticipantsFallsBackToNull() {
  store.saveMeetingFile('m-bad2', { mode: 'free', participants: 'not-array' });
  const re = store.loadMeetingFile('m-bad2');
  assert.strictEqual(re.participants, null, 'non-array → null');
}

function testEmptyArrayParticipantsAllowed() {
  // Q11=A：用户故意清空也持久化
  store.saveMeetingFile('m-empty', { mode: 'free', participants: [] });
  const re = store.loadMeetingFile('m-empty');
  assert.deepStrictEqual(re.participants, [], 'empty array preserved');
}

console.log('--- meeting-store free fields ---');
run('testFreshSaveAndLoad', testFreshSaveAndLoad);
run('testLegacyMeetingDefaultsToPilot', testLegacyMeetingDefaultsToPilot);
run('testInvalidModeFallsBackToPilot', testInvalidModeFallsBackToPilot);
run('testInvalidParticipantsFallsBackToNull', testInvalidParticipantsFallsBackToNull);
run('testEmptyArrayParticipantsAllowed', testEmptyArrayParticipantsAllowed);

// cleanup
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2：跑测试，验证 FAIL**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-store-free-fields.test.js
```

预期：4-5 个 ✗（saveMeetingFile 没写 mode/participants 字段，loaded 对应字段是 undefined）

- [ ] **Step 3：修改 saveMeetingFile，加两个新字段（兜底）**

`C:\Users\lintian\claude-session-hub\core\meeting-store.js` 第 23-37 行（`saveMeetingFile`）：

把原来的 `payload` 对象改为：

```js
const payload = {
  schemaVersion: SCHEMA_VERSION,
  id,
  _timeline: Array.isArray(data._timeline) ? data._timeline : [],
  _cursors: data._cursors && typeof data._cursors === 'object' ? data._cursors : {},
  _nextIdx: typeof data._nextIdx === 'number' ? data._nextIdx : 0,
  slotSpecs: Array.isArray(data.slotSpecs) ? data.slotSpecs : null,
  pilotSlot: (typeof data.pilotSlot === 'number') ? data.pilotSlot : null,
  dispatchMode: ['all', 'pilot', 'observer'].includes(data.dispatchMode) ? data.dispatchMode : 'all',
  // free-mode（2026-05-04）：mode = 'pilot'|'free'，缺失/非法 → 'pilot'（老 meeting 兼容）
  mode: ['pilot', 'free'].includes(data.mode) ? data.mode : 'pilot',
  // free-mode（2026-05-04）：participants = number[]（slot 索引）｜null（首次未初始化）
  //   非数组 → null；空数组保留（Q11=A：尊重用户清空）
  participants: Array.isArray(data.participants) ? data.participants : null,
  savedAt: Date.now(),
};
```

- [ ] **Step 4：再跑测试，验证 PASS**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-store-free-fields.test.js
```

预期：5 个 ✓，exit 0

- [ ] **Step 5：commit**

```powershell
git add core/meeting-store.js tests/unit-meeting-store-free-fields.test.js
git commit -m "feat(meeting-store): T1 — mode/participants 字段持久化 + 老 meeting 兼容"
```

---

## Task 2：core/roundtable-free.js dispatch 部分

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\roundtable-free.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js`

**关键接口**：
- `deriveTargetSids(meeting, mode, summarizerSlot)` → string[]
- `derivePilotCompatDispatchMode(participants)` → 'all' | 'pilot' | 'observer'

`deriveTargetSids` 输入约定：`meeting.subSessions` 是 sid 数组（slot 0/1/2 由数组位置决定），`meeting.participants` 是 slot 索引数组。返回的 sid 数组保持 slot 顺序，便于 prompt 渲染时同序。

- [ ] **Step 1：写失败测试**

创建 `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js`：

```js
'use strict';
// 测 core/roundtable-free.js dispatch 推导

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const meeting = {
  subSessions: ['sid_pikachu', 'sid_charmander', 'sid_squirtle'],
  participants: [0, 1, 2],
};

function testDeriveTargetSids_FanoutAllThree() {
  const sids = free.deriveTargetSids(meeting, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_charmander', 'sid_squirtle']);
}

function testDeriveTargetSids_FanoutOneSlot() {
  const m = { ...meeting, participants: [1] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_charmander']);
}

function testDeriveTargetSids_FanoutTwoSlots() {
  const m = { ...meeting, participants: [0, 2] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_squirtle']);
}

function testDeriveTargetSids_DebateSameAsFanout() {
  const m = { ...meeting, participants: [0, 1] };
  const sids = free.deriveTargetSids(m, 'debate', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_charmander']);
}

function testDeriveTargetSids_SummaryIgnoresParticipants() {
  // Q8=A：summary 模式 summarizer 独说，不受 participants 影响
  const m = { ...meeting, participants: [0] };  // 仅勾选 pikachu
  const sids = free.deriveTargetSids(m, 'summary', 'squirtle');  // 但选 squirtle 总结
  assert.deepStrictEqual(sids, ['sid_squirtle'], 'summary 不受 participants 限制');
}

function testDeriveTargetSids_EmptyParticipants() {
  // Q11=A：空 participants → 空 targets（UI 已防发送，这里仅返回空数组）
  const m = { ...meeting, participants: [] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, []);
}

function testDeriveTargetSids_NullParticipants() {
  // 首次进 free 模式（participants 仍是 null）→ 调用方应初始化为 [0,1,2]
  // 但若调用方未初始化就调 derive → 空数组（防御性）
  const m = { ...meeting, participants: null };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, []);
}

function testDerivePilotCompat_Three() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([0, 1, 2]), 'all');
}

function testDerivePilotCompat_One() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([1]), 'pilot');
}

function testDerivePilotCompat_Two() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([0, 2]), 'observer');
}

function testDerivePilotCompat_Edge() {
  // 0 人 / >3 人（防御性）→ 'all'
  assert.strictEqual(free.derivePilotCompatDispatchMode([]), 'all');
  assert.strictEqual(free.derivePilotCompatDispatchMode([0,1,2,3]), 'all');
  assert.strictEqual(free.derivePilotCompatDispatchMode(null), 'all');
}

console.log('--- roundtable-free dispatch ---');
run('testDeriveTargetSids_FanoutAllThree', testDeriveTargetSids_FanoutAllThree);
run('testDeriveTargetSids_FanoutOneSlot', testDeriveTargetSids_FanoutOneSlot);
run('testDeriveTargetSids_FanoutTwoSlots', testDeriveTargetSids_FanoutTwoSlots);
run('testDeriveTargetSids_DebateSameAsFanout', testDeriveTargetSids_DebateSameAsFanout);
run('testDeriveTargetSids_SummaryIgnoresParticipants', testDeriveTargetSids_SummaryIgnoresParticipants);
run('testDeriveTargetSids_EmptyParticipants', testDeriveTargetSids_EmptyParticipants);
run('testDeriveTargetSids_NullParticipants', testDeriveTargetSids_NullParticipants);
run('testDerivePilotCompat_Three', testDerivePilotCompat_Three);
run('testDerivePilotCompat_One', testDerivePilotCompat_One);
run('testDerivePilotCompat_Two', testDerivePilotCompat_Two);
run('testDerivePilotCompat_Edge', testDerivePilotCompat_Edge);

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2：跑测试，验证 FAIL**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js
```

预期：`Cannot find module '../core/roundtable-free'` 或全部 11 个 ✗

- [ ] **Step 3：实现 core/roundtable-free.js（dispatch 部分）**

创建 `C:\Users\lintian\claude-session-hub\core\roundtable-free.js`：

```js
'use strict';
// Roundtable Free Mode — 自由模式 dispatch + prompt 模板（2026-05-04）
//
// 与主驾模式（pilot mode）共存，独立模块。
// pilot 路径完全不动；本模块仅在 meeting.mode === 'free' 时被 main.js 调用。
//
// 核心接口：
//   deriveTargetSids(meeting, mode, summarizerSlot) → string[]
//     按 mode 决定本轮目标：
//       summary → [summarizerSub.sid]（不受 participants 影响）
//       fanout/debate → participants 对应的 sub.sid，按 slot 顺序
//
//   derivePilotCompatDispatchMode(participants) → 'all'|'pilot'|'observer'
//     兼容字段：写到 turn record 的 dispatchMode，让现有 roundtable-injection.js
//     同组跳过算法零修改。语义：参与者集合的等价类标签。
//
//   buildFreeFanoutPrompt / buildFreeDebatePrompt / buildFreeSummaryPrompt
//     第一行格式：# 自由模式 第 N 轮 <mode> — 你是 <slotLabel>
//     满足 Resend T2 第一行契约（非空 + 含轮号）

const SLOT_IDS = ['pikachu', 'charmander', 'squirtle'];

function deriveTargetSids(meeting, mode, summarizerSlot) {
  if (!meeting || !Array.isArray(meeting.subSessions)) return [];

  if (mode === 'summary') {
    if (!summarizerSlot) return [];
    const idx = SLOT_IDS.indexOf(summarizerSlot);
    if (idx < 0) return [];
    const sid = meeting.subSessions[idx];
    return sid ? [sid] : [];
  }

  // fanout / debate：按 participants 过滤 sub
  if (!Array.isArray(meeting.participants)) return [];
  const result = [];
  for (const slotIdx of meeting.participants) {
    if (typeof slotIdx !== 'number' || slotIdx < 0 || slotIdx > 2) continue;
    const sid = meeting.subSessions[slotIdx];
    if (sid) result.push(sid);
  }
  return result;
}

function derivePilotCompatDispatchMode(participants) {
  if (!Array.isArray(participants)) return 'all';
  const len = participants.length;
  if (len === 1) return 'pilot';
  if (len === 2) return 'observer';
  // 0 / 3 / >3 → all（兜底；3 人是天然全员；0/>3 防御性默认）
  return 'all';
}

module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  // T3 会补 buildFree* prompt 模板
};
```

- [ ] **Step 4：再跑测试，验证 PASS**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js
```

预期：11 个 ✓，exit 0

- [ ] **Step 5：commit**

```powershell
git add core/roundtable-free.js tests/unit-roundtable-free-dispatch.test.js
git commit -m "feat(roundtable-free): T2 — deriveTargetSids + derivePilotCompatDispatchMode"
```

---

## Task 3：roundtable-free.js prompt 三模板

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\roundtable-free.js` (extend with build* fns)
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js`

**第一行契约（沿用 Resend T2）**：`# 自由模式 第 N 轮 <mode> — 你是 <slotLabel>`

- [ ] **Step 1：写失败测试**

创建 `C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js`：

```js
'use strict';
// 测 core/roundtable-free.js prompt 三模板 + 第一行格式契约

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const baseMeeting = {
  subSessions: ['sid_pi', 'sid_ch', 'sid_sq'],
  participants: [0, 1, 2],
};

function testFanoutFirstLineContract() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 1,            // Charmander 视角
    participants: [0, 1],
    userInput: 'hello',
    lastTurnInjection: null,
    turnNum: 5,
  });
  const firstLine = p.split('\n')[0];
  // 契约：非空 + 含轮号 + 自由模式标识 + slot label
  assert.ok(firstLine.length > 0, 'first line non-empty');
  assert.ok(/第\s*5\s*轮/.test(firstLine), 'first line contains turn number');
  assert.ok(firstLine.includes('自由模式'), 'first line marks 自由模式');
  assert.ok(firstLine.includes('fanout'), 'first line includes mode');
  assert.ok(firstLine.includes('Charmander'), 'first line includes self slot');
}

function testFanoutListsParticipants() {
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'hi',
    lastTurnInjection: null,
    turnNum: 1,
  });
  // 显式列出参与者（自由模式不藏 selfRole，只列发言人）
  assert.ok(p.includes('Pikachu'), 'lists Pikachu');
  assert.ok(p.includes('Charmander'), 'lists Charmander');
  assert.ok(!p.includes('Squirtle'), '未勾选的不列出');
}

function testFanoutHasNoMainCoPilot() {
  // 确认 free 模式 prompt 完全不包含"主驾"/"副驾"/"co-pilot" 字眼
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1, 2],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 2,
  });
  assert.ok(!p.includes('主驾'), 'no 主驾');
  assert.ok(!p.includes('副驾'), 'no 副驾');
  assert.ok(!p.includes('co-pilot'), 'no co-pilot');
}

function testDebateFirstLineContract() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: '反驳一下',
    lastTurnInjection: null,
    turnNum: 6,
  });
  const firstLine = p.split('\n')[0];
  assert.ok(/第\s*6\s*轮/.test(firstLine), 'turn number');
  assert.ok(firstLine.includes('自由模式'), 'free mode marker');
  assert.ok(firstLine.includes('debate'), 'mode marker');
}

function testDebateMentionsRebuttal() {
  const p = free.buildFreeDebatePrompt({
    meeting: baseMeeting,
    selfSlot: 0,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: null,
    turnNum: 1,
  });
  // 辩论 prompt 必须明确说"反驳/呼应"
  assert.ok(p.includes('反驳') || p.includes('呼应'), 'debate prompt mentions rebut/respond');
}

function testSummaryFirstLineContract() {
  const p = free.buildFreeSummaryPrompt({
    meeting: baseMeeting,
    summarizerSlot: 'squirtle',
    userInput: '',
    lastTurnInjection: null,
    turnNum: 7,
  });
  const firstLine = p.split('\n')[0];
  assert.ok(/第\s*7\s*轮/.test(firstLine), 'turn number');
  assert.ok(firstLine.includes('自由模式'), 'free mode marker');
  assert.ok(firstLine.includes('summary'), 'mode marker');
  assert.ok(firstLine.includes('Squirtle'), 'summarizer label');
}

function testSummaryNoMainCoPilot() {
  const p = free.buildFreeSummaryPrompt({
    meeting: baseMeeting,
    summarizerSlot: 'pikachu',
    userInput: '',
    lastTurnInjection: null,
    turnNum: 3,
  });
  assert.ok(!p.includes('主驾'), 'summary no 主驾');
  assert.ok(!p.includes('副驾'), 'summary no 副驾');
}

function testInjectionIsRendered() {
  const inj = {
    lastTurnNum: 4,
    lastTurnMode: 'fanout',
    lastDispatchMode: 'all',
    isSummaryInjection: false,
    speakers: [
      { sid: 'sid_pi', label: 'Pikachu', role: null, text: '上一轮 Pikachu 说了 X', status: 'completed' },
    ],
  };
  const p = free.buildFreeFanoutPrompt({
    meeting: baseMeeting,
    selfSlot: 1,
    participants: [0, 1],
    userInput: 'q',
    lastTurnInjection: inj,
    turnNum: 5,
  });
  assert.ok(p.includes('上一轮 Pikachu 说了 X'), 'injection text rendered');
  assert.ok(p.includes('Pikachu'), 'injection speaker label rendered');
}

console.log('--- roundtable-free prompt ---');
run('testFanoutFirstLineContract', testFanoutFirstLineContract);
run('testFanoutListsParticipants', testFanoutListsParticipants);
run('testFanoutHasNoMainCoPilot', testFanoutHasNoMainCoPilot);
run('testDebateFirstLineContract', testDebateFirstLineContract);
run('testDebateMentionsRebuttal', testDebateMentionsRebuttal);
run('testSummaryFirstLineContract', testSummaryFirstLineContract);
run('testSummaryNoMainCoPilot', testSummaryNoMainCoPilot);
run('testInjectionIsRendered', testInjectionIsRendered);

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2：跑测试，验证 FAIL**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js
```

预期：8 个 ✗（buildFree* 函数还不存在）

- [ ] **Step 3：扩展 core/roundtable-free.js（加 prompt 模板）**

在 `C:\Users\lintian\claude-session-hub\core\roundtable-free.js` 文件**末尾、`module.exports` 之前**插入：

```js
// ---------------------------------------------------------------------------
// Prompt 模板（free 模式专用）
// ---------------------------------------------------------------------------

const SLOT_DISPLAY = {
  pikachu:    { en: 'Pikachu',    icon: '⚡' },
  charmander: { en: 'Charmander', icon: '🔥' },
  squirtle:   { en: 'Squirtle',   icon: '💎' },
};

function _slotLabel(slotIdOrIdx) {
  const id = typeof slotIdOrIdx === 'number' ? SLOT_IDS[slotIdOrIdx] : slotIdOrIdx;
  const d = SLOT_DISPLAY[id];
  return d ? `${d.icon} ${d.en}` : 'AI';
}

function _formatParticipantList(participants) {
  if (!Array.isArray(participants) || participants.length === 0) return '';
  return participants.map(idx => _slotLabel(idx)).join(', ');
}

function _renderInjection(inj) {
  if (!inj || !Array.isArray(inj.speakers) || inj.speakers.length === 0) return '';
  const lines = ['', '[上一轮注入]'];
  if (inj.isSummaryInjection) {
    lines.push(`（上一轮是摘要轮，第 ${inj.lastTurnNum} 轮 · ${inj.lastTurnMode}）`);
  } else {
    lines.push(`（第 ${inj.lastTurnNum} 轮 · ${inj.lastTurnMode} · ${inj.lastDispatchMode}）`);
  }
  for (const s of inj.speakers) {
    lines.push('');
    lines.push(`### ${s.label}（${s.status || 'completed'}）`);
    lines.push(s.text || '');
  }
  return lines.join('\n');
}

function buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum }) {
  const selfLabel = _slotLabel(selfSlot);
  const partList = _formatParticipantList(participants);
  const lines = [
    `# 自由模式 第 ${turnNum} 轮 fanout — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · fanout`,
    `- 本轮发言人：${partList}`,
    `- 你是：${selfLabel}`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）。');
  return lines.join('\n');
}

function buildFreeDebatePrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum }) {
  const selfLabel = _slotLabel(selfSlot);
  const partList = _formatParticipantList(participants);
  const lines = [
    `# 自由模式 第 ${turnNum} 轮 debate — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · 辩论`,
    `- 本轮发言人：${partList}`,
    `- 你是：${selfLabel}`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请反驳/呼应其他发言人的观点（你们看得到对方本轮言论）。');
  return lines.join('\n');
}

function buildFreeSummaryPrompt({ meeting, summarizerSlot, userInput, lastTurnInjection, turnNum }) {
  const selfLabel = _slotLabel(summarizerSlot);
  const lines = [
    `# 自由模式 第 ${turnNum} 轮 summary — 你是 ${selfLabel}`,
    '',
    '[本轮上下文]',
    `- 模式：自由模式 · 总结`,
    `- 你被点名担任本轮总结人`,
  ];
  const inj = _renderInjection(lastTurnInjection);
  if (inj) lines.push(inj);
  lines.push('', '[用户输入]', userInput || '');
  lines.push('', '请综合上述历史给出总结。');
  return lines.join('\n');
}
```

并把 `module.exports` 改为：

```js
module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  buildFreeFanoutPrompt,
  buildFreeDebatePrompt,
  buildFreeSummaryPrompt,
};
```

- [ ] **Step 4：再跑测试，验证 PASS**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js
```

预期：8 个 ✓，exit 0

也跑 T2 测试确保未破坏：

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js
```

预期：仍 11 个 ✓

- [ ] **Step 5：commit**

```powershell
git add core/roundtable-free.js tests/unit-roundtable-free-prompt.test.js
git commit -m "feat(roundtable-free): T3 — buildFree*Prompt 三模板 + 第一行契约"
```

---

## Task 4：main.js 两个新 IPC handler

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js` (新增两个 ipcMain.handle)
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js`

**关键约束**：
- `roundtable:set-meeting-mode`：mode ∈ {'pilot','free'}；inProgress=true 时拒绝（Q9=A）
- `roundtable:set-participants`：校验 number[] 元素 ∈ {0,1,2} + 去重；空数组允许（Q11=A）
- 切到 free 模式时，若 meeting.participants===null，**首次初始化为 [0,1,2]**

由于 main.js 整体不易在测试里 import，本 task 的单测**只测 helper 函数**（提取出来导出 + 校验逻辑），E2E 留给 T8 验证 IPC 真实往返。

- [ ] **Step 1：写失败测试（unit-meeting-mode-toggle）**

创建 `C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js`：

```js
'use strict';
// 测 main.js 提取的 _validateMode + _validateParticipants 校验函数

const assert = require('assert');
const { _validateMode, _validateParticipants } = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

function testValidateMode_Pilot() {
  assert.strictEqual(_validateMode('pilot'), 'pilot');
}
function testValidateMode_Free() {
  assert.strictEqual(_validateMode('free'), 'free');
}
function testValidateMode_RejectsInvalid() {
  assert.throws(() => _validateMode('banana'), /Invalid mode/);
  assert.throws(() => _validateMode(null), /Invalid mode/);
  assert.throws(() => _validateMode(undefined), /Invalid mode/);
}

function testValidateParticipants_Empty() {
  // Q11=A：空允许
  assert.deepStrictEqual(_validateParticipants([]), []);
}
function testValidateParticipants_All() {
  assert.deepStrictEqual(_validateParticipants([0, 1, 2]), [0, 1, 2]);
}
function testValidateParticipants_Dedupe() {
  assert.deepStrictEqual(_validateParticipants([1, 1, 0]), [0, 1]);
}
function testValidateParticipants_RejectOutOfRange() {
  assert.throws(() => _validateParticipants([0, 3]), /Invalid participant slot/);
  assert.throws(() => _validateParticipants([-1]), /Invalid participant slot/);
}
function testValidateParticipants_RejectNonArray() {
  assert.throws(() => _validateParticipants('all'), /participants must be array/);
  assert.throws(() => _validateParticipants(null), /participants must be array/);
}

console.log('--- meeting-mode-toggle validators ---');
run('testValidateMode_Pilot', testValidateMode_Pilot);
run('testValidateMode_Free', testValidateMode_Free);
run('testValidateMode_RejectsInvalid', testValidateMode_RejectsInvalid);
run('testValidateParticipants_Empty', testValidateParticipants_Empty);
run('testValidateParticipants_All', testValidateParticipants_All);
run('testValidateParticipants_Dedupe', testValidateParticipants_Dedupe);
run('testValidateParticipants_RejectOutOfRange', testValidateParticipants_RejectOutOfRange);
run('testValidateParticipants_RejectNonArray', testValidateParticipants_RejectNonArray);

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2：写失败测试（unit-participants-persistence）— 简化版（与 T1 meeting-store 测试互补）**

创建 `C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js`：

```js
'use strict';
// 测 deriveTargetSids 在 participants 不同状态下的行为
//（往返持久化由 T1 的 unit-meeting-store-free-fields 覆盖）

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const meeting = { subSessions: ['s0', 's1', 's2'] };

function testParticipants_DefaultAllOnFreshFreeMode() {
  // 首次进 free 模式：main.js 初始化 [0,1,2]
  // 这里仅验证 derive 在 [0,1,2] 时返回全员
  const m = { ...meeting, participants: [0, 1, 2] };
  assert.deepStrictEqual(free.deriveTargetSids(m, 'fanout', null), ['s0','s1','s2']);
}

function testParticipants_OrderPreserved() {
  // participants 顺序应映射到 sub 顺序（不打乱）
  const m = { ...meeting, participants: [2, 0] };
  assert.deepStrictEqual(free.deriveTargetSids(m, 'fanout', null), ['s2','s0']);
}

function testParticipants_DuplicatesIgnored() {
  // IPC 校验已去重；这里用直接传重复值看 derive 行为（也会按 slot 去取，可能产生重复 sid，
  // 但 IPC 路径不会传非去重值，本测试仅是防御）
  const m = { ...meeting, participants: [1, 1] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  // derive 不去重（IPC 已去重）；如调用方违约，结果会有重复
  assert.deepStrictEqual(sids, ['s1','s1']);
}

console.log('--- participants persistence ---');
run('testParticipants_DefaultAllOnFreshFreeMode', testParticipants_DefaultAllOnFreshFreeMode);
run('testParticipants_OrderPreserved', testParticipants_OrderPreserved);
run('testParticipants_DuplicatesIgnored', testParticipants_DuplicatesIgnored);

process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 3：跑两个测试，验证 FAIL**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js
```

预期：第一个全 ✗（_validateMode/_validateParticipants 未定义）；第二个全 ✓（已实现）

- [ ] **Step 4：在 core/roundtable-free.js 加校验函数 + 导出**

在 `module.exports` 之前插入：

```js
// ---------------------------------------------------------------------------
// IPC 校验 helper（main.js 用）
// ---------------------------------------------------------------------------

function _validateMode(mode) {
  if (mode !== 'pilot' && mode !== 'free') {
    throw new Error(`Invalid mode: ${JSON.stringify(mode)} (expected 'pilot' or 'free')`);
  }
  return mode;
}

function _validateParticipants(arr) {
  if (!Array.isArray(arr)) {
    throw new Error(`participants must be array, got ${typeof arr}`);
  }
  const seen = new Set();
  for (const x of arr) {
    if (typeof x !== 'number' || x < 0 || x > 2) {
      throw new Error(`Invalid participant slot: ${JSON.stringify(x)} (expected 0|1|2)`);
    }
    seen.add(x);
  }
  return [...seen].sort((a, b) => a - b);
}
```

并在 `module.exports` 加：

```js
module.exports = {
  deriveTargetSids,
  derivePilotCompatDispatchMode,
  buildFreeFanoutPrompt,
  buildFreeDebatePrompt,
  buildFreeSummaryPrompt,
  _validateMode,
  _validateParticipants,
};
```

- [ ] **Step 5：跑测试，验证 PASS**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js
```

预期：两个 test 都全 ✓

- [ ] **Step 6：在 main.js 加两个 IPC handler**

在 `C:\Users\lintian\claude-session-hub\main.js` **第 827 行附近**（`roundtable:dispatch-mode-set` handler 之后），插入：

```js
// free-mode（2026-05-04）— 切换 meeting.mode 'pilot' ⇄ 'free'
//   inProgress=true 时拒绝（Q9=A：避免半轮发言后改语义）
//   切到 free 模式时若 meeting.participants===null，首次初始化为 [0,1,2]
ipcMain.handle('roundtable:set-meeting-mode', async (_e, { meetingId, mode } = {}) => {
  if (!meetingId) throw new Error('Missing meetingId');
  const free = require('./core/roundtable-free');
  const validMode = free._validateMode(mode);

  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

  // Q9=A：inProgress 时拒绝
  if (_roundtableInProgress.has(meetingId)) {
    throw new Error('正在跑一轮，请等结束后再切模式');
  }

  meeting.mode = validMode;

  // 切到 free 模式且 participants 未初始化 → 默认全选
  if (validMode === 'free' && meeting.participants === null) {
    meeting.participants = [0, 1, 2];
  }

  meetingManager.saveMeeting(meetingId);

  try {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
      pilotSlotByMeeting: _pilotSlotByMeeting,
      dispatchModeByMeeting: _dispatchModeByMeeting,
    });
  } catch (e) {
    console.warn('[圆桌] roundtable:set-meeting-mode persist failed:', e.message);
  }

  sendToRenderer('meeting-updated', { meeting: meetingManager.getMeeting(meetingId) });
  return { ok: true };
});

// free-mode（2026-05-04）— 设置 free 模式参与者勾选
//   接受空数组（Q11=A：尊重用户清空，UI 已防发送）
ipcMain.handle('roundtable:set-participants', async (_e, { meetingId, participants } = {}) => {
  if (!meetingId) throw new Error('Missing meetingId');
  const free = require('./core/roundtable-free');
  const validated = free._validateParticipants(participants);

  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

  meeting.participants = validated;
  meetingManager.saveMeeting(meetingId);

  try {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
      pilotSlotByMeeting: _pilotSlotByMeeting,
      dispatchModeByMeeting: _dispatchModeByMeeting,
    });
  } catch (e) {
    console.warn('[圆桌] roundtable:set-participants persist failed:', e.message);
  }

  sendToRenderer('meeting-updated', { meeting: meetingManager.getMeeting(meetingId) });
  return { ok: true };
});
```

注：`meetingManager.saveMeeting(meetingId)` 为现有方法（用于触发 markDirty），如不存在请用现有同等的持久化调用，与上方 `roundtable:dispatch-mode-set` 风格一致。如 meetingManager 没有 saveMeeting，回退到 stateStore.save 即可（state 含 meetings 数组）。

- [ ] **Step 7：smoke test 启动 Hub 验证 main.js 不挂**

```powershell
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" 2>&1 | Select-Object -First 30
```

（用 timeout 6s 类似策略，看到 `[hub] hook server listening` 就说明 main.js 没挂）。验证后 Stop-Process electron。

⚠ **铁律提醒**：禁止 kill 用户生产 Hub。验证用**新启动的 electron 进程**，timeout 后自己 Stop-Process。

- [ ] **Step 8：commit**

```powershell
git add main.js core/roundtable-free.js tests/unit-meeting-mode-toggle.test.js tests/unit-participants-persistence.test.js
git commit -m "feat(roundtable): T4 — set-meeting-mode + set-participants IPC handler"
```

---

## Task 5：main.js dispatchRoundtableTurn 入口分支 + 默认 mode='free'

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js` (dispatchRoundtableTurn 1084-1247 附近 + meetingManager createMeeting 默认值)

**关键改动**：在 effectiveDispatchMode 计算前加 `if (meeting.mode === 'free')` 分支：派生 effectiveDispatchMode、按 participants 过滤 targetSubs、用 `roundtable-free` 的 build*Prompt 替代 orch.build*Prompt。**不动 pilot 路径**。

- [ ] **Step 1：定位修改点**

在 `C:\Users\lintian\claude-session-hub\main.js:1084` 找到 `async function dispatchRoundtableTurn(meetingId, { mode, userInput, summarizerSlot, dispatchMode })`。

阅读 1132-1247 行，确认：
- 1138：`effectiveDispatchMode` 计算
- 1142：pilot/observer 要求 pilotSlot 校验
- 1145：pilot 模式 disable debate 校验
- 1150-1157：targetSubs 过滤
- 1191-1244：fanout/debate/summary 三个 mode 分支，各自调 `orch.buildFanoutPrompt/buildDebatePrompt/buildSummaryPrompt`
- 1360：`const meta = { dispatchMode: effectiveDispatchMode };` 写入 turn record

- [ ] **Step 2：在 1136 行（effectiveDispatchMode 之前）插入 free 模式分支**

把第 1132-1157 行原来的逻辑包一层 if/else。修改为：

```js
// pilot redesign（2026-05-02）：dispatchMode × mode 正交路由。
// free-mode（2026-05-04）：meeting.mode === 'free' 时改为 participants 派生路由。

const isFreeMode = meeting.mode === 'free';
const free = isFreeMode ? require('./core/roundtable-free') : null;

let pilotSlot;
let effectiveDispatchMode;
let targetSubs;

if (isFreeMode) {
  // Free 模式：从 participants 派生 effectiveDispatchMode + targets
  pilotSlot = null;  // free 模式无主驾
  // 容错：若 participants 仍是 null（异常状态），UI 应该已防发送，这里兜底为 [0,1,2]
  const parts = Array.isArray(meeting.participants) ? meeting.participants : [0, 1, 2];

  if (parts.length === 0) {
    return { status: 'error', reason: '请勾选至少一位发言人', turnNum: null };
  }
  if (mode === 'debate' && parts.length < 2) {
    return { status: 'error', reason: '辩论需要至少 2 位发言人', turnNum: null };
  }

  effectiveDispatchMode = free.derivePilotCompatDispatchMode(parts, mode);

  if (mode === 'summary') {
    // summary 不受 participants 限制（Q8=A）
    const targetSid = summarizerSlot ? sidBySlot(summarizerSlot) : null;
    if (!targetSid) {
      return { status: 'error', reason: `summarizer slot '${summarizerSlot}' 不在会议室或未活跃`, turnNum: null };
    }
    targetSubs = subs.filter(x => x.sid === targetSid);
  } else {
    // fanout / debate：按 participants 过滤
    const partSet = new Set(parts);
    targetSubs = subs.filter(x => partSet.has(x.slotIndex));
  }
} else {
  // Pilot 模式：原路径完全不动
  pilotSlot = (typeof meeting.pilotSlot === 'number' && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2)
    ? meeting.pilotSlot : null;
  effectiveDispatchMode = ['all', 'pilot', 'observer'].includes(dispatchMode)
    ? dispatchMode
    : (meeting.dispatchMode || 'all');

  if (effectiveDispatchMode !== 'all' && pilotSlot === null) {
    return { status: 'error', reason: `dispatchMode '${effectiveDispatchMode}' 需要先选定主驾`, turnNum: null };
  }
  if (effectiveDispatchMode === 'pilot' && mode === 'debate') {
    return { status: 'error', reason: '主驾发言模式下无法辩论（一家无法互辩）', turnNum: null };
  }

  targetSubs = (() => {
    if (effectiveDispatchMode === 'all') return subs;
    if (effectiveDispatchMode === 'pilot') {
      return subs.filter(x => subSidsRaw.indexOf(x.sid) === pilotSlot);
    }
    return subs.filter(x => subSidsRaw.indexOf(x.sid) !== pilotSlot);
  })();
}

if (targetSubs.length === 0) {
  return { status: 'error', reason: 'dispatch 过滤后无活跃目标 session', turnNum: null };
}
```

⚠ 注意：原来 1138 行的 `dispatchMode` 参数仍存在（renderer 仍会传），free 模式下被忽略 — 符合 spec 8.3。

- [ ] **Step 3：在 fanout/debate/summary 三个分支里加 free 模式 prompt 分支**

修改 1191-1207 行 fanout 分支为：

```js
if (mode === 'fanout') {
  const lastTurn = orch.getLastTurn();
  turnNum = orch.beginTurn('fanout');
  const targetSids = targetSubs.map(t => t.sid);
  const injectMap = rtInjection.computeLastTurnInjection(lastTurn, targetSids, sidLabelFn, sidRoleFn);
  for (const x of targetSubs) {
    let prompt;
    if (isFreeMode) {
      prompt = free.buildFreeFanoutPrompt({
        meeting,
        selfSlot: x.slotIndex,
        participants: meeting.participants,
        userInput,
        lastTurnInjection: injectMap[x.sid] || null,
        turnNum,
      });
    } else {
      const dispatchSpec = _computeDispatchSpec(x, targetSubs, pilotSlot, subSidsRaw, effectiveDispatchMode);
      prompt = orch.buildFanoutPrompt(turnNum, userInput, null, dispatchSpec, injectMap[x.sid] || null, timelinePath);
    }
    targets.push({ ...x, prompt });
  }
}
```

修改 1207-1220 行 debate 分支为：

```js
else if (mode === 'debate') {
  const last = orch.getLastTurn();
  if (!last) {
    orch.rollbackTurn(orch.state.currentTurn + 1);
    return { status: 'error', reason: '没有上一轮可中转，请先用 fanout 提问', turnNum: null };
  }
  turnNum = orch.beginTurn('debate');
  const targetSids = targetSubs.map(t => t.sid);
  const injectMap = rtInjection.computeLastTurnInjection(last, targetSids, sidLabelFn, sidRoleFn);
  for (const x of targetSubs) {
    let prompt;
    if (isFreeMode) {
      prompt = free.buildFreeDebatePrompt({
        meeting,
        selfSlot: x.slotIndex,
        participants: meeting.participants,
        userInput,
        lastTurnInjection: injectMap[x.sid] || null,
        turnNum,
      });
    } else {
      const dispatchSpec = _computeDispatchSpec(x, targetSubs, pilotSlot, subSidsRaw, effectiveDispatchMode);
      prompt = orch.buildDebatePrompt(turnNum, userInput, dispatchSpec, injectMap[x.sid] || null, timelinePath);
    }
    targets.push({ ...x, prompt });
  }
}
```

修改 1221-1244 行 summary 分支：原 `orch.buildSummaryPrompt` 那行替换为：

```js
let prompt;
if (isFreeMode) {
  prompt = free.buildFreeSummaryPrompt({
    meeting,
    summarizerSlot,
    userInput,
    lastTurnInjection: injectMap[target.sid] || null,
    turnNum,
  });
} else {
  const dispatchSpec = _computeDispatchSpec(target, targetSubs, pilotSlot, subSidsRaw, effectiveDispatchMode);
  prompt = orch.buildSummaryPrompt(turnNum, target.sid, sidLabelFn, dispatchSpec, injectMap[target.sid] || null, timelinePath);
}
targets.push({ ...target, prompt });
```

- [ ] **Step 4：新建 meeting 默认 mode='free'**

在 main.js 找到 `meetingManager.createMeeting` 或类似创建 meeting 的位置（搜 `createMeeting`），在初始 meeting 对象中加：

```js
mode: 'free',          // free-mode（2026-05-04）：新建 meeting 默认自由模式
participants: [0, 1, 2], // free-mode：默认全员勾选
```

如代码风格不一致请就近模仿现有字段（如 dispatchMode 默认 'all'）。

- [ ] **Step 5：smoke test**

```powershell
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" 2>&1 | Select-Object -First 40
```

预期：看到 `[hub] hook server listening` 启动正常，**无 `App threw an error during load`**。验证后 Stop-Process electron。

- [ ] **Step 6：跑现有 pilot 测试确保零回归**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-injection-matrix.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-pilot-dispatch-mode.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-slot-participation.test.js
```

预期：全 ✓（pilot 路径零修改 → 测试零变化）

- [ ] **Step 7：commit**

```powershell
git add main.js
git commit -m "feat(roundtable): T5 — dispatchRoundtableTurn 接通 free 模式 + 新建默认 free"
```

---

## Task 6：renderer mode toggle + free 头像勾选区

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` (面板渲染区，2280-2380 附近)

**目标**：
- 在 toolbar 顶部加 segmented control `[🆓 自由模式] [🎯 主驾模式]`，inProgress 时 disabled
- free 模式时分发按钮组替换为头像勾选区（pilot 模式 UI 完全不动）
- 主驾红框（`_applyPilotCardVisual`）在 free 模式下不调用

- [ ] **Step 1：在 panel 渲染区前加 mode toggle HTML**

定位 `meeting-room.js:2333` 的 `el.innerHTML = ` 起点。

把 `${statusLine}` 之前插入：

```js
const meetingMode = (meeting.mode === 'free' || meeting.mode === 'pilot') ? meeting.mode : 'pilot';
const modeToggleDisabled = inProgress ? 'disabled' : '';
const modeToggleHtml = `
  <div class="mr-mode-toggle" role="group" aria-label="圆桌模式">
    <button class="mr-mode-toggle-btn ${meetingMode === 'free' ? 'active' : ''}" data-meeting-mode="free" ${modeToggleDisabled} title="自由模式：勾选发言人">🆓 自由模式</button>
    <button class="mr-mode-toggle-btn ${meetingMode === 'pilot' ? 'active' : ''}" data-meeting-mode="pilot" ${modeToggleDisabled} title="主驾模式：群策/主驾/副驾">🎯 主驾模式</button>
  </div>
`;
```

并把 `el.innerHTML` 改为以 `${modeToggleHtml}` 开头：

```js
el.innerHTML = `
  ${modeToggleHtml}
  ${statusLine}
  ...
```

- [ ] **Step 2：在 toolbar 里按 meetingMode 选择渲染分发区**

把第 2336-2340 行的 `<div class="mr-rt-dispatch-group" ...>三按钮</div>` 改为按 mode 分支：

```js
const SLOT_AVATARS = ['pikachu.png', 'charmander.png', 'squirtle.png'];
const SLOT_LABELS = ['⚡ Pikachu · 皮卡丘', '🔥 Charmander · 小火龙', '💎 Squirtle · 杰尼龟'];

const dispatchAreaHtml = (() => {
  if (meetingMode === 'free') {
    const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
    const partSet = new Set(participants);
    const slotsHtml = [0, 1, 2].map(idx => {
      const checked = partSet.has(idx);
      const disabled = inProgress ? 'disabled' : '';
      return `
        <label class="mr-free-slot ${checked ? 'checked' : ''} ${disabled}" data-slot-idx="${idx}">
          <input type="checkbox" class="mr-free-slot-cb" data-slot-idx="${idx}" ${checked ? 'checked' : ''} ${disabled} />
          <img src="assets/pokemon/${SLOT_AVATARS[idx]}" alt="${SLOT_LABELS[idx]}" />
          <span class="mr-free-slot-label">${SLOT_LABELS[idx]}</span>
        </label>
      `;
    }).join('');
    return `<div class="mr-free-participants" role="group" aria-label="本轮发言人">
      <span class="mr-free-participants-title">本轮发言人</span>
      ${slotsHtml}
    </div>`;
  }
  // pilot 模式：原三按钮组（一行不动）
  return `<div class="mr-rt-dispatch-group" role="group" aria-label="分发模式">
    <button class="mr-rt-dispatch-btn ${dispatchMode === 'all' ? 'active' : ''}" data-dispatch-mode="all" ${dispatchAllDisabled} title="群策群力：本轮 prompt 发给全员">🤝 群策群力</button>
    <button class="mr-rt-dispatch-btn ${dispatchMode === 'pilot' ? 'active' : ''}" data-dispatch-mode="pilot" ${dispatchPilotDisabled} title="${dispatchPilotTitle}">🎯 主驾发言</button>
    <button class="mr-rt-dispatch-btn ${dispatchMode === 'observer' ? 'active' : ''}" data-dispatch-mode="observer" ${dispatchObserverDisabled} title="${dispatchObserverTitle}">👥 副驾发言</button>
  </div>`;
})();
```

把 `el.innerHTML` 中三按钮组替换为 `${dispatchAreaHtml}`。

也要把主驾按钮区（第 2350-2358 行 `<span class="mr-rt-tb-pilot-wrap">...`）包到 `meetingMode === 'pilot' ? ... : ''` 条件里 —— free 模式下隐藏：

```js
const pilotWrapHtml = (meetingMode === 'pilot') ? `
  <span class="mr-rt-tb-divider"></span>
  <span class="mr-rt-tb-pilot-wrap">
    <button class="${pilotBtnCls}" id="mr-pilot-btn" title="...">🚗 主驾角色:<span id="mr-pilot-label">${pilotBtnLabel}</span> ▾</button>
    <span id="mr-pilot-menu" class="mr-pilot-menu" style="display:none;">
      <div class="mr-pilot-option" data-slot="0">⚡ Slot 1 · 皮卡丘</div>
      <div class="mr-pilot-option" data-slot="1">🔥 Slot 2 · 小火龙</div>
      <div class="mr-pilot-option" data-slot="2">💎 Slot 3 · 杰尼龟</div>
      <div class="mr-pilot-option mr-pilot-option-off" data-slot="-1">取消主驾</div>
    </span>
  </span>
` : '';
```

并把 `el.innerHTML` 里那段替换为 `${pilotWrapHtml}`。

- [ ] **Step 3：注册 mode toggle click handler**

在 panel 渲染逻辑里（找现有 `el.querySelectorAll('.mr-rt-dispatch-btn[data-dispatch-mode]').forEach` 附近），加：

```js
el.querySelectorAll('.mr-mode-toggle-btn[data-meeting-mode]').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.hasAttribute('disabled')) return;
    const newMode = btn.getAttribute('data-meeting-mode');
    if (newMode === meetingMode) return;
    try {
      await ipcRenderer.invoke('roundtable:set-meeting-mode', { meetingId: meeting.id, mode: newMode });
    } catch (err) {
      console.error('[set-meeting-mode] failed:', err);
      alert('切换模式失败：' + (err && err.message ? err.message : String(err)));
    }
  });
});
```

- [ ] **Step 4：注册头像勾选 click handler**

同区域加：

```js
el.querySelectorAll('.mr-free-slot-cb[data-slot-idx]').forEach(cb => {
  cb.addEventListener('click', async (ev) => {
    ev.stopPropagation();  // 防止 label click 重复触发
    const slotIdx = parseInt(cb.getAttribute('data-slot-idx'), 10);
    const current = Array.isArray(meeting.participants) ? [...meeting.participants] : [0, 1, 2];
    let next;
    if (cb.checked) {
      // 勾选：加入
      next = current.includes(slotIdx) ? current : [...current, slotIdx];
    } else {
      // 取消：移除
      next = current.filter(x => x !== slotIdx);
    }
    next.sort((a, b) => a - b);
    try {
      await ipcRenderer.invoke('roundtable:set-participants', { meetingId: meeting.id, participants: next });
    } catch (err) {
      console.error('[set-participants] failed:', err);
      alert('保存失败：' + (err && err.message ? err.message : String(err)));
      // 回滚 UI
      cb.checked = !cb.checked;
    }
  });
});
```

- [ ] **Step 5：在 _applyPilotCardVisual 调用前 guard 仅 pilot 模式调**

定位 `meeting-room.js:914-917` 调用 `_applyPilotCardVisual` 处。改为：

```js
if (meeting.mode !== 'free') {
  const dispatchModeForVisual = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
    ? meeting.dispatchMode : 'all';
  _applyPilotCardVisual(meeting, pilotSlotForVisual, dispatchModeForVisual);
}
```

- [ ] **Step 6：smoke test 启动 Hub，目视验证 UI**

启动隔离 Hub：

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-free-mode-T6"
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9221
```

人工验证：
- 新建会议（3 claude）→ 看到顶部 segmented control 高亮"自由模式"
- 看到三个头像 + 全部勾选
- 点击"主驾模式"切换，UI 切回原三按钮 + 红框区
- 切回"自由模式"，状态保持

验证后 Stop-Process。

- [ ] **Step 7：commit**

```powershell
git add renderer/meeting-room.js
git commit -m "feat(renderer): T6 — mode toggle segmented control + free 头像勾选区"
```

---

## Task 7：renderer 状态行 / 输入框 / 辩论按钮分支 + CSS

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 1：状态行格式分支**

定位 `meeting-room.js:2326-2331` 状态行渲染。改为按 mode 分支：

```js
let statusLine;
if (meetingMode === 'free') {
  const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
  const SLOT_NAMES_S = ['⚡Pikachu', '🔥Charmander', '💎Squirtle'];
  let speakerStr;
  if (parts.length === 0) {
    speakerStr = '<strong style="color:#f85149">⚠ 请勾选至少一位发言人</strong>';
  } else {
    speakerStr = '发言人: <strong>' + parts.map(i => SLOT_NAMES_S[i]).join(', ') + '</strong>';
  }
  statusLine = `<div class="mr-status-line">分发: <strong>自由</strong> · ${speakerStr}${
    inProgress ? ' · <strong>⏳ 处理中</strong>' : (turns > 0 ? ` · 已 ${turns} 轮` : '')
  }</div>`;
} else {
  // pilot 路径：原状态行不动
  const dispatchModeLabel = { all: '群策群力', pilot: '主驾发言', observer: '副驾发言' }[dispatchMode];
  const pilotLabel = pilotOn ? `Slot ${pilotSlot + 1}` : '未选';
  statusLine = `<div class="mr-status-line">分发: <strong>${dispatchModeLabel}</strong> · 主驾: <strong>${pilotLabel}</strong>${
    inProgress ? ' · <strong>⏳ 处理中</strong>' : (turns > 0 ? ` · 已 ${turns} 轮` : '')
  }</div>`;
}
```

- [ ] **Step 2：辩论按钮 disabled 条件加 free 分支**

定位 `meeting-room.js:2310` `debateDisabled` 计算。改为：

```js
const debateDisabled = (() => {
  if (turns < 1 || inProgress) return 'disabled';
  if (meetingMode === 'free') {
    const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
    return parts.length < 2 ? 'disabled' : '';
  }
  // pilot 模式：原条件
  return dispatchMode === 'pilot' ? 'disabled' : '';
})();

const debateBtnTitle = (() => {
  if (turns < 1) return '至少完成 1 轮 fanout 才能辩论';
  if (inProgress) return '上一轮还在跑，请等结束';
  if (meetingMode === 'free') {
    const parts = Array.isArray(meeting.participants) ? meeting.participants : [];
    if (parts.length < 2) return '勾选至少 2 位才能辩论';
    return '让目标范围内的 AI 结合彼此观点重新发言';
  }
  if (dispatchMode === 'pilot') return '主驾发言模式下一家无法辩论';
  return '让目标范围内的 AI 结合彼此观点重新发言';
})();
```

并在 HTML 里把辩论按钮 title 改为 `${debateBtnTitle}`。

- [ ] **Step 3：输入框 0 人勾选保护**

找到圆桌输入框渲染处（搜 `圆桌讨论：发普通文本启动一轮` 或 placeholder），改为：

```js
const isFreeZeroSelected = (meetingMode === 'free') &&
  (Array.isArray(meeting.participants) && meeting.participants.length === 0);

const rtInputDisabled = isFreeZeroSelected ? 'readonly' : '';
const rtInputCls = isFreeZeroSelected ? 'mr-rt-input mr-rt-input-disabled' : 'mr-rt-input';
const rtInputPlaceholder = isFreeZeroSelected
  ? '请先勾选至少一位发言人'
  : '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who>';
```

把现有 input 标签的 `placeholder` 和 `class` 替换为这两个变量；`<input ... ${rtInputDisabled} placeholder="${rtInputPlaceholder}">`。

发送按钮（如有显式 button）也加 `${isFreeZeroSelected ? 'disabled' : ''}`。

- [ ] **Step 4：CSS 新样式**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css` **末尾**追加：

```css
/* ============================================================
   Free Mode (2026-05-04) — 圆桌自由模式样式
   ============================================================ */

/* mode toggle segmented control（顶部） */
.mr-mode-toggle {
  display: inline-flex;
  gap: 4px;
  margin: 8px 0 4px 0;
  padding: 3px;
  background: rgba(255,255,255,0.04);
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
}
.mr-mode-toggle-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: #c9d1d9;
  cursor: pointer;
  border-radius: 4px;
  transition: all .15s;
}
.mr-mode-toggle-btn:hover:not([disabled]) {
  background: rgba(255,255,255,0.06);
}
.mr-mode-toggle-btn.active {
  background: #1f6feb;
  color: white;
  font-weight: 600;
}
.mr-mode-toggle-btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

/* free 模式头像勾选区 */
.mr-free-participants {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.06);
}
.mr-free-participants-title {
  font-size: 12px;
  color: #8b949e;
  margin-right: 4px;
  user-select: none;
}
.mr-free-slot {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: rgba(255,255,255,0.03);
  border-radius: 4px;
  border: 1.5px solid transparent;
  cursor: pointer;
  opacity: 0.4;
  transition: all .15s;
}
.mr-free-slot.checked {
  opacity: 1;
  border-color: #1f6feb;
  background: rgba(31,111,235,0.08);
}
.mr-free-slot:hover:not(.disabled) {
  background: rgba(255,255,255,0.06);
}
.mr-free-slot.disabled {
  cursor: not-allowed;
  opacity: 0.3 !important;
}
.mr-free-slot-cb {
  margin: 0;
  cursor: pointer;
}
.mr-free-slot img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}
.mr-free-slot-label {
  font-size: 12px;
  color: #c9d1d9;
  user-select: none;
}

/* 输入框 0 人灰态 */
.mr-rt-input.mr-rt-input-disabled {
  background: rgba(255,255,255,0.02);
  color: #6e7681;
  cursor: not-allowed;
}
```

- [ ] **Step 5：smoke test + 目视验证**

启动隔离 Hub，验证：
- free 模式状态行显示"分发: 自由 · 发言人: ⚡Pikachu, 🔥Charmander, 💎Squirtle"
- 取消勾选 1 个 → 状态行更新；勾选 0 个 → 显示警告 + 输入框灰
- 辩论按钮：1 人时 disabled，2-3 人时 enabled
- 切回 pilot 模式 → 原状态行/按钮组完整恢复

- [ ] **Step 6：commit**

```powershell
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): T7 — 状态行/输入框/辩论按钮 free 分支 + CSS 样式"
```

---

## Task 8：隔离 Hub CDP E2E 5 场景

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-free-mode-verify.js`（gitignored，需 `git add -f`）

**5 场景**（spec section 10.3）：

1. 新建会议默认 free + 全选 → 三人都收到 prompt
2. 取消勾选 1 人 → 仅 2 人收到 free prompt
3. 0 人勾选保护 → 输入框灰 + 发送 disabled + placeholder 文案正确
4. 辩论 disable / enable → 1 人 disabled，2 人 enabled
5. 模式切换状态保留 → pilot 设主驾 → free → pilot 还原

- [ ] **Step 1：写 E2E 脚本骨架**

参考 `tests/_e2e-resend-verify.js`（Resend T8 已存在）的模板风格创建。脚本要点：

- 启动隔离 hub（`CLAUDE_HUB_DATA_DIR = C:\temp\hub-free-mode-e2e + --remote-debugging-port=9230`），用 PS `& exe` **同句**而非 Start-Process（feedback_hub_isolation_env_pitfall）
- 用 `chrome-remote-interface` 连 9230 端口的 Hub 主窗口（target.url 含 `index.html`）
- 创建 3 claude 会议（也可以用 Gemini/Codex 测，避免开真 Claude session 烧 token）
- 5 个 scenario 函数依次跑，每个之后 print PASS/FAIL
- 最后 Stop-Process electron + 清理临时目录
- exit code: 全 PASS = 0，否则 1

由于 E2E 内容非常长（~400 行），写 plan 不展开完整代码 —— 实施时参考 `_e2e-resend-verify.js` 的 helper 函数风格，添加 5 个对应 scenario。

- [ ] **Step 2：跑 E2E 验证**

```powershell
node C:\Users\lintian\claude-session-hub\tests\_e2e-free-mode-verify.js
```

预期：5 个场景全 PASS，exit 0

- [ ] **Step 3：commit**

由于 `_e2e-*.js` 脚本被 gitignore，需 `-f`：

```powershell
git add -f tests/_e2e-free-mode-verify.js
git commit -m "test(e2e): T8 — 自由模式 CDP E2E 5 场景"
```

---

## Task 9：集成验证 + silent-failure 扫描 + finishing

**Files:** 多文件回归 + 可能少量补丁

- [ ] **Step 1：跑完整测试集合**

```powershell
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-store-free-fields.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-injection-matrix.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-pilot-dispatch-mode.test.js
node C:\Users\lintian\claude-session-hub\tests\unit-roundtable-slot-participation.test.js
```

预期：全 ✓，exit 0（pre-existing baseline 失败如 dispatch-mode `testCreateMeetingMenuContract` 不在本任务范围）

- [ ] **Step 2：silent-failure-hunter 扫新代码**

调用 silent-failure-hunter agent（项目自定义 sub-agent），让它扫：
- `core/roundtable-free.js`
- main.js dispatchRoundtableTurn 修改部分
- 两个新 IPC handler

让它 report MEDIUM/HIGH 级别的 silent failure（empty catch / dangerous fallback / missing error propagation）。

人工修掉 HIGH（如有），MEDIUM 列入 backlog。

- [ ] **Step 3：smoke test 启动 Hub**

```powershell
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub" 2>&1 | Select-Object -First 30
```

预期：`[hub] hook server listening` 启动正常。

- [ ] **Step 4：四路审查（可选）**

如有时间，调 Codex / Gemini / DeepSeek 三家做 code review（参考 `reference_multi_model_review.md`），收集 issue。

- [ ] **Step 5：finishing commit**

如 silent-failure 扫描发现需修补的，commit：

```powershell
git add <修补文件>
git commit -m "fix(roundtable-free): T9 — silent-failure 修补 + 集成回归通过"
```

如无需补丁，跳过此 step（task 收尾）。

- [ ] **Step 6：写收尾汇报**

汇报内容（中文，按 CLAUDE.md 铁律）：
- 9 个 task 全 done，N 个 commit 落地
- 单测/E2E 通过情况
- pilot 路径零回归确认
- 已知 backlog（如 silent-failure MEDIUM）
- 用户验证步骤：
  - 重启 Hub
  - 新建会议看默认是否 free 模式
  - 勾选/切换/0 人保护/辩论 disable/模式切换状态保留 5 项 spot-check
- **不 push**（按用户偏好）

---

## Self-Review

### 1. Spec coverage

逐节对照 `2026-05-04-roundtable-free-mode-design.md`：

| Spec 节 | 实现 task |
|---|---|
| §1-3 目标/原则/用户故事 | 整个 plan |
| §4.1-4.3 数据模型 | T1（meeting-store 字段持久化）+ T5（新建默认 mode='free'）|
| §4.4 turn record 派生 dispatchMode | T2（derivePilotCompatDispatchMode）+ T5（main.js meta 写入）|
| §5 架构 | T2-T5 |
| §6.1 mode toggle | T6 |
| §6.2 free 分发区 | T6 |
| §6.3 状态行 | T7 |
| §6.4 辩论按钮 | T7 |
| §6.5 0人保护 | T7 |
| §6.6 pilot UI 不变 | T6（pilot 分支保留原 HTML）|
| §7 free prompt 模板 | T3 |
| §8 IPC 协议 | T4 |
| §9 不变量（7 条） | 整个 plan + T9 验证 |
| §10 测试矩阵 | T1/T2/T3/T4 单测 + T8 E2E |
| §11 兼容性 | T1（兜底）+ T5（新建默认）|
| §12 边界/风险 | T4（inProgress 拒绝）+ T5（空 participants 拒绝）+ T7（UI 防发送）|
| §13 task 切分 | T1-T9 与 spec 一致 |

✓ 覆盖完整。

### 2. Placeholder scan

- T1-T7 全部带可执行代码 ✓
- T8（E2E 脚本）只描述结构，未展开完整代码 — 但理由充分（~400 行，参考已有 `_e2e-resend-verify.js` 模板），不是 placeholder
- 无 TBD / TODO / "implement later" ✓

### 3. Type consistency

- `meeting.mode`：T1/T4/T5/T6/T7 一致使用 `'pilot' | 'free'` ✓
- `meeting.participants`：T1/T2/T4/T5/T6/T7 一致使用 `number[] | null` ✓
- `deriveTargetSids(meeting, mode, summarizerSlot)`：T2 定义，T5 使用，签名一致 ✓
- `derivePilotCompatDispatchMode(participants)`：T2 定义，T5 使用 ✓
- `buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum })`：T3 定义，T5 使用，参数完全一致 ✓
- `_validateMode` / `_validateParticipants`：T4 定义并被 IPC handler 使用 ✓
- IPC `roundtable:set-meeting-mode` / `roundtable:set-participants`：T4 定义，T6 调用 ✓

✓ 类型/签名一致。

---

## 执行选择

Plan complete and saved to `C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-04-roundtable-free-mode.md`. Two execution options:

**1. Subagent-Driven (推荐)** — 每 task fresh subagent，spec compliance + code quality 两阶段 review，最快迭代

**2. Inline Execution** — 当前 session 内 batch 执行，checkpoint 处暂停 review

Which approach?
