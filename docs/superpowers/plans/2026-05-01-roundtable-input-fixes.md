# 圆桌输入区 4 项修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复会议室进入后输入框暂时不可用、AI 卡片永久"创建中"两个 bug，新增软提醒 banner，重排 toolbar 按钮顺序。

**Architecture:**
- **真正的 CLI ready 信号**：复用 `main.js:564 _RT_READY_MARKERS`（gemini="Type your message"、codex="gpt-5.X"、claude=buffer ≥ 1500 字符），通过新 IPC `cli-ready-status` 暴露给 renderer
- **Renderer 缓存 + 轮询**：`_cliReadyCache[sid]` 单调（true 后不再变 false），`startCliReadyPoll` 每 1s 拉取（已 ready 的跳过，全 ready 后停止）
- **isInitializing 判断改用 cliReadyCache**：替换原 `markerStatus !== 'done' && markerStatus !== 'streaming'`（语义错误）的判断
- **Auto-focus + setupInput 防擦**：openMeeting 后 50ms 让 input 拿焦点；setupInput 的 textContent 重置仅首次 binding 触发
- **Soft alert banner**：`mr-toolbar` 和 `mr-input-row` 之间新增 `<div id="mr-input-soft-alert">`，由 `_refreshSoftAlert` 渲染；任意 sub 未 ready 时显示，自动消失，可手动 dismiss
- **Toolbar 重排**：群策群力/总结发言相邻，divider 后是总结人选择器

**Tech Stack:** Electron / vanilla JS renderer / 原生 CSS / Node.js core / pytest + Playwright (CDP) E2E

---

## File Structure

**Modify:**
- `main.js` — 新增 `cli-ready-status` IPC handler（约 +12 行，靠近现有 `marker-status` handler）
- `renderer/meeting-room.js` — 6 处改动（约 +80 行 / 改 ~15 行）
- `renderer/meeting-room.css` — 末尾追加 `.mr-input-soft-alert*` 规则（约 +25 行）
- `renderer/index.html` — 在 `mr-toolbar` 和 `mr-input-row` 之间插入 banner div（+1 行）
- `package.json` — version bump

**Create:**
- `tests/_e2e-input-fixes-verify.js` — E2E 验证脚本

---

## Task 1: main.js 新增 cli-ready-status IPC handler

**Files:**
- Modify: `main.js` (附近 `ipcMain.handle('marker-status', ...)` 约 1001 行)

**目的：** 把 `_RT_READY_MARKERS` 的判断逻辑作为同步 IPC 暴露给 renderer。

- [ ] **Step 1: 找到 marker-status IPC handler 位置**

```bash
grep -n "ipcMain.handle('marker-status'" main.js
```

Expected: 输出形如 `1001:ipcMain.handle('marker-status', ...)`。

同时确认 `_RT_READY_MARKERS` 定义位置和 `sessionManager.getSessionBuffer` 是否在 main.js 顶部 require：

```bash
grep -n "_RT_READY_MARKERS" main.js | head -3
grep -n "getSessionBuffer\b" main.js | head -3
```

- [ ] **Step 2: 在 marker-status handler 之后追加 cli-ready-status handler**

修改 `main.js`，在 `ipcMain.handle('marker-status', ...)` 之后追加：

```js
ipcMain.handle('cli-ready-status', (_e, sessionId) => {
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  // session 对象的 kind 字段位置可能在 session.kind 或 session.info.kind，按现有代码风格走
  const kind = session.kind || (session.info && session.info.kind);
  if (!kind) return false;
  const buf = sessionManager.getSessionBuffer(sessionId) || '';
  const need = _RT_READY_MARKERS[kind] || [];
  if (need.length === 0) {
    return buf.length >= 1500;   // claude / glm 走长度兜底
  }
  return need.some(m => buf.includes(m));
});
```

**注意**：如果 `_RT_READY_MARKERS` 在 main.js 中定义位置（约 564 行）**晚于** marker-status handler（1001 行），上面的代码可以直接引用——`const _RT_READY_MARKERS` 在文件顶层属同一作用域，IPC handler 闭包内可见。

