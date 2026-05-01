# 圆桌架构重构（阶段 1）：Shell/卡片分离 + 树形侧边栏 — 实施计划

**日期**：2026-05-02
**关联 spec**：`C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-02-hub-roundtable-arch-refactor-design.md`
**HTML mockup**：`C:\Users\lintian\claude-session-hub\docs\hub-roundtable-arch-refactor-2026-05-02.html`
**用户决策**：Q1=A / Q2=A / Q3=B
**执行模式**：用户已明确"这次我希望你自己执行修改"，由当前 Claude 直接按 Task 0 → 9 顺序执行

---

## Goal

把"卡片摘要"和"shell PTY 流"从同一棵 DOM 树里彻底分开，根治 6 个 UI/渲染 bug（#1 #2 #5 #6 #7 #8）。

## Architecture

- **数据层**：零改动（state.json schema / sessions.meetingId / meetings.subSessions 完全不动）
- **Renderer 层**：sidebar 改树形 + 圆桌界面去 shell + 主区新增 shell view + xterm 容器单 viewer 切换
- **xterm 切换**：复用 `terminalCache.get(sid).container` 单例，detach/attach 切换 mount 点，PTY 不中断

## Tech Stack

- Electron 主进程 IPC（不改）
- node-pty（不改）
- xterm.js + FitAddon（复用现有缓存）
- localStorage（新增 hubExpandedMeetings）

## 执行铁律（CLAUDE.md）

1. 中文交互 / 绝对路径 / 截图必须附路径
2. 测试必须真实执行（CDP 真测，禁 mock）
3. 严禁 kill 用户生产 Hub 进程
4. 隔离 Hub `CLAUDE_HUB_DATA_DIR=C:\temp\hub-arch-refactor` 测试
5. AI 测试用 Gemini/Codex（不动 Claude session）
6. commit ≥3 文件 → Task 9 触发 `/post-refactor-verify`
7. 影响 UX 的删改必须汇报（已在 spec 标注）
8. 版本号同步（Task 7）

---

## Task 0: AI logo 资源准备

**Files**:
- Audit: 查找 `C:\Users\lintian\AI-Arena\` 是否已有 5 家 AI logo
- New: `C:\Users\lintian\claude-session-hub\renderer\assets\ai-logos\{claude,gemini,codex,deepseek,glm}.svg`

**Steps**:

- [ ] **Step 1**: Glob 搜 AI-Arena 项目里 logo 资产

```bash
# 通过 Glob 工具搜 AI-Arena
ls C:/Users/lintian/AI-Arena/ -R 2>&1 | grep -iE "logo|claude|gemini|codex|deepseek|glm" | head -20
```

- [ ] **Step 2**: 复用或生成 5 个 16x16 SVG（claude/gemini/codex/deepseek/glm）
  - 复用：直接 cp 到 `renderer/assets/ai-logos/`
  - 兜底：写纯字母 SVG（`C` `G` `X` `D` `Z` 各家品牌色背景）

```html
<!-- 兜底 SVG 模板（claude.svg） -->
<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="3" fill="#c47cf6"/>
  <text x="8" y="12" font-size="10" font-weight="700" text-anchor="middle"
        fill="white" font-family="Arial">C</text>
</svg>
```

- [ ] **Step 3**: 确认 5 个文件已落盘
  - 路径：`C:\Users\lintian\claude-session-hub\renderer\assets\ai-logos\`
  - 文件：claude.svg / gemini.svg / codex.svg / deepseek.svg / glm.svg

- [ ] **Step 4**: Commit

```bash
cd C:/Users/lintian/claude-session-hub
git add renderer/assets/ai-logos/
git commit -m "feat(ui): add 5 AI mini logos for sidebar tree"
```

---

## Task 1: sidebar 树形改造

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\renderer.js:528-621` (renderSessionList)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\styles.css:475-666` (新增 .session-item.meeting / .child / .expand-arrow / .ai-logo-mini)

**Steps**:

- [ ] **Step 1**: 在 renderer.js 模块顶部新增 expand state 管理

```js
// 新增（renderer.js 模块顶部）
const _expandedMeetings = new Set(
  (() => {
    try { return JSON.parse(localStorage.getItem('hubExpandedMeetings') || '[]'); }
    catch { return []; }
  })()
);

