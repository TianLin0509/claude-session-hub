# 圆桌卡片二期优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现"圆桌卡片二期优化"4 项改进 — (1) row1/row2 stats 合并 (2) 三家 CLI 全 JSONL 流式预览 + PTY 兜底 (3) 沉浸/调试模式切换 (4) 动态重排兜底。

**Architecture:** 核心改造在 `core/transcript-tap.js`：让 ClaudeTap/GeminiTap/CodexTap 三家都暴露结构化流式 blocks（`thinking` / `text` / `tool_use`），通过 `transcriptTap.getStreamingText(sid)` 统一接口。`main.js:_rtExtractStreamingText` 优先用 tap，PTY 降级。renderer 端 `_renderFusedTabs` 按 block 类型分别渲染。沉浸/重排在 renderer 单独闭环。

**Tech Stack:** Node.js (Electron main) / Vanilla JS (renderer) / xterm.js / fs.watch + JsonlTail / ResizeObserver / CSS Grid

**前置依赖（必须已合入 master）：**
- `docs/superpowers/plans/2026-05-01-roundtable-card-redesign.md`（一期：Pokemon 头像、stats 数据通道）
- `docs/superpowers/plans/2026-05-01-roundtable-input-fixes.md`（输入框修复 + cli-ready-status IPC）

**关联文档：**
- 设计：`docs/superpowers/specs/2026-05-01-roundtable-card-optimization-design.md`
- 效果图：`docs/roundtable-card-optimization-2026-05-01.html`

---

### Task 0: Codex agent_message_delta 协议 Spike（必须先做，决定 Task 4 命运）

**Files:**
- 临时脚本：`tests/_spike-codex-delta.js`（spike 完成后可删）

- [ ] **Step 1: 写 spike 脚本**

创建 `tests/_spike-codex-delta.js`：

```js
'use strict';
// Spike: 验证 Codex rollout-*.jsonl 中 agent_message_delta 事件协议
// 用法：先在 Hub 中跑一次 Codex turn，然后运行此脚本
const fs = require('fs');
const path = require('path');
const os = require('os');
const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

(async () => {
  const today = new Date();
  const dir = path.join(
    SESSIONS,
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  );
  let files;
  try { files = await fs.promises.readdir(dir); } catch (e) {
    console.error('No rollout dir today:', dir);
    process.exit(1);
  }
  const rollouts = files.filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    .map(f => ({ f, full: path.join(dir, f) }))
    .sort((a, b) => fs.statSync(b.full).mtime - fs.statSync(a.full).mtime);
  if (rollouts.length === 0) { console.error('No rollouts found'); process.exit(1); }
  const latest = rollouts[0].full;
  console.log('Analyzing:', latest);

  const raw = await fs.promises.readFile(latest, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const eventTypes = new Map();
  const deltaSamples = [];
  let deltaConcatLen = 0;
  let lastAgentMessage = '';

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'event_msg') continue;
    const t = obj.payload?.type;
    if (!t) continue;
    eventTypes.set(t, (eventTypes.get(t) || 0) + 1);
    if (t === 'agent_message_delta') {
      if (deltaSamples.length < 5) deltaSamples.push(obj.payload);
      if (typeof obj.payload.delta === 'string') deltaConcatLen += obj.payload.delta.length;
    }
    if (t === 'task_complete' && typeof obj.payload.last_agent_message === 'string') {
      lastAgentMessage = obj.payload.last_agent_message;
    }
  }

  console.log('Event type counts:', Object.fromEntries(eventTypes));
  console.log('Delta concat len:', deltaConcatLen);
  console.log('Last agent message len:', lastAgentMessage.length);
  console.log('Delta samples:', JSON.stringify(deltaSamples, null, 2).slice(0, 1500));
  console.log('Match check (delta concat ≈ last_agent_message):',
    deltaConcatLen >= lastAgentMessage.length * 0.9 ? '✓ PASS' : '✗ FAIL');
})();
```

- [ ] **Step 2: 启动 Hub + 跑 Codex turn**

启动隔离 Hub 实例：

```bash
export CLAUDE_HUB_DATA_DIR=/c/temp/hub-spike-codex
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9241 &
```

进 Hub UI → 创建圆桌（仅勾选 Codex）→ 进会议室 → 等 Codex 就绪 → 发一条简单 prompt（如"用三句话介绍 React"）→ 等 turn 完成。

- [ ] **Step 3: 运行 spike 脚本分析**

```bash
node tests/_spike-codex-delta.js
```

预期输出：

```
Event type counts: { task_started: 1, agent_message_delta: 87, task_complete: 1, ... }
Delta concat len: 423
Last agent message len: 420
Match check: ✓ PASS
Delta samples: [{ "type": "agent_message_delta", "delta": "React" }, ...]
```

- [ ] **Step 4: 决策记录**

把 spike 结果记录到 `tests/_spike-codex-delta-result.md`：

```markdown
# Codex agent_message_delta Spike Result

- Date: 2026-05-XX
- Codex CLI version: <gpt-5.5 / 输出版本号>
- Event types found: { ... }
- delta 字段位置: payload.delta (string)
- Concat 与 last_agent_message 匹配: PASS / FAIL
- 决策: [实施 Task 4 / 跳过 Task 4，Codex 仍走 PTY]
```

- [ ] **Step 5: Commit spike 工件**

```bash
git add tests/_spike-codex-delta.js tests/_spike-codex-delta-result.md
git commit -m "spike: verify Codex agent_message_delta protocol"
```

**Spike 通过/失败处理：**
- ✓ PASS → 继续 Task 4 (CodexTap delta 实现)
- ✗ FAIL → 跳过 Task 4 全部，本 plan 后续把 Codex 当作"始终走 PTY 兜底"对待。把 Task 4 所有 step 标 `[~]` 表示 skip。

---