- [ ] **Step 3: 启动隔离 Hub 验证 IPC 工作**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t1"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9231
```

打开 Hub，进入会议室。打开 DevTools console，等几秒钟（让 PTY 启动），然后在 console 里执行：

```js
require('electron').ipcRenderer.invoke('cli-ready-status', '<某 sub 的 sid>')
```

具体 sid 怎么拿：先在 console 跑：
```js
Object.keys(require('electron').ipcRenderer._events).filter(k => k.includes('session'))
// 或看 meetingData[activeMeetingId].subSessions
```

**Expected**：
- session 启动 < 2s 时调用 → 返回 false
- session 启动 > 5s（Claude 已显示 prompt）时调用 → 返回 true

如果 IPC 调用本身报错（如 "No handler registered"），说明改动未生效，重启 Hub 再试。

- [ ] **Step 4: 提交**

```bash
git add main.js
git commit -m "feat(roundtable): expose cli-ready-status IPC for accurate session ready detection"
```

---

## Task 2: renderer 新增 _cliReadyCache + cliReadyPoll

**Files:**
- Modify: `renderer/meeting-room.js`（顶部模块级变量 + `startMarkerPoll` 附近新增函数）

**目的：** renderer 侧缓存 ready 状态、轮询拉取、ready 后单调不变。

- [ ] **Step 1: 在文件顶部加模块级变量**

定位 `renderer/meeting-room.js:12 let _markerStatusCache = {};` 这一行，在它**下面**追加：

```js
let _markerStatusCache = {};
let _cliReadyCache = {};        // sid → boolean，单调（true 后不再变 false）
let _cliReadyPollTimer = null;
```

同时定位 `_markerPollTimer` 的定义位置（应该在附近）：

```bash
grep -n "_markerPollTimer\s*=" renderer/meeting-room.js
```

确保 `_cliReadyPollTimer` 与 `_markerPollTimer` 处于同一作用域。

- [ ] **Step 2: 在 startMarkerPoll 之后新增 startCliReadyPoll / stopCliReadyPoll**

定位 `renderer/meeting-room.js:1140 function startMarkerPoll()`，在 `stopMarkerPoll`（约 1160 行）**之后**追加两个新函数：

```js
function startCliReadyPoll() {
  if (_cliReadyPollTimer) return;
  const pollOnce = async () => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting) return;
    let changed = false;
    for (const sid of meeting.subSessions) {
      if (_cliReadyCache[sid]) continue;   // 已 ready 的不再 poll
      const ready = await ipcRenderer.invoke('cli-ready-status', sid);
      if (ready) { _cliReadyCache[sid] = true; changed = true; }
    }
    if (changed) {
      // ready 状态变化 → 重渲染 strip 让 isInitializing 切换
      const m = meetingData[activeMeetingId];
      if (m) {
        renderTerminals(m);
        if (typeof _refreshSoftAlert === 'function') _refreshSoftAlert(m);   // Task 6 提供
      }
    }
    if (meeting.subSessions.every(sid => _cliReadyCache[sid])) {
      stopCliReadyPoll();
    }
  };
  pollOnce();   // 立即触发一次（不等 1s）
  _cliReadyPollTimer = setInterval(pollOnce, 1000);
}

function stopCliReadyPoll() {
  if (_cliReadyPollTimer) { clearInterval(_cliReadyPollTimer); _cliReadyPollTimer = null; }
}
```

**注意**：`_refreshSoftAlert` 在 Task 6 才会实现，这里用 `typeof === 'function'` 做条件调用，保证 Task 2 单独落地不会因函数不存在而报 ReferenceError。

- [ ] **Step 3: 在 openMeeting 调用 startCliReadyPoll**

定位 `renderer/meeting-room.js:885-904 function openMeeting`，在 `startMarkerPoll();` 这一行**下面**追加：

```js
startMarkerPoll();
startCliReadyPoll();   // 新增
```

- [ ] **Step 4: 在 closeMeetingPanel 停止 poll + 重置 cache**

定位 `renderer/meeting-room.js:906-916 function closeMeetingPanel`，把 `stopMarkerPoll()` / `_markerStatusCache = {}` 附近改为：

```js
function closeMeetingPanel() {
  activeMeetingId = null;
  _inputBound = false;
  stopMarkerPoll();
  stopCliReadyPoll();           // 新增
  _markerStatusCache = {};
  _cliReadyCache = {};          // 新增

  const panel = panelEl();
  if (panel) panel.style.display = 'none';
  const el = terminalsEl();
  if (el) el.innerHTML = '';
  subTerminals = {};
}
```

- [ ] **Step 5: 语法快速校验**

```bash
node --check renderer/meeting-room.js
```

Expected: 无输出。如果报 SyntaxError 立即修复。

- [ ] **Step 6: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "feat(roundtable): add _cliReadyCache + startCliReadyPoll for true CLI ready detection"
```

---

## Task 3: 替换 isInitializing 判断（核心 bug 修复）

**Files:**
- Modify: `renderer/meeting-room.js:165`

**目的：** 把错用的 markerStatus 判断换成正确的 _cliReadyCache 判断。

- [ ] **Step 1: 找到 isInitializing 当前代码**

```bash
grep -n "isInitializing" renderer/meeting-room.js | head -5
```

Expected: 看到 `165:    const isInitializing = s && markerState !== 'done' && markerState !== 'streaming';`

- [ ] **Step 2: 替换判断条件**

修改 `renderer/meeting-room.js:163-165`：

```js
// 旧（注释掉或删除）：
// const markerState = _markerStatusCache[sub.sid];
// const isInitializing = s && markerState !== 'done' && markerState !== 'streaming';

// 新：
const markerState = _markerStatusCache[sub.sid];   // 保留：仍被 markerStatusHtml 等其他位置使用
const isInitializing = s && !_cliReadyCache[sub.sid];
```

