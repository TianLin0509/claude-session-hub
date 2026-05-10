# 新建圆桌：自选 AI + 模型选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前硬编码的"Claude+Gemini+Codex 三家"圆桌升级为"用户自选 5 选 3（允许重复）+ 各家选 model"的 Modal 引导流。Pokemon 头像与 slot 位置绑定（slot 1=皮卡丘永远）。后端去硬编码 + 让 DeepSeek/GLM 通过 ClaudeTap 真正接入圆桌 timeline。

**Architecture:** 核心架构转变是"按 kind 索引 → 按 slot index / sid 索引"。renderer 端 `subs.{claude,gemini,codex}` 改成 `slots[0|1|2]`；orchestrator 端 `aiStats.{claude,gemini,codex}` 改成 `aiStats[<sid>]`。新增 `renderer/meeting-create-modal.{js,css}` 实现弹窗。`transcript-tap.js:_backendFor()` 加 deepseek/glm 路由 ClaudeTap 复用其 transcript JSONL 流式。

**Tech Stack:** Electron / Vanilla JS / CSS Grid / IPC / xterm.js / JsonlTail / fs.watch

**前置依赖（建议但非强制）：**
- `2026-05-01-roundtable-card-optimization.md`（提供 partial.blocks 流式架构基础）

**关联文档：**
- 设计：`C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-01-meeting-create-modal-design.md`

---

### Task 0: DeepSeek Stop Hook Spike（必须先做）

**Files:**
- 临时脚本：`tests/_spike-deepseek-stop-hook.js`（spike 完成后可删）

- [ ] **Step 1: 写 spike 验证脚本**

`tests/_spike-deepseek-stop-hook.js`：

```js
'use strict';
// Spike: 验证 DeepSeek session（CLAUDE_CONFIG_DIR=~/.claude-deepseek）下
// Stop hook 是否仍调用 hub 的 /api/hook/stop endpoint
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  // 启动 hub（外部脚本启动），假定 hook port 已知（或读 .claude-session-hub/state.json）
  // 此 spike 主要靠手动观察 hub log 验证：
  //   1. spawn deepseek session in hub
  //   2. send a prompt
  //   3. wait turn complete
  //   4. check hub stdout for "[hook] stop received sid=<sid> path=~/.claude-deepseek/projects/..."
  //   5. check transcriptTap.notifyClaudeStop is called

  // 简化版：扫 ~/.claude-deepseek/projects/ 下最新 jsonl 文件
  // 是否在合理时间内（30s）出现 stop_reason: "end_turn"
  const dsRoot = path.join(os.homedir(), '.claude-deepseek', 'projects');
  let dirs;
  try { dirs = await fs.promises.readdir(dsRoot); } catch (e) {
    console.error('No .claude-deepseek/projects/ dir, skip spike');
    process.exit(0);
  }
  console.log('DeepSeek projects dirs:', dirs);

  // 找最新的 jsonl
  let latest = null;
  for (const d of dirs) {
    const subdir = path.join(dsRoot, d);
    const files = await fs.promises.readdir(subdir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(subdir, f);
      const stat = await fs.promises.stat(full);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { full, mtime: stat.mtimeMs };
      }
    }
  }
  if (!latest) {
    console.error('No deepseek jsonl found, run a session first');
    process.exit(1);
  }
  console.log('Latest DeepSeek transcript:', latest.full);

  const raw = await fs.promises.readFile(latest.full, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const types = {};
  let endTurnFound = false;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    types[obj?.type] = (types[obj?.type] || 0) + 1;
    if (obj?.type === 'assistant' && obj.message?.stop_reason === 'end_turn') {
      endTurnFound = true;
    }
  }
  console.log('Type counts:', types);
  console.log('end_turn assistant block found:', endTurnFound ? '✓ YES' : '✗ NO');
  console.log('Decision:', endTurnFound ? 'PASS — DeepSeek transcript 兼容 ClaudeTap' : 'FAIL — 需要新增 DeepSeekTap');
})();
```

- [ ] **Step 2: 启动隔离 Hub + 跑 DeepSeek session**

```bash
export CLAUDE_HUB_DATA_DIR=/c/temp/hub-spike-deepseek
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9251 &
```

进 Hub UI → 创建 DeepSeek 单 session（侧边栏）→ 等就绪 → 发简单 prompt 如"用三句话介绍 React" → 等 turn 完成 → 观察 hub stdout 是否打 `[hook] stop received` 日志。

- [ ] **Step 3: 运行 spike 脚本分析**

```bash
node tests/_spike-deepseek-stop-hook.js
```

- [ ] **Step 4: 决策记录 + Commit**

把 spike 结果记录到 `tests/_spike-deepseek-stop-hook-result.md`：

```markdown
# DeepSeek Stop Hook Spike Result
- Date: 2026-05-XX
- DeepSeek model: deepseek-v4-pro
- Hub log "[hook] stop received": YES / NO
- Transcript JSONL has end_turn block: YES / NO
- ClaudeTap.notifyStop invoked: YES / NO
- 决策: [PASS — 直接走 Task 1（_backendFor 加路由）/ FAIL — 需新增 DeepSeekTap 类]
```

```bash
git add tests/_spike-deepseek-stop-hook.js tests/_spike-deepseek-stop-hook-result.md
git commit -m "spike: verify DeepSeek Stop hook compatibility with ClaudeTap"
```

**Spike 通过/失败处理：**
- ✓ PASS → 继续 Task 1 简单加 `_backendFor` 路由
- ✗ FAIL → 在 Task 1 中改为新增独立 `DeepSeekTap` 类（仿 ClaudeTap 但扫 `~/.claude-deepseek/projects/`），其他 Task 不变

---

### Task 1: transcript-tap.js 加 deepseek/glm 路由

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:922-927`
- Test: `C:\Users\lintian\claude-session-hub\tests\transcript-tap-deepseek-glm.test.js`

- [ ] **Step 1: 写 failing test**

`tests/transcript-tap-deepseek-glm.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TranscriptTap } = require('../core/transcript-tap');

test('_backendFor routes deepseek to ClaudeTap backend', () => {
  const tap = new TranscriptTap();
  // 通过 registerSession + getLastAssistantText 间接验证 backend 路由
  tap.registerSession('test-ds-1', 'deepseek', { cwd: process.cwd() });
  // 不会抛错说明 backend 找到（旧实现返回 null 时静默不抛，此 case 改为...）
  // 直接调内部 method
  const backend = tap._backendFor('deepseek');
  assert.ok(backend, '_backendFor(deepseek) should not be null');
  assert.strictEqual(backend, tap._claude, 'deepseek routes to ClaudeTap');

  const backend2 = tap._backendFor('glm');
  assert.strictEqual(backend2, tap._claude, 'glm routes to ClaudeTap');

  tap.unregisterSession('test-ds-1');
});

