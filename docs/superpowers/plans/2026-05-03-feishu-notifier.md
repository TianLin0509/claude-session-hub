# 飞书未读消息通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub 任意 session 完成一轮 / 进入"等你输入"状态时主动推送通知卡片到飞书私聊，纯单向、配置可缺、与现有 `feishu-codex-gateway` 完全独立。

**Architecture:** main 进程新增 `core/feishu-notifier.js`（去重 + 发卡片）订阅 renderer 端 IPC `feishu-notify`；renderer 仅在 `onReplyCompleteFromHook` 末尾追加 1 行 IPC；复用 `core/feishu-client.js` 现有 SDK 与共享应用凭据。

**Tech Stack:** Node.js + Electron IPC + 现有 `FeishuClient`（飞书 OpenAPI tenant_access_token）；测试用纯 Node `assert` + 注入式 fake client / fake clock；E2E 用 Playwright over CDP。

**参考 Spec:** `docs/superpowers/specs/2026-05-03-feishu-notifier-design.md`

---

## 文件结构

| 文件 | 操作 | 责任 |
|------|------|------|
| `core/feishu-notifier.js` | **创建** | 接 IPC payload → 60s 去重 → 拼卡片 → 调 `FeishuClient.sendCard`。导出 `FeishuNotifier` class + `buildNotifyCard()` |
| `tests/unit-feishu-notifier.test.js` | **创建** | 单元测试，注入 fake client + fake clock |
| `tests/integration-feishu-notifier-ipc.test.js` | **创建** | 集成测试：renderer IPC 能到 main notifier |
| `tests/e2e-feishu-notifier.js` | **创建** | E2E：隔离 Hub + Playwright CDP + 真实飞书推送 |
| `main.js` | 修改 | 启动初始化 notifier + 注册 `ipcMain.on('feishu-notify')` + `resolveNotifyConfig()` |
| `renderer/renderer.js` | 修改 (`:2961-2995` 区域) | `onReplyCompleteFromHook()` 末尾追加 1 行 IPC |

---

## Task 1：notifier 骨架 + 首次推送 happy path

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\feishu-notifier.js`
- Create: `C:\Users\lintian\claude-session-hub\tests\unit-feishu-notifier.test.js`

- [ ] **Step 1.1: 写失败测试 — 构造校验 + 首次推送**

写入 `C:\Users\lintian\claude-session-hub\tests\unit-feishu-notifier.test.js`：

```js
'use strict';

const assert = require('assert');
const { FeishuNotifier, buildNotifyCard } = require('../core/feishu-notifier.js');

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    sendCard: async (args) => {
      calls.push(args);
      return { code: 0, data: { message_id: 'fake-mid-' + calls.length } };
    },
  };
}

function makeFakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function basePayload(overrides = {}) {
  return Object.assign({
    sessionId: 'sess-A',
    title: 'lindang-agent',
    kind: 'codex',
    isWaiting: false,
    newlyWaiting: false,
    waitingText: null,
    preview: '已完成数据拉取，准备进入下一轮分析。',
    timestamp: 1_700_000_000_000,
  }, overrides);
}

async function testConstructorValidation() {
  assert.throws(
    () => new FeishuNotifier({ chatId: 'oc_x' }),
    /client is required/i,
    'missing client must throw',
  );
  assert.throws(
    () => new FeishuNotifier({ client: makeFakeClient() }),
    /chatId is required/i,
    'missing chatId must throw',
  );
  console.log('  ok constructor validation');
}

async function testFirstSend() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client,
    chatId: 'oc_target',
    now: clock.now,
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 1, 'sendCard called exactly once');
  assert.strictEqual(client.calls[0].chatId, 'oc_target');
  assert.ok(client.calls[0].card, 'card payload provided');
  console.log('  ok first send');
}