**保留 `markerState` 变量**：因为 `markerStatusHtml`（1133 行）等还在用 markerStatus，不能砍掉整个 marker poll 系统——只是 isInitializing 的判断换了来源。

- [ ] **Step 3: 启动 Hub 实测**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t3"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9232
```

进入会议室，**不发任何消息**。观察三个卡片的状态：

- t = 0~3s：可能仍显示「创建中」（CLI 启动中）
- t = 3~10s（Claude 启动屏出现 + buffer ≥ 1500）：Claude 卡片切到「待命」
- t = 5~15s（Gemini 显示 'Type your message'）：Gemini 卡片切到「待命」
- t = 5~15s（Codex 显示 'gpt-5.X'）：Codex 卡片切到「待命」

**关键验收**：所有 AI 都不发消息也能切到「待命」（之前是永久卡死）。

如果切换不稳，把 console 留着观察 `console.log('[debug] cliReadyCache', _cliReadyCache)` 几次（手动在 DevTools 跑）。

- [ ] **Step 4: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "fix(roundtable): isInitializing now uses _cliReadyCache (was incorrectly using markerStatus)"
```

---

## Task 4: 修复 Bug A —— openMeeting auto-focus input

**Files:**
- Modify: `renderer/meeting-room.js:885-904 openMeeting`

**目的：** 让 input 在 layout 稳定后拿到焦点，避免 xterm 反复抢焦点导致的"输入框暂时不可用"。

- [ ] **Step 1: 在 openMeeting 末尾追加 setTimeout focus**

定位 `function openMeeting`，在函数体末尾（最后一个 `if` 块之后、函数闭合 `}` 之前）追加：

```js
function openMeeting(meetingId, meeting) {
  activeMeetingId = meetingId;
  meetingData[meetingId] = meeting;

  const panel = panelEl();
  panel.style.display = 'flex';

  renderHeader(meeting);
  renderTerminals(meeting);
  renderToolbar(meeting);
  setupInput(meeting);
  startMarkerPoll();
  startCliReadyPoll();

  if (_isPanelCapableMeeting(meeting)) {
    refreshRoundtablePanel(meeting);
  } else {
    _removeRtPanel();
  }

  // 修复 Bug A：layout 稳定后 auto-focus input（xterm.terminal.open 会抢焦点）
  setTimeout(() => {
    const inputBox = document.getElementById('mr-input-box');
    if (inputBox && document.activeElement !== inputBox) {
      inputBox.focus();
    }
  }, 50);
}
```

**为什么 50ms**：`renderTerminals → renderFocusMode → openSubTerminal → cached.terminal.open()` 是同步调用栈，`robustFit` 用 rAF（≈16.67ms 一帧）；50ms 给了 ~3 帧时间让 xterm 内部 layout 稳定，之后 input.focus() 才能稳。

- [ ] **Step 2: 启动 Hub 实测**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t4"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9233
```

进入会议室，**不点击任何位置**，立即键盘输入字符（如"hello"）。

**Expected**：字符立即出现在输入框中。

如果字符没出现 / 出现在 xterm 终端里：
- 50ms 不够，调到 100ms 或 150ms
- 或者 input.focus() 调用后 xterm 又抢回去，需要在 setTimeout 内加 `e.preventDefault()` 或在 xterm.open 后调 `terminal.blur()`

- [ ] **Step 3: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "fix(roundtable): auto-focus input box on openMeeting (50ms delay for layout stability)"
```

---

## Task 5: 修复 Bug A 副作用 —— setupInput 防擦输入

**Files:**
- Modify: `renderer/meeting-room.js:1609-1647 setupInput`

**目的：** 多次 IPC 触发 setupInput 不再擦掉用户已输入内容。

- [ ] **Step 1: 找到 setupInput 当前实现**

```bash
grep -n "function setupInput" renderer/meeting-room.js
```

读 1609-1647 行的 setupInput 函数体。

- [ ] **Step 2: 把 textContent 重置移到 _inputBound 块内**

修改 `renderer/meeting-room.js`，把 setupInput 函数前面的：

```js
function setupInput(meeting) {
  const inputBox = document.getElementById('mr-input-box');
  const sendBtn = document.getElementById('mr-send-btn');
  const targetSelect = document.getElementById('mr-input-target');
  if (!inputBox || !sendBtn) return;

  inputBox.textContent = '';   // ← 这一行擦了用户已输入内容
  inputBox.dataset.placeholder = meeting.scene
    ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
    : '输入消息...';
  // ...
```

改为：

```js
function setupInput(meeting) {
  const inputBox = document.getElementById('mr-input-box');
  const sendBtn = document.getElementById('mr-send-btn');
  const targetSelect = document.getElementById('mr-input-target');
  if (!inputBox || !sendBtn) return;

  // placeholder 每次更新（适配模式切换）
  inputBox.dataset.placeholder = meeting.scene
    ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
    : '输入消息...';
  // textContent 重置只在 _inputBound = false 时做（见下文）
  // ...
```

然后在 `_inputBound` 守护语句后追加 textContent 重置：