function _persistExpandedMeetings() {
  localStorage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
}

function toggleMeetingExpand(meetingId) {
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

function _aiLogoHtml(kind) {
  const map = {
    claude: 'claude.svg', gemini: 'gemini.svg', codex: 'codex.svg',
    deepseek: 'deepseek.svg', glm: 'glm.svg', powershell: null,
  };
  const f = map[kind];
  if (!f) return '<span style="color:var(--text-secondary)">▶_</span>';
  return `<img class="ai-logo-mini" src="./assets/ai-logos/${f}" alt="${kind}" />`;
}
```

- [ ] **Step 2**: 改写 `renderSessionList` 主循环（renderer.js:528-621）— 改为 tree walk

伪代码骨架（最终代码以 Edit 时为准，需根据现有上下文适配）：

```js
function renderSessionList() {
  const regularSessions = Array.from(sessions.values()).filter(s => !s.meetingId);
  const meetingItems = Object.values(meetings);

  // 圆桌新建时默认展开
  for (const m of meetingItems) {
    if (!_expandedMeetings.has(m.id) && _isMeetingNew(m)) {
      _expandedMeetings.add(m.id);
    }
  }

  const all = [
    ...meetingItems.map(m => ({ ...m, _isMeeting: true, _meeting: m })),
    ...regularSessions
  ];
  const sorted = sortByPinnedThenLastMessage(all);

  sessionListEl.innerHTML = '';

  for (const item of sorted) {
    if (item._isMeeting) {
      // === 圆桌 entry ===
      const isExpanded = _expandedMeetings.has(item.id);
      const div = document.createElement('div');
      div.className = `session-item meeting ${isExpanded ? 'expanded' : ''} ${activeMeetingId === item.id ? 'selected' : ''}`;
      div.dataset.meetingId = item.id;
      div.innerHTML = `
        <span class="expand-arrow" data-action="toggle-expand">▶</span>
        🎯 ${escapeHtml(item.title)}
        <span class="meeting-badge">${item._meeting.subSessions.length}</span>
      `;
      div.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="toggle-expand"]')) {
          e.stopPropagation();
          toggleMeetingExpand(item.id);
        } else {
          selectMeeting(item.id);
        }
      });
      sessionListEl.appendChild(div);

      // === 子 session 缩进 ===
      if (isExpanded) {
        for (const subId of item._meeting.subSessions) {
          const sub = sessions.get(subId);
          if (!sub) continue;
          const subDiv = document.createElement('div');
          subDiv.className = `session-item child ${activeSessionId === subId ? 'selected' : ''}`;
          subDiv.dataset.sessionId = subId;
          subDiv.innerHTML = `
            ${_aiLogoHtml(sub.kind)}
            <span class="title">${escapeHtml(sub.title)}</span>
          `;
          subDiv.addEventListener('click', () => {
            selectSubSession(subId);  // 切到 shell view
          });
          sessionListEl.appendChild(subDiv);
        }
      }
    } else {
      // === 普通顶层 session（保留原渲染） ===
      const div = createNormalSessionItem(item);
      sessionListEl.appendChild(div);
    }
  }
}

function selectSubSession(sessionId) {
  activeSessionId = sessionId;
  activeMeetingId = null;
  showMainView('shell', sessionId);  // Task 2 提供
  renderSessionList();
}
```

- [ ] **Step 3**: styles.css 新增 CSS

```css
/* 圆桌 entry */
.session-item.meeting {
  padding: 12px 12px;
  border: 1.5px solid rgba(196,124,246,0.35);
  background: linear-gradient(135deg, rgba(196,124,246,0.05), transparent);
  border-radius: 6px;
  margin: 6px 0;
  font-weight: 500;
  font-size: 13.5px;
}
.session-item.meeting.expanded {
  border-color: rgba(196,124,246,0.55);
}
.session-item.meeting.selected {
  border-color: var(--accent-blue);
  background: rgba(88,166,255,0.1);
}
.session-item.meeting .expand-arrow {
  display: inline-block;
  width: 14px;
  transition: transform 200ms;
  color: var(--text-secondary);
  cursor: pointer;
}
.session-item.meeting.expanded .expand-arrow {
  transform: rotate(90deg);
}
.session-item.meeting .meeting-badge {
  float: right;
  background: rgba(196,124,246,0.2);
  color: #c47cf6;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 11px;
}

