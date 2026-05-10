# 圆桌输入区 4 项修复与改造设计文档

**日期**: 2026-05-01
**作者**: Claude (brainstorming)
**状态**: spec · 待用户验收
**关联文件**:
- 效果图 HTML: `docs/roundtable-input-fixes-2026-05-01.html`
- 上游协调:
  - `docs/superpowers/plans/2026-04-30-roundtable-resilience.md`
  - `docs/superpowers/plans/2026-04-30-roundtable-latency.md`
  - `docs/superpowers/plans/2026-05-01-roundtable-card-redesign.md`

---

## 1. 背景

会议室进入后，用户报告了三个 bug + 一个 UI 改进诉求：

| # | 问题 | 现象 | 影响 |
|---|------|------|------|
| **A** | 输入框暂时不可用 | 进入会议室后，input 不响应点击/键盘几秒，要等 layout 稳定或主动点 tab 才"解锁" | 体验断裂 |
| **B** | "创建中"状态永久卡死 | 三个 AI 卡片永远显示「创建中…」，**除非用户实际问了第一个问题、AI 答完一题** | 用户看不出 AI 是否真就绪，错以为系统有问题 |
| **C** | 缺少软提醒 | AI 还在创建/启动时，用户无任何感知。如果 AI 还没 ready 就发送，输入会等待或丢失 | 期望管理 |
| **D** | 按钮位置 | 「群策群力」「总结发言」之间被「总结人」选择器隔开，两个动作按钮分离 | 用户体验小痛点 |

---

## 2. 根因分析（Bug A / Bug B 必读）

### 2.1 Bug A：输入框暂时不可用

**根因 A1（主因）**：xterm 抢焦点 + 缺少 auto-focus
- `meeting-room.js:1099 openSubTerminal` 调用 `cached.terminal.open(container)` 时，xterm 内部 `.xterm-helper-textarea` 自动获得焦点
- `meeting-room.js:1289-1301 robustFit` 用 rAF 循环反复 `fit()`，期间可能再次让 xterm 抢焦点
- `meeting-room.js:885 openMeeting` 没有显式让 `#mr-input-box` 获得焦点
- 直到 layout 稳定（"过一会"），用户点击 input 才能稳住焦点

**根因 A2（次因）**：setupInput 副作用泄漏
- `setupInput` 1615-1618 行每次调用都执行 `inputBox.textContent = ''` 和 placeholder 重设
- 即使 `_inputBound = true` 守护住了 listener 重复绑定，但内容/属性重置仍发生
- 多个 IPC 路径（`add-meeting-sub` / `update-meeting`）会反复触发 setupInput

### 2.2 Bug B：「创建中」永久卡死

**根因（确定，关键发现）**：
`renderer/meeting-room.js:165` 把 `markerStatus` 当成「session 是否就绪」的信号用，但 `markerStatus`（`core/summary-engine.js:79`）实际语义是 **「AI 是否产出过 summary marker（START_MARKER..END_MARKER 标记符号）」**：

```js
markerStatus(rawBuffer, sessionId) {
  if (!rawBuffer) return this._markerCache.has(sessionId) ? 'done' : 'none';
  // 检查 buffer 中是否含 START_MARKER / END_MARKER
  // 三种返回值：'none' | 'streaming' | 'done'
}
```

返回值语义：
- `'none'` = session **没产出过** summary marker（**包括 PTY 已启动并显示 prompt 的"待命"态**）
- `'streaming'` = AI 正在输出 marker（已开始没结束）
- `'done'` = AI 已答完至少一题

renderer:165 错误判断：
```js
const isInitializing = s && markerState !== 'done' && markerState !== 'streaming';
```

→ session 刚启动还没问问题时，markerStatus 必然是 `'none'`（永远不是 done/streaming）→ `isInitializing` 永远 true → **永久"创建中"**。

只有当用户问出第一个问题、AI 答完一题、产出 summary marker 后，markerStatus 才变 `'done'`，UI 才"解锁"。这与用户截图反映的现象完全一致。

**修复方向**：必须用真正的「CLI 启动完毕」信号，而不是「summary marker 是否产出」。

### 2.3 真正的 CLI ready 信号在哪里

`main.js:564 _RT_READY_MARKERS` 已经存在，且 `main.js:573 _rtWaitCliReady` 正确实现了"CLI 是否启动完毕"的判断：