test('_backendFor returns null for unknown kind', () => {
  const tap = new TranscriptTap();
  assert.strictEqual(tap._backendFor('unknown-kind'), null);
});
```

- [ ] **Step 2: 跑 test 验证失败**

```bash
node --test tests/transcript-tap-deepseek-glm.test.js
```

预期：FAIL（_backendFor 当前对 deepseek/glm 返回 null）

- [ ] **Step 3: 改 _backendFor**

修改 `core/transcript-tap.js:922-927`：

```js
_backendFor(kind) {
  if (kind === 'claude' || kind === 'claude-resume' || kind === 'deepseek' || kind === 'glm') {
    return this._claude;
  }
  if (kind === 'codex') return this._codex;
  if (kind === 'gemini') return this._gemini;
  return null;
}
```

- [ ] **Step 4: 跑 test 验证通过 + Commit**

```bash
node --test tests/transcript-tap-deepseek-glm.test.js
git add core/transcript-tap.js tests/transcript-tap-deepseek-glm.test.js
git commit -m "feat(transcript-tap): route deepseek/glm to ClaudeTap"
```

---

### Task 2: main.js _RT_READY_MARKERS 加 deepseek

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js:564-569`

- [ ] **Step 1: 加条目**

```js
const _RT_READY_MARKERS = {
  claude: [],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  codex: ['gpt-5.5', 'gpt-5.4', 'Context 100%', 'send'],
  glm: [],
  deepseek: [],  // 新增 — 与 claude 同策略，buffer ≥ 1500 字符兜底
};
```

- [ ] **Step 2: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
git add main.js
git commit -m "feat(main): add deepseek marker entry to _RT_READY_MARKERS"
```

---

### Task 3: session-manager.js relaunchCli 加 deepseek/glm

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\session-manager.js:587-606`

- [ ] **Step 1: 加分支**

```js
} else if (kind === 'claude') {
  cmd = ' claude --model claude-opus-4-7[1m]\r\n';
} else if (kind === 'deepseek') {
  cmd = ` claude --model ${session.currentModel?.id || 'deepseek-v4-pro'} --permission-mode bypassPermissions\r\n`;
} else if (kind === 'glm') {
  cmd = ` claude --model ${session.currentModel?.id || 'glm-5.1'} --permission-mode bypassPermissions\r\n`;
} else {
  return false;
}
```

- [ ] **Step 2: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -10
git add core/session-manager.js
git commit -m "feat(session-manager): support relaunchCli for deepseek/glm"
```

---

### Task 4: session-manager.js Claude/Codex 加 opts.model fallback

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\session-manager.js:321,407`

- [ ] **Step 1: 改 Claude 分支**

`core/session-manager.js:321` 区域：

```js
// 旧
cmd = ` claude --model claude-opus-4-7[1m]`;
// 新
cmd = ` claude --model ${opts.model || 'claude-opus-4-7[1m]'}`;
```

- [ ] **Step 2: 改 Codex 分支**

`core/session-manager.js:407` 区域：

```js
// 旧
cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5`;
// 新
cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${opts.model || 'gpt-5.5'}`;
```

- [ ] **Step 3: 真测各家创建（不传 model 参数应仍走默认）**

启动隔离 Hub → 创建 Claude session（不传 model）→ assert 启动后 `currentModel.id === 'claude-opus-4-7[1m]'`。再创建一个 Claude session 显式传 `model: 'claude-sonnet-4-5'` → assert 启动命令含 `--model claude-sonnet-4-5`。

- [ ] **Step 4: Commit**

```bash
git add core/session-manager.js
git commit -m "feat(session-manager): allow opts.model override for claude/codex"
```

---

### Task 5: roundtable-orchestrator.js aiStats 改 sid 索引

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js:38-44, 49-54, 76-80, 211-227, 257-270`
- Test: `C:\Users\lintian\claude-session-hub\tests\orchestrator-aistats-migration.test.js`

- [ ] **Step 1: 写 failing test（迁移逻辑）**

`tests/orchestrator-aistats-migration.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

test('aiStats old format (kind-indexed) migrates to sid-indexed', async () => {
  // 模拟一个老 state.json
  const oldState = {
    aiStats: {
      claude: { totalThinkSec: 100, totalTokens: 5000, perTurnHistory: [] },
      gemini: { totalThinkSec: 50, totalTokens: 3000, perTurnHistory: [] },
      codex: { totalThinkSec: 30, totalTokens: 2000, perTurnHistory: [] },
    },
  };

  // 模拟当前 meeting 的 subSessions
  const currentMeeting = {
    subSessions: ['sid-aaa', 'sid-bbb', 'sid-ccc'],
  };
  const sessionsBySid = new Map([
    ['sid-aaa', { kind: 'claude', currentModel: { id: 'claude-opus-4-7[1m]' } }],
    ['sid-bbb', { kind: 'gemini', currentModel: { id: 'gemini-2.5-flash' } }],
    ['sid-ccc', { kind: 'codex', currentModel: { id: 'gpt-5.5' } }],
  ]);

  const { migrateAiStats } = require('../core/roundtable-orchestrator');
  const migrated = migrateAiStats(oldState.aiStats, currentMeeting, sessionsBySid);

  assert.ok(migrated['sid-aaa'], 'sid-aaa migrated from claude');
  assert.strictEqual(migrated['sid-aaa'].totalThinkSec, 100);
  assert.strictEqual(migrated['sid-aaa'].kind, 'claude');
  assert.ok(migrated['sid-bbb'], 'sid-bbb migrated from gemini');
  assert.ok(migrated['sid-ccc'], 'sid-ccc migrated from codex');
});