/* 子 session 缩进 */
.session-item.child {
  padding: 6px 10px 6px 28px;
  margin: 1px 0 1px 8px;
  border-left: 2px solid var(--color-border);
  background: rgba(255,255,255,0.02);
  font-size: 12.5px;
  border-radius: 4px;
}
.session-item.child:hover {
  background: rgba(88,166,255,0.06);
  border-left-color: var(--accent-blue);
}
.session-item.child.selected {
  background: rgba(88,166,255,0.12);
  border-left-color: var(--accent-blue);
}

/* AI logo mini */
.ai-logo-mini {
  display: inline-block;
  width: 14px; height: 14px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 6px;
}
```

- [ ] **Step 4**: 触发 `_persistExpandedMeetings` 在 meeting 创建时默认展开

```js
ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  _expandedMeetings.add(meeting.id);  // 新建默认展开
  _persistExpandedMeetings();
  renderSessionList();
});
```

- [ ] **Step 5**: 验证 — 启动隔离 Hub，肉眼确认 sidebar 树形

```bash
# 启动隔离 Hub（PowerShell）
$env:CLAUDE_HUB_DATA_DIR="C:\temp\hub-arch-refactor"
cd C:/Users/lintian/claude-session-hub
npm start
# 创建一个圆桌（任意 3 家），观察 sidebar 是否出现树形 + 缩进
```

- [ ] **Step 6**: Commit

```bash
git add renderer/renderer.js renderer/styles.css
git commit -m "feat(sidebar): tree-shaped meeting + child sessions with expand/collapse"
```

---

## Task 2: 主区 shell view 容器 + xterm 容器复用机制

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`（加 `<div id="shell-view-panel">`）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\renderer.js`（加 mount/unmount/showMainView 函数）

**Steps**:

- [ ] **Step 1**: index.html 新增 shell view panel（与 meeting-room-panel 兄弟级）

```html
<!-- 新增（与 #meeting-room-panel 兄弟） -->
<div id="shell-view-panel" style="display:none">
  <div id="shell-view-mount"></div>
</div>
```

- [ ] **Step 2**: styles.css 新增 shell-view-panel 样式

```css
#shell-view-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
  overflow: hidden;
}
#shell-view-mount {
  flex: 1;
  position: relative;
  overflow: hidden;
}
#shell-view-mount > div {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
}
```

- [ ] **Step 3**: renderer.js 新增 view 切换 + mount/unmount 函数

```js
function showMainView(viewName, sessionId) {
  const mr = document.getElementById('meeting-room-panel');
  const sv = document.getElementById('shell-view-panel');
  const welcomeEl = document.getElementById('welcome-panel');  // 假设存在

  if (viewName === 'meeting') {
    mr.style.display = 'flex';
    sv.style.display = 'none';
    if (welcomeEl) welcomeEl.style.display = 'none';
    unmountFromMainShell();
  } else if (viewName === 'shell' || viewName === 'normal-session') {
    mr.style.display = 'none';
    sv.style.display = 'flex';
    if (welcomeEl) welcomeEl.style.display = 'none';
    mountTerminalToMainShell(sessionId);
  } else if (viewName === 'welcome') {
    mr.style.display = 'none';
    sv.style.display = 'none';
    if (welcomeEl) welcomeEl.style.display = 'flex';
    unmountFromMainShell();
  }
}

function mountTerminalToMainShell(sessionId) {
  const cached = getOrCreateTerminal(sessionId);  // 已有
  const mount = document.getElementById('shell-view-mount');
  if (!cached || !mount) return;

  // 1. 若 container 已挂在别处 → detach
  if (cached.container.parentElement && cached.container.parentElement !== mount) {
    cached.container.parentElement.removeChild(cached.container);
  }
  // 2. attach 到主区
  if (cached.container.parentElement !== mount) {
    mount.appendChild(cached.container);
  }
  // 3. fit
  requestAnimationFrame(() => {
    try { cached.fitAddon.fit(); } catch {}
    cached.terminal.focus();
  });
}