(async () => {
  console.log('Running FeishuNotifier tests...');
  await testConstructorValidation();
  await testFirstSend();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 1.2: 运行测试，确认 fail（模块还不存在）**

Run:
```powershell
cd C:\Users\lintian\claude-session-hub
node tests/unit-feishu-notifier.test.js
```

Expected: 报错 `Cannot find module '../core/feishu-notifier.js'`

- [ ] **Step 1.3: 写最小实现**

写入 `C:\Users\lintian\claude-session-hub\core\feishu-notifier.js`：

```js
'use strict';

function buildNotifyCard(payload) {
  // 占位实现，Task 6 会扩展
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content: `Hub 提醒 · ${payload.title || ''}` },
      ],
    },
  };
}

class FeishuNotifier {
  constructor({ client, chatId, dedupeWindowMs = 60_000, dryRunLogPath = null, logger = console, now = () => Date.now() } = {}) {
    if (!client) throw new Error('FeishuNotifier: client is required');
    if (chatId === undefined || chatId === null) throw new Error('FeishuNotifier: chatId is required');
    this.client = client;
    this.chatId = chatId;
    this.dedupeWindowMs = dedupeWindowMs;
    this.dryRunLogPath = dryRunLogPath;
    this.logger = logger;
    this.now = now;
    this._lastSentAt = new Map();
    this._lastError = null;
  }

  get lastError() { return this._lastError; }

  async notify(payload) {
    if (!payload || !payload.sessionId) {
      return { sent: false, reason: 'invalid' };
    }
    const card = buildNotifyCard(payload);
    try {
      await this.client.sendCard({ chatId: this.chatId, card });
      this._lastSentAt.set(payload.sessionId, this.now());
      return { sent: true, reason: 'sent' };
    } catch (err) {
      this._lastError = { time: this.now(), message: err.message };
      this.logger.warn && this.logger.warn('[feishu-notify] send failed:', err.message);
      return { sent: false, reason: 'error' };
    }
  }
}

module.exports = { FeishuNotifier, buildNotifyCard };
```

- [ ] **Step 1.4: 运行测试，确认 pass**

Run:
```powershell
node tests/unit-feishu-notifier.test.js
```

Expected:
```
Running FeishuNotifier tests...
  ok constructor validation
  ok first send
All passed.
```

- [ ] **Step 1.5: Commit**

```powershell
cd C:\Users\lintian\claude-session-hub
git add core/feishu-notifier.js tests/unit-feishu-notifier.test.js
git commit -m @'
feat(feishu): notifier skeleton + first-send happy path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2：60s 同 session 去重 + 60s 后重新触发

**Files:**
- Modify: `core/feishu-notifier.js`
- Modify: `tests/unit-feishu-notifier.test.js`

- [ ] **Step 2.1: 在测试文件追加两个失败测试**

在 `testFirstSend` 之后、IIFE 之前追加：

```js
async function testDedupeWithinWindow() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(30_000);
  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: false, reason: 'deduped' });
  assert.strictEqual(client.calls.length, 1, 'sendCard called only on first');
  console.log('  ok dedupe within window');
}

async function testReSendAfterWindow() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(61_000);
  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 2);
  console.log('  ok re-send after window');
}
```

并在 IIFE 内追加调用：

```js
  await testDedupeWithinWindow();
  await testReSendAfterWindow();
```

- [ ] **Step 2.2: 运行测试，确认 dedupe 测试 fail**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: `testDedupeWithinWindow` 失败，因为目前代码每次都会发。

- [ ] **Step 2.3: 在 `notify()` 入口加去重判断**

修改 `core/feishu-notifier.js` 的 `notify()` 方法，把当前实现替换为：

```js
  async notify(payload) {
    if (!payload || !payload.sessionId) {
      return { sent: false, reason: 'invalid' };
    }
    const last = this._lastSentAt.get(payload.sessionId) || 0;
    const t = this.now();
    if (t - last < this.dedupeWindowMs) {
      return { sent: false, reason: 'deduped' };
    }
    return this._send(payload, t);
  }

  async _send(payload, t) {
    const card = buildNotifyCard(payload);
    try {
      await this.client.sendCard({ chatId: this.chatId, card });
      this._lastSentAt.set(payload.sessionId, t);
      return { sent: true, reason: 'sent' };
    } catch (err) {
      this._lastError = { time: t, message: err.message };
      this.logger.warn && this.logger.warn('[feishu-notify] send failed:', err.message);
      return { sent: false, reason: 'error' };
    }
  }
```

- [ ] **Step 2.4: 运行测试，确认全部 pass**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 4 个 `ok` 全部出现，结尾 `All passed.`

- [ ] **Step 2.5: Commit**

```powershell
git add core/feishu-notifier.js tests/unit-feishu-notifier.test.js
git commit -m @'
feat(feishu): 60s same-session dedupe in notifier

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3：newlyWaiting 绕过去重 + 不同 session 隔离

**Files:**
- Modify: `core/feishu-notifier.js`
- Modify: `tests/unit-feishu-notifier.test.js`

- [ ] **Step 3.1: 追加两个失败测试**

在 `tests/unit-feishu-notifier.test.js` IIFE 之前追加：

```js
async function testNewlyWaitingBypassesDedupe() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(10_000);
  const result = await notifier.notify(basePayload({ newlyWaiting: true, isWaiting: true }));

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 2, 'newlyWaiting bypasses dedupe');
  console.log('  ok newlyWaiting bypasses dedupe');
}

async function testDifferentSessionsIndependent() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload({ sessionId: 'sess-A' }));
  await notifier.notify(basePayload({ sessionId: 'sess-B' }));

  assert.strictEqual(client.calls.length, 2, 'different sessions both send');
  console.log('  ok different sessions independent');
}
```

并在 IIFE 内追加调用：

```js
  await testNewlyWaitingBypassesDedupe();
  await testDifferentSessionsIndependent();
```