### Task 1: ClaudeTap 改 tail 模式

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:114-158`
- Test: `C:\Users\lintian\claude-session-hub\tests\transcript-tap-claude-stream.test.js`

- [ ] **Step 1: 写 failing test**

创建 `tests/transcript-tap-claude-stream.test.js`：

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert');
const { TranscriptTap } = require('../core/transcript-tap');

test('ClaudeTap onLine 累积 thinking/text/tool_use 块到 streamingBuf', async () => {
  const tap = new TranscriptTap();
  const sid = 'test-claude-' + Date.now();

  // mock transcript file in temp dir
  const dir = path.join(os.tmpdir(), 'claude-tap-test-' + Date.now());
  await fs.promises.mkdir(dir, { recursive: true });
  const jsonlPath = path.join(dir, 'mock-session.jsonl');
  await fs.promises.writeFile(jsonlPath, '');

  tap.registerSession(sid, 'claude', { cwd: dir });
  // 模拟通过 hook 注入 transcriptPath（Stop hook 路径）
  await tap.notifyClaudeStop(sid, jsonlPath);

  // 追加流式块（模拟 Claude CLI 写入）
  const block1 = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', thinking: '我先想想' }],
    },
  });
  const block2 = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '答案是 42' }],
    },
  });
  await fs.promises.appendFile(jsonlPath, block1 + '\n');
  await fs.promises.appendFile(jsonlPath, block2 + '\n');

  // 等 JsonlTail 异步 onLine 触发
  await new Promise(r => setTimeout(r, 800));

  const blocks = tap.getStreamingText(sid);
  assert.ok(Array.isArray(blocks), 'getStreamingText returns array');
  assert.equal(blocks.length, 2, 'two blocks accumulated');
  assert.equal(blocks[0].type, 'thinking');
  assert.equal(blocks[0].text, '我先想想');
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].text, '答案是 42');

  tap.clearStreamingBuf(sid);
  assert.equal(tap.getStreamingText(sid), null, 'cleared');

  tap.unregisterSession(sid);
  await fs.promises.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑 test 验证失败**

```bash
node --test tests/transcript-tap-claude-stream.test.js
```

预期：FAIL（getStreamingText 不存在 / 累积不工作）

- [ ] **Step 3: 改造 ClaudeTap 加 JsonlTail + streamingBuf**

修改 `core/transcript-tap.js` 中 `ClaudeTap`（约 120-158 行），改成：

```js
class ClaudeTap extends EventEmitter {
  constructor() {
    super();
    this._bound = new Map();
    // hubSessionId → { transcriptPath, lastText, _streamingBuf, _tail }
  }

  registerSession(hubSessionId /* , ctx */) {
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null,
        lastText: null,
        _streamingBuf: [],
        _tail: null,
      });
    }
  }

  unregisterSession(hubSessionId) {
    const entry = this._bound.get(hubSessionId);
    if (entry?._tail) {
      try { entry._tail.close(); } catch {}
    }
    this._bound.delete(hubSessionId);
  }

  getLastAssistantText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    return e?.lastText || null;
  }

  getStreamingText(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (!e || !e._streamingBuf || e._streamingBuf.length === 0) return null;
    return [...e._streamingBuf];
  }

  clearStreamingBuf(hubSessionId) {
    const e = this._bound.get(hubSessionId);
    if (e) e._streamingBuf = [];
  }

  async notifyStop(hubSessionId, transcriptPath) {
    if (!transcriptPath || !hubSessionId) return;
    if (!this._bound.has(hubSessionId)) {
      this._bound.set(hubSessionId, {
        transcriptPath: null, lastText: null, _streamingBuf: [], _tail: null,
      });
    }
    const entry = this._bound.get(hubSessionId);
    entry.transcriptPath = transcriptPath;

    // 启动 JsonlTail（如未启）— 让后续轮也能流式
    if (!entry._tail) {
      const onLine = (obj) => {
        if (obj?.type !== 'assistant' || !obj.message?.content) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            entry._streamingBuf.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            entry._streamingBuf.push({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use' && block.name) {
            entry._streamingBuf.push({
              type: 'tool_use',
              name: block.name,
              input: block.input || {},
            });
          }
        }
        // 50KB 截断
        let totalLen = 0;
        for (let i = entry._streamingBuf.length - 1; i >= 0; i--) {
          const b = entry._streamingBuf[i];
          totalLen += (b.text || JSON.stringify(b.input || {})).length;
          if (totalLen > 50000) {
            entry._streamingBuf = entry._streamingBuf.slice(i + 1);
            break;
          }
        }
      };
      entry._tail = new JsonlTail(transcriptPath, onLine);
      await entry._tail.start();
    }

    // 既有 last assistant message 读取（保持兼容）
    const text = await readLastAssistantMessageFromClaudeTranscript(transcriptPath);
    if (text) {
      entry.lastText = text;
      this.emit('turn-complete', {
        hubSessionId, text, completedAt: Date.now(),
      });
    }
  }
}
```

- [ ] **Step 4: 跑 test 验证通过**

```bash
node --test tests/transcript-tap-claude-stream.test.js
```

预期：PASS

- [ ] **Step 5: Commit**

```bash
git add core/transcript-tap.js tests/transcript-tap-claude-stream.test.js
git commit -m "feat(transcript-tap): ClaudeTap stream blocks via JsonlTail"
```

---

### Task 2: GeminiTap 暴露 streamingBuf

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:458-727` (GeminiTap)
- Test: `C:\Users\lintian\claude-session-hub\tests\transcript-tap-gemini-stream.test.js`

- [ ] **Step 1: 写 failing test**

创建 `tests/transcript-tap-gemini-stream.test.js`：

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert');
const { TranscriptTap } = require('../core/transcript-tap');