function unmountFromMainShell() {
  const mount = document.getElementById('shell-view-mount');
  if (!mount) return;
  while (mount.firstChild) {
    mount.removeChild(mount.firstChild);  // detach 容器（保留 xterm 实例引用在 terminalCache）
  }
}
```

- [ ] **Step 4**: 顶层普通 session 点击也走相同 mount 机制

```js
// 改写现有 selectSession（renderer.js）
function selectSession(sessionId) {
  activeSessionId = sessionId;
  activeMeetingId = null;
  showMainView('normal-session', sessionId);
  renderSessionList();
}
```

- [ ] **Step 5**: 改写 selectMeeting 为切到 meeting view

```js
function selectMeeting(meetingId) {
  activeMeetingId = meetingId;
  activeSessionId = null;
  showMainView('meeting');
  // 触发圆桌渲染（保留现有 openMeeting 逻辑，但移除 mountSubTerminal 调用，Task 3 处理）
  openMeeting(meetingId);
  renderSessionList();
}
```

- [ ] **Step 6**: 验证 — 启动隔离 Hub，点圆桌 / 点子 session 看 view 切换

```bash
# 启动隔离 Hub
$env:CLAUDE_HUB_DATA_DIR="C:\temp\hub-arch-refactor"
npm start
# 1. 创建圆桌 → 默认进圆桌 view
# 2. 点 sidebar 子 session 行 → 主区切到 shell view + xterm
# 3. 点 sidebar 圆桌行 → 切回圆桌 view
```

- [ ] **Step 7**: Commit

```bash
git add renderer/index.html renderer/renderer.js renderer/styles.css
git commit -m "feat(main): shell-view-panel + xterm container detach/attach reuse"
```

---

## Task 3: 圆桌界面去 shell（删除 mr-terminals）

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html:120-138`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1758-2054`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css:128-156`

**Steps**:

- [ ] **Step 1**: index.html 删除 `<div class="mr-terminals" id="mr-terminals">` 整个元素

- [ ] **Step 2**: meeting-room.js 删除函数（共 6 个）：
  - `renderTerminals(meeting)` (~1758-1790)
  - `mountSubTerminal(sessionId)` (~1795-1830)
  - `openSubTerminal(sessionId)` (~1832-1870)
  - `fitSubTerminal(sessionId)` (~1875-1900)
  - `unmountSubTerminal(sessionId)` (~1905-1925)
  - `terminalsEl()` helper

- [ ] **Step 3**: meeting-room.js 删除 state

```js
// 删除：let subTerminals = {};
```

- [ ] **Step 4**: 删除 openMeeting 中所有 `mountSubTerminal` / `renderTerminals` 调用

- [ ] **Step 5**: meeting-room.css 删除 CSS 块
  - `.mr-terminals { ... }` (128-156)
  - `.mr-terminals.focus-mode { ... }`
  - `.mr-slot { ... }`
  - `.mr-slot[data-session-id] { ... }`
  - `.mr-slot.focused { ... }`
  - `.mr-sub-terminal { ... }`

- [ ] **Step 6**: 验证 — 启动 Hub，进圆桌看 DOM

```js
// 在 DevTools console
document.getElementById('mr-terminals')  // 应为 null
document.querySelectorAll('.mr-slot').length  // 应为 0
```

- [ ] **Step 7**: Commit

```bash
git add renderer/index.html renderer/meeting-room.js renderer/meeting-room.css
git commit -m "refactor(meeting): remove mr-terminals; shell moved to sidebar sub-session"
```

---

## Task 4: 删除沉浸/调试模式切换

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1432-1485`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css:1682-1710`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`（删 immersive-toggle 按钮）
- Modify: `C:\Users\lintian\claude-session-hub\main.js`（save-immersive-mode → no-op）

**Steps**:

- [ ] **Step 1**: meeting-room.js 删除函数和状态
  - `_toggleMeetingMode(meetingId)` (~1432-1450)
  - `_applyMeetingMode(immersive)` (~1455-1485)
  - `let _immersiveByMeeting = {};`
  - 所有 `_immersiveByMeeting[mid]` 引用
  - 所有 `panel.classList.add('immersive')` / `panel.classList.remove('immersive')`

- [ ] **Step 2**: meeting-room.css 删除 CSS 块
  - `#meeting-room-panel.immersive .mr-terminals { ... }` (1682-1695)
  - `#meeting-room-panel.immersive .mr-rt-panel { ... }` (1700-1710)
  - 任何 `.immersive` 选择器