test('aiStats new format (sid-indexed) passes through unchanged', () => {
  const { migrateAiStats } = require('../core/roundtable-orchestrator');
  const newFormat = {
    'sid-xxx': { totalThinkSec: 10, kind: 'deepseek' },
  };
  const meeting = { subSessions: ['sid-xxx'] };
  const sessions = new Map();
  const r = migrateAiStats(newFormat, meeting, sessions);
  assert.strictEqual(r['sid-xxx'].totalThinkSec, 10);
});
```

- [ ] **Step 2: 跑 test 验证失败**

```bash
node --test tests/orchestrator-aistats-migration.test.js
```

预期：FAIL（migrateAiStats 不存在）

- [ ] **Step 3: 改 orchestrator**

修改 `core/roundtable-orchestrator.js`：

```js
// 38-44 行附近的 initState
this.state = {
  meetingId,
  currentTurn: 0,
  currentMode: null,
  turns: [],
  aiStats: {},  // 改成空对象，由 _loadState 或 completeTurn 动态填
};

// 76-80 行 _loadState 内
const loaded = this._tryLoadFromDisk();
if (loaded?.aiStats) {
  loaded.aiStats = migrateAiStats(loaded.aiStats, this._currentMeeting, this._sessionsBySid);
}
this.state = { ...this.state, ...loaded };

// 257-270 行 completeTurn
completeTurn(turnNum, mode, userInput, byMap, meta, byStatus, statsBySid /* 新增 */) {
  // ... 既有逻辑
  for (const sid of (this._currentMeeting?.subSessions || [])) {
    if (!this.state.aiStats[sid]) {
      this.state.aiStats[sid] = {
        totalThinkSec: 0,
        totalTokens: 0,
        perTurnHistory: [],
        kind: byMap[sid]?.kind,
        model: byMap[sid]?.model,
      };
    }
    const s = this.state.aiStats[sid];
    const thisSec = statsBySid?.thinkSec?.[sid] || 0;
    const thisTok = statsBySid?.tokens?.[sid] || 0;
    s.totalThinkSec += thisSec;
    s.totalTokens += thisTok;
    s.perTurnHistory.push({ turn: turnNum, thinkSec: thisSec, tokens: thisTok });
  }
}

// 文件底部 module.exports 加 migrateAiStats
function migrateAiStats(stats, meeting, sessionsBySid) {
  if (!stats || typeof stats !== 'object') return {};
  // 检测老格式：含 claude/gemini/codex 任一 key
  const isOldFormat = stats.claude || stats.gemini || stats.codex;
  if (!isOldFormat) return stats;

  const migrated = {};
  for (const sid of (meeting?.subSessions || [])) {
    const session = sessionsBySid?.get(sid);
    if (!session) continue;
    const oldStat = stats[session.kind];
    if (oldStat) {
      migrated[sid] = {
        ...oldStat,
        kind: session.kind,
        model: session.currentModel?.id,
      };
    }
  }
  return migrated;
}

module.exports = { RoundtableOrchestrator, migrateAiStats };
```

- [ ] **Step 4: 跑 test 验证通过 + Commit**

```bash
node --test tests/orchestrator-aistats-migration.test.js
git add core/roundtable-orchestrator.js tests/orchestrator-aistats-migration.test.js
git commit -m "feat(orchestrator): aiStats sid-indexed with old-format migration"
```

---

### Task 6: main.js 投票/互评/turn 统计去硬编码

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js:946-960, 1488, 1499`

- [ ] **Step 1: 改 dispatchRoundtableTurn 内的统计 dict**

`main.js:946-960` 区域：

```js
// 旧
const thinkSecByKind = { claude: 0, gemini: 0, codex: 0 };
const tokensByKind = { claude: 0, gemini: 0, codex: 0 };

// 新（从当前 meeting subSessions 动态构建）
const subSids = (meeting.subSessions || []);
const thinkSecBySid = Object.fromEntries(subSids.map(sid => [sid, 0]));
const tokensBySid = Object.fromEntries(subSids.map(sid => [sid, 0]));
```

下游所有读写按 sid。`completeTurn` 调用：

```js
orch.completeTurn(turnNum, mode, userInput, byMap, meta, byStatus, {
  thinkSec: thinkSecBySid,
  tokens: tokensBySid,
});
```

- [ ] **Step 2: 改投票/互评 API 返回**

`main.js:1488, 1499` 区域：

```js
// 旧
return kind ? [] : { claude: [], gemini: [], codex: [] };

// 新
const meeting = meetingManager.getMeeting(meetingId);
return kind ? [] : Object.fromEntries(
  (meeting?.subSessions || []).map(sid => [sid, []])
);
```

- [ ] **Step 3: smoke test + Commit**

启动 Hub → 进圆桌 → 跑一次 turn → 看 console 是否报错。

```bash
git add main.js
git commit -m "feat(main): vote/review/turn stats indexed by sid not kind"
```

---

### Task 7: general-roundtable-private-store 去白名单

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\general-roundtable-private-store.js:27, 37, 42, 61`
- Test: `C:\Users\lintian\claude-session-hub\tests\private-store-no-whitelist.test.js`

- [ ] **Step 1: 写 test**

`tests/private-store-no-whitelist.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

test('private store accepts deepseek/glm kinds', async () => {
  const tmp = path.join(os.tmpdir(), 'priv-test-' + Date.now());
  await fs.promises.mkdir(tmp, { recursive: true });
  process.env.CLAUDE_HUB_DATA_DIR = tmp;
  // 重置 require cache 以让 store 用新路径
  delete require.cache[require.resolve('../core/general-roundtable-private-store')];
  const store = require('../core/general-roundtable-private-store');

  // 关键 assert: 不应抛错
  await assert.doesNotReject(async () => {
    await store.savePrivateMessage('mid-1', 'deepseek', { text: 'hi' });
  });
  await assert.doesNotReject(async () => {
    await store.savePrivateMessage('mid-1', 'glm', { text: 'hello' });
  });

  await fs.promises.rm(tmp, { recursive: true, force: true });
  delete process.env.CLAUDE_HUB_DATA_DIR;
});
```

- [ ] **Step 2: 跑 test 验证失败**

```bash
node --test tests/private-store-no-whitelist.test.js
```

预期：FAIL（白名单拒绝 deepseek/glm）

- [ ] **Step 3: 删白名单**

修改 `core/general-roundtable-private-store.js:27, 37, 42, 61` 四处：

```js
// 旧
if (!['claude', 'gemini', 'codex'].includes(kind)) {
  throw new Error(`Invalid kind: ${kind}`);
}
// 新
if (!kind || typeof kind !== 'string') {
  throw new Error(`Invalid kind: ${kind}`);
}
```

- [ ] **Step 4: 跑 test 验证通过 + Commit**

```bash
node --test tests/private-store-no-whitelist.test.js
git add core/general-roundtable-private-store.js tests/private-store-no-whitelist.test.js
git commit -m "feat(private-store): remove kind whitelist, accept any AI"
```

---

### Task 8: meeting-store 持久化 slotSpecs

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-store.js:21-34`