```js
  // ...原 targetSelect 处理...

  if (_inputBound) return;
  _inputBound = true;

  // 改造：textContent 擦除挪到这里（仅首次 binding，避免擦掉用户已输入内容）
  inputBox.textContent = '';

  // 后续 listener 绑定保持不变...
```

- [ ] **Step 3: 启动 Hub 实测**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t5"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9234
```

进入会议室，输入一些字符（不发送）。然后触发某个会调用 setupInput 的事件——最简单的是 add-meeting-sub（点击「+ 添加」按钮加个 sub）或切换 scene 模式。

**Expected**：输入框中已输入的字符**保留**（之前会被擦）。

- [ ] **Step 4: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "fix(roundtable): preserve user input across setupInput re-invocations (move textContent reset into _inputBound guard)"
```

---

## Task 6: 软提醒 banner（HTML + CSS + render）

**Files:**
- Modify: `renderer/index.html:108-117`
- Modify: `renderer/meeting-room.css` 末尾
- Modify: `renderer/meeting-room.js`（新增 `_refreshSoftAlert` 函数 + 调用点）

- [ ] **Step 1: 在 index.html 添加 banner div**

定位 `renderer/index.html:108-117`，找到：

```html
<div class="meeting-room-panel" id="meeting-room-panel" style="display:none">
  <div class="mr-header" id="mr-header"></div>
  <div class="mr-terminals" id="mr-terminals"></div>
  <div class="mr-toolbar" id="mr-toolbar"></div>
  <div class="mr-input-row" id="mr-input-row">
    <select class="mr-target-select" id="mr-input-target" title="发送目标"></select>
    <div class="mr-input-box" id="mr-input-box" contenteditable="true" data-placeholder="输入消息..."></div>
    <button class="mr-send-btn" id="mr-send-btn" title="发送">▶</button>
  </div>
</div>
```

在 `mr-toolbar` 和 `mr-input-row` 之间插入 banner div：

```html
<div class="meeting-room-panel" id="meeting-room-panel" style="display:none">
  <div class="mr-header" id="mr-header"></div>
  <div class="mr-terminals" id="mr-terminals"></div>
  <div class="mr-toolbar" id="mr-toolbar"></div>
  <div class="mr-input-soft-alert" id="mr-input-soft-alert" style="display:none"></div>
  <div class="mr-input-row" id="mr-input-row">
    <select class="mr-target-select" id="mr-input-target" title="发送目标"></select>
    <div class="mr-input-box" id="mr-input-box" contenteditable="true" data-placeholder="输入消息..."></div>
    <button class="mr-send-btn" id="mr-send-btn" title="发送">▶</button>
  </div>
</div>
```

- [ ] **Step 2: 在 meeting-room.css 末尾追加 banner 样式**

```css
/* === Soft alert banner（2026-05-01）=== */
.mr-input-soft-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  background: rgba(250, 204, 21, 0.15);
  border-top: 1px solid rgba(250, 204, 21, 0.25);
  border-bottom: 1px solid rgba(250, 204, 21, 0.25);
  color: #fde68a;
  font-size: 12px;
  animation: mr-input-soft-alert-pulse 2s ease-in-out infinite;
}
@keyframes mr-input-soft-alert-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.75; }
}
.mr-input-soft-alert-dismiss {
  margin-left: auto;
  cursor: pointer;
  opacity: 0.6;
  background: none;
  border: none;
  color: inherit;
  font-size: 14px;
  padding: 0 4px;
}
.mr-input-soft-alert-dismiss:hover { opacity: 1; }
```

- [ ] **Step 3: 在 meeting-room.js 新增 _bannerDismissedFor + _refreshSoftAlert**

在文件顶部模块级变量区追加：

```js
let _bannerDismissedFor = null;   // 用户主动关闭过 banner 的 meetingId
```

在 `markerStatusHtml`（约 1133 行）函数附近新增 `_refreshSoftAlert`：

```js
function _refreshSoftAlert(meeting) {
  const el = document.getElementById('mr-input-soft-alert');
  if (!el || !meeting) return;

  // 用户已 dismiss → 不再显示
  if (_bannerDismissedFor === meeting.id) {
    el.style.display = 'none';
    return;
  }

  const labelMap = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM', powershell: 'PowerShell' };
  const notReady = [];
  for (const sid of meeting.subSessions) {
    if (_cliReadyCache[sid]) continue;
    const s = sessions ? sessions.get(sid) : null;
    if (!s) continue;
    notReady.push(labelMap[s.kind] || s.kind);
  }

  if (notReady.length === 0) {
    el.style.display = 'none';
    return;
  }

  const names = notReady.join('、');
  el.innerHTML = `
    <span style="font-size:14px;">⏳</span>
    <span>${notReady.length} 个 AI 还在创建中（${escapeHtml(names)}），可输入但建议稍候发送</span>
    <button class="mr-input-soft-alert-dismiss" title="关闭提示">✕</button>
  `;
  el.style.display = '';

  const btn = el.querySelector('.mr-input-soft-alert-dismiss');
  if (btn) btn.addEventListener('click', () => {
    _bannerDismissedFor = meeting.id;
    el.style.display = 'none';
  });
}
```