- [ ] **Step 3.2: 运行测试，确认 newlyWaiting 测试 fail**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: `testNewlyWaitingBypassesDedupe` 失败（被去重拦了）。`testDifferentSessionsIndependent` 应该已经天然 pass（因为去重 key 就是 sessionId），可以先观察。

- [ ] **Step 3.3: 在 `notify()` 入口加 newlyWaiting 绕过逻辑**

修改 `core/feishu-notifier.js` 的 `notify()` 方法：

```js
  async notify(payload) {
    if (!payload || !payload.sessionId) {
      return { sent: false, reason: 'invalid' };
    }
    const t = this.now();
    if (!payload.newlyWaiting) {
      const last = this._lastSentAt.get(payload.sessionId) || 0;
      if (t - last < this.dedupeWindowMs) {
        return { sent: false, reason: 'deduped' };
      }
    }
    return this._send(payload, t);
  }
```

- [ ] **Step 3.4: 运行测试，全部 pass**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 6 个 `ok`，`All passed.`

- [ ] **Step 3.5: Commit**

```powershell
git add core/feishu-notifier.js tests/unit-feishu-notifier.test.js
git commit -m @'
feat(feishu): newlyWaiting bypasses dedupe; per-session isolation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4：API 失败处理 + lastError

**Files:**
- Modify: `tests/unit-feishu-notifier.test.js`

注：实现已经在 Task 1/2 提前完成（`_send` 已捕获 err 并写 `_lastError`），这里只补测试。

- [ ] **Step 4.1: 追加失败处理测试**

在 IIFE 之前追加：

```js
async function testApiFailureNoThrow() {
  const failingClient = {
    sendCard: async () => { throw new Error('Feishu HTTP 500'); },
  };
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client: failingClient, chatId: 'oc_target', now: clock.now,
    logger: { warn: () => {} },
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: false, reason: 'error' });
  assert.ok(notifier.lastError, 'lastError recorded');
  assert.strictEqual(notifier.lastError.message, 'Feishu HTTP 500');
  console.log('  ok api failure does not throw');
}
```

并在 IIFE 内追加：`await testApiFailureNoThrow();`

- [ ] **Step 4.2: 运行测试，全部 pass**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 7 个 `ok`，`All passed.`

- [ ] **Step 4.3: Commit**

```powershell
git add tests/unit-feishu-notifier.test.js
git commit -m @'
test(feishu): api failure does not throw, lastError recorded

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5：dry-run 模式

**Files:**
- Modify: `core/feishu-notifier.js`
- Modify: `tests/unit-feishu-notifier.test.js`

- [ ] **Step 5.1: 追加 dry-run 测试**

在 IIFE 之前追加：

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

async function testDryRunMode() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-notify-dry-'));
  const logPath = path.join(tmpDir, 'feishu-notify.log');
  const notifier = new FeishuNotifier({
    client, chatId: '', dryRunLogPath: logPath, now: clock.now,
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'dryrun' });
  assert.strictEqual(client.calls.length, 0, 'sendCard NOT called in dryrun');
  assert.ok(fs.existsSync(logPath), 'dry-run log exists');
  const logContent = fs.readFileSync(logPath, 'utf8');
  assert.ok(logContent.includes('sess-A'), 'log contains sessionId');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ok dry-run mode');
}
```

并在 IIFE 追加：`await testDryRunMode();`

- [ ] **Step 5.2: 运行测试，确认 fail（dry-run 还没实现）**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: dry-run 测试失败（要么调了 sendCard，要么文件不存在）。

- [ ] **Step 5.3: 在 `_send` 之前加 dry-run 分支**

修改 `core/feishu-notifier.js` 顶部增加 require：

```js
const fs = require('fs');
```

在 `_send()` 方法**之前**新增 `_writeDryRun()` 方法，并修改 `notify()` 让它在 chatId === '' 时走 dry-run：

```js
  async notify(payload) {
    if (!payload || !payload.sessionId) {
      return { sent: false, reason: 'invalid' };
    }
    const t = this.now();
    if (!payload.newlyWaiting) {
      const last = this._lastSentAt.get(payload.sessionId) || 0;
      if (t - last < this.dedupeWindowMs) {
        return { sent: false, reason: 'deduped' };
      }
    }
    if (this.chatId === '') {
      this._writeDryRun(payload, t);
      this._lastSentAt.set(payload.sessionId, t);
      return { sent: true, reason: 'dryrun' };
    }
    return this._send(payload, t);
  }

  _writeDryRun(payload, t) {
    if (!this.dryRunLogPath) return;
    const card = buildNotifyCard(payload);
    const line = JSON.stringify({ t, payload, card }) + '\n';
    try {
      fs.appendFileSync(this.dryRunLogPath, line, 'utf8');
    } catch (err) {
      this._lastError = { time: t, message: 'dryrun log failed: ' + err.message };
    }
  }