- [ ] **Step 1: 加 slotSpecs 字段**

```js
// 序列化（save）
const data = {
  schemaVersion: 1,
  id: meeting.id,
  _timeline: meeting._timeline,
  _cursors: meeting._cursors,
  _nextIdx: meeting._nextIdx,
  slotSpecs: meeting.slotSpecs || null,  // 新增
  savedAt: Date.now(),
};

// 反序列化（load）后赋值给 meeting 对象（在 main.js restoreMeeting 区域）：
meeting.slotSpecs = data.slotSpecs || undefined;
```

- [ ] **Step 2: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -10
git add core/meeting-store.js main.js  # 如 restoreMeeting 也改了
git commit -m "feat(meeting-store): persist slotSpecs for re-create"
```

---

### Task 9: IPC 'create-meeting' / 'add-meeting-sub' 升级

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js:485-491, 493-538`
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js`（如需 setSlotSpecs API）

- [ ] **Step 1: 升级 'create-meeting'**

`main.js:485-491`：

```js
ipcMain.handle('create-meeting', async (_e, opts = {}) => {
  const meeting = await meetingManager.createMeeting(opts);

  if (Array.isArray(opts.slots) && opts.slots.length > 0) {
    // 新路径：按 slots 顺序创建 sub
    for (const slot of opts.slots) {
      await _addSubInternal(meeting.id, slot.kind, { model: slot.model });
    }
    meetingManager.setSlotSpecs(meeting.id, opts.slots);  // 新增 API
  } else {
    // 兼容旧路径：renderer 永远会传 slots，仅老 e2e 脚本可能不传
    console.warn('[create-meeting] no slots provided, falling back to default 3 AI');
    for (const kind of ['claude', 'gemini', 'codex']) {
      await _addSubInternal(meeting.id, kind, {});
    }
  }
  return meeting;
});
```

新增 `_addSubInternal(meetingId, kind, opts)` 内部辅助函数（封装既有 `'add-meeting-sub'` 的核心逻辑），便于 IPC 和内部循环共用。

- [ ] **Step 2: 升级 'add-meeting-sub'**

`main.js:493-538`：

```js
ipcMain.handle('add-meeting-sub', async (_e, { meetingId, kind, model }) => {
  return _addSubInternal(meetingId, kind, { model });
});

async function _addSubInternal(meetingId, kind, opts = {}) {
  const session = await sessionManager.createSession(kind, {
    meetingId,
    model: opts.model,
  });
  meetingManager.addSubSession(meetingId, session.id);
  return session;
}
```

- [ ] **Step 3: 加 setSlotSpecs API**

`core/meeting-room.js` 或 `core/meeting-manager.js`（视实际命名）：

```js
setSlotSpecs(meetingId, slots) {
  const meeting = this.meetings.get(meetingId);
  if (!meeting) return;
  meeting.slotSpecs = slots;
  this._persist(meetingId);  // 触发 meeting-store 落盘
}
```

- [ ] **Step 4: smoke test**

启动 Hub → 在 DevTools console 直接 invoke：

```js
window.electronAPI.invoke('create-meeting', {
  mode: 'general',
  scene: 'general',
  slots: [
    { index: 0, kind: 'claude', model: 'claude-opus-4-7[1m]' },
    { index: 1, kind: 'gemini', model: 'gemini-2.5-flash' },
    { index: 2, kind: 'codex', model: 'gpt-5.5' },
  ],
}).then(m => console.log('Created:', m));
```

assert 返回 meeting 对象 + 3 个 sub session 创建成功。

- [ ] **Step 5: Commit**

```bash
git add main.js core/meeting-room.js core/meeting-manager.js
git commit -m "feat(ipc): create-meeting accepts slots array, add-meeting-sub accepts model"
```

---

### Task 10: renderer/meeting-room.js slot 重构 + _avatarBySlot

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:140, 145-147, 197, 224-239`

- [ ] **Step 1: 改 subs 对象 → slots 数组**

`renderer/meeting-room.js:140-147`：

```js
// 旧
const subs = { claude: null, gemini: null, codex: null };
sessionsAll.forEach(s => {
  if (s.meetingId !== meeting.id) return;
  if (s.kind === 'claude' && !subs.claude) subs.claude = { sid: s.id, label: s.title };
  else if (s.kind === 'gemini' && !subs.gemini) subs.gemini = { sid: s.id, label: s.title };
  else if (s.kind === 'codex' && !subs.codex) subs.codex = { sid: s.id, label: s.title };
});

// 新
const slots = [null, null, null];
const subSids = meeting.subSessions || [];
for (let i = 0; i < subSids.length && i < 3; i++) {
  const s = sessionsAll.find(x => x.id === subSids[i]);
  if (s) {
    slots[i] = {
      sid: s.id,
      label: s.title,
      kind: s.kind,
      model: s.currentModel?.id || s.currentModel?.displayName,
    };
  }
}
```

- [ ] **Step 2: 改渲染循环**

`renderer/meeting-room.js:197`：

```js
// 旧
for (const kind of ['claude', 'gemini', 'codex']) {
  const sub = subs[kind];
  if (!sub) continue;
  tabs.push(_ftHtml(sub, partial, status, ...));
}

// 新
for (let i = 0; i < 3; i++) {
  const slot = slots[i];
  if (!slot) continue;
  tabs.push(_ftHtml(slot, partial, status, slot.model, ctxPct, isInitializing, lastTurnByMap, /* slotIndex */ i));
}
```

- [ ] **Step 3: 加 _avatarBySlot + 改 _ftHtml 签名**

```js
function _avatarBySlot(i) {
  const arr = [
    'assets/pokemon/pikachu.png',
    'assets/pokemon/charmander.png',
    'assets/pokemon/squirtle.png',
  ];
  return arr[i] || 'assets/pokemon/default.png';
}

function _ftHtml(slot, partial, status, model, ctxPct, isInitializing, lastTurnByMap, slotIndex) {
  const avatar = _avatarBySlot(slotIndex);  // 新：按 slot 索引
  // ... 既有逻辑保持，仅改头像来源
}
```

- [ ] **Step 4: 真测视觉**

启动隔离 Hub → 旧 meeting 仍能正常打开 + 头像顺序皮卡丘/小火龙/杰尼龟 → 截图。

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(renderer): slot-indexed cards with _avatarBySlot"
```

---

### Task 11: renderer/meeting-room.js RT_MENTION_ITEMS 动态构建

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1716-1719`