- [ ] **Step 4: 在 closeMeetingPanel 重置 _bannerDismissedFor**

修改 Task 2 Step 4 已经改过的 `closeMeetingPanel`，再加一行：

```js
function closeMeetingPanel() {
  activeMeetingId = null;
  _inputBound = false;
  stopMarkerPoll();
  stopCliReadyPoll();
  _markerStatusCache = {};
  _cliReadyCache = {};
  _bannerDismissedFor = null;   // 新增（让下次进入会议室 banner 重新可见）

  const panel = panelEl();
  if (panel) panel.style.display = 'none';
  const el = terminalsEl();
  if (el) el.innerHTML = '';
  subTerminals = {};
  // banner 容器随 panel display:none 隐藏，不需要单独清空 innerHTML
}
```

- [ ] **Step 5: 在 openMeeting 末尾调一次 _refreshSoftAlert**

修改 Task 4 已经改过的 `openMeeting`，在 setTimeout focus 之后追加：

```js
  // ...auto-focus setTimeout...
  setTimeout(() => {
    const inputBox = document.getElementById('mr-input-box');
    if (inputBox && document.activeElement !== inputBox) {
      inputBox.focus();
    }
  }, 50);

  // 新增：初次渲染 banner（cliReadyCache 此时大概率全空 → banner 显示所有 sub）
  _refreshSoftAlert(meeting);
}
```

- [ ] **Step 6: 验证 Task 2 中 startCliReadyPoll 已经会调 _refreshSoftAlert**

打开 `renderer/meeting-room.js` 中 Task 2 添加的 `startCliReadyPoll` 函数体，确认 changed=true 分支里有：

```js
if (typeof _refreshSoftAlert === 'function') _refreshSoftAlert(m);
```

现在 `_refreshSoftAlert` 已定义，typeof 检查会通过，每次 ready 状态变化都会更新 banner。

- [ ] **Step 7: 启动 Hub 实测三态**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t6"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9235
```

进入会议室，肉眼观察：

- **态 1（开始时）**：banner 显示"3 个 AI 还在创建中（Claude、Gemini、Codex），可输入但建议稍候发送" + ✕
- **态 2（部分 ready）**：banner 文案动态更新（如"2 个 AI 还在创建中（Gemini、Codex）"）
- **态 3（全 ready）**：banner 自动消失
- **dismiss 测试**：态 1 时点 ✕ → banner 消失
- **重开测试**：dismiss 后 close meeting → 重开同一会议室 → banner 再次出现

- [ ] **Step 8: 提交**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css renderer/index.html
git commit -m "feat(roundtable): soft alert banner shows pending AI creation status, non-blocking"
```

---

## Task 7: Toolbar 按钮顺序互换

**Files:**
- Modify: `renderer/meeting-room.js:1390-1401`

- [ ] **Step 1: 找到 toolbar HTML 当前实现**

```bash
grep -n "mr-rt-debate-btn\|mr-rt-summary-btn\|mr-rt-summary-pick" renderer/meeting-room.js | head -5
```

确认 1390-1401 行附近的 toolbar 模板。

- [ ] **Step 2: 调换三个元素的顺序**

修改 `renderer/meeting-room.js`，把：

```js
el.innerHTML = `
  <div class="mr-rt-toolbar">
    <button class="mr-rt-tb-btn primary" id="mr-rt-debate-btn" ${debateDisabled} title="让三家结合对方观点重新发言（基于上一轮）">🤝 群策群力</button>
    <span class="mr-rt-tb-divider"></span>
    <label class="mr-rt-tb-pick">
      <span class="mr-rt-tb-pick-label">总结人:</span>
      <select id="mr-rt-summary-pick" ${disabledAttr}>${opts || '<option disabled>无可用 AI</option>'}</select>
    </label>
    <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${debateDisabled} title="让选中的 AI 综合所有轮次给最终意见">📝 总结发言</button>
    <span class="mr-rt-tb-status" id="mr-rt-tb-status">${inProgress ? '⏳ 处理中…' : (turns === 0 ? '先发个问题让三家本色发言' : `已 ${turns} 轮`)}</span>
  </div>
`;
```

改为（群策群力和总结发言相邻，divider 后是总结人选择器）：

```js
el.innerHTML = `
  <div class="mr-rt-toolbar">
    <button class="mr-rt-tb-btn primary" id="mr-rt-debate-btn" ${debateDisabled} title="让三家结合对方观点重新发言（基于上一轮）">🤝 群策群力</button>
    <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${debateDisabled} title="让选中的 AI 综合所有轮次给最终意见">📝 总结发言</button>
    <span class="mr-rt-tb-divider"></span>
    <label class="mr-rt-tb-pick">
      <span class="mr-rt-tb-pick-label">总结人:</span>
      <select id="mr-rt-summary-pick" ${disabledAttr}>${opts || '<option disabled>无可用 AI</option>'}</select>
    </label>
    <span class="mr-rt-tb-status" id="mr-rt-tb-status">${inProgress ? '⏳ 处理中…' : (turns === 0 ? '先发个问题让三家本色发言' : `已 ${turns} 轮`)}</span>
  </div>