```

- [ ] **Step 5.4: 运行测试，全部 pass**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 8 个 `ok`，`All passed.`

- [ ] **Step 5.5: Commit**

```powershell
git add core/feishu-notifier.js tests/unit-feishu-notifier.test.js
git commit -m @'
feat(feishu): dry-run mode (chatId='' writes JSONL log)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 6：buildNotifyCard 真实卡片拼装

**Files:**
- Modify: `core/feishu-notifier.js`
- Modify: `tests/unit-feishu-notifier.test.js`

- [ ] **Step 6.1: 追加卡片测试**

在 IIFE 之前追加：

```js
async function testCardWaitingState() {
  const card = buildNotifyCard(basePayload({
    isWaiting: true,
    newlyWaiting: true,
    waitingText: '请审批：删除文件 a.txt',
  }));
  assert.strictEqual(card.schema, '2.0');
  assert.strictEqual(card.header.template, 'orange', 'orange for waiting');
  const md = card.body.elements.map(e => e.content || '').join('\n');
  assert.ok(md.includes('lindang-agent'), 'title in markdown');
  assert.ok(md.includes('等你回复'), 'waiting label');
  assert.ok(md.includes('请审批：删除文件 a.txt'), 'waitingText shown');
  console.log('  ok card waiting state');
}

async function testCardCompletedState() {
  const card = buildNotifyCard(basePayload({
    isWaiting: false,
    preview: '已完成数据拉取，准备进入下一轮分析。',
  }));
  assert.strictEqual(card.header.template, 'wathet', 'wathet for completed');
  const md = card.body.elements.map(e => e.content || '').join('\n');
  assert.ok(md.includes('一轮完成'), 'completed label');
  assert.ok(md.includes('已完成数据拉取'), 'preview shown');
  console.log('  ok card completed state');
}

async function testCardPreviewTruncation() {
  const longPreview = 'x'.repeat(500);
  const card = buildNotifyCard(basePayload({ preview: longPreview }));
  const md = card.body.elements.map(e => e.content || '').join('\n');
  // preview 段不应超过 200 字符（不算 "..." 后缀）
  const xCount = (md.match(/x/g) || []).length;
  assert.ok(xCount <= 210, `preview truncated, got ${xCount} chars`);
  console.log('  ok card preview truncation');
}
```

并在 IIFE 追加：

```js
  await testCardWaitingState();
  await testCardCompletedState();
  await testCardPreviewTruncation();
```

- [ ] **Step 6.2: 运行测试，确认 fail**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 三个新测试全 fail（占位实现没有 header、没有 "等你回复" 等字样）。

- [ ] **Step 6.3: 替换 `buildNotifyCard` 真实实现**

把 `core/feishu-notifier.js` 顶部的 `buildNotifyCard` 函数替换为：

```js
function truncatePreview(text, max = 200) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function formatTimestamp(t) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function buildNotifyCard(payload) {
  const isWaiting = !!payload.isWaiting;
  const statusLine = isWaiting ? '⏸ 等你回复' : '✅ 一轮完成';
  const bodyText = isWaiting
    ? truncatePreview(payload.waitingText || payload.preview || '')
    : truncatePreview(payload.preview || '');
  const time = formatTimestamp(payload.timestamp || Date.now());
  const md = [
    `**状态：${statusLine}**`,
    '',
    bodyText || '（无内容）',
    '',
    `— Hub @ ${time}`,
  ].join('\n');

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: isWaiting ? 'orange' : 'wathet',
      title: { tag: 'plain_text', content: `Hub 提醒 · ${payload.title || ''}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: md },
      ],
    },
  };
}
```

- [ ] **Step 6.4: 运行测试，全部 pass**

Run: `node tests/unit-feishu-notifier.test.js`

Expected: 11 个 `ok`，`All passed.`

- [ ] **Step 6.5: Commit**

```powershell
git add core/feishu-notifier.js tests/unit-feishu-notifier.test.js
git commit -m @'
feat(feishu): real notify-card markdown (waiting=orange, done=wathet)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 7：main.js 配置解析 + 启动初始化 + IPC handler

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

参照现有 `feishuCodex` 注入模式（main.js:3138-3163）。

- [ ] **Step 7.1: 在 main.js 顶部 require 区域追加 import**

找到 main.js 中 require `feishu-client` 的地方（应该在文件靠前位置）：

```powershell
cd C:\Users\lintian\claude-session-hub
node -e "const c=require('fs').readFileSync('main.js','utf8'); const lines=c.split('\n'); for(let i=0;i<lines.length;i++) if(lines[i].includes('feishu-client')) console.log((i+1)+': '+lines[i]);"
```

确认现有 require 形式，然后在**同一处**追加 `FeishuNotifier`：

```js
const { FeishuNotifier } = require('./core/feishu-notifier.js');
```