```js
const _RT_READY_MARKERS = {
  claude: [],   // 空 markers → buffer ≥ 1500 字符兜底
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  codex: ['gpt-5.5', 'gpt-5.4', 'Context 100%', 'send'],
  glm: [],
};
```

判断逻辑：
- `_RT_READY_MARKERS[kind]` 非空 → ring buffer 含任一 marker → ready
- `_RT_READY_MARKERS[kind]` 空 → ring buffer 长度 ≥ 1500 字符 → ready（启动屏 ANSI box 通常 ≥ 2KB）

这套逻辑已被异步 `_rtWaitCliReady` 在 `_rtSendToPty` 路径用过。本次需要**把同样判断作为同步 IPC 暴露给 renderer**。

---

## 3. 设计目标

| 目标 | 验收标准 |
|------|---------|
| **G1：进入会议室即可输入** | openMeeting 后 < 100ms 用户键盘输入字符即可显示 |
| **G2：「创建中」状态准确** | CLI 真正 ready（buffer 含 marker 或 ≥ 1500 字符）后 UI < 1s 切到「待命」；之前不显示 ready |
| **G3：未就绪时软提醒** | 任意 sub `cliReady = false` 时输入区上方显示非阻塞 banner，列出未就绪的 AI 名字；全 ready 后自动消失 |
| **G4：按钮顺序优化** | 「群策群力」「总结发言」相邻；「总结人」选择器移到 divider 之后 |

**非目标（明确不做）**：
- ❌ 不重构整个 marker-status 系统（它对其他用途仍然有效，只是 isInitializing 用错了）
- ❌ 不引入 push-based ready 通知（poll 已够用，开销极小）
- ❌ 不解耦 marker poll 与 cli-ready poll（两者并存，独立 timer，便于回滚）

---

## 4. 设计原则

### 4.1 ready 信号的精确性

**只有 CLI 真就绪才标记 ready，不取巧用别的信号**。比如不能用"PTY spawn 成功"——那只是进程启动，CLI（Claude/Gemini/Codex）的初始化（OAuth、MCP 加载、UI 绘制）还要 5-15s。

复用 `_RT_READY_MARKERS` 的好处：
- 已经被 `_rtWaitCliReady` 实战验证过
- 与发送路径用同一信号，UI 显示与发送行为一致

### 4.2 缓存 + 单调性

`_cliReadyCache[sid]` 一旦置 true 就不再变 false（直到 `closeMeetingPanel` 重置）。理由：
- CLI 启动后不会"退化"为未就绪（除非崩溃，那有别的错误处理路径）
- 单调性让 UI 状态稳定，不会因 ring buffer 字符串扫描偶尔失误而抖动
- 减少轮询开销：已 ready 的 sid 跳过

### 4.3 Banner 不阻塞

软提醒 banner 是**视觉提示**，不能 disable input。理由：
- 用户可能想趁 AI 启动时把问题打好（缩短端到端时间）
- 阻塞会让 UI 看起来"卡死"
- 按钮（群策群力/总结发言）该 disable 时还是 disable（依赖既有 inProgress 逻辑，与本次正交）

### 4.4 立即触发 + 持续轮询

`startCliReadyPoll` 启动时**立即调一次 pollOnce**，不等 setInterval 周期。这是为了让用户进入会议室的第一帧就能拿到 ready 状态（如果 CLI 已经启动几秒了）。

---

## 5. 详细设计

### 5.1 Bug A 修复：input auto-focus + setupInput 防擦

**改动 1：`openMeeting` 末尾自动 focus input**