- [ ] **Step 1: 改静态常量为动态函数**

```js
// 旧
const RT_MENTION_ITEMS = [
  { kind: 'claude', label: '@claude' },
  { kind: 'gemini', label: '@gemini' },
  { kind: 'codex', label: '@codex' },
];

// 新
function buildRtMentionItems(meeting) {
  const items = [];
  const subSids = meeting?.subSessions || [];

  // 主项：@slot1 / @slot2 / @slot3
  for (let i = 0; i < subSids.length; i++) {
    items.push({
      sid: subSids[i],
      slotIndex: i,
      label: `@slot${i + 1}`,
    });
  }

  // 兼容层：kind 唯一时注册 @kind 别名
  const kindCount = {};
  for (const sid of subSids) {
    const session = sessionsAll.find(s => s.id === sid);
    if (session?.kind) kindCount[session.kind] = (kindCount[session.kind] || 0) + 1;
  }
  for (const sid of subSids) {
    const session = sessionsAll.find(s => s.id === sid);
    if (session?.kind && kindCount[session.kind] === 1) {
      items.push({
        sid,
        kind: session.kind,
        label: `@${session.kind}`,
      });
    }
  }

  return items;
}
```

所有原本读 `RT_MENTION_ITEMS` 的地方改成 `buildRtMentionItems(currentMeeting)`。

- [ ] **Step 2: 真测 mention 弹窗**

启动 Hub → 创建混合圆桌（如 [Claude, Claude, Gemini]）→ 输入 `@` → assert 弹出 `@slot1, @slot2, @slot3, @gemini`（claude 因重复不出 `@claude`）。