- [ ] **Step 7.2: 在 main.js mobile try-catch 块**之后**（与 mobile init 完全独立的 try-catch）追加 notifier 初始化**

定位锚点是 `app.whenReady().then(async () => { ... });` 回调中 mobile try-catch 的右大括号（main.js:3190 `}` 之后、3191 `});` 之前）。在这一处插入一个**独立的 try-catch**，避免 notifier 初始化失败被 mobile 的 catch 误吞、并避免 mobile 启动失败时 notifier 跟着挂掉：

```js

    // ---- Feishu Notifier (one-way push, independent of mobile + feishuCodex) ----
    try {
      const hubConfigForNotify = getHubConfig();
      const notifyConf = resolveFeishuNotifyConfig(hubConfigForNotify);
      if (notifyConf && notifyConf.appId && notifyConf.appSecret && notifyConf.chatId !== undefined) {
        const notifyClient = new FeishuClient({
          appId: notifyConf.appId,
          appSecret: notifyConf.appSecret,
          domain: notifyConf.domain || 'feishu',
          baseUrl: process.env.HUB_FEISHU_BASE_URL || null,
        });
        const dataDir = getHubDataDir();
        global.__feishuNotifier = new FeishuNotifier({
          client: notifyClient,
          chatId: notifyConf.chatId,
          dedupeWindowMs: notifyConf.dedupeMs || 60_000,
          dryRunLogPath: notifyConf.chatId === '' ? path.join(dataDir, 'feishu-notify.log') : null,
        });
        ipcMain.on('feishu-notify', (_event, payload) => {
          global.__feishuNotifier.notify(payload).catch(err => {
            console.warn('[feishu-notify] notify rejected:', err.message);
          });
        });
        const masked = notifyConf.chatId === '' ? '<dryrun>' : (notifyConf.chatId.slice(0, 6) + '****');
        console.log(`[feishu-notify] enabled, chatId=${masked}`);
      } else {
        console.log('[feishu-notify] disabled (missing app_id/app_secret/chat_id)');
      }
    } catch (e) {
      console.error('[feishu-notify] init failed:', e.message);
    }
```

注：`getHubDataDir` 与 `FeishuClient` 与 `ipcMain` 与 `path` 在 main.js 顶部均已 require（已确认）。仅需追加 `FeishuNotifier` 一项（Step 7.1）。`getHubConfig` 已在 main.js 中现有调用。

- [ ] **Step 7.3: 在 main.js 中添加 `resolveFeishuNotifyConfig` helper**

`getHubConfig` 是顶部 import（main.js:27 `const { getConfig: getHubConfig } = require('./core/hub-config.js');`）。把 helper 放在 `app.whenReady` 之前的工具函数区即可（比如 `startAgentScanner` 函数附近，main.js:3101 上下）。追加：

```js
function resolveFeishuNotifyConfig(hubConfig) {
  const c = (hubConfig && hubConfig.feishuNotify) || {};
  const sharedFeishu = (hubConfig && hubConfig.feishuCodex) || {};
  const appId    = process.env.HUB_FEISHU_APP_ID    || c.appId    || sharedFeishu.appId    || '';
  const appSecret= process.env.HUB_FEISHU_APP_SECRET|| c.appSecret|| sharedFeishu.appSecret|| '';
  const domain   = process.env.HUB_FEISHU_DOMAIN    || c.domain   || sharedFeishu.domain   || 'feishu';
  const chatIdEnv = process.env.HUB_FEISHU_NOTIFY_CHAT_ID;
  const chatId = (chatIdEnv !== undefined) ? chatIdEnv : c.chatId;  // env 中空字符串视为 dryrun
  const dedupeMsEnv = process.env.HUB_FEISHU_NOTIFY_DEDUPE_MS;
  const dedupeMs = dedupeMsEnv ? Number(dedupeMsEnv) : (c.dedupeMs || 60_000);
  if (chatId === undefined) return null; // 完全未配置
  return { appId, appSecret, domain, chatId, dedupeMs };
}
```

- [ ] **Step 7.4: 启动 smoke test，确认 Hub 能正常起来（无 chat_id 配置时静默禁用）**

Run（**用隔离 data dir，避免污染生产 Hub 状态**）：

```powershell
cd C:\Users\lintian\claude-session-hub
$env:CLAUDE_HUB_DATA_DIR = "$env:TEMP\hub-task7-smoke"
Remove-Item Env:HUB_FEISHU_NOTIFY_CHAT_ID -ErrorAction SilentlyContinue  # 确保未配
$proc = Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -PassThru -RedirectStandardOutput "$env:TEMP\hub-smoke.log" -RedirectStandardError "$env:TEMP\hub-smoke.err.log"
Start-Sleep -Seconds 8
Stop-Process -Id $proc.Id -Force
Remove-Item Env:CLAUDE_HUB_DATA_DIR
Get-Content "$env:TEMP\hub-smoke.log" | Select-String -Pattern "feishu-notify|hook server"
```