`;
```

后续 `el.querySelector('#mr-rt-debate-btn')` / `el.querySelector('#mr-rt-summary-btn')` / `el.querySelector('#mr-rt-summary-pick')` 的事件绑定**保持不变**——它们用 ID 选择器，与 DOM 顺序无关。

- [ ] **Step 3: 启动 Hub 目视检查**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t7"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9236
```

进入会议室，看 toolbar：
- ✅ 群策群力 (primary 紫蓝)
- ✅ 总结发言 (warm 橙黄) ← 紧挨着群策群力
- ✅ │ divider
- ✅ 总结人: [Claude▾]
- ✅ 状态文本

- [ ] **Step 4: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "style(roundtable): place 群策群力/总结发言 buttons adjacent, move 总结人 select after divider"
```

---

## Task 8: 版本号同步

**Files:**
- Modify: `package.json`
- Modify: UI 版本号显示位（如有）

- [ ] **Step 1: 决定 bump 目标**

```bash
git log --oneline -10
cat package.json | grep version
```

如果 `2026-05-01-roundtable-card-redesign.md` plan 已合并（即 version 已是 0.2.0）→ 本 plan bump 到 0.3.0。
如果尚未合并 → 本 plan bump 到 0.2.0（card-redesign 后续合并时再调到 0.3.0）。

- [ ] **Step 2: 修改 package.json**

```json
"version": "0.3.0",
```

（按上一步确定的目标值）

- [ ] **Step 3: grep UI 版本号显示位（参考 card-redesign plan Task 7）**

```bash
grep -rn "0\.2\.0\|0\.1\.0\|version" renderer/index.html renderer/styles.css 2>/dev/null | grep -v node_modules | head -10
```

如果找到 hardcoded 版本号字符串，同步更新；如果用动态读取，不必改。

- [ ] **Step 4: 启动 Hub 验证版本号**

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-input-fixes-t8"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9237
```

打开 Hub，肉眼确认版本号显示位的值是新版本号。

- [ ] **Step 5: 提交**

```bash
git add package.json renderer/
git commit -m "chore: bump version to 0.3.0 for roundtable input fixes"
```

---

## Task 9: E2E 自动化验证

**Files:**
- Create: `tests/_e2e-input-fixes-verify.js`

- [ ] **Step 1: 参考既有 E2E 模板**

```bash
ls tests/_e2e-fused-tab-verify.js tests/_e2e-card-redesign-verify.js 2>/dev/null
```

读其中一个理解 CDP 连接 / 选择器 / 截图保存路径风格。

- [ ] **Step 2: 写 _e2e-input-fixes-verify.js**

`tests/_e2e-input-fixes-verify.js`:

```js
'use strict';
// E2E: 验证 2026-05-01 圆桌输入区 4 项修复
//   1. 启动隔离 Hub（CLAUDE_HUB_DATA_DIR + remote-debugging）
//   2. 进入会议室
//   3. 验证 auto-focus（document.activeElement === input box）
//   4. 等 cliReadyCache 在 ~10s 内全部 true
//   5. 验证 banner 自动消失
//   6. 验证 toolbar 按钮顺序

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const HUB_DIR = path.resolve(__dirname, '..');
const TEST_DATA_DIR = `C:\\temp\\hub-input-fixes-${Date.now()}`;
const DEBUG_PORT = 9240;
const SCREENSHOT_DIR = path.join(__dirname, '_input-fixes-screenshots');