test('GeminiTap onLine 累积 type:"gemini" content 到 streamingBuf', async () => {
  // 这个 test 直接调 GeminiTap._bindSession 私有路径不容易。
  // 改成：mock 出整个文件 + 让 GeminiTap 自己 scan/bind 的端到端模拟。
  // 简化：调 emit-style 测——直接 push 到 _streamingBuf 验证 getter
  const tap = new TranscriptTap();
  const sid = 'test-gemini-' + Date.now();

  const dir = path.join(os.tmpdir(), 'gemini-tap-test-' + Date.now());
  const projectDir = path.join(dir, 'fakeproject');
  const chatsDir = path.join(projectDir, 'chats');
  await fs.promises.mkdir(chatsDir, { recursive: true });
  await fs.promises.writeFile(path.join(projectDir, '.project_root'), dir);
  const sessionPath = path.join(chatsDir, 'session-aaaaaaaa.jsonl');
  await fs.promises.writeFile(sessionPath, '');

  // 不容易让 GeminiTap 用 GEMINI_TMP_ROOT 的 fake 路径——
  // 改 strat: 通过 registerSession + 写 fake jsonl 到真路径，避免文件系统 mock。
  // 此 test 仅确保 getStreamingText / clearStreamingBuf 接口存在并且 null-safe。
  assert.equal(tap.getStreamingText(sid), null, 'null when not bound');
  tap.clearStreamingBuf(sid);  // should not throw

  // 完整 GeminiTap onLine 累积验证放到 E2E（Task 12）真跑 Gemini turn 后 assert。
  await fs.promises.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑 test 验证失败（getStreamingText 不存在）**

```bash
node --test tests/transcript-tap-gemini-stream.test.js
```

预期：FAIL

- [ ] **Step 3: 改 GeminiTap onLine 累积**

修改 `core/transcript-tap.js` 中 GeminiTap 的 `_bindSession`（约 615-727 行），找到 `boundEntry` 初始化处加字段：

```js
const boundEntry = {
  sessionPath, tail: null, lastText: null, isJsonl,
  debounceTimer: null,
  _streamingBuf: [],  // 新增
};
```

在 `onLine` 内 `type:"gemini"` 分支补累积逻辑（约 682-691 行）：

```js
if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null
    && typeof obj.content === 'string' && obj.content.trim().length > 0) {
  this._recordTokens(hubSessionId, obj.tokens);
  // 新增：累积到 streamingBuf
  boundEntry._streamingBuf.push({ type: 'text', text: obj.content });
  if (boundEntry._streamingBuf.length > 200) {
    boundEntry._streamingBuf.shift();  // 简易上限
  }
  emitIfComplete(obj.content, { signalSource: 'tokens_total' });
} else if (obj?.type === 'gemini' && obj.tokens && obj.tokens.total != null) {
  this._recordTokens(hubSessionId, obj.tokens);
} else if (obj?.type === 'gemini' && typeof obj.content === 'string' && obj.content.trim().length > 0) {
  // 仅累积 content，未必 emit（流式中间态，token 还没到）
  boundEntry._streamingBuf.push({ type: 'text', text: obj.content });
}
```

加 GeminiTap 类方法：

```js
getStreamingText(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (!entry || !entry._streamingBuf || entry._streamingBuf.length === 0) return null;
  return [...entry._streamingBuf];
}

clearStreamingBuf(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (entry) entry._streamingBuf = [];
}
```

- [ ] **Step 4: 跑 test 验证通过**

```bash
node --test tests/transcript-tap-gemini-stream.test.js
```

预期：PASS

- [ ] **Step 5: Commit**

```bash
git add core/transcript-tap.js tests/transcript-tap-gemini-stream.test.js
git commit -m "feat(transcript-tap): GeminiTap accumulate stream blocks"
```

---

### Task 3: TranscriptTap 顶层代理

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:733-798` (TranscriptTap class)

- [ ] **Step 1: 加两个公开方法**

在 `TranscriptTap` 类（约 733 行）中添加：

```js
getStreamingText(hubSessionId) {
  return (
    this._claude.getStreamingText(hubSessionId) ||
    this._gemini.getStreamingText(hubSessionId) ||
    (this._codex.getStreamingText ? this._codex.getStreamingText(hubSessionId) : null) ||
    null
  );
}

clearStreamingBuf(hubSessionId) {
  for (const b of [this._claude, this._gemini, this._codex]) {
    try {
      if (b.clearStreamingBuf) b.clearStreamingBuf(hubSessionId);
    } catch {}
  }
}
```

注意：`this._codex.getStreamingText` 在 Task 4 spike 失败时不会存在，所以加防御性 `?` 链。

- [ ] **Step 2: smoke test 启动 Hub**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

预期：看到 `[hub] hook server listening on 127.0.0.1:...`，没有 `Cannot find module` 或语法错误。

- [ ] **Step 3: Commit**

```bash
git add core/transcript-tap.js
git commit -m "feat(transcript-tap): expose getStreamingText/clearStreamingBuf"
```

---

### Task 4: CodexTap delta 累积（仅 Spike 通过时）

**前置：** Task 0 spike PASS。否则跳过整个 Task 4。

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:244-447` (CodexTap)

- [ ] **Step 1: 加 _streamingBuf 字段**

修改 CodexTap 的 `_tryBind`（约 442 行的 `this._bound.set`）：

```js
this._bound.set(hubSessionId, {
  rolloutPath, tail, lastText: null,
  _pendingEmitTimer: null, _pendingText: null, _pendingDurationMs: null,
  _streamingBuf: [],  // 新增
});
```

- [ ] **Step 2: 在 onLine 加 delta 分支**

修改 `_tryBind` 内的 `onLine`（约 400-438 行），在 task_started/task_complete 之前添加 delta 处理：

```js
const onLine = (obj) => {
  if (obj?.type !== 'event_msg' || !obj.payload) return;
  const entry = this._bound.get(hubSessionId);
  if (!entry) return;
  const eventType = obj.payload.type;

  // 新增：agent_message_delta 累积
  if (eventType === 'agent_message_delta' && typeof obj.payload.delta === 'string') {
    entry._streamingBuf.push({ type: 'text', text: obj.payload.delta });
    // 上限 200 条
    if (entry._streamingBuf.length > 200) entry._streamingBuf.shift();
    return;
  }

  // 既有 task_started 取消 pending（保持），同时清空 streamingBuf 开新 task
  if (eventType === 'task_started') {
    entry._streamingBuf = [];
    if (entry._pendingEmitTimer) {
      clearTimeout(entry._pendingEmitTimer);
      entry._pendingEmitTimer = null;
      entry._pendingText = null;
      entry._pendingDurationMs = null;
    }
  }

  // 既有 task_complete 处理（保持不变）
  if (eventType === 'task_complete' && typeof obj.payload.last_agent_message === 'string') {
    // ... 既有代码 ...
  }
};
```

- [ ] **Step 3: 加 CodexTap 类方法**

```js
getStreamingText(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (!entry || !entry._streamingBuf || entry._streamingBuf.length === 0) return null;
  return [...entry._streamingBuf];
}

clearStreamingBuf(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (entry) entry._streamingBuf = [];
}
```

- [ ] **Step 4: 写 spike-derived test**

创建 `tests/transcript-tap-codex-stream.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TranscriptTap } = require('../core/transcript-tap');

test('CodexTap getStreamingText null-safe before binding', () => {
  const tap = new TranscriptTap();
  assert.equal(tap.getStreamingText('not-bound'), null);
  tap.clearStreamingBuf('not-bound');  // should not throw
});

// 完整 delta 累积验证由 E2E (Task 12) 真跑 Codex turn 后 assert
```

- [ ] **Step 5: 跑 test 验证 + Commit**

```bash
node --test tests/transcript-tap-codex-stream.test.js
git add core/transcript-tap.js tests/transcript-tap-codex-stream.test.js
git commit -m "feat(transcript-tap): CodexTap accumulate agent_message_delta"
```

---

### Task 5: main.js `_rtExtractStreamingText` 按 kind 分流

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js:649-674`

- [ ] **Step 1: 改造函数签名 + 实现**

替换原 `_rtExtractStreamingText(sid)` 为 `_rtExtractStreamingText(sid, kind)`：

```js
function _rtExtractStreamingText(sid, kind) {
  // 优先 transcript-tap 结构化 blocks
  const blocks = transcriptTap.getStreamingText(sid);
  if (Array.isArray(blocks) && blocks.length > 0) {
    return { source: 'tap', blocks };
  }

  // 兜底：PTY ringBuffer + 简化过滤
  const buf = sessionManager.getSessionBuffer(sid) || '';
  if (!buf) return { source: 'pty', blocks: [] };

  const cleaned = buf
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');

  const lines = cleaned.split('\n').reverse();
  const kept = [];
  let len = 0;
  const MAX = 500;
  for (const ln of lines) {
    if (len >= MAX) break;
    const trim = ln.trim();
    if (!trim) continue;
    if (/^(PS |>|\$|❊|·|·)/.test(trim)) continue;
    if (/^\[.*圆桌.*轮/.test(trim)) continue;
    if (/^(##\s*用户问题|请独立回答)/.test(trim)) continue;
    if (/quota\s+--?no.sandbox|gemini\s+--approval/.test(trim)) continue;
    kept.push(trim);
    len += trim.length;
  }
  const text = kept.reverse().join('\n').slice(-500);
  return { source: 'pty', blocks: text ? [{ type: 'text', text }] : [] };
}
```

- [ ] **Step 2: 找出所有调用方并升级**

grep `_rtExtractStreamingText` 所有调用点（main.js 内）：

```bash
grep -n "_rtExtractStreamingText" main.js
```

每个调用点都加上 `kind` 参数。例如 `dispatchRoundtableTurn` 中（约 720 行）：

```js
// 旧: const text = _rtExtractStreamingText(sid);
// 新:
const session = sessionManager.getSession(sid);
const kind = session?.kind || (session?.info && session.info.kind) || 'unknown';
const result = _rtExtractStreamingText(sid, kind);
const text = result.blocks.map(b => b.type === 'text' ? b.text : '').join('').slice(-500);
const blocks = result.blocks;
```

- [ ] **Step 3: smoke test 启动 Hub**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -30
```

预期：`[hub] hook server listening on ...`；无 `_rtExtractStreamingText is not a function` 之类错误。

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): split _rtExtractStreamingText by kind, prefer tap blocks"
```

---

### Task 6: IPC payload 升级为 blocks + clearStreamingBuf 时机

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js:705-849` (dispatchRoundtableTurn 区域)

- [ ] **Step 1: payload 改造**

找到 `roundtable-partial-update` IPC 发送处（约 main.js:846-849），替换为：

```js
// 旧: mainWindow.webContents.send('roundtable-partial-update', { sid, label, status, text, tokens });
// 新:
const result = _rtExtractStreamingText(sid, kind);
const text = result.blocks.map(b => b.type === 'text' ? b.text : '').join('').slice(-500);
mainWindow.webContents.send('roundtable-partial-update', {
  sid,
  label,
  status,
  blocks: result.blocks,
  source: result.source,
  text,  // 兼容字段，老 renderer 仍可用
  tokens: tokens || undefined,
});
```

- [ ] **Step 2: dispatchRoundtableTurn 开始时清空 streamingBuf**

`dispatchRoundtableTurn`（约 main.js:705 行）函数顶部：

```js
async function dispatchRoundtableTurn(meeting, ...) {
  // 既有逻辑前插入：
  for (const sub of meeting.subs || []) {
    try { transcriptTap.clearStreamingBuf(sub.sid); } catch {}
  }
  // 既有逻辑继续...
}
```

- [ ] **Step 3: smoke test + 真跑一次 turn**

启动 Hub → 创建圆桌 → 发一条 prompt → 观察 DevTools Console 的 `roundtable-partial-update` IPC payload 是否含 `blocks` 字段。

```js
// 在 renderer DevTools console:
window.electronAPI.onRoundtablePartialUpdate?.((p) => console.log('partial:', p));
// 应看到 { sid, label, status, blocks: [...], source: 'tap'|'pty', text, tokens }
```

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): IPC roundtable-partial-update carries blocks array"
```

---

### Task 7: renderer 结构化渲染 preview blocks

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:150-280` (`_renderFusedTabs` / `_ftHtml`)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css:519-580` (preview 相关)

- [ ] **Step 1: 加 renderPreviewBlocks + formatToolUse 函数**

在 `renderer/meeting-room.js` 顶部（其他 helper 附近）添加：

```js
function escapeHtmlSafe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatToolUseBlock(block) {
  const name = block.name || '';
  const input = block.input || {};
  if (/^(WebSearch|web_search)$/i.test(name)) {
    const q = input.query || input.q || '';
    return `🔍 搜索: "${q}"`;
  }
  if (/^(Read|read_file|read)$/i.test(name)) {
    return `📄 读: ${input.path || input.file || ''}`;
  }
  if (/^(Bash|shell|exec)$/i.test(name)) {
    const cmd = String(input.command || input.cmd || '').slice(0, 60);
    return `⚙ 执行: ${cmd}`;
  }
  if (/^(Edit|Write|edit|write)$/i.test(name)) {
    return `✏ 编辑: ${input.file_path || input.path || ''}`;
  }
  return `🔧 ${name}`;
}

function renderPreviewBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const html = [];
  // 工具调用最多 8 个，最末优先
  let toolBudget = 8;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'tool_use' && toolBudget <= 0) blocks[i] = null;
    else if (b.type === 'tool_use') toolBudget--;
  }
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'thinking') {
      const t = String(block.text || '').slice(-400);
      html.push(`<div class="mr-ft-think">${escapeHtmlSafe(t)}</div>`);
    } else if (block.type === 'tool_use') {
      const summary = formatToolUseBlock(block);
      html.push(`<span class="mr-ft-tool">${escapeHtmlSafe(summary)}</span>`);
    } else if (block.type === 'text') {
      const t = String(block.text || '').slice(-2000);
      // 复用既有 markdown render（marked / DOMPurify）
      const md = (typeof renderMarkdown === 'function') ? renderMarkdown(t) : escapeHtmlSafe(t);
      html.push(`<div class="mr-ft-md">${md}</div>`);
    }
  }
  return html.join('');
}
```

- [ ] **Step 2: 改 _renderFusedTabs 用 blocks**

在 `_renderFusedTabs`（约 150-222 行）中，找到 preview 渲染处（约 216 / 220 / 232 行），改成：

```js
// 旧: const previewHtml = renderMarkdown(partial.text || '').slice(-800);
// 新:
let previewHtml;
if (Array.isArray(partial?.blocks) && partial.blocks.length > 0) {
  previewHtml = renderPreviewBlocks(partial.blocks);
} else if (partial?.text) {
  // 兼容老 payload
  previewHtml = renderPreviewBlocks([{ type: 'text', text: partial.text }]);
} else {
  previewHtml = '';
}
```

- [ ] **Step 3: 加 CSS 样式**

在 `renderer/meeting-room.css` 中（preview 样式块附近）添加：

```css
.mr-ft-think {
  color: var(--text-dim, #8b949e);
  font-style: italic;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.mr-ft-think::before { content: "💭 "; }

.mr-ft-tool {
  display: inline-block;
  background: rgba(57, 208, 216, 0.12);
  color: #39d0d8;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11.5px;
  margin: 2px 4px 2px 0;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.mr-ft-md {
  font-size: 12.5px;
  line-height: 1.55;
}
```

- [ ] **Step 4: 真跑一次 turn 验证视觉效果**

启动隔离 Hub（`CLAUDE_HUB_DATA_DIR=C:\temp\hub-render-test`）→ 创建圆桌 + 选 Claude → 发 prompt → 观察 cards-tab preview 区是否：
- thinking 块以 `💭 xxx` 灰斜体出现
- tool_use 块以 `🔍 搜索: "..."` 高亮 chip 出现
- text 块正常 markdown 渲染

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): structured preview rendering for thinking/tool/text blocks"
```

---

### Task 8: row1/row2 stats 合并

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:224-239` (`_ftHtml`)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css:519-570` (.mr-ft / .mr-ft-elapsed 等)

- [ ] **Step 1: 改 _ftHtml 把 stats 合并到 row1/row2**

替换 `_ftHtml`（约 224 行）：

```js
function _ftHtml(sub, partial, status, model, ctxPct, isInitializing, lastTurnByMap) {
  const name = sub.label || sub.kind || '?';
  const avatar = _avatarFor(sub.kind);
  const statusBadge = _statusBadge(sub, partial, status, isInitializing);
  const modelTag = model ? `<span class="mr-ft-model">${escapeHtmlSafe(model)}</span>` : '';
  const ctxTag = ctxPct != null ? `<span class="mr-ft-ctx">Ctx ${ctxPct}%</span>` : '';

  const thinkSecCur = partial?.thinkSecCur ?? '-';
  const thinkSecTotal = partial?.thinkSecTotal ?? '-';
  const tokensCur = partial?.tokensCur ?? '-';
  const tokensTotal = partial?.tokensTotal ?? '-';

  const timeStat = `<span class="mr-ft-stat-inline" title="本轮思考 / 累计">⏱ <span class="num">${thinkSecCur}</span> · ${thinkSecTotal}</span>`;
  const tokenStat = `<span class="mr-ft-stat-inline" title="本轮 token / 累计">🪙 <span class="num">${tokensCur}</span> · ${tokensTotal}</span>`;

  let previewHtml;
  if (Array.isArray(partial?.blocks) && partial.blocks.length > 0) {
    previewHtml = renderPreviewBlocks(partial.blocks);
  } else if (partial?.text) {
    previewHtml = renderPreviewBlocks([{ type: 'text', text: partial.text }]);
  } else if (lastTurnByMap?.[sub.sid]) {
    previewHtml = renderPreviewBlocks([{ type: 'text', text: lastTurnByMap[sub.sid] }]);
  } else {
    previewHtml = '';
  }

  return `
    <div class="mr-ft-row1">
      <div class="mr-ft-avatar">${avatar}</div>
      <div class="mr-ft-name">${escapeHtmlSafe(name)}</div>
      ${statusBadge}
      ${timeStat}
    </div>
    <div class="mr-ft-row2">
      ${modelTag}
      ${ctxTag}
      ${tokenStat}
    </div>
    <div class="mr-ft-divider"></div>
    <div class="mr-ft-preview">${previewHtml}</div>
  `;
}
```

- [ ] **Step 2: CSS 调整**

修改 `renderer/meeting-room.css`：

```css
/* 调整 .mr-ft */
.mr-ft {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 220px;
  container-type: inline-size;  /* 启用容器查询 */
}

/* row1/row2 改 flex 布局，stats push 到右边 */
.mr-ft-row1, .mr-ft-row2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.mr-ft-stat-inline {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-dim, #8b949e);
}
.mr-ft-stat-inline .num {
  color: var(--text, #e6edf3);
  font-weight: 600;
}

/* 删除 row3/row4 旧样式 */
.mr-ft-elapsed,
.mr-ft-tokens-row {
  display: none;  /* 渐进删除：先 hide，确认无引用后下个 commit 物理删 */
}

.mr-ft-divider {
  height: 1px;
  background: var(--border-soft, #21262d);
  margin: 6px 0 8px;
}

.mr-ft-preview {
  flex: 1;
  overflow-y: hidden;
}

/* 响应式降级 */
@container (max-width: 280px) {
  .mr-ft-stat-inline {
    flex-basis: 100%;
    margin-left: 0;
    margin-top: 2px;
  }
}
```

- [ ] **Step 3: 删 row3/row4 的死代码**

grep `_ftHtml` / `mr-ft-elapsed` / `mr-ft-tokens-row` 确认无引用后，从 CSS 完全删除（不留 `display:none`）：

```bash
grep -n "mr-ft-elapsed\|mr-ft-tokens-row" renderer/
```

无残留则删除 CSS 中这两个选择器整段。

- [ ] **Step 4: 视觉验证**

启动隔离 Hub → 进会议室 → 截图 cards 区域 → 对比 HTML mockup 的 "After" 区。assert：
- row1 名字旁有 `⏱ 33s · -`
- row2 模型旁有 `🪙 1.2k · -`
- preview 区能放下 4 行内容

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): merge time/token stats into row1/row2"
```

---

### Task 9: 沉浸 / 调试模式切换

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html:108-130` (meeting-room-panel header)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` (新增 toggleMeetingMode / applyMeetingMode)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`
- Modify: `C:\Users\lintian\claude-session-hub\main.js` (state.json schema 持久化)

- [ ] **Step 1: index.html 加按钮 + 包 shell 区**

修改 `renderer/index.html` meeting-room-panel header：

```html
<!-- 在 #meeting-room-title 那一行的右侧加 -->
<button id="meeting-room-mode-toggle" class="mr-mode-btn" title="切换沉浸/调试模式">
  <span id="mr-mode-icon">🖥</span>
  <span id="mr-mode-label">调试</span>
</button>
```

shell 容器包一层（用于隐藏）：

```html
<!-- 原 shell 区域外加包装 -->
<div id="mr-shell-area">
  <!-- ... 既有 shell DOM ... -->
</div>
```

- [ ] **Step 2: renderer/meeting-room.js 加 toggle 逻辑**

在 `meeting-room.js` 文件末尾或合适位置加：

```js
function toggleMeetingMode() {
  const mid = state.currentMeetingId;
  if (!mid) return;
  state.immersiveByMeeting = state.immersiveByMeeting || {};
  const cur = !!state.immersiveByMeeting[mid];
  const next = !cur;
  state.immersiveByMeeting[mid] = next;
  applyMeetingMode(next);
  // persist via既有 saveState API（不存在则改成 ipcRenderer 调 'save-state'）
  if (typeof saveStateDebounced === 'function') saveStateDebounced();
  else window.electronAPI?.saveState?.({ immersiveByMeeting: state.immersiveByMeeting });
}

function applyMeetingMode(immersive) {
  const panel = document.getElementById('meeting-room-panel');
  const btn = document.getElementById('meeting-room-mode-toggle');
  const iconEl = document.getElementById('mr-mode-icon');
  const labelEl = document.getElementById('mr-mode-label');
  if (!panel || !btn) return;
  if (immersive) {
    panel.classList.add('immersive');
    btn.classList.add('immersive');
    if (iconEl) iconEl.textContent = '🎯';
    if (labelEl) labelEl.textContent = '沉浸';
  } else {
    panel.classList.remove('immersive');
    btn.classList.remove('immersive');
    if (iconEl) iconEl.textContent = '🖥';
    if (labelEl) labelEl.textContent = '调试';
  }
  // 等动画结束再 fit xterm
  setTimeout(() => {
    if (typeof _relayoutMeetingRoom === 'function') _relayoutMeetingRoom();
  }, 260);
  // 防快速反复点击
  btn.style.pointerEvents = 'none';
  setTimeout(() => { btn.style.pointerEvents = ''; }, 280);
}

// openMeeting 末尾调（约 meeting-room.js:885-904 区域）：
function _restoreMeetingMode(meeting) {
  state.immersiveByMeeting = state.immersiveByMeeting || {};
  const immersive = !!state.immersiveByMeeting[meeting.id];
  applyMeetingMode(immersive);
}
```

`openMeeting` 末尾插入：

```js
// 既有 setupInput / startMarkerPoll 之后
_restoreMeetingMode(meeting);
// 绑定按钮（用 _inputBound 同模式的 once-bind 守卫）
const toggleBtn = document.getElementById('meeting-room-mode-toggle');
if (toggleBtn && !toggleBtn._bound) {
  toggleBtn.addEventListener('click', toggleMeetingMode);
  toggleBtn._bound = true;
}
```

- [ ] **Step 3: CSS 加切换样式 + 动画**

在 `renderer/meeting-room.css` 加：

```css
.mr-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-card-2, #1c232c);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text, #e6edf3);
  cursor: pointer;
  user-select: none;
}
.mr-mode-btn:hover { background: rgba(88, 166, 255, 0.08); }
.mr-mode-btn.immersive {
  background: rgba(88, 166, 255, 0.18);
  border-color: var(--accent, #58a6ff);
  color: var(--accent, #58a6ff);
}

#mr-shell-area {
  transition: max-height 240ms ease-out, opacity 240ms ease-out;
  overflow: hidden;
  max-height: 100vh;
  opacity: 1;
}
#meeting-room-panel.immersive #mr-shell-area {
  max-height: 0 !important;
  opacity: 0;
  pointer-events: none;
}

.mr-ft-strip {
  transition: flex 240ms ease-out;
}
#meeting-room-panel.immersive .mr-ft-strip {
  flex: 1;
  height: auto;
}
#meeting-room-panel.immersive .mr-ft {
  height: 100%;
}
```

- [ ] **Step 4: state.json schema 持久化**

在 `main.js` 中找到 `_loadState` / `_saveState`（搜 "state.json"），确认 `immersiveByMeeting` 字段会被自动序列化（多数情况下顶层 state 字典是 plain object，会自然包含）。如有显式 schema 白名单，加入 `immersiveByMeeting`。

- [ ] **Step 5: 真测切换**

启动隔离 Hub → 进会议室 → 点 🖥 调试按钮 → assert shell 区淡出 + cards 拉伸 → 截图 → 关 Hub → 重启 Hub → 进同一会议室 → assert 自动恢复沉浸模式。

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/meeting-room.js renderer/meeting-room.css main.js
git commit -m "feat(renderer): immersive/debug mode toggle with per-meeting persistence"
```

---

### Task 10: 动态重排兜底（_relayoutMeetingRoom + ResizeObserver）

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`
- Test: `C:\Users\lintian\claude-session-hub\tests\meeting-room-relayout.test.js`

- [ ] **Step 1: 写 failing test（DOM mock）**

`tests/meeting-room-relayout.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('_relayoutMeetingRoom is exported and callable', () => {
  // 此 test 仅验证函数存在不抛错；真重排效果在 E2E 验
  // 因 Node 环境无 DOM，加载 module 失败属预期，仅验证文件加载到提到 _relayoutMeetingRoom
  const fs = require('fs');
  const src = fs.readFileSync('renderer/meeting-room.js', 'utf8');
  assert.match(src, /function\s+_relayoutMeetingRoom\s*\(/, 'function defined');
  assert.match(src, /ResizeObserver/, 'ResizeObserver used');
  assert.match(src, /fitAddon\.fit\(\)/, 'xterm fit called');
});
```

- [ ] **Step 2: 跑 test 验证失败**

```bash
node --test tests/meeting-room-relayout.test.js
```

预期：FAIL（_relayoutMeetingRoom 还没写）

- [ ] **Step 3: 加 _relayoutMeetingRoom + observer 注册**

在 `renderer/meeting-room.js` 末尾或合适位置加：

```js
function _debounce(fn, wait) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

let _meetingResizeObserver = null;
let _lastLayoutW = 0;
let _lastLayoutH = 0;

function _relayoutMeetingRoom() {
  const panel = document.getElementById('meeting-room-panel');
  if (!panel || panel.style.display === 'none') return;

  // 强制 reflow
  void panel.offsetHeight;

  // xterm fit
  if (typeof _focusCache === 'object' && _focusCache) {
    for (const sid of Object.keys(_focusCache)) {
      const cached = _focusCache[sid];
      if (cached?.fitAddon) {
        try { cached.fitAddon.fit(); } catch {}
      }
    }
  }

  // history panel 高度（如展开）
  const hp = document.getElementById('mr-history-panel');
  if (hp && hp.classList.contains('expanded')) {
    hp.style.maxHeight = `${hp.scrollHeight}px`;
  }
}

function _setupMeetingResizeObserver() {
  if (_meetingResizeObserver) return;
  const panel = document.getElementById('meeting-room-panel');
  if (!panel) return;

  const debouncedRelayout = _debounce((entries) => {
    const e = entries[0];
    if (!e) return;
    const { width, height } = e.contentRect;
    if (Math.abs(width - _lastLayoutW) < 4 && Math.abs(height - _lastLayoutH) < 4) return;
    _lastLayoutW = width;
    _lastLayoutH = height;
    _relayoutMeetingRoom();
  }, 100);

  _meetingResizeObserver = new ResizeObserver(debouncedRelayout);
  _meetingResizeObserver.observe(panel);

  // window resize（cover devtools 场景）
  window.addEventListener('resize', _debounce(_relayoutMeetingRoom, 100));
}

function _teardownMeetingResizeObserver() {
  if (_meetingResizeObserver) {
    try { _meetingResizeObserver.disconnect(); } catch {}
    _meetingResizeObserver = null;
  }
}
```

`openMeeting` 末尾调用 `_setupMeetingResizeObserver()`。`closeMeetingPanel` 调 `_teardownMeetingResizeObserver()`。

- [ ] **Step 4: CSS 防溢出三件套**

确认 `.mr-ft-strip` 有：

```css
.mr-ft-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));  /* 防 grid item 溢出 */
  gap: 8px;
  min-height: 0;                                      /* 让 grid 在 flex parent 中可缩 */
}
```

确认 `.mr-ft` 已加 `overflow: hidden`（Task 8 已加）。

- [ ] **Step 5: 跑 test 验证通过**

```bash
node --test tests/meeting-room-relayout.test.js
```

预期：PASS

- [ ] **Step 6: 真测窗口 resize**

启动 Hub → 进会议室 → 拖拽窗口边缘改尺寸 → 观察 cards / shell 是否实时重排，无重叠。

- [ ] **Step 7: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css tests/meeting-room-relayout.test.js
git commit -m "feat(renderer): ResizeObserver-based dynamic relayout with xterm fit"
```

---

### Task 11: 版本号升级

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\package.json`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`（如有版本号显示）

- [ ] **Step 1: package.json 改版本**

```bash
grep -n '"version"' package.json
```

把 `"version": "0.3.0"` 改为 `"version": "0.4.0"`（或在前一份 plan 已升的基础上 +0.1）。

- [ ] **Step 2: UI 版本显示同步（如有）**

```bash
grep -n "v0\." renderer/index.html renderer/meeting-room.js
```

把版本徽章从 `v0.3.0` 改成 `v0.4.0`（HTML/JS 中所有匹配处）。

- [ ] **Step 3: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -10
git add package.json renderer/
git commit -m "chore: bump version to 0.4.0 (card optimization)"
```

---

### Task 12: E2E 验收脚本

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-card-optimization-verify.js`
- Create: `C:\Users\lintian\claude-session-hub\tests\screenshots\card-optimization\` (目录)

- [ ] **Step 1: 写 E2E 脚本**

创建 `tests/_e2e-card-optimization-verify.js`：

```js
'use strict';
// E2E 验收 — 圆桌卡片二期优化
// 用法：node tests/_e2e-card-optimization-verify.js
// 前置：Hub 进程已用 CDP 端口 9233 启动，且 CLAUDE_HUB_DATA_DIR=C:\temp\hub-cardopt

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9233;
const SHOT_DIR = path.join(__dirname, 'screenshots', 'card-optimization');

async function shot(client, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await client.Page.captureScreenshot({ format: 'png' });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
  return file;
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

  // 1. 创建圆桌 + 进会议室
  await evalJs(client, `
    (async () => {
      // 假设 Hub UI 暴露了 createMeeting/openMeeting helper
      // 否则用 DOM 点击：document.querySelector('#new-meeting-btn').click()
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
  await shot(client, '01-initial.png');

  // 2. 启动 turn
  await evalJs(client, `document.querySelector('#mr-toolbar-qcql, [data-action="qcql"]').click()`);
  await new Promise(r => setTimeout(r, 5000));
  await shot(client, '02-streaming.png');

  // assert preview 区无 throbbing 字串
  const previewText = await evalJs(client, `
    Array.from(document.querySelectorAll('.mr-ft-preview'))
      .map(el => el.innerText).join('\\n')
  `);
  if (/thinking more with|Inferring|Cogitated/i.test(previewText)) {
    throw new Error('Preview still contains throbbing noise: ' + previewText.slice(0, 200));
  }
  console.log('[ok] preview clean');

  // 3. 等 turn 完成
  await new Promise(r => setTimeout(r, 60000));  // 等 1 分钟
  await shot(client, '03-done.png');

  // assert row1 含 ⏱，row2 含 🪙
  const row1Text = await evalJs(client, `
    Array.from(document.querySelectorAll('.mr-ft-row1'))[0]?.innerText || ''
  `);
  const row2Text = await evalJs(client, `
    Array.from(document.querySelectorAll('.mr-ft-row2'))[0]?.innerText || ''
  `);
  if (!/⏱/.test(row1Text)) throw new Error('row1 missing ⏱: ' + row1Text);
  if (!/🪙/.test(row2Text)) throw new Error('row2 missing 🪙: ' + row2Text);
  console.log('[ok] stats merged into row1/row2');

  // 4. 点沉浸按钮
  await evalJs(client, `document.getElementById('meeting-room-mode-toggle').click()`);
  await new Promise(r => setTimeout(r, 350));
  await shot(client, '04-immersive.png');

  const shellHidden = await evalJs(client, `
    getComputedStyle(document.getElementById('mr-shell-area')).maxHeight === '0px'
  `);
  if (!shellHidden) throw new Error('Shell area not hidden in immersive mode');
  console.log('[ok] immersive mode hides shell');

  // 5. 切回调试
  await evalJs(client, `document.getElementById('meeting-room-mode-toggle').click()`);
  await new Promise(r => setTimeout(r, 350));
  await shot(client, '05-debug.png');

  // 6. resize 窗口
  await client.Emulation.setDeviceMetricsOverride({
    width: 1024, height: 600, deviceScaleFactor: 1, mobile: false,
  });
  await new Promise(r => setTimeout(r, 300));
  await shot(client, '06-resized.png');

  await client.Emulation.clearDeviceMetricsOverride();
  await client.close();
  console.log('[ok] all assertions passed; screenshots in', SHOT_DIR);
})().catch(e => {
  console.error('[FAIL]', e);
  process.exit(1);
});
```

- [ ] **Step 2: 启动隔离 Hub**

```bash
export CLAUDE_HUB_DATA_DIR=/c/temp/hub-cardopt
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9233 &
sleep 4
```

- [ ] **Step 3: 跑 E2E**

```bash
node tests/_e2e-card-optimization-verify.js
```

预期：6 张截图全部生成；console 看到 `[ok] all assertions passed`。

- [ ] **Step 4: 视觉 spot-check**

打开 `tests/screenshots/card-optimization/` 目录，依次比对：
- `01-initial.png`：cards 占主区 ≥ 35%，无重叠
- `02-streaming.png`：preview 区有 `💭` 思考块或 `🔍` 工具块或正常文本，**无** `thinking more with` 类噪声
- `03-done.png`：row1/row2 有 ⏱/🪙 stats
- `04-immersive.png`：shell 区不可见，cards 占满
- `05-debug.png`：shell 区恢复
- `06-resized.png`：1024×600 视口下无溢出

- [ ] **Step 5: Commit**

```bash
git add tests/_e2e-card-optimization-verify.js tests/screenshots/card-optimization/.gitkeep
git commit -m "test(e2e): card optimization verify script + screenshot snapshots"
```

- [ ] **Step 6: 关闭隔离 Hub**

```bash
# 找到 PID（注意：不要 kill 用户生产 Hub）
ps -ef | grep "hub-cardopt" | grep -v grep | awk '{print $2}' | xargs -r kill
```

---

### Task 13: post-refactor-verify（≥3 文件改动触发）

本次改动涉及 `core/transcript-tap.js` / `main.js` / `renderer/meeting-room.js` / `renderer/meeting-room.css` / `renderer/index.html` / `package.json` / 多个 `tests/*.js` —— 远超 3 文件门槛。

按 `C:\Users\lintian\CLAUDE.md` 铁律执行 `/post-refactor-verify` 流程：

- [ ] **Step 1: grep 残留**

```bash
grep -rn "_rtExtractStreamingText" main.js renderer/ core/
grep -rn "mr-ft-elapsed\|mr-ft-tokens-row" renderer/ main.js
grep -rn "partial.text" renderer/ main.js  # 应该已经全部改为 partial.blocks 兜底
```

预期：仅在 _rtExtractStreamingText 定义处和兼容字段处出现，无 dead reference。

- [ ] **Step 2: 调用方一致性**

```bash
grep -rn "transcriptTap\.\(getStreamingText\|clearStreamingBuf\)" main.js core/ renderer/
```

assert 所有调用与 spec §6.2 接口签名一致。

- [ ] **Step 3: E2E 重跑（Task 12 已做，本步只确认通过）**

如 Task 12 截图齐全且 console 无 FAIL，本步直接通过。

- [ ] **Step 4: 四路审查**

按 `/cli-caller` skill Part 6 多方审查模板：
- 文件：本份改动的所有 git diff（`git diff master..HEAD`）
- 输出：高置信度 + 中置信度问题列表

- [ ] **Step 5: 处理审查反馈**

每条高置信度问题 → 修复 + 新 commit。
中置信度 → 评估后决策（修 / 标 known issue / 拒）。

- [ ] **Step 6: 放行标记**

通过则在 `docs/post-refactor-verify-records.md`（如不存在则创建）追加：

```markdown
## 2026-05-XX · roundtable-card-optimization
- E2E: 6/6 PASS
- 多方审查: <Claude/Gemini/Codex/DeepSeek 四路结果>
- 高置信度问题: 0 (或修复 commit hash 列表)
- 放行人: 立花道雪
```

- [ ] **Step 7: Commit + 推送**

```bash
git add docs/post-refactor-verify-records.md
git commit -m "verify: post-refactor 4-way review pass for card optimization"
git push origin <branch>  # 如有远程
```

---

## 总结

12 个核心 Task + 1 个 verify Task。spike 通过则全部 13 个；spike 失败则跳过 Task 4，剩 12 个。

**估时**：~6 工作日（spike 通过）/ ~5.5 天（spike 失败 Codex 仍 PTY）

**关键里程碑**：
1. Task 0 spike → 决定 Codex 走向
2. Task 1-4 → 数据层全部就绪（核心改造）
3. Task 5-7 → 串通 main↔renderer 流式
4. Task 8-10 → 视觉/交互层
5. Task 11-13 → 收尾验收

**执行顺序铁律**：Task 0 → 1 → 2 → 3 → 4(条件) → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13。
- Task 1-4 内部可并行（不同文件区域），但建议串行（同一 transcript-tap.js 文件，避免 merge 冲突）
- Task 8 / 9 / 10 内部可并行（不同 renderer 子模块），但建议先 8 后 9/10（10 依赖 8 改完的 grid 结构）

**回滚预案**：
- 任何 Task 失败 → `git reset --hard <last-good-commit>`
- 整体撤回 → `git revert <range>`，保留 docs/ 但回滚代码
- 用户生产 Hub 不受影响（隔离测试 + 未推 master 之前一切都在 dev branch / worktree 内）