- [ ] **Step 3**: index.html 删除 immersive-toggle 按钮 DOM
  - 找到 `<button id="mr-immersive-toggle" class="mr-immersive-toggle">` 整个元素删除
  - 任何关联的图标 / label

- [ ] **Step 4**: main.js `save-immersive-mode` IPC handler 改 no-op

```js
// main.js
ipcMain.handle('save-immersive-mode', (_e, _arg) => {
  // DEPRECATED 2026-05-02: 沉浸/调试模式切换已删除
  return { ok: true };
});
```

- [ ] **Step 5**: 移除 renderer 端调用 `save-immersive-mode` 的代码（_toggleMeetingMode 已删，应无残留）

- [ ] **Step 6**: 验证

```bash
# grep 残留
grep -rn "_immersiveByMeeting\|_toggleMeetingMode\|_applyMeetingMode\|immersive-toggle\|panel-panel.immersive" \
  C:/Users/lintian/claude-session-hub/renderer/
# 应为 0 命中
```

- [ ] **Step 7**: Commit

```bash
git add renderer/meeting-room.js renderer/meeting-room.css renderer/index.html main.js
git commit -m "refactor(meeting): remove immersive/debug mode toggle; only one view"
```

---

## Task 5: 逃生按钮常驻 + 新增"进 shell"按钮

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:500-518` (_ftHtml)
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1321-1323` (删 3min 门槛)

**Steps**:

- [ ] **Step 1**: 改写 `_ftHtml` 中的逃生按钮渲染（meeting-room.js:500-518）

```js
// 改前：仅 isWaitingState 或 isTerminalErrorState 显示
// 改后：waiting / error / idle-no-content 都立即显示三按钮
const isWaitingState = statusCls === 'thinking' || statusCls === 'streaming' || statusCls === 'soft_alert';
const isTerminalErrorState = statusCls === 'errored' || statusCls === 'absent';
const isIdleNoContent = statusCls === 'idle' && !hasContent;

const showEscape = isWaitingState || isTerminalErrorState || isIdleNoContent;

const escapeHtml = showEscape ? `
  <div class="mr-card-escape">
    <button class="esc-btn" data-action="extract" data-sid="${sub.sid}">📋 提取</button>
    <button class="esc-btn danger" data-action="skip" data-sid="${sub.sid}">⏭ 跳过</button>
    <button class="esc-btn" data-action="enter-shell" data-sid="${sub.sid}">🔧 进 shell</button>
  </div>
` : '';
```

- [ ] **Step 2**: 在 `_rtPanel` 的 click 委托里加 enter-shell 处理

```js
panel.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const sid = btn.dataset.sid;
  if (action === 'enter-shell') {
    e.stopPropagation();
    selectSubSession(sid);  // Task 1 已暴露
  } else if (action === 'extract') {
    onExtractCard(sid);
  } else if (action === 'skip') {
    onSkipCard(sid);
  } else if (action === 'relaunch') {
    onRelaunchCard(sid);
  }
});
```

- [ ] **Step 3**: 删除 3min 时延门槛（meeting-room.js:1321-1323）

```js
// 改前
if (waitingSec > 180) {
  message = '⚠ 已等待 3 分钟仍无响应，大概率卡死...';
} else {
  message = '可能是慢响应 / 限流 / 卡死...';
}

// 改后（按钮无门槛，文案随时间升级）
if (waitingSec > 180) {
  message = '⚠ 已等待 3 分钟仍无响应，大概率卡死。建议进 shell 看真实输出。';
} else if (waitingSec > 60) {
  message = '响应较慢，可考虑跳过或进 shell 检查';
} else {
  message = '等待 AI 响应中...';
}
```

- [ ] **Step 4**: 验证 — 隔离 Hub 创建圆桌，发言后立即看到三按钮