Expected:
- 看到 `[hub] hook server listening on 127.0.0.1:...`
- 看到 `[feishu-notify] disabled (missing app_id/app_secret/chat_id)`
- **不能**看到任何 stack trace 或 `init failed`

- [ ] **Step 7.5: Commit**

```powershell
git add main.js
git commit -m @'
feat(feishu): wire FeishuNotifier into main.js (env+config, IPC handler)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 8：renderer 触发 IPC

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\renderer.js`（`onReplyCompleteFromHook` 函数末尾，约 :2993）

- [ ] **Step 8.1: 定位锚点行**

```powershell
cd C:\Users\lintian\claude-session-hub
node -e "const lines=require('fs').readFileSync('renderer/renderer.js','utf8').split('\n'); for(let i=2960;i<3000;i++) console.log((i+1)+'| '+lines[i]);"
```

确认 `:2993` 附近为 `renderSessionList();` 和 `schedulePersist();`。

- [ ] **Step 8.2: 在 `renderSessionList(); schedulePersist();` 之后插入 IPC 发送**

修改 `renderer/renderer.js` `onReplyCompleteFromHook` 函数末尾（在 `schedulePersist();` 那行之后），插入：

```js
  // 飞书通知（无条件发，main 端做去重 + 启用判定）
  try {
    ipcRenderer.send('feishu-notify', {
      sessionId,
      title: session.title,
      kind: session.kind,
      isWaiting: !!session.isWaiting,
      newlyWaiting,
      waitingText: session.waitingText || null,
      preview: session.lastOutputPreview || '',
      timestamp: Date.now(),
    });
  } catch {}
```

- [ ] **Step 8.3: smoke test — 启动 Hub 确认 renderer 不报错**

Run（用隔离 data dir）：

```powershell
$env:CLAUDE_HUB_DATA_DIR = "$env:TEMP\hub-task8-smoke"
$proc = Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -PassThru -RedirectStandardOutput "$env:TEMP\hub-smoke.log" -RedirectStandardError "$env:TEMP\hub-smoke.err.log"
Start-Sleep -Seconds 8
Stop-Process -Id $proc.Id -Force
Remove-Item Env:CLAUDE_HUB_DATA_DIR
Get-Content "$env:TEMP\hub-smoke.err.log" | Select-String -Pattern "Error|Uncaught"
```

Expected: 无 `Error` / `Uncaught` 输出。

- [ ] **Step 8.4: Commit**

```powershell
git add renderer/renderer.js
git commit -m @'
feat(feishu): renderer emits feishu-notify IPC on reply complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 9：集成测试 — IPC 链路

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\integration-feishu-notifier-ipc.test.js`

集成测试不启动完整 Electron（成本高）。改为：手动触发 main.js 同样的 init 路径（注入 fake `ipcMain` + fake `FeishuClient`），确认 payload 在去重判定后正确路由到 client.sendCard。

- [ ] **Step 9.1: 写集成测试**

写入 `tests/integration-feishu-notifier-ipc.test.js`：

```js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { FeishuNotifier } = require('../core/feishu-notifier.js');

// 模拟 main.js 中的 IPC handler 注册逻辑
function wireIpcToNotifier(notifier) {
  const ipcMain = new EventEmitter();
  ipcMain.on('feishu-notify', (_event, payload) => {
    notifier.notify(payload).catch(() => {});
  });
  return ipcMain;
}

// 模拟 renderer 端 send
function rendererSend(ipcMain, channel, payload) {
  ipcMain.emit(channel, { sender: { id: 1 } }, payload);
}

async function testIpcRoutesToNotifier() {
  const calls = [];
  const fakeClient = {
    sendCard: async (args) => { calls.push(args); return { code: 0 }; },
  };
  const notifier = new FeishuNotifier({ client: fakeClient, chatId: 'oc_test' });
  const ipcMain = wireIpcToNotifier(notifier);

  rendererSend(ipcMain, 'feishu-notify', {
    sessionId: 'ipc-A',
    title: 'integration',
    isWaiting: false,
    newlyWaiting: false,
    preview: 'hello',
    timestamp: Date.now(),
  });

  // notify 是 async，等微任务出栈
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(calls.length, 1, 'sendCard called via IPC');
  assert.strictEqual(calls[0].chatId, 'oc_test');
  console.log('  ok ipc routes to notifier');
}

async function testIpcWithoutHandlerNoCrash() {
  // 模拟 main.js 完全不注册 handler 的情况：renderer.send 不会抛
  const ipcMain = new EventEmitter();
  // 没有 .on('feishu-notify', ...)
  assert.doesNotThrow(() => {
    rendererSend(ipcMain, 'feishu-notify', { sessionId: 'orphan' });
  }, 'EventEmitter.emit returns false but does not throw');
  console.log('  ok ipc without handler no crash');
}

(async () => {
  console.log('Running FeishuNotifier IPC integration tests...');
  await testIpcRoutesToNotifier();
  await testIpcWithoutHandlerNoCrash();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 9.2: 运行测试，pass**

Run:
```powershell
node tests/integration-feishu-notifier-ipc.test.js
```

Expected:
```
Running FeishuNotifier IPC integration tests...
  ok ipc routes to notifier
  ok ipc without handler no crash