`renderer/meeting-room.js:885-904`，在 `openMeeting` 函数末尾追加：

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
  startCliReadyPoll();   // 新增（5.2 见）

  if (_isPanelCapableMeeting(meeting)) {
    refreshRoundtablePanel(meeting);
  } else {
    _removeRtPanel();
  }

  // 新增：给 layout 稳定时间后 auto-focus input（修复 Bug A）
  setTimeout(() => {
    const inputBox = document.getElementById('mr-input-box');
    if (inputBox && document.activeElement !== inputBox) {
      inputBox.focus();
    }
  }, 50);
}
```

**改动 2：`setupInput` 仅首次 binding 时擦内容**

`renderer/meeting-room.js:1609-1647`，把"重置 textContent / placeholder"挪进 `if (!_inputBound)` 块：

```js
function setupInput(meeting) {
  const inputBox = document.getElementById('mr-input-box');
  const sendBtn = document.getElementById('mr-send-btn');
  const targetSelect = document.getElementById('mr-input-target');
  if (!inputBox || !sendBtn) return;

  // 改造：placeholder 每次都更新（适配模式切换），但 textContent 不擦
  inputBox.dataset.placeholder = meeting.scene
    ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
    : '输入消息...';

  // targetSelect 处理保持不变...
  if (targetSelect) {
    if (_isPanelCapableMeeting(meeting)) {
      targetSelect.style.display = 'none';
    } else {
      targetSelect.style.display = '';
      targetSelect.style.opacity = '';
      targetSelect.style.pointerEvents = '';
    }
  }

  if (targetSelect && !_isPanelCapableMeeting(meeting)) {
    targetSelect.innerHTML = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const session = sessions ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || sid) : sid;
      const opt = document.createElement('option');
      opt.value = sid;
      opt.textContent = label;
      if (meeting.sendTarget === sid) opt.selected = true;
      targetSelect.appendChild(opt);
    }
    targetSelect.value = meeting.sendTarget || 'all';
  }

  if (_inputBound) return;
  _inputBound = true;

  // 改造：textContent 擦除挪到这里（仅首次）
  inputBox.textContent = '';

  // 后续 listener 绑定保持不变...
}
```

### 5.2 Bug B 修复：新增 cli-ready-status IPC + cliReadyPoll

**改动 3：main.js 新增 IPC handler**

`main.js`（在 `marker-status` IPC handler 附近，约 1001 行）：

```js
ipcMain.handle('cli-ready-status', (_e, sessionId) => {
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  const kind = session.kind;
  const buf = sessionManager.getSessionBuffer(sessionId) || '';
  const need = _RT_READY_MARKERS[kind] || [];
  if (need.length === 0) {
    return buf.length >= 1500;   // claude / glm 走长度兜底
  }
  return need.some(m => buf.includes(m));
});
```

**注意**：`_RT_READY_MARKERS` 是 module-local 常量。如果 IPC handler 在 _RT_READY_MARKERS 定义之前的代码中（看具体位置），需要用 hoisted const 或调整顺序。

**改动 4：renderer 新增 _cliReadyCache + startCliReadyPoll**

`renderer/meeting-room.js`，在文件顶部 IIFE 内（约 12 行附近 `let _markerStatusCache = {};` 旁）：

```js
let _cliReadyCache = {};        // sid → boolean，单调（true 后不再变 false）
let _cliReadyPollTimer = null;
```

新增函数（在 `startMarkerPoll` 附近，约 1140 行：

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
      // 触发 strip 重渲染（让 isInitializing 切换）
      const m = meetingData[activeMeetingId];
      if (m) {
        renderTerminals(m);
        _refreshSoftAlert(m);   // 改动 5 见
      }
    }
    if (meeting.subSessions.every(sid => _cliReadyCache[sid])) {
      stopCliReadyPoll();
    }
  };
  pollOnce();
  _cliReadyPollTimer = setInterval(pollOnce, 1000);
}

function stopCliReadyPoll() {
  if (_cliReadyPollTimer) { clearInterval(_cliReadyPollTimer); _cliReadyPollTimer = null; }
}
```

**改动 5：替换 isInitializing 判断**

`renderer/meeting-room.js:165`：

```js
// 旧（错的）：
// const isInitializing = s && markerState !== 'done' && markerState !== 'streaming';

// 新（正确）：
const isInitializing = s && !_cliReadyCache[sub.sid];
```

**改动 6：`closeMeetingPanel` 重置 cache + stop poll**

`renderer/meeting-room.js:906-916`：

```js
function closeMeetingPanel() {
  activeMeetingId = null;
  _inputBound = false;
  stopMarkerPoll();
  stopCliReadyPoll();           // 新增
  _markerStatusCache = {};
  _cliReadyCache = {};          // 新增
  _bannerDismissedFor = null;   // 改动 5.3 见

  const panel = panelEl();
  if (panel) panel.style.display = 'none';
  const el = terminalsEl();
  if (el) el.innerHTML = '';
  subTerminals = {};
}
```