```
启动隔离 Hub → 创建圆桌（gemini+codex+deepseek）→ 发言 "@all 你好"
→ 卡片立即显示 [📋 提取] [⏭ 跳过] [🔧 进 shell]（不等 3min）
→ 点 "🔧 进 shell" → 切到对应子 session shell view
```

- [ ] **Step 5**: Commit

```bash
git add renderer/meeting-room.js
git commit -m "feat(meeting): always-on escape buttons + enter-shell jump"
```

---

## Task 6: 截断方向反转

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:121-150` (_renderPreviewBlocks)

**Steps**:

- [ ] **Step 1**: 改写 `_renderPreviewBlocks`

```js
function _renderPreviewBlocks(blocks, sessionId) {  // 加 sessionId 参数用于截断提示 click
  const html = [];
  const filtered = blocks; // 既有过滤逻辑保留

  for (const block of filtered) {
    if (block.type === 'thinking') {
      const raw = String(block.text || '');
      const t = raw.slice(0, 400);  // ← 反转：截尾保头
      const truncated = raw.length > 400;
      html.push(`<div class="mr-ft-think">${escapeHtml(t)}${
        truncated ? `<span class="mr-truncated-hint" data-action="enter-shell" data-sid="${sessionId}">▾ 思考已截断 · 进 shell 看完整 →</span>` : ''
      }</div>`);
    } else if (block.type === 'tool_use') {
      // 工具块保留最后 8 个（不变）
    } else if (block.type === 'text') {
      const raw = String(block.text || '');
      const t = raw.slice(0, 2000);  // ← 反转
      const truncated = raw.length > 2000;
      const md = renderMarkdown(t);
      html.push(`<div class="mr-ft-md">${md}${
        truncated ? `<span class="mr-truncated-hint" data-action="enter-shell" data-sid="${sessionId}">▾ 仅显示前 2000 字 · 进 shell 看完整 →</span>` : ''
      }</div>`);
    }
  }
  return html.join('');
}
```

- [ ] **Step 2**: 调用方 _ftHtml 中传 sessionId

```js
// _ftHtml 改：
const previewHtml = _renderPreviewBlocks(blocks, sub.sid);
```

- [ ] **Step 3**: styles.css 或 meeting-room.css 加截断提示样式

```css
.mr-truncated-hint {
  display: block;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--color-border);
  color: var(--accent-blue);
  font-size: 11px;
  cursor: pointer;
}
.mr-truncated-hint:hover { text-decoration: underline; }
```

- [ ] **Step 4**: click 委托已在 Task 5 接通（data-action="enter-shell"）

- [ ] **Step 5**: 验证 — 隔离 Hub，让 AI 输出超 2000 字回答

```
让 gemini 写一个 3000 字的故事 → 卡片只显示前 2000 字 + 截断提示
点截断提示 → 切到子 session shell view 看完整输出
```

- [ ] **Step 6**: Commit

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "fix(meeting): truncate from tail not head; show 'enter shell' hint"
```

---

## Task 7: 版本号同步

**Files**:
- Modify: `C:\Users\lintian\claude-session-hub\package.json`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`（如有版本徽章）

**Steps**:

- [ ] **Step 1**: 读 package.json 当前版本

```bash
grep '"version"' C:/Users/lintian/claude-session-hub/package.json
```

- [ ] **Step 2**: +0.1 编辑 version 字段

```json
// 例如 "1.5.3" → "1.6.0"（minor +1）或 "1.5.3" → "1.5.4"（patch +1）
// 选 minor 因为是较大架构改动
```

- [ ] **Step 3**: 若 index.html 有版本徽章，同步更新

- [ ] **Step 4**: Commit

```bash
git add package.json renderer/index.html
git commit -m "chore(version): bump for arch refactor"
```

---

## Task 8: E2E 验证（CDP 真测）

**Files**:
- New: `C:\Users\lintian\claude-session-hub\tests\_e2e-arch-refactor-verify.js`

**Steps**:

- [ ] **Step 1**: 创建 E2E 测试脚本

```js
// tests/_e2e-arch-refactor-verify.js
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const HUB_DIR = 'C:\\temp\\hub-arch-refactor';
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\claude-session-hub\\tests\\screenshots\\arch-refactor';