All passed.
```

- [ ] **Step 9.3: Commit**

```powershell
git add tests/integration-feishu-notifier-ipc.test.js
git commit -m @'
test(feishu): integration test for IPC -> notifier routing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 10：E2E 真实测试脚本

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\e2e-feishu-notifier.js`

按 Hub CLAUDE.md "启动模板 A" + "禁止操作生产 Hub" 铁律。E2E 脚本启动隔离实例，触发真实 turn 完成事件，验证日志 + 让用户人工确认飞书侧到达。

- [ ] **Step 10.1: 写 E2E 脚本**

写入 `tests/e2e-feishu-notifier.js`：

```js
'use strict';

// E2E: 飞书通知端到端真实推送测试
//
// 前置：
//   $env:HUB_FEISHU_APP_ID    = "<真实>"
//   $env:HUB_FEISHU_APP_SECRET = "<真实>"
//   $env:HUB_FEISHU_NOTIFY_CHAT_ID = "<真实 chat_id 或专用 E2E 单聊>"
//   $env:HUB_E2E_FEISHU = "1"   # 显式开关，避免误触
//
// 用法：
//   node tests/e2e-feishu-notifier.js
//
// 流程：
//   1. 用 CLAUDE_HUB_DATA_DIR 起一个隔离 Hub 实例（端口 9221）
//   2. Playwright 通过 CDP 连接，验证 Hub 主窗口启动成功
//   3. 通过 IPC 直接派发一个 fake turn-complete 事件（不依赖真实 Codex 调用）
//   4. 轮询 main 进程 stdout，期望 [feishu-notify] enabled 出现
//   5. 提示用户人工确认飞书侧到达
//   6. 60s 内重复触发 → 期望 [feishu-notify] deduped
//   7. Stop 隔离 Hub

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.env.HUB_E2E_FEISHU !== '1') {
  console.log('Set HUB_E2E_FEISHU=1 to enable this E2E (real Feishu push).');
  process.exit(0);
}

const REQUIRED = ['HUB_FEISHU_APP_ID', 'HUB_FEISHU_APP_SECRET', 'HUB_FEISHU_NOTIFY_CHAT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`Missing env ${k}`);
    process.exit(1);
  }
}

const HUB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), 'hub-feishu-e2e-' + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('Isolated data dir:', DATA_DIR);

const electronExe = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env, {
  CLAUDE_HUB_DATA_DIR: DATA_DIR,
});