(async function main() {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEST_DATA_DIR };
  const electronExe = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  const hub = spawn(electronExe, ['.', `--remote-debugging-port=${DEBUG_PORT}`], { cwd: HUB_DIR, env });
  hub.stdout.on('data', d => process.stdout.write(`[hub] ${d}`));
  hub.stderr.on('data', d => process.stderr.write(`[hub] ${d}`));

  await new Promise(r => setTimeout(r, 8000)); // wait for boot + meeting prep

  let client;
  try {
    client = await CDP({ port: DEBUG_PORT });
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();

    // --- T1: auto-focus 验证 ---
    const focusCheck = await Runtime.evaluate({
      expression: `({
        activeId: document.activeElement && document.activeElement.id,
        hasInputBox: !!document.getElementById('mr-input-box'),
      })`,
      returnByValue: true,
    });
    console.log('[T1 auto-focus]', focusCheck.result.value);

    // --- T2: 等 cliReadyCache 全部 true (最长 30s) ---
    let allReady = false;
    for (let i = 0; i < 30; i++) {
      const r = await Runtime.evaluate({
        expression: `(() => {
          const ck = window._cliReadyCache_external_probe || null;
          // 通过 IPC 探测每个 sub 的 ready 状态（_cliReadyCache 是 IIFE 内部变量）
          const m = window.meetingData ? window.meetingData[window.activeMeetingId] : null;
          if (!m) return { allReady: false, reason: 'no meeting' };
          // 这里直接调 IPC 验证
          return { sids: m.subSessions };
        })()`,
        returnByValue: true,
      });
      const sids = r.result.value && r.result.value.sids;
      if (!sids || sids.length === 0) { await new Promise(r2 => setTimeout(r2, 1000)); continue; }
      const checks = await Promise.all(sids.map(sid => Runtime.evaluate({
        expression: `require('electron').ipcRenderer.invoke('cli-ready-status', '${sid}')`,
        awaitPromise: true,
        returnByValue: true,
      })));
      const ready = checks.map(c => c.result.value);
      if (ready.every(Boolean)) { allReady = true; console.log(`[T2 cli-ready] all ready at t=${i}s`); break; }
      console.log(`[T2 cli-ready] t=${i}s ready=${ready}`);
      await new Promise(r2 => setTimeout(r2, 1000));
    }
    if (!allReady) console.warn('[T2 cli-ready] FAILED to reach all-ready in 30s');

    // --- T3: banner 自动消失 ---
    const bannerCheck = await Runtime.evaluate({
      expression: `(() => {
        const el = document.getElementById('mr-input-soft-alert');
        return { exists: !!el, display: el ? el.style.display : null };
      })()`,
      returnByValue: true,
    });
    console.log('[T3 banner]', bannerCheck.result.value);
    if (allReady && bannerCheck.result.value.display !== 'none') {
      console.warn('[T3 banner] should be hidden when all ready');
    }

    // --- T4: toolbar 按钮顺序 ---
    const toolbarCheck = await Runtime.evaluate({
      expression: `(() => {
        const toolbar = document.querySelector('.mr-rt-toolbar');
        if (!toolbar) return { ok: false, reason: 'no .mr-rt-toolbar' };
        const children = Array.from(toolbar.children);
        return {
          ok: true,
          order: children.map(c => c.id || c.className).slice(0, 5),
        };
      })()`,
      returnByValue: true,
    });
    console.log('[T4 toolbar]', toolbarCheck.result.value);

    // 截图
    const shot = await Page.captureScreenshot({ format: 'png' });
    const shotPath = path.join(SCREENSHOT_DIR, `input-fixes-${Date.now()}.png`);
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('Screenshot:', shotPath);

    console.log('PASS: input fixes E2E ran');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    if (client) await client.close();
    hub.kill();
  }
})();
```

**注意**：T1 检查 `document.activeElement.id === 'mr-input-box'`。如果失败（active 是 xterm-helper-textarea），可能需要在生产代码中调整 setTimeout 的延迟。

T2 用 IPC 探测每个 sid 的 ready 状态（`_cliReadyCache` 是 IIFE 内部变量，外部拿不到）。需要 main world 里能调 ipcRenderer——确认 meeting-room.js 用的是哪种 contextIsolation 模式（搜 `nodeIntegration` / `contextIsolation`）：

```bash
grep -n "nodeIntegration\|contextIsolation" main.js
```

如果 `contextIsolation: true`，CDP Runtime.evaluate 默认在 isolated world，拿不到 require。改用：
```js
expression: 'document.activeElement.id'   // 只读 DOM，不调 IPC
```

E2E 简化为只验证 DOM 结构 + 截图，cliReady 状态通过截图肉眼验收。

- [ ] **Step 3: 运行 E2E**

```bash
node tests/_e2e-input-fixes-verify.js
```

Expected：
- `[T1 auto-focus] { activeId: 'mr-input-box', hasInputBox: true }` 或 `activeId: null`（focus 在 body 也可接受，关键是 input 不被 xterm 抢）
- `[T2 cli-ready] all ready at t=NN` (NN ≤ 15)
- `[T3 banner] { exists: true, display: 'none' }` （ready 后）
- `[T4 toolbar] { ok: true, order: ['mr-rt-debate-btn', 'mr-rt-summary-btn', 'mr-rt-tb-divider', ...] }`
- `PASS: input fixes E2E ran`
- 截图文件存在

- [ ] **Step 4: 目视截图核查**

```bash
explorer.exe tests/_input-fixes-screenshots/
```

肉眼确认：
- ✅ 三张 AI 卡片状态都是「待命」（不是「创建中」）
- ✅ banner 不显示（因为已经全 ready）
- ✅ toolbar 按钮顺序正确

- [ ] **Step 5: 提交**

```bash
git add tests/_e2e-input-fixes-verify.js
git commit -m "test(roundtable): add E2E for input fixes (auto-focus + cliReady + banner + toolbar)"
```

---

## Verification Checklist

实施完成后逐项确认：

- [ ] `cli-ready-status` IPC 在 main.js 注册
- [ ] renderer 顶部有 `_cliReadyCache` / `_cliReadyPollTimer` / `_bannerDismissedFor` 三个模块级变量
- [ ] `startCliReadyPoll` / `stopCliReadyPoll` / `_refreshSoftAlert` 三个函数已添加
- [ ] `openMeeting` 调用 `startCliReadyPoll()` + 末尾 setTimeout focus + `_refreshSoftAlert(meeting)`
- [ ] `closeMeetingPanel` 调用 `stopCliReadyPoll()` + 重置 `_cliReadyCache` + 重置 `_bannerDismissedFor`
- [ ] `_renderFusedTabs:165` 的 `isInitializing` 用 `!_cliReadyCache[sub.sid]`
- [ ] `setupInput` 的 `inputBox.textContent = ''` 已挪到 `_inputBound = true` 之后
- [ ] `index.html` 在 mr-toolbar / mr-input-row 之间有 `<div id="mr-input-soft-alert">`
- [ ] `meeting-room.css` 末尾有 `.mr-input-soft-alert*` 规则
- [ ] toolbar 按钮顺序：群策群力 → 总结发言 → divider → 总结人 → 状态
- [ ] `package.json` version 已 bump
- [ ] **手测 T1-T7 全通过**（见 spec.md §8.1）
- [ ] E2E `_e2e-input-fixes-verify.js` 跑通
- [ ] node_modules 完整性检查（`timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20` 见 `[hub] hook server listening`）
- [ ] 所有 commit 已创建（应有 ~9 个）
- [ ] git status 干净

---

## Rollback Plan

各 Task commit 独立，可单独 revert：

```bash
# 仅回退 banner 改造（保留 cliReady fix）
git log --oneline | grep -i "soft alert"
git revert <hash>