(async () => {
  // 1. 启动隔离 Hub
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: HUB_DIR };
  const hub = spawn('npm', ['start'], { cwd: 'C:\\Users\\lintian\\claude-session-hub', env, shell: true });
  await new Promise(r => setTimeout(r, 8000));

  // 2. CDP 连接
  const browser = await chromium.connectOverCDP('http://localhost:9229');  // 假设 Electron 启了 remote-debugging-port
  const page = browser.contexts()[0].pages()[0];

  // 3. 截图初始 sidebar
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial.png') });

  // 4. 创建圆桌
  await page.click('[data-test="create-meeting"]');
  await page.click('[data-slot-kind="gemini"]');
  await page.click('[data-slot-kind="codex"]');
  await page.click('[data-slot-kind="deepseek"]');
  await page.click('[data-test="confirm-create"]');
  await page.waitForTimeout(2000);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-meeting-created.png') });

  // 5. assert 树形
  const treeCount = await page.evaluate(() => ({
    meetings: document.querySelectorAll('.session-item.meeting').length,
    children: document.querySelectorAll('.session-item.child').length,
  }));
  console.log('Tree assert:', treeCount);
  if (treeCount.meetings !== 1 || treeCount.children !== 3) throw new Error('FAIL tree');

  // 6. 折叠测试
  await page.click('.session-item.meeting .expand-arrow');
  await page.waitForTimeout(500);
  const childAfterCollapse = await page.locator('.session-item.child').count();
  if (childAfterCollapse !== 0) throw new Error('FAIL collapse');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-collapsed.png') });

  // 7. 重展开
  await page.click('.session-item.meeting .expand-arrow');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-expanded.png') });

  // 8. 点子 session
  await page.click('.session-item.child:nth-child(2)');  // gemini
  await page.waitForTimeout(1000);
  const inShellView = await page.evaluate(() => {
    return document.getElementById('shell-view-panel').style.display !== 'none' &&
           document.querySelector('#shell-view-mount > div') !== null;
  });
  if (!inShellView) throw new Error('FAIL shell view');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-shell-view.png') });

  // 9. 切回圆桌
  await page.click('.session-item.meeting');
  await page.waitForTimeout(1000);
  const inMeetingView = await page.evaluate(() => {
    return document.getElementById('meeting-room-panel').style.display !== 'none' &&
           document.getElementById('mr-terminals') === null;  // 已删除
  });
  if (!inMeetingView) throw new Error('FAIL meeting view');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-back-to-meeting.png') });

  // 10. 圆桌发言
  await page.fill('#mr-input-box', '@all 简单介绍一下自己，5 句话');
  await page.click('#mr-send-btn');
  await page.waitForTimeout(3000);

  // 11. assert 三按钮立即出现
  const escapeBtns = await page.locator('.mr-card-escape button').count();
  if (escapeBtns < 3) throw new Error('FAIL escape buttons not shown');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-escape-buttons.png') });

  // 12. 点进 shell
  await page.click('.mr-card-escape button[data-action="enter-shell"]');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-enter-shell-from-card.png') });

  // 13. 等 AI 回答完整 → 检查截断
  await page.waitForTimeout(30000);  // 等回答
  const truncatedHints = await page.locator('.mr-truncated-hint').count();
  console.log('Truncated hints:', truncatedHints);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09-final-cards.png') });

  console.log('✓ All E2E assertions passed');
  await browser.close();
  hub.kill();
})();
```

- [ ] **Step 2**: 运行 E2E

```bash
cd C:/Users/lintian/claude-session-hub
node tests/_e2e-arch-refactor-verify.js
```

- [ ] **Step 3**: 修任何失败的 assertion，重跑直到全绿

- [ ] **Step 4**: Commit

```bash
git add tests/_e2e-arch-refactor-verify.js tests/screenshots/arch-refactor/
git commit -m "test(e2e): arch refactor verification — tree, shell-view, escape, truncate"
```

---

## Task 9: post-refactor-verify

**Steps**:

- [ ] **Step 1**: grep 残留

```bash
grep -rn "mr-terminals\|subTerminals\|_immersiveByMeeting\|_toggleMeetingMode\|_applyMeetingMode\|mr-shell-area\|focus-mode\|immersive-toggle" \
  C:/Users/lintian/claude-session-hub/renderer/ \
  C:/Users/lintian/claude-session-hub/main.js