const proc = spawn(electronExe, [HUB_DIR, '--remote-debugging-port=9221'], {
  cwd: HUB_DIR,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const seen = { enabled: false, sent: 0, deduped: 0, error: null };
let allLog = '';
proc.stdout.on('data', d => {
  const s = d.toString();
  allLog += s;
  process.stdout.write('[hub-stdout] ' + s);
  if (s.includes('[feishu-notify] enabled')) seen.enabled = true;
  if (s.match(/\[feishu-notify\].*sent/i)) seen.sent++;
  if (s.match(/\[feishu-notify\].*deduped/i)) seen.deduped++;
});
proc.stderr.on('data', d => {
  const s = d.toString();
  allLog += s;
  process.stderr.write('[hub-stderr] ' + s);
  if (s.match(/feishu-notify.*failed|init failed/i)) seen.error = s;
});

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function awaitCondition(label, fn, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(500);
  }
  throw new Error(`Timeout waiting: ${label}`);
}

async function triggerNotifyViaCdp() {
  // CDP 连入第一个 BrowserWindow，runtime.evaluate 调 ipcRenderer.send
  const CDP = require('chrome-remote-interface');
  // 等 CDP 端口起来
  await awaitCondition('cdp ready', () => true /* 由 spawn 后 sleep 兜底 */, 1);
  await sleep(3000);
  const targets = await CDP.List({ port: 9221 });
  // 找第一个 file:// 类型的 target（renderer）
  const renderer = targets.find(t => t.type === 'page' && t.url.startsWith('file://'));
  if (!renderer) throw new Error('renderer target not found');
  const cli = await CDP({ target: renderer.webSocketDebuggerUrl });
  try {
    await cli.Runtime.enable();
    const expr = `
      (function(){
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('feishu-notify', {
          sessionId: 'e2e-sess',
          title: 'E2E test',
          kind: 'codex',
          isWaiting: false,
          newlyWaiting: false,
          waitingText: null,
          preview: 'E2E: 一轮完成测试，请在飞书查收。',
          timestamp: Date.now(),
        });
        return 'sent';
      })()
    `;
    const r = await cli.Runtime.evaluate({ expression: expr, awaitPromise: false });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    console.log('[e2e] ipc dispatched:', r.result.value);
  } finally {
    await cli.close();
  }
}

(async () => {
  try {
    console.log('[e2e] waiting Hub to boot...');
    await awaitCondition('feishu-notify enabled', () => seen.enabled, 30_000);
    console.log('[e2e] feishu-notify init OK');

    console.log('[e2e] firing first IPC...');
    await triggerNotifyViaCdp();
    await sleep(5000);

    if (seen.error) throw new Error('notifier reported error: ' + seen.error);
    console.log('[e2e] PRE-FLIGHT OK');

    console.log('---------------------------------------------------');
    console.log('请在飞书查看是否收到通知卡片');
    console.log('  接收 chat_id:', process.env.HUB_FEISHU_NOTIFY_CHAT_ID);
    console.log('  期望卡片标题: Hub 提醒 · E2E test');
    console.log('  期望状态: ✅ 一轮完成');
    console.log('---------------------------------------------------');
    console.log('15s 后将触发第二次（应被 60s dedupe 拦截，不到达飞书）');
    await sleep(15_000);

    console.log('[e2e] firing second IPC (should be deduped)...');
    await triggerNotifyViaCdp();
    await sleep(3000);
    console.log('[e2e] dedupe count so far:', seen.deduped);

    console.log('---------------------------------------------------');
    console.log('Hub 进程将保持运行 60s，便于你确认飞书第 2 条没到');
    console.log('60s 后再触发第 3 次（应到达）');
    console.log('---------------------------------------------------');
    await sleep(60_000);

    await triggerNotifyViaCdp();
    await sleep(5000);

    console.log('[e2e] DONE. Stopping isolated Hub.');
    console.log('[e2e] Final log path:', path.join(DATA_DIR, 'feishu-notify.log'), '(if dryrun)');
  } catch (err) {
    console.error('[e2e] FAIL:', err.message);
    console.error('[e2e] last 2000 chars of Hub log:\n', allLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    try { proc.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 2000);
  }
})();
```

- [ ] **Step 10.2: 检查依赖**

`chrome-remote-interface` 已被 Hub 用过，确认 package.json：

```powershell
node -e "console.log(require('./package.json').dependencies['chrome-remote-interface'] || require('./package.json').devDependencies['chrome-remote-interface'] || 'MISSING')"
```

如果 `MISSING`：

```powershell
npm install --save-dev chrome-remote-interface
```

注：CLAUDE.md 提醒 "禁止 npm install 在测试副本里"，但**主目录**安装是允许的。

- [ ] **Step 10.3: 真实 E2E 跑一次（用户参与）**

```powershell
$env:HUB_FEISHU_APP_ID    = "<填真实>"
$env:HUB_FEISHU_APP_SECRET = "<填真实>"
$env:HUB_FEISHU_NOTIFY_CHAT_ID = "<填真实 chat_id>"
$env:HUB_E2E_FEISHU = "1"
node tests/e2e-feishu-notifier.js
```

期望：
- 控制台显示 `[feishu-notify] enabled`
- 第 1 次 IPC 后用户在飞书看到一张卡片（**人工确认 ✓**）
- 第 2 次 IPC（15s 后）：飞书无新卡片，控制台显示 `deduped`（**人工确认无新消息 ✓**）
- 第 3 次 IPC（60s 后）：飞书第 2 张卡片到达（**人工确认 ✓**）

如果失败，附 Hub log 末尾 2000 字到 issue。

- [ ] **Step 10.4: Commit E2E 脚本**

```powershell
git add tests/e2e-feishu-notifier.js package.json package-lock.json
git commit -m @'
test(feishu): e2e real-push test via isolated Hub + CDP-driven IPC

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## 完成检查表

- [ ] 11 个单元测试全 pass：`node tests/unit-feishu-notifier.test.js`
- [ ] 2 个集成测试全 pass：`node tests/integration-feishu-notifier-ipc.test.js`
- [ ] Hub smoke test 启动正常（无 chat_id 时静默禁用，无 stack trace）
- [ ] E2E 真实推送 3 个场景通过用户人工验证
- [ ] 验收标准对照 spec：
  - [ ] 配置全：每次完成一轮 60s 内首条到达 ✓
  - [ ] 配置全：60s 内重复合并 ✓
  - [ ] 配置全：60s 后再发 ✓
  - [ ] 配置全：newlyWaiting 立即推 ✓
  - [ ] 配置缺：Hub 启动正常 ✓
  - [ ] API 失败不阻塞 ✓
  - [ ] dry-run 模式日志 ✓
  - [ ] 与现有 feishu-codex-gateway 不互扰（手工确认即可，gateway 仍按原逻辑工作）