**改动 7：`openMeeting` 启动 cliReadyPoll**

见 5.1 改动 1（已包含 `startCliReadyPoll();`）。

### 5.3 改进 C：Soft alert banner

**HTML 结构**：在 `index.html:108-117 meeting-room-panel` 中，`mr-toolbar` 和 `mr-input-row` 之间插入：

```html
<div class="meeting-room-panel" id="meeting-room-panel" style="display:none">
  <div class="mr-header" id="mr-header"></div>
  <div class="mr-terminals" id="mr-terminals"></div>
  <div class="mr-toolbar" id="mr-toolbar"></div>
  <div class="mr-input-soft-alert" id="mr-input-soft-alert" style="display:none"></div>
  <div class="mr-input-row" id="mr-input-row">
    ...保持不变...
  </div>
</div>
```

**新增渲染函数**（`renderer/meeting-room.js`）：

```js
let _bannerDismissedFor = null;   // 用户主动关闭过 banner 的 meetingId（每次 closeMeetingPanel 重置）

function _refreshSoftAlert(meeting) {
  const el = document.getElementById('mr-input-soft-alert');
  if (!el) return;

  // 用户已 dismiss → 不再显示
  if (_bannerDismissedFor === meeting.id) {
    el.style.display = 'none';
    return;
  }

  // 计算还在创建中的 sub
  const notReady = [];
  for (const sid of meeting.subSessions) {
    if (_cliReadyCache[sid]) continue;
    const s = sessions ? sessions.get(sid) : null;
    if (!s) continue;
    notReady.push({ kind: s.kind, label: { claude: 'Claude', gemini: 'Gemini', codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM', powershell: 'PowerShell' }[s.kind] || s.kind });
  }

  if (notReady.length === 0) {
    el.style.display = 'none';
    return;
  }

  const names = notReady.map(x => x.label).join('、');
  const word = notReady.length === 1 ? '个' : '个';
  el.innerHTML = `
    <span style="font-size:14px;">⏳</span>
    <span>${notReady.length}${word} AI 还在创建中（${escapeHtml(names)}），可输入但建议稍候发送</span>
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

**调用位置**：
- `openMeeting` 末尾调一次 `_refreshSoftAlert(meeting)`
- `startCliReadyPoll` 的 pollOnce 在 changed=true 时调
- `updateMeetingData` 处理 `meeting-updated` IPC 时调（覆盖 add-sub 后的情况）

**CSS**（`renderer/meeting-room.css` 末尾追加）：

```css
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

### 5.4 改进 D：按钮顺序互换

**改动**：`renderer/meeting-room.js:1390-1401`，调换 toolbar HTML：

```js
// 旧：
el.innerHTML = `
  <div class="mr-rt-toolbar">
    <button class="mr-rt-tb-btn primary" id="mr-rt-debate-btn" ${debateDisabled} title="...">🤝 群策群力</button>
    <span class="mr-rt-tb-divider"></span>
    <label class="mr-rt-tb-pick">
      <span class="mr-rt-tb-pick-label">总结人:</span>
      <select id="mr-rt-summary-pick" ${disabledAttr}>${opts || '<option disabled>无可用 AI</option>'}</select>
    </label>
    <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${debateDisabled} title="...">📝 总结发言</button>
    <span class="mr-rt-tb-status" id="mr-rt-tb-status">${...}</span>
  </div>
`;

// 新（两动作按钮放一起）：
el.innerHTML = `
  <div class="mr-rt-toolbar">
    <button class="mr-rt-tb-btn primary" id="mr-rt-debate-btn" ${debateDisabled} title="...">🤝 群策群力</button>
    <button class="mr-rt-tb-btn warm" id="mr-rt-summary-btn" ${debateDisabled} title="...">📝 总结发言</button>
    <span class="mr-rt-tb-divider"></span>
    <label class="mr-rt-tb-pick">
      <span class="mr-rt-tb-pick-label">总结人:</span>
      <select id="mr-rt-summary-pick" ${disabledAttr}>${opts || '<option disabled>无可用 AI</option>'}</select>
    </label>
    <span class="mr-rt-tb-status" id="mr-rt-tb-status">${...}</span>
  </div>
`;
```

事件绑定（`debateBtn` / `summaryBtn` / `pick` 各自的 querySelector）保持不变。

---

## 6. 数据流

```
┌──────────────────────────────────────────────────────────┐
│ session-manager.js                                        │
│   PTY onData → ringBuffer 累积 → 含 ready marker         │
└─────────────────┬─────────────────────────────────────────┘
                  │
                  │ getSessionBuffer(sid)
                  ▼