# 应为 0 命中（除已知 no-op handler 注释）
```

- [ ] **Step 2**: 调用方一致性

```bash
# 所有引用 mountSubTerminal / openSubTerminal / fitSubTerminal 的地方都被清理
grep -rn "mountSubTerminal\|openSubTerminal\|fitSubTerminal\|unmountSubTerminal\|renderTerminals" \
  C:/Users/lintian/claude-session-hub/renderer/
# 应为 0 命中
```

- [ ] **Step 3**: E2E 全绿（Task 8 已完成）

- [ ] **Step 4**: 四路审查（按 cli-caller skill Part 6）

```
准备 system prompt：包含 7 个改动文件的 diff 摘要 + 审查重点（破坏性删除 / 调用方一致性 / xterm 容器 detach 时机 / localStorage 持久化逻辑）
并行调：
  - mcp__gemini-cli__chat
  - mcp__codex-cli__codex（sandbox: read-only）
  - mcp__deepseek__chat_completion（model: deepseek-v4-pro）
Claude 自审：Read 7 个文件的 diff
汇总：高置信度（≥2 路共识）/ 中置信度（单路）/ 元信息
```

- [ ] **Step 5**: 修复审查发现的高置信度问题（如有）

- [ ] **Step 6**: Final commit + 推送（仅在用户明确要求时）

```bash
git status  # 确认所有改动已 commit
git log --oneline -10  # 确认 commit 历史
# 不主动 push，等用户指令
```

- [ ] **Step 7**: 写完成报告（中文）给用户

```markdown
## 圆桌架构重构（阶段 1）完成报告

### 已修复
- ✅ #1 shell 压按钮
- ✅ #2 Gemini 渲染怪
- ✅ #5 卡死 3min 才出逃生
- ✅ #6 模式切换渲染重复
- ✅ #7 摘要截断方向
- ✅ #8 终端被压缩

### 改动文件（共 N 个）
- ...

### E2E 截图
- ...（绝对路径列表）

### 待办（阶段 2）
- #3 @summary @deepseek 不识别
- #4 cli-ready 首次延迟
```

---

## 复用资产

- `terminalCache.get(sessionId)` 单例缓存（renderer.js:919+）
- `parseRoundtableCommand` 命令解析（meeting-room.js:35-64）
- `_rtPanelState` 卡片状态管理
- `getOrCreateTerminal` xterm 实例创建
- `state.json` / `meetings.json` 持久化（不动）
- `create-meeting` IPC + slots[] 创建流程（不动）
- session-manager.js（完全不动）

---

## 风险与回滚

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | xterm detach/attach 闪烁 | 中 | rAF + opacity transition；attach 后 fit |
| R2 | PTY 输出 detach 期堆积 | 低 | ringBuffer 已支撑 |
| R3 | localStorage race | 低 | 同步写 |
| R4 | 老 state.json immersiveByMeeting | 低 | no-op handler |
| R5 | 老用户找不到调试模式 | 中 | 子 session shell 等价 |
| R6 | 圆桌内 codex/gemini resume 触动 | 中 | E2E Task 8 验证发言链路 |

**回滚方案**：所有 Task 都是独立 commit，可逐 commit revert。最坏 `git reset --hard <pre-refactor-sha>`。

---

## 估时

| Task | 名称 | 预估 |
|---|---|---|
| 0 | AI logo | 0.3 天 |
| 1 | sidebar 树形 | 1.0 天 |
| 2 | 主区 shell view | 1.0 天 |
| 3 | 圆桌去 shell | 0.5 天 |
| 4 | 删模式切换 | 0.3 天 |
| 5 | 逃生按钮 | 0.5 天 |
| 6 | 截断反转 | 0.3 天 |
| 7 | 版本号 | 0.1 天 |
| 8 | E2E | 0.7 天 |
| 9 | verify + 四路 | 0.5 天 |
| **合计** | | **≈ 5.2 工作日** |

---

## 阶段 2 预告（不在本 plan）

- #3 `meeting-room.js:38` `summaryRe` 正则补 `deepseek|glm`
- #4 `openMeeting` 时主动 invoke `cli-ready-status` 一次

预计 1 工作日。