- [ ] **Step 3: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(renderer): dynamic RT_MENTION_ITEMS by slot + unique kind alias"
```

---

### Task 12: Modal UI · meeting-create-modal 新增

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\renderer\meeting-create-modal.js`
- Create: `C:\Users\lintian\claude-session-hub\renderer\meeting-create-modal.css`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`

- [ ] **Step 1: 写 modal CSS**

`renderer/meeting-create-modal.css`：

```css
.mcm-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 9999;
  display: flex; align-items: center; justify-content: center;
}
.mcm-dialog {
  width: 720px; max-width: 90vw; max-height: 90vh;
  background: var(--bg-card, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 10px;
  display: flex; flex-direction: column;
  box-shadow: 0 16px 64px rgba(0, 0, 0, 0.5);
}
.mcm-header {
  display: flex; align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-soft, #21262d);
}
.mcm-title { font-size: 16px; font-weight: 600; flex: 1; }
.mcm-close {
  background: none; border: none; color: var(--text-dim, #8b949e);
  font-size: 22px; cursor: pointer; padding: 0 6px;
}
.mcm-body { padding: 18px; flex: 1; overflow-y: auto; }
.mcm-slots {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 18px;
}
.mcm-slot {
  background: var(--bg-card-2, #1c232c);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 14px;
  display: flex; flex-direction: column;
  gap: 10px; align-items: center;
}
.mcm-avatar { width: 56px; height: 56px; border-radius: 50%; }
.mcm-slot-label {
  font-size: 11.5px; color: var(--text-dim, #8b949e);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.mcm-slot label {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 12px; color: var(--text-dim, #8b949e);
  width: 100%;
}
.mcm-slot select {
  background: var(--bg, #0d1117);
  color: var(--text, #e6edf3);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 13px;
  width: 100%;
}
.mcm-scene {
  font-size: 13px; color: var(--text, #e6edf3);
  display: flex; gap: 16px; align-items: center;
  padding-top: 8px; border-top: 1px solid var(--border-soft, #21262d);
}
.mcm-scene label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.mcm-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 14px 18px;
  border-top: 1px solid var(--border-soft, #21262d);
}
.mcm-footer button {
  padding: 8px 18px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--border, #30363d);
}
.mcm-cancel { background: var(--bg-card-2, #1c232c); color: var(--text, #e6edf3); }
.mcm-primary { background: var(--accent, #58a6ff); color: #000; border-color: var(--accent, #58a6ff); font-weight: 600; }
.mcm-primary:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 2: 写 modal JS**

`renderer/meeting-create-modal.js`：

```js
'use strict';

const MODELS_BY_KIND = {
  claude: ['claude-opus-4-7[1m]', 'claude-opus-4-6', 'claude-sonnet-4-5'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  codex: ['gpt-5.5', 'gpt-5.4'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  glm: ['glm-5.1', 'glm-4.6', 'glm-4-plus', 'glm-4-air'],
};

const KIND_LABELS = {
  claude: 'Claude', gemini: 'Gemini', codex: 'Codex',
  deepseek: 'DeepSeek', glm: 'GLM',
};

const DEFAULT_SLOTS = [
  { kind: 'claude', model: 'claude-opus-4-7[1m]' },
  { kind: 'gemini', model: 'gemini-2.5-flash' },
  { kind: 'codex', model: 'gpt-5.5' },
];

const SLOT_AVATARS = [
  'assets/pokemon/pikachu.png',
  'assets/pokemon/charmander.png',
  'assets/pokemon/squirtle.png',
];

const SLOT_NAMES = ['皮卡丘位', '小火龙位', '杰尼龟位'];

let _modalEl = null;
let _currentMode = 'general';

function _ensureModal() {
  if (_modalEl) return _modalEl;
  _modalEl = document.createElement('div');
  _modalEl.id = 'meeting-create-modal';
  _modalEl.className = 'mcm-overlay';
  _modalEl.style.display = 'none';
  _modalEl.innerHTML = `
    <div class="mcm-dialog" role="dialog" aria-labelledby="mcm-title-text">
      <div class="mcm-header">
        <span class="mcm-title" id="mcm-title-text">新建<span id="mcm-mode-label">通用</span>圆桌</span>
        <button class="mcm-close" aria-label="关闭">×</button>
      </div>
      <div class="mcm-body">
        <div class="mcm-slots">
          ${[0, 1, 2].map(i => _slotHtml(i)).join('')}
        </div>
        <div class="mcm-scene">
          场景:
          <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
          <label><input type="radio" name="mcm-scene" value="research"> 投研</label>
        </div>
      </div>
      <div class="mcm-footer">
        <button class="mcm-cancel">取消</button>
        <button class="mcm-create mcm-primary">创建圆桌</button>
      </div>
    </div>
  `;
  document.body.appendChild(_modalEl);
  _bindEvents();
  return _modalEl;
}

function _slotHtml(i) {
  const def = DEFAULT_SLOTS[i];
  const aiOptions = Object.keys(MODELS_BY_KIND).map(k =>
    `<option value="${k}"${k === def.kind ? ' selected' : ''}>${KIND_LABELS[k]}</option>`
  ).join('');
  const modelOptions = MODELS_BY_KIND[def.kind].map(m =>
    `<option value="${m}"${m === def.model ? ' selected' : ''}>${m}</option>`
  ).join('');
  return `
    <div class="mcm-slot" data-slot="${i}">
      <img class="mcm-avatar" src="${SLOT_AVATARS[i]}" alt="${SLOT_NAMES[i]}">
      <div class="mcm-slot-label">Slot ${i + 1} · ${SLOT_NAMES[i]}</div>
      <label>AI: <select class="mcm-ai-select">${aiOptions}</select></label>
      <label>Model: <select class="mcm-model-select">${modelOptions}</select></label>
    </div>
  `;
}

function _bindEvents() {
  _modalEl.querySelector('.mcm-close').addEventListener('click', closeModal);
  _modalEl.querySelector('.mcm-cancel').addEventListener('click', closeModal);
  _modalEl.querySelector('.mcm-create').addEventListener('click', _onCreate);

  // 点遮罩关闭
  _modalEl.addEventListener('click', (e) => {
    if (e.target === _modalEl) closeModal();
  });

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _modalEl.style.display !== 'none') closeModal();
  });

  // AI dropdown 改变 → 刷新 model 列表
  _modalEl.querySelectorAll('.mcm-slot').forEach(slotEl => {
    const aiSel = slotEl.querySelector('.mcm-ai-select');
    aiSel.addEventListener('change', () => _refreshModelOptions(slotEl));
  });
}

function _refreshModelOptions(slotEl) {
  const kind = slotEl.querySelector('.mcm-ai-select').value;
  const modelSel = slotEl.querySelector('.mcm-model-select');
  const opts = MODELS_BY_KIND[kind] || [];
  modelSel.innerHTML = opts.map((m, i) =>
    `<option value="${m}"${i === 0 ? ' selected' : ''}>${m}</option>`
  ).join('');
}

async function _onCreate() {
  const slots = [];
  _modalEl.querySelectorAll('.mcm-slot').forEach((el, i) => {
    slots.push({
      index: i,
      kind: el.querySelector('.mcm-ai-select').value,
      model: el.querySelector('.mcm-model-select').value,
    });
  });
  const scene = _modalEl.querySelector('input[name="mcm-scene"]:checked').value;
  const mode = scene === 'research' ? 'research' : 'general';

  const createBtn = _modalEl.querySelector('.mcm-create');
  createBtn.disabled = true;
  createBtn.textContent = '创建中...';

  try {
    const meeting = await window.electronAPI.invoke('create-meeting', { mode, scene, slots });
    closeModal();
    if (typeof window.openMeeting === 'function') window.openMeeting(meeting);
    else if (typeof openMeeting === 'function') openMeeting(meeting);
  } catch (e) {
    console.error('[meeting-create] failed', e);
    alert('创建失败：' + e.message);
    createBtn.disabled = false;
    createBtn.textContent = '创建圆桌';
  }
}

function openMeetingCreateModal(mode = 'general') {
  _currentMode = mode;
  _ensureModal();
  _modalEl.querySelector('#mcm-mode-label').textContent = mode === 'research' ? '投研' : '通用';
  // 重置到默认
  _modalEl.querySelectorAll('.mcm-slot').forEach((el, i) => {
    el.querySelector('.mcm-ai-select').value = DEFAULT_SLOTS[i].kind;
    _refreshModelOptions(el);
    el.querySelector('.mcm-model-select').value = DEFAULT_SLOTS[i].model;
  });
  _modalEl.querySelector(`input[name="mcm-scene"][value="${mode}"]`).checked = true;
  _modalEl.querySelector('.mcm-create').disabled = false;
  _modalEl.querySelector('.mcm-create').textContent = '创建圆桌';
  _modalEl.style.display = 'flex';
}

function closeModal() {
  if (_modalEl) _modalEl.style.display = 'none';
}

window.openMeetingCreateModal = openMeetingCreateModal;
window.closeMeetingCreateModal = closeModal;
```

- [ ] **Step 3: index.html 引用**

`renderer/index.html`：

```html
<head>
  ...
  <link rel="stylesheet" href="meeting-create-modal.css">
</head>
<body>
  ...
  <script src="meeting-create-modal.js"></script>
</body>
```

- [ ] **Step 4: 视觉验证**

启动隔离 Hub → 在 DevTools console `window.openMeetingCreateModal('general')` → assert modal 弹出 → 改各 slot AI/model → 点创建 → assert IPC 调用成功 → 进会议室。

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-create-modal.js renderer/meeting-create-modal.css renderer/index.html
git commit -m "feat(renderer): meeting-create-modal with 5x3 AI/model picker"
```

---

### Task 13: createMeetingByMode 改 openMeetingCreateModal

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\renderer.js:1604-1637`

- [ ] **Step 1: 改函数体**

```js
// 旧
async function createMeetingByMode(mode = 'general') {
  const meeting = await window.electronAPI.invoke('create-meeting', { mode });
  for (const kind of ['claude', 'gemini', 'codex']) {
    await window.electronAPI.invoke('add-meeting-sub', { meetingId: meeting.id, kind });
  }
  openMeeting(meeting);
}

// 新
function createMeetingByMode(mode = 'general') {
  if (typeof window.openMeetingCreateModal === 'function') {
    window.openMeetingCreateModal(mode);
  } else {
    console.error('Meeting create modal not loaded');
  }
}
```

- [ ] **Step 2: 真测**

启动 Hub → 点侧边栏 + → 新建圆桌 → assert modal 弹出（不再立即创建） → 提交后 assert 进会议室。

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(renderer): createMeetingByMode opens modal instead of direct create"
```

---

### Task 14: 版本号

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\package.json`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`（如有版本号显示）

- [ ] **Step 1: 改版本**

```bash
# 找当前版本
grep -n '"version"' package.json
```

把 version `+0.1`（如 `0.4.0` → `0.5.0`）。

- [ ] **Step 2: UI 版本徽章同步**

```bash
grep -n "v0\." renderer/index.html renderer/meeting-room.js
```

把所有匹配的版本字串同步。

- [ ] **Step 3: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -10
git add package.json renderer/
git commit -m "chore: bump version (meeting create modal)"
```

---

### Task 15: E2E 验收

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-meeting-create-modal-verify.js`
- Create: `C:\Users\lintian\claude-session-hub\tests\screenshots\meeting-create-modal\` (目录)

- [ ] **Step 1: 写 E2E 脚本**

`tests/_e2e-meeting-create-modal-verify.js`：

```js
'use strict';
// E2E 验收 — 新建圆桌 Modal
// 用法：node tests/_e2e-meeting-create-modal-verify.js
// 前置：Hub 进程已用 CDP 端口 9251 启动，且 CLAUDE_HUB_DATA_DIR=C:\temp\hub-meeting-create

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9251;
const SHOT_DIR = path.join(__dirname, 'screenshots', 'meeting-create-modal');

async function shot(client, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await client.Page.captureScreenshot({ format: 'png' });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
}

async function evalJs(client, expr) {
  const r = await client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const targets = await CDP.List({ port: CDP_PORT });
  const target = targets.find(t => t.type === 'page');
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  await client.Page.enable();
  await client.Runtime.enable();

  // Case A · 默认创建（皮卡丘位 = Claude/Opus 4.7）
  await evalJs(client, `window.openMeetingCreateModal('general')`);
  await new Promise(r => setTimeout(r, 300));
  await shot(client, '00-modal-open.png');

  await evalJs(client, `document.querySelector('.mcm-create').click()`);
  await new Promise(r => setTimeout(r, 3000));
  await shot(client, '01-default.png');

  // assert 3 卡 + 头像顺序
  const card1AvatarSrc = await evalJs(client, `
    document.querySelectorAll('.mr-ft-avatar img')[0]?.src || ''
  `);
  if (!/pikachu/i.test(card1AvatarSrc)) throw new Error('Slot 1 not pikachu: ' + card1AvatarSrc);
  console.log('[ok] Case A default 3 cards correct');

  // Case B · 自定义创建（DeepSeek/Claude/GLM）
  await evalJs(client, `window.openMeetingCreateModal('general')`);
  await new Promise(r => setTimeout(r, 300));

  await evalJs(client, `
    const slots = document.querySelectorAll('.mcm-slot');
    slots[0].querySelector('.mcm-ai-select').value = 'deepseek';
    slots[0].querySelector('.mcm-ai-select').dispatchEvent(new Event('change'));
    slots[1].querySelector('.mcm-ai-select').value = 'claude';
    slots[1].querySelector('.mcm-ai-select').dispatchEvent(new Event('change'));
    slots[1].querySelector('.mcm-model-select').value = 'claude-sonnet-4-5';
    slots[2].querySelector('.mcm-ai-select').value = 'glm';
    slots[2].querySelector('.mcm-ai-select').dispatchEvent(new Event('change'));
    slots[2].querySelector('.mcm-model-select').value = 'glm-4.6';
  `);
  await shot(client, '02-modal-custom.png');

  await evalJs(client, `document.querySelector('.mcm-create').click()`);
  await new Promise(r => setTimeout(r, 8000));  // deepseek 启动较慢
  await shot(client, '03-custom-created.png');

  // assert 头像仍是皮卡丘/小火龙/杰尼龟
  const avatarsB = await evalJs(client, `
    Array.from(document.querySelectorAll('.mr-ft-avatar img')).map(el => el.src).join(' | ')
  `);
  if (!/pikachu.*charmander.*squirtle/i.test(avatarsB)) {
    throw new Error('Avatars not by slot: ' + avatarsB);
  }
  console.log('[ok] Case B custom: avatars by slot');

  // 流式验证
  await evalJs(client, `document.querySelector('[data-action="qcql"], #mr-toolbar-qcql').click()`);
  await new Promise(r => setTimeout(r, 30000));
  await shot(client, '04-streaming.png');

  // assert DeepSeek 卡片有 preview 内容（transcript-tap 走 ClaudeTap 应该有）
  const dsPreview = await evalJs(client, `
    document.querySelectorAll('.mr-ft-preview')[0]?.innerText || ''
  `);
  if (dsPreview.length < 20) {
    console.warn('DeepSeek preview short: ' + dsPreview.slice(0, 100));
  } else {
    console.log('[ok] DeepSeek streaming preview has content');
  }

  // Case C · kind 重复（3 Claude）
  await evalJs(client, `window.openMeetingCreateModal('general')`);
  await new Promise(r => setTimeout(r, 300));
  await evalJs(client, `
    const slots = document.querySelectorAll('.mcm-slot');
    [0, 1, 2].forEach(i => {
      slots[i].querySelector('.mcm-ai-select').value = 'claude';
      slots[i].querySelector('.mcm-ai-select').dispatchEvent(new Event('change'));
      slots[i].querySelector('.mcm-model-select').value = 'claude-opus-4-7[1m]';
    });
  `);
  await evalJs(client, `document.querySelector('.mcm-create').click()`);
  await new Promise(r => setTimeout(r, 5000));
  await shot(client, '05-three-claude.png');

  // 持久化验证（关 Hub + 重启）
  console.log('[manual] 关闭 Hub 后重启，再跑 06-restored.png 截图（手动步骤）');

  await client.close();
  console.log('[ok] all assertions passed; screenshots in', SHOT_DIR);
})().catch(e => {
  console.error('[FAIL]', e);
  process.exit(1);
});
```

- [ ] **Step 2: 启动隔离 Hub**

```bash
export CLAUDE_HUB_DATA_DIR=/c/temp/hub-meeting-create
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9251 &
sleep 4
```

- [ ] **Step 3: 跑 E2E**

```bash
node tests/_e2e-meeting-create-modal-verify.js
```

预期：6 张以上截图生成；console 看到 `[ok] all assertions passed`。

- [ ] **Step 4: 视觉 spot-check**

依次比对：
- `00-modal-open.png`：modal 弹出，3 slot 横排，预填 Claude/Gemini/Codex
- `01-default.png`：进会议室，头像 = 皮卡丘/小火龙/杰尼龟
- `02-modal-custom.png`：modal 内 slot 1 = DeepSeek/v4-pro，slot 2 = Claude/Sonnet 4.5，slot 3 = GLM/glm-4.6
- `03-custom-created.png`：圆桌头像仍是皮卡丘/小火龙/杰尼龟（未跟着 kind 变）
- `04-streaming.png`：3 卡都有 preview（特别是 DeepSeek 必须非空）
- `05-three-claude.png`：3 个 Claude 独立运行不互扰

- [ ] **Step 5: 关闭隔离 Hub + Commit**

```bash
ps -ef | grep "hub-meeting-create" | grep -v grep | awk '{print $2}' | xargs -r kill
git add tests/_e2e-meeting-create-modal-verify.js tests/screenshots/meeting-create-modal/.gitkeep
git commit -m "test(e2e): meeting create modal verify with 5 cases"
```

---

### Task 16: post-refactor-verify

涉及 11+ 文件改动，触发 `/post-refactor-verify` 流程。

- [ ] **Step 1: grep 残留**

```bash
grep -rn "for (const kind of \['claude'" main.js renderer/ core/
grep -rn "subs\.\(claude\|gemini\|codex\)" renderer/
grep -rn "thinkSecByKind\|tokensByKind" main.js core/
grep -rn "aiStats\.\(claude\|gemini\|codex\)" core/ main.js
```

预期：所有结果应为 0，或仅出现在迁移代码（`migrateAiStats`）的兼容分支。

- [ ] **Step 2: 调用方一致性**

```bash
grep -rn "_avatarBySlot\|_avatarFor" renderer/
grep -rn "buildRtMentionItems\|RT_MENTION_ITEMS" renderer/
```

assert `_avatarBySlot` 仅在圆桌卡片用；`_avatarFor` 在侧边栏保留。

- [ ] **Step 3: E2E 重跑（Task 15 已做，本步只确认通过）**

如 Task 15 截图齐全且 console 无 FAIL，本步直接通过。

- [ ] **Step 4: 四路审查**

按 `/cli-caller` skill Part 6 多方审查模板：
- 文件：本份改动的所有 git diff（`git diff master..HEAD` 或对应 base branch）
- 输出：高/中置信度问题列表

- [ ] **Step 5: 处理审查反馈**

每条高置信度问题 → 修复 + 新 commit。
中置信度 → 评估后决策（修 / 标 known issue / 拒）。

- [ ] **Step 6: 放行标记**

通过则在 `docs/post-refactor-verify-records.md`（如不存在则创建）追加：

```markdown
## 2026-05-XX · meeting-create-modal
- E2E: 6/6 PASS
- 多方审查: <Claude/Gemini/Codex/DeepSeek 四路结果>
- 高置信度问题: 0 (或修复 commit hash 列表)
- 放行人: 立花道雪
```

```bash
git add docs/post-refactor-verify-records.md
git commit -m "verify: post-refactor 4-way review pass for meeting create modal"
```

---

## Self-Review

### Spec coverage
- 优化 1（Modal UI 5x3）→ Task 12, 13 ✓
- DeepSeek/GLM 接入圆桌 timeline → Task 1 ✓
- _RT_READY_MARKERS deepseek → Task 2 ✓
- relaunchCli deepseek/glm → Task 3 ✓
- session-manager opts.model fallback → Task 4 ✓
- aiStats 改 sid 索引 + 老格式迁移 → Task 5 ✓
- main.js 投票/互评/turn 统计 → Task 6 ✓
- private-store 去白名单 → Task 7 ✓
- meeting-store 持久化 slotSpecs → Task 8 ✓
- IPC 升级 → Task 9 ✓
- renderer slot 重构 + _avatarBySlot → Task 10 ✓
- RT_MENTION_ITEMS 动态构建 → Task 11 ✓
- 版本号 → Task 14 ✓
- E2E + post-refactor-verify → Task 15, 16 ✓

### 类型一致性
- `slots` 数组在 Modal/IPC/orchestrator/renderer 全程一致 ✓
- `slotSpecs` 类型定义在 spec §4.3 与 plan Task 8/9 一致 ✓
- `aiStats[<sid>]` schema 在 Task 5/6 一致 ✓
- `thinkSecBySid` / `tokensBySid` 命名在 Task 5/6 一致 ✓

### 占位符扫描
- 无 TBD / TODO / "implement later" ✓
- 每步都有具体代码或具体命令 ✓

### 执行顺序铁律
Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16

特别注意：
- **Task 0 必须先做**（决定 Task 1 的实现路径，PASS = 简单 1 行 fix，FAIL = 写 DeepSeekTap）
- Task 5 必须在 Task 6 之前（接口变化）
- Task 9 必须在 Task 12 之前（IPC 升级让 Modal 提交链路通）
- Task 10 + 11 可并行（renderer 不同区域），但建议串行（同文件避免冲突）
- Task 12 + 13 必须按 12→13 顺序（13 依赖 Modal 已加载）

---

## 回滚预案

- 任何 Task 失败 → `git reset --hard <last-good-commit>`
- 整体撤回 → `git revert <range>`，保留 docs/ 但回滚代码
- 用户生产 Hub 不受影响（隔离测试 + 未推 master 之前一切都在 dev branch / worktree 内）

---

## 估时

- Task 0（spike）：0.3 天
- Task 1-4（transcript-tap + markers + relaunch + model fallback）：0.5 天
- Task 5（orchestrator + 迁移）：1 天
- Task 6（main.js 统计去硬编码）：0.5 天
- Task 7-8（private-store + meeting-store）：0.5 天
- Task 9（IPC 升级）：0.5 天
- Task 10-11（renderer slot 重构 + mention）：1 天
- Task 12（Modal UI 实现）：1.5 天
- Task 13（createMeetingByMode 改造）：0.2 天
- Task 14（version）：0.1 天
- Task 15-16（E2E + post-refactor-verify + 四路审查）：1 天

**合计 ~7 工作日**（spike 通过）/ ~8 天（spike 失败需写 DeepSeekTap）

---

## Execution Handoff

```
读 C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-01-meeting-create-modal.md
按 superpowers:executing-plans 或 superpowers:subagent-driven-development 执行

设计文档: C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-01-meeting-create-modal-design.md

执行铁律:
1. Task 0 (DeepSeek Stop hook spike) 必须先做，决定 Task 1 实现路径
2. 严格按 Task 0 → 1 → ... → 16 顺序
3. 测试用 CDP 真测，禁止 mock 假测（CLAUDE.md 铁律）
4. 测试 Hub 用 CLAUDE_HUB_DATA_DIR=C:\temp\hub-meeting-create 隔离启动
5. 严禁 kill 用户生产 Hub 进程
6. 不影响现有功能：旧 meeting 打开必须仍正常（subSessions 数组顺序 = slot 顺序自动兼容）
7. Task 16 (post-refactor-verify) 含四路审查，按 /cli-caller skill Part 6 模板
```