┌──────────────────────────────────────────────────────────┐
│ main.js                                                   │
│   ipcMain.handle('cli-ready-status', sid → boolean)     │
│     基于 _RT_READY_MARKERS[kind] 判断 buffer            │
└─────────────────┬─────────────────────────────────────────┘
                  │ IPC
                  ▼
┌──────────────────────────────────────────────────────────┐
│ renderer/meeting-room.js                                  │
│   startCliReadyPoll → pollOnce(每 1s, 已 ready 的跳过)   │
│     → _cliReadyCache[sid] = true                         │
│     → renderTerminals(m) (重新渲染 strip)               │
│     → _refreshSoftAlert(m) (更新 banner)                │
│   _renderFusedTabs:165                                    │
│     isInitializing = s && !_cliReadyCache[sub.sid]      │
└──────────────────────────────────────────────────────────┘
```

---

## 7. 风险与边界条件

| 场景 | 处理 |
|------|------|
| Buffer 含 ready marker 但 CLI 实际还没 ready（极端） | ready marker 是 CLI 启动屏关键文本（gpt-5.X、Type your message 等），出现即代表 prompt 可见，对用户而言已经"看上去 ready"。极端情况下输入会被 CLI 缓冲 |
| 用户在 banner 出现前已经在输入 | Banner 出现不会改 input.textContent，不影响用户已输入内容 |
| Banner dismiss 后再进会议室 | `closeMeetingPanel` 重置 `_bannerDismissedFor = null`，下次正常显示 |
| CLI ready 后又崩溃 | `_cliReadyCache[sid]` 不会变 false（单调）；崩溃由别的错误处理路径处理（resilience plan 的 absent/errored 状态） |
| auto-focus 影响用户先看终端 | 仅 openMeeting 时 50ms 延迟 focus 一次；用户点终端后焦点切走，不会反复抢回 |
| 多 sub session 注入冲突 | poll 每次扫所有 subSessions，已 ready 的跳过；新 sub（add-meeting-sub）会被下一轮 poll 检测 |
| Auto-focus 与 modal 冲突 | 50ms 延迟，且 `document.activeElement !== inputBox` 时才 focus，避免抢用户已主动 focus 的其他元素 |
| poll IPC 开销 | ready 后停止；3 sub × 1Hz × ~30s（最长冷启动）≈ 90 次/会议室；每次 IPC 仅 ringBuffer indexOf 扫描，开销可忽略 |
| renderTerminals 重渲染开销 | changed 时才调，且 ready 是单调的，每个 sid 至多触发一次 changed=true |
| 老 IPC `marker-status` 是否还要保留 | 保留——它在别的地方（badge 显示）仍在使用，不删 |

---

## 8. 测试要求

### 8.1 视觉手测（最重要）

| # | 场景 | 期望 |
|---|------|------|
| T1 | 启动 Hub，进入会议室（首次） | < 1s 内卡片状态从「创建中」切到「待命」 |
| T2 | 进入会议室后立即键盘输入字符 | 字符立即显示在 input box（不需要点击 input） |
| T3 | AI 启动慢的场景（断网/MCP 慢加载） | 软提醒 banner 显示，列出还在创建的 AI 名字 |
| T4 | 全部 AI ready | banner 自动消失 |
| T5 | banner dismiss → 关闭会议室 → 重新打开同一会议室 | banner 再次正常显示 |
| T6 | 按钮位置目视 | 群策群力 / 总结发言 相邻；总结人在 divider 之后 |
| T7 | 多次 setupInput 触发后 input 内容不被擦 | 用户已输入的内容保留 |

### 8.2 自动化（Playwright + CDP）

新增 `tests/_e2e-input-fixes-verify.js`，验证：
- `document.activeElement.id === 'mr-input-box'`（auto-focus 生效）
- `_cliReadyCache` 在 1.5s 内全部为 true
- `.mr-input-soft-alert` 元素存在且 display 与 _cliReadyCache 联动
- toolbar 子元素顺序：第 1 个 = 群策群力按钮，第 2 个 = 总结发言按钮

---

## 9. 与既有 plan 的协调

| Plan | 互动 | 协调建议 |
|------|------|----------|
| `2026-04-30-roundtable-resilience.md` | resilience 引入新状态（manual_extracted/absent/errored），本 plan 仅用 `_cliReadyCache` 判断 isInitializing | 零冲突。新状态由 status 渲染，与 cliReady 正交 |
| `2026-04-30-roundtable-latency.md` | latency 在 session-manager 加 `roundtableReady` 字段 | 语义重叠但用途不同：roundtableReady = "至少 ready 过一次"的发送侧缓存（持久）；cliReadyCache = "当前 ring buffer 是否含 marker"的 UI 缓存（renderer 内存）。两者独立 |
| `2026-05-01-roundtable-card-redesign.md` | card-redesign 改 `_ftHtml` 和 `_renderFusedTabs`；本 plan 只改 line 165 的判断条件 | 行级冲突：line 165 isInitializing 计算。建议本 plan **先合并**，card-redesign 在 rebase 时直接采用新 `!_cliReadyCache[sub.sid]` 表达式 |

**建议执行顺序**：
1. 本 plan（input fixes）→ 修复阻塞性 bug
2. latency
3. resilience
4. card-redesign（最后，依赖 resilience 状态枚举）

---

## 10. 项目文件锚点

| 文件 | 作用 |
|------|------|
| `renderer/meeting-room.js:165` | isInitializing 判断（修改） |
| `renderer/meeting-room.js:885-904` | openMeeting（追加 auto-focus + startCliReadyPoll） |
| `renderer/meeting-room.js:906-916` | closeMeetingPanel（追加 stopCliReadyPoll + reset cache） |
| `renderer/meeting-room.js:1140-1158` | startMarkerPoll（不动，作为 cliReadyPoll 的对照参考） |
| `renderer/meeting-room.js:1390-1401` | renderRtPanel toolbar HTML（按钮重排） |
| `renderer/meeting-room.js:1609-1647` | setupInput（textContent 重置移到 _inputBound 块） |
| `renderer/meeting-room.css` 末尾 | 新增 `.mr-input-soft-alert` 等规则 |
| `renderer/index.html:108-117` | meeting-room-panel 加 banner div |
| `main.js:564 _RT_READY_MARKERS` | ready marker 表（不动，作为新 IPC 的数据源） |
| `main.js:1001 marker-status` | 老 IPC（不动）；附近新增 `cli-ready-status` IPC |
| `core/summary-engine.js:79 markerStatus` | 老 marker 检测（不动） |

---

## 11. 改动总览

**新增**：
- IPC handler `cli-ready-status` (main.js)
- `_cliReadyCache` / `_cliReadyPollTimer` (meeting-room.js)
- `startCliReadyPoll` / `stopCliReadyPoll` (meeting-room.js)
- `_refreshSoftAlert` (meeting-room.js)
- `_bannerDismissedFor` (meeting-room.js)
- `<div id="mr-input-soft-alert">` (index.html)
- `.mr-input-soft-alert*` CSS (meeting-room.css)
- E2E test `tests/_e2e-input-fixes-verify.js`

**修改**：
- `_renderFusedTabs:165` isInitializing 判断
- `openMeeting` 启动 cliReadyPoll + auto-focus
- `closeMeetingPanel` 停 cliReadyPoll + 重置 cache
- `setupInput` textContent 重置移到 _inputBound 块
- `renderRtPanel` toolbar HTML 重排（D）

**删除**：
- 无

---

## 12. 版本号

涉及 UI 可见改动（按钮位置 + banner + 状态切换），按 CLAUDE.md 铁律 bump 版本号。如果 card-redesign plan 已 bump 0.2.0，本 plan 再 bump 到 0.3.0；如果 card-redesign 还没合并，本 plan bump 到 0.2.0（和 card-redesign plan 协调时让 card-redesign 调到 0.3.0）。

具体见 plan.md 的 Task 7。

---

## 13. 下一步

1. 用户验收本 spec
2. 进入 writing-plans skill 写 plan.md
3. plan.md 拆成若干可独立 commit 的 Task
4. 提交给执行 Claude 实施