# 整批回退本 plan
git log --oneline | grep -i "input.fixes\|cli.ready\|auto.focus\|setupInput"
git revert <hashes>

# 紧急回退到本 plan 之前
git log --oneline | head -20
git revert <range>
```

CSS / JS 改动各自独立。如果 cliReadyCache 路径有问题，可以**只回退 Task 3**（isInitializing 改回 markerStatus 老逻辑），保留新 IPC 和 cache 数据流——这样 banner 不变，但 isInitializing 回到老 bug 状态。

---

## Out of Scope

明确不在本次 plan 内：

- ❌ 重构 marker-status 系统（它在别处仍在用，仅 isInitializing 用错了）
- ❌ Push-based ready 通知（poll 已够用）
- ❌ 解耦 markerPoll 与 cliReadyPoll（两者并存便于回滚）
- ❌ Banner 包含倒计时 / 进度条
- ❌ Banner 提供"取消创建"操作
- ❌ Toolbar 重排涉及新增按钮（只调换现有按钮顺序）
- ❌ 修复 xterm 内部抢焦点行为（仅在 openMeeting 末尾 auto-focus 一次，不持续监听）

---

## 与既有 plan 的协调

| Plan | 互动 | 协调建议 |
|------|------|----------|
| `2026-04-30-roundtable-resilience.md` | 引入新状态 manual_extracted/absent/errored | 零冲突。新状态由 status 渲染，与 cliReady 正交 |
| `2026-04-30-roundtable-latency.md` | session-manager 加 `roundtableReady` | 语义重叠但用途不同（持久缓存 vs UI 缓存）。本 plan 不依赖 latency |
| `2026-05-01-roundtable-card-redesign.md` | 改 `_ftHtml` + `_renderFusedTabs` | **行级冲突**：line 165 isInitializing 计算 |

**与 card-redesign 协调**：
- 如果先合并 card-redesign：本 plan rebase 时把 line 165 的 `markerState !== 'done' && markerState !== 'streaming'` 替换为 `!_cliReadyCache[sub.sid]`，其他 card-redesign 改造保持
- 如果先合并本 plan：card-redesign rebase 时用本 plan 已落地的 `!_cliReadyCache[sub.sid]` 表达式

**建议执行顺序**：本 plan 先合（修复阻塞性 bug），其他 plan 再合。

---

## 项目铁律对齐

- ✅ **CLAUDE.md surgical changes**：只改受影响的代码路径，不顺手重构
- ✅ **CLAUDE.md 测试铁律**：每 Task 都包含真实启动 Hub 验证（不靠 mock）
- ✅ **CLAUDE.md 版本号铁律**：Task 8 同步 bump
- ✅ **CLAUDE.md hub 隔离规则**：所有 Hub 启动用 `CLAUDE_HUB_DATA_DIR` 隔离实例
- ✅ **CLAUDE.md 大改动验证**：commit ≥3 文件需 `/post-refactor-verify`，执行 Claude 自行调用

---

## Execution Hint

交接给另一个 Claude 时可用此 prompt：

```
读 docs/superpowers/plans/2026-05-01-roundtable-input-fixes.md
按 superpowers:executing-plans 执行
设计文档: docs/superpowers/specs/2026-05-01-roundtable-input-fixes-design.md
效果图: docs/roundtable-input-fixes-2026-05-01.html
注意：本 plan 修复阻塞性 bug，应优先于 latency / resilience / card-redesign 三份 plan 执行
```
