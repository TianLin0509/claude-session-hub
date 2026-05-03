# Hub UI Redesign · Spec 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hub 主区聊天和整体主题改造成 B 呼吸卡片 + P 紫色基调,引入工具调用智能折叠/绝对时间戳/代码块强化/精灵·logo 头像/hover 操作按钮,同时不破坏 xterm PTY 渲染、圆桌 slot、文件预览功能。

**Architecture:** 在现有 xterm 容器之上叠加一个"消息层"(`.msg-overlay`),由 `renderTurnCard()` 渲染 turn 数据为卡片 DOM。提供"卡片/PTY"切换;卡片视图下卡片层覆盖 xterm,PTY 视图下卡片层 `display:none`。markdown 用已有 `marked` + `dompurify`,代码高亮新引入 `prismjs`。所有"算"的层(IPC/state.json schema/hook server/PTY)不动。

**Tech Stack:** Electron + vanilla JS(无框架)、CSS3 自定义属性、marked 18(已装)、dompurify 3(已装)、prismjs(本 plan 新装)。

**Worktree 根目录:** `C:\Users\lintian\hub-feat-ui-redesign-spec1`

**Spec:** `docs/superpowers/specs/2026-05-04-hub-ui-redesign-spec1-design.md`

---

## File Structure

| 文件(相对 worktree 根) | 责任 | 改动量 |
| --- | --- | --- |
| `package.json` | +`prismjs` 依赖 + version 0.9.0 | +2 行 |
| `package-lock.json` | npm install 自动更新 | 自动 |
| `renderer/styles.css` | G 主题 CSS 变量 + 卡片/工具块/代码块/头像/操作按钮样式 + 自定义滚动条 | +280 行 |
| `renderer/index.html` | terminal panel 容器加 `.msg-overlay` + 视图切换按钮 + version `v0.9.0` | +15 行 |
| `renderer/renderer.js` | turn 卡片渲染器、折叠状态管理、操作按钮 handler、时间格式化、prismjs 集成、path-link 识别复用 | +280 行 |
| `renderer/path-link.js` (新建) | 抽出共享的 path-link 识别函数(避免 meeting-room.js / renderer.js 重复) | +80 行 |
| `renderer/index.html` | 引入 `prismjs` + 主题 CSS + `path-link.js` | +3 行 |
| `core/hub-config.js` | +`uiToolFoldThreshold` / `uiCodeFoldThreshold` 默认值 | +6 行 |
| `core/state.js`(若存在,否则 main.js 的持久化段) | session.uiState.foldedTools / foldedCodes 字段 | +10 行 |
| `tests/unit-format-time.test.js` (新建) | formatAbsoluteTime 单测 | +40 行 |
| `tests/unit-path-link.test.js` (新建) | path-link 识别函数单测 | +60 行 |
| `tests/e2e-ui-spec1.js` (新建) | CDP E2E 13 场景脚本 | +500 行 |

**复用不改:** `renderer/meeting-room.js` 的 `rt-file-link` 逻辑改 import 共享函数(轻微改动); `renderer/assets/ai-logos/*.svg` 全部复用; xterm.js 内部不动; minimap/nav 按钮 CSS 重绘但 JS 接口不动。

---

## Task 1: 引入 prismjs 依赖

**Files:**
- Modify: `package.json`(deps + version)
- Auto: `package-lock.json`

- [ ] **Step 1: 在 worktree 内确认 node_modules junction 还活**

```powershell
Test-Path "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe"
```
Expected: `True`

- [ ] **Step 2: cd 主目录,在主目录装 prismjs(避免污染 worktree junction 目标)**

```powershell
cd C:\Users\lintian\claude-session-hub
npm install prismjs --save
```
Expected: `added 1 package`,无 error。 注意必须在主目录(`C:\Users\lintian\claude-session-hub`)装,不要在 worktree 目录装 — junction 复用同一份 node_modules,worktree 装会污染主目录。

- [ ] **Step 3: 验证 prismjs 装好**

```powershell
Test-Path "C:\Users\lintian\claude-session-hub\node_modules\prismjs\prism.js"
```
Expected: `True`

- [ ] **Step 4: 把主目录的 package.json + package-lock.json 改动 cherry-pick 到 worktree branch**

```powershell
cd C:\Users\lintian\hub-feat-ui-redesign-spec1
Copy-Item C:\Users\lintian\claude-session-hub\package.json package.json -Force
Copy-Item C:\Users\lintian\claude-session-hub\package-lock.json package-lock.json -Force
```

- [ ] **Step 5: 同步把 package.json 版本号改 0.9.0**

Edit `package.json`:
```json
"version": "0.9.0",
```

- [ ] **Step 6: smoke test electron 启动**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-t1"
& "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" "C:\Users\lintian\hub-feat-ui-redesign-spec1" 2>&1 | Select-Object -First 25
```
Expected: 看到 `[hub] hook server listening on 127.0.0.1:34xx`,无 `Cannot find module` 错误。手动 Ctrl+C 关掉。

- [ ] **Step 7: Commit**

```powershell
cd C:\Users\lintian\hub-feat-ui-redesign-spec1
git add package.json package-lock.json
git commit -m "deps(ui-redesign): add prismjs + bump v0.8.5 -> v0.9.0"
```

---

## Task 2: G 主题 CSS 变量 + 紫色自定义滚动条

**Files:**
- Modify: `renderer/styles.css`(:root + 全局滚动条段)

- [ ] **Step 1: 在 styles.css 顶部 `:root` 段加紫色变量**

找到现有 `:root { --bg-primary: ...` 段,在其后追加:

```css
/* === Spec 1 v0.9.0 · UI redesign · 紫色基调 === */
:root {
  /* P 紫色基调 */
  --ui-purple-1: #8b5cf6;
  --ui-purple-2: #a78bfa;
  --ui-purple-3: #c4b5fd;
  --ui-purple-tint-bg: #2a2335;
  --ui-purple-glow: rgba(139, 92, 246, 0.5);

  /* 卡片 */
  --turn-bg-assistant: #1c1d23;
  --turn-bg-user: var(--ui-purple-tint-bg);
  --turn-meta-fg: #71717a;
  --turn-body-fg: #d4d4d8;
  --turn-radius: 8px;
  --turn-padding: 10px 14px;
  --turn-gap: 8px;

  /* 工具调用块 */
  --tool-call-bg: #14151a;
  --tool-call-border: #2a2b32;
  --tool-call-name: #fbbf24;
  --tool-call-toggle: var(--ui-purple-2);
  --tool-call-ok: #34d399;
  --tool-call-fail: #f87171;
}
```

- [ ] **Step 2: 加自定义紫色滚动条(排除 xterm)**

在 styles.css 末尾追加:

```css
/* === Spec 1 v0.9.0 · 紫色滚动条 === */
*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
  transition: background 0.2s;
}
*:hover::-webkit-scrollbar-thumb { background: rgba(139, 92, 246, 0.25); }
*::-webkit-scrollbar-thumb:hover { background: var(--ui-purple-glow); }

/* 排除 xterm 内部滚动条(它有自己的 viewport,会冲突) */
.xterm *::-webkit-scrollbar,
.xterm-viewport::-webkit-scrollbar {
  width: auto; height: auto;
}
.xterm *::-webkit-scrollbar-thumb,
.xterm-viewport::-webkit-scrollbar-thumb {
  background: revert;
}
```

- [ ] **Step 3: 启动隔离 Hub 视觉验证滚动条**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-t2"
Start-Process -FilePath "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" -ArgumentList "C:\Users\lintian\hub-feat-ui-redesign-spec1","--remote-debugging-port=9341"
Start-Sleep 5
```

打开 http://localhost:9341/ 看 sidebar/主区滚动条是否细紫色。手动 hover 看变深。Stop-Process 关掉。

- [ ] **Step 4: Commit**

```powershell
git add renderer/styles.css
git commit -m "feat(ui-redesign/G): 紫色 CSS 变量 + 自定义滚动条(排除 xterm)"
```

---

## Task 3: 消息层容器 + "卡片/PTY" 视图切换骨架

**Files:**
- Modify: `renderer/index.html`(terminal-panel 内加 `.msg-overlay` + 切换按钮)
- Modify: `renderer/styles.css`(`.msg-overlay` + `.view-toggle` 样式)
- Modify: `renderer/renderer.js`(切换 handler + 默认状态)

- [ ] **Step 1: 在 index.html `terminal-panel` 内加 .msg-overlay 容器和切换按钮**

找到 `<div id="terminal-panel">` 段(grep `id="terminal-panel"`),在其内最末加:

```html
<!-- Spec 1 v0.9.0: 消息层(卡片视图) -->
<div id="msg-overlay" class="msg-overlay"></div>
<!-- 视图切换按钮 -->
<div class="view-toggle">
  <button class="view-toggle-btn active" data-view="card" title="卡片视图(默认)">📇 卡片</button>
  <button class="view-toggle-btn" data-view="pty" title="PTY 视图(原始终端)">⌨ PTY</button>
</div>
```

- [ ] **Step 2: 加 CSS**

styles.css 末尾追加:

```css
/* === Spec 1 v0.9.0 · 消息层 === */
.msg-overlay {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  background: var(--bg-primary);
  padding: 12px 16px;
  z-index: 50;
  font-family: "Inter", -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.65;
  color: var(--turn-body-fg);
}
.msg-overlay.hidden { display: none; }

/* 视图切换按钮(右上角浮) */
.view-toggle {
  position: absolute;
  top: 8px; right: 12px;
  z-index: 100;
  display: flex;
  gap: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.view-toggle-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.view-toggle-btn.active {
  background: var(--ui-purple-1);
  color: white;
}
```

- [ ] **Step 3: 在 renderer.js 加切换 handler**

找一个合适位置(比如现有 `mountPromptNavButtons` 附近),追加:

```javascript
// === Spec 1 v0.9.0 · 视图切换 ===
let currentView = 'card'; // 'card' | 'pty'

function applyViewMode(mode) {
  currentView = mode;
  const overlay = document.getElementById('msg-overlay');
  if (overlay) overlay.classList.toggle('hidden', mode !== 'card');
  document.querySelectorAll('.view-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // 切到 PTY 时 refit xterm
  if (mode === 'pty') {
    const cached = terminalCache.get(currentSessionId);
    if (cached && cached.fitAddon) cached.fitAddon.fit();
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-toggle-btn');
  if (btn && btn.dataset.view) applyViewMode(btn.dataset.view);
});
```

- [ ] **Step 4: 默认初始化为 card 模式**

renderer.js 启动序列(`(async () => { ... })()` 段)末尾加:

```javascript
applyViewMode('card');
```

- [ ] **Step 5: smoke test — 启动隔离 Hub,确认切换按钮工作**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-t3"
Start-Process -FilePath "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" -ArgumentList "C:\Users\lintian\hub-feat-ui-redesign-spec1","--remote-debugging-port=9342"
Start-Sleep 6
```

打开 http://localhost:9342/,在主区右上看到"📇 卡片 / ⌨ PTY"按钮,点切换看 .msg-overlay 显隐。Stop-Process。

- [ ] **Step 6: Commit**

```powershell
git add renderer/index.html renderer/styles.css renderer/renderer.js
git commit -m "feat(ui-redesign/D): 消息层容器 + 卡片/PTY 视图切换骨架"
```

---

## Task 4: turn 卡片渲染器 + D1 绝对时间戳

**Files:**
- Create: `tests/unit-format-time.test.js`
- Modify: `renderer/renderer.js`(formatAbsoluteTime + renderTurnCard 基础)
- Modify: `renderer/styles.css`(.turn-card / .turn-who / .turn-meta 样式)

- [ ] **Step 1: 写 formatAbsoluteTime 单测(失败优先)**

Create `tests/unit-format-time.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

// 直接 require source — formatAbsoluteTime 要在 renderer.js export 前用 module.exports
const { formatAbsoluteTime } = require('../renderer/format-time.js');

test('same day → HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2026-05-04T08:30:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '08:30');
});

test('cross day same year → M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2026-05-03T14:22:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '5月3日 14:22');
});

test('cross year → YYYY年M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2025-12-03T14:22:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '2025年12月3日 14:22');
});
```

- [ ] **Step 2: 跑测试看失败**

```powershell
node --test tests/unit-format-time.test.js
```
Expected: FAIL (模块不存在)

- [ ] **Step 3: 实现 formatAbsoluteTime**

Create `renderer/format-time.js`:

```javascript
function formatAbsoluteTime(ts, now = new Date()) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

module.exports = { formatAbsoluteTime };
```

- [ ] **Step 4: 跑测试看通过**

```powershell
node --test tests/unit-format-time.test.js
```
Expected: PASS (3 tests)

- [ ] **Step 5: 在 renderer.js 引入 + 写 renderTurnCard**

renderer.js 顶部 require 段加:
```javascript
const { formatAbsoluteTime } = require('./format-time.js');
```

renderer.js 适当位置(比如 renderAccountUsage 附近)加渲染器:

```javascript
// === Spec 1 v0.9.0 · turn 卡片渲染 ===
function escapeHtmlText(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderTurnCard(turn) {
  // turn = { role: 'user'|'assistant', text, ts, model?, toolCalls?[] }
  const isUser = turn.role === 'user';
  const cls = isUser ? 'turn-card user' : 'turn-card';
  const who = isUser ? '你' : (turn.model || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';
  const body = escapeHtmlText(turn.text || '').replace(/\n/g, '<br>');
  return `<div class="${cls}" data-turn-id="${escapeHtmlText(turn.id || '')}">
    <div class="turn-head">
      <span class="turn-who">${escapeHtmlText(who)}</span>
      <span class="turn-meta">${escapeHtmlText(ts)}</span>
    </div>
    <div class="turn-body">${body}</div>
  </div>`;
}

// debug: 暴露给 console 验证
window._renderTurnCard = renderTurnCard;
```

- [ ] **Step 6: 加 CSS**

styles.css 末尾追加:

```css
/* === Spec 1 v0.9.0 · turn 卡片 === */
.turn-card {
  background: var(--turn-bg-assistant);
  padding: var(--turn-padding);
  border-radius: var(--turn-radius);
  margin-bottom: var(--turn-gap);
}
.turn-card.user {
  background: var(--turn-bg-user);
  border-left: 3px solid var(--ui-purple-1);
}
.turn-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.turn-who {
  color: var(--ui-purple-2);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.turn-card.user .turn-who { color: var(--ui-purple-3); }
.turn-meta {
  color: var(--turn-meta-fg);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.turn-body {
  margin-top: 4px;
  color: var(--turn-body-fg);
}
```

- [ ] **Step 7: 浏览器 console 验证渲染**

启动隔离 Hub(同 task 3 的命令模板,端口 9343)。打开 DevTools console:
```javascript
document.getElementById('msg-overlay').innerHTML =
  _renderTurnCard({role:'user', text:'看下 main.js', ts: Date.now()}) +
  _renderTurnCard({role:'assistant', text:'好的,正在查...', ts: Date.now(), model:'Claude · Opus 4.7'});
```
Expected: 两张卡片显示,user 紫色 border,assistant 中性灰,时间戳 14:22 格式。

- [ ] **Step 8: Commit**

```powershell
git add renderer/format-time.js tests/unit-format-time.test.js renderer/renderer.js renderer/styles.css
git commit -m "feat(ui-redesign/D+D1): turn 卡片渲染器 + 绝对时间戳(单测覆盖)"
```

---

## Task 5: 工具调用块渲染 + D 智能折叠(>15 行)

**Files:**
- Modify: `renderer/renderer.js`(扩展 renderTurnCard,加 renderToolCall + 折叠状态)
- Modify: `renderer/styles.css`(.tc-* 样式)
- Modify: `core/hub-config.js`(uiToolFoldThreshold 默认 15)

- [ ] **Step 1: hub-config.js 加阈值默认**

找到 `DEFAULTS = {` 段,加:
```javascript
ui_tool_fold_threshold: 15,
ui_code_fold_threshold: 30,
```

找到 `_cachedConfig = { ... }` 段,加:
```javascript
uiToolFoldThreshold: parseInt(getConfigValue('uiToolFoldThreshold', 'HUB_UI_TOOL_FOLD', 'ui.tool_fold_threshold', DEFAULTS.ui_tool_fold_threshold), 10),
uiCodeFoldThreshold: parseInt(getConfigValue('uiCodeFoldThreshold', 'HUB_UI_CODE_FOLD', 'ui.code_fold_threshold', DEFAULTS.ui_code_fold_threshold), 10),
```

- [ ] **Step 2: 在 main.js 暴露阈值给 renderer(走 get-hub-config IPC)**

找到 `ipcMain.handle('get-hub-config-raw', () => { ... })` 段,在返回 object 里加:
```javascript
uiToolFoldThreshold: config.uiToolFoldThreshold,
uiCodeFoldThreshold: config.uiCodeFoldThreshold,
```

- [ ] **Step 3: renderer.js 加 renderToolCall + 折叠状态(in-memory 先)**

renderer.js renderTurnCard 附近追加:

```javascript
// 折叠状态: { 'turnId:toolIdx': true(展开)|false(折叠) }
const _foldedToolsState = new Map();
let _toolFoldThreshold = 15; // 启动时从 config 拉

function setFoldedTool(turnId, idx, expanded) {
  _foldedToolsState.set(`${turnId}:${idx}`, expanded);
}
function getFoldedTool(turnId, idx, defaultExpanded) {
  const key = `${turnId}:${idx}`;
  if (_foldedToolsState.has(key)) return _foldedToolsState.get(key);
  return defaultExpanded;
}

function renderToolCall(turnId, idx, tc) {
  // tc = { name, cmd, stdout, ok, durationMs, exitCode? }
  const lines = (tc.stdout || '').split('\n').length;
  const isFail = tc.ok === false;
  const shouldFold = lines > _toolFoldThreshold && !isFail;
  const expanded = getFoldedTool(turnId, idx, !shouldFold);
  const status = isFail
    ? `<span class="tc-fail">✗</span>${tc.exitCode != null ? ' exit ' + tc.exitCode : ''}`
    : `<span class="tc-ok">✓</span>`;
  const dur = tc.durationMs != null ? ` · ${(tc.durationMs/1000).toFixed(1)}s` : '';
  const meta = `${lines} line${lines===1?'':'s'}${dur}`;
  return `<div class="tc" data-turn="${escapeHtmlText(turnId)}" data-idx="${idx}">
    <div class="tc-head">
      <span><span class="tc-name">${escapeHtmlText(tc.name)}</span> ${escapeHtmlText(tc.cmd || '')}</span>
      <span class="tc-meta">${status} ${meta}</span>
    </div>
    ${shouldFold && !expanded
      ? `<div class="tc-toggle" data-action="tc-expand">▸ 展开 ${lines} 行(折叠 >${_toolFoldThreshold} 行)</div>`
      : `<pre class="tc-out">${escapeHtmlText(tc.stdout || '')}</pre>${shouldFold ? '<div class="tc-toggle" data-action="tc-collapse">▾ 折叠</div>' : ''}`}
  </div>`;
}

// 扩展 renderTurnCard 接受 toolCalls
const _origRenderTurnCard = renderTurnCard;
renderTurnCard = function(turn) {
  const baseHtml = _origRenderTurnCard(turn);
  if (!turn.toolCalls || !turn.toolCalls.length) return baseHtml;
  // 在 turn-body 内插入工具块
  const toolHtml = turn.toolCalls.map((tc, i) => renderToolCall(turn.id || '', i, tc)).join('');
  return baseHtml.replace('</div>\n  </div>', `${toolHtml}</div>\n  </div>`);
};
window._renderTurnCard = renderTurnCard;

// 全局 click handler: 工具块展开/折叠
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="tc-expand"], [data-action="tc-collapse"]');
  if (!btn) return;
  const wrap = btn.closest('.tc');
  const turnId = wrap.dataset.turn;
  const idx = parseInt(wrap.dataset.idx, 10);
  const want = btn.dataset.action === 'tc-expand';
  setFoldedTool(turnId, idx, want);
  // 重渲染整张卡片(简单粗暴,后续 task 7 加 incremental)
  rerenderTurn(turnId);
});

function rerenderTurn(turnId) {
  // 简单实现: 找到 .turn-card[data-turn-id=...],从内存 turn 数据重新生成 HTML
  // turn 数据来源: 后续 task 接入 session.turns[]; 这里先留 hook
  const card = document.querySelector(`.turn-card[data-turn-id="${turnId}"]`);
  if (!card || !window._sessionTurns) return;
  const turn = (window._sessionTurns.get && window._sessionTurns.get(turnId)) || null;
  if (!turn) return;
  card.outerHTML = renderTurnCard(turn);
}
```

- [ ] **Step 4: 启动 Hub 拉 config 把阈值塞进 _toolFoldThreshold**

renderer.js 启动序列里 `get-hub-config-raw` 完成 then 加:
```javascript
if (typeof cfg.uiToolFoldThreshold === 'number') _toolFoldThreshold = cfg.uiToolFoldThreshold;
if (typeof cfg.uiCodeFoldThreshold === 'number') _codeFoldThreshold = cfg.uiCodeFoldThreshold;
```

- [ ] **Step 5: 加 CSS**

styles.css 末尾追加:

```css
/* === Spec 1 v0.9.0 · 工具调用块 === */
.tc {
  background: var(--tool-call-bg);
  border: 1px solid var(--tool-call-border);
  border-radius: 6px;
  margin: 8px 0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
}
.tc-head {
  padding: 6px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.tc-name { color: var(--tool-call-name); font-weight: 600; }
.tc-meta { color: var(--turn-meta-fg); font-size: 10px; flex-shrink: 0; }
.tc-ok { color: var(--tool-call-ok); }
.tc-fail { color: var(--tool-call-fail); }
.tc-out {
  margin: 0;
  padding: 4px 10px 8px;
  color: #a1a1aa;
  border-top: 1px solid var(--tool-call-border);
  white-space: pre;
  font-size: 10.5px;
  line-height: 1.45;
  max-height: 480px;
  overflow-y: auto;
}
.tc-toggle {
  color: var(--tool-call-toggle);
  cursor: pointer;
  padding: 6px 10px;
  font-size: 10.5px;
  border-top: 1px solid var(--tool-call-border);
  user-select: none;
}
.tc-toggle:hover { background: rgba(167, 139, 250, 0.05); }
```

- [ ] **Step 6: console 验证 — 模拟 16 行 stdout 折叠**

启动隔离 Hub(端口 9344),DevTools console:
```javascript
const longOut = Array.from({length: 16}, (_, i) => `line ${i+1}`).join('\n');
document.getElementById('msg-overlay').innerHTML = _renderTurnCard({
  id: 't1', role: 'assistant', text: '看下 ls 输出', ts: Date.now(),
  toolCalls: [{ name: 'Bash', cmd: 'ls', stdout: longOut, ok: true, durationMs: 320 }]
});
```
Expected: 看到折叠 toggle `▸ 展开 16 行(折叠 >15 行)`。点它展开看到 16 行 stdout。再点 `▾ 折叠` 收起。

- [ ] **Step 7: 改成 14 行验证 ≤ 阈值直接展开**

console:
```javascript
const shortOut = Array.from({length: 14}, (_, i) => `line ${i+1}`).join('\n');
document.getElementById('msg-overlay').innerHTML = _renderTurnCard({
  id: 't2', role: 'assistant', text: '', ts: Date.now(),
  toolCalls: [{ name: 'Bash', cmd: 'ls', stdout: shortOut, ok: true, durationMs: 200 }]
});
```
Expected: 直接展示 14 行,无 toggle。

- [ ] **Step 8: 验证失败 case 始终展开**

console:
```javascript
const failOut = Array.from({length: 50}, (_, i) => `error ${i+1}`).join('\n');
document.getElementById('msg-overlay').innerHTML = _renderTurnCard({
  id: 't3', role: 'assistant', text: '失败了', ts: Date.now(),
  toolCalls: [{ name: 'Bash', cmd: 'bad-cmd', stdout: failOut, ok: false, exitCode: 127, durationMs: 50 }]
});
```
Expected: 即使 50 行也直接展开,标题显示 `✗ exit 127`。

- [ ] **Step 9: Commit**

```powershell
git add renderer/renderer.js renderer/styles.css core/hub-config.js main.js
git commit -m "feat(ui-redesign/D): 工具调用块 + 智能折叠(>15行,失败始终展开)"
```

---

## Task 6: D2 markdown 渲染 + prismjs 高亮 + Copy 按钮 + 长代码块折叠

**Files:**
- Modify: `renderer/index.html`(引入 prismjs + 主题 css)
- Modify: `renderer/renderer.js`(turn body 改 marked + dompurify + prismjs 高亮 + copy/fold 处理)
- Modify: `renderer/styles.css`(代码块 + copy 按钮 + 紫调 prism override)

- [ ] **Step 1: index.html 引入 prismjs**

在 `<head>` 段(找 `<link rel="stylesheet" href="styles.css">` 附近)加:

```html
<link rel="stylesheet" href="../node_modules/prismjs/themes/prism-tomorrow.css">
<script src="../node_modules/prismjs/prism.js"></script>
<script src="../node_modules/prismjs/components/prism-bash.min.js"></script>
<script src="../node_modules/prismjs/components/prism-javascript.min.js"></script>
<script src="../node_modules/prismjs/components/prism-json.min.js"></script>
<script src="../node_modules/prismjs/components/prism-python.min.js"></script>
<script src="../node_modules/prismjs/components/prism-typescript.min.js"></script>
<script src="../node_modules/prismjs/components/prism-markdown.min.js"></script>
```

- [ ] **Step 2: renderer.js 把 turn body 改用 marked + dompurify**

renderer.js 顶部 require 段确认有:
```javascript
const { marked } = require('marked');
const DOMPurify = require('dompurify');
```

改 renderTurnCard(原 task 4 加的) 的 body 段:

```javascript
function renderTurnCard(turn) {
  const isUser = turn.role === 'user';
  const cls = isUser ? 'turn-card user' : 'turn-card';
  const who = isUser ? '你' : (turn.model || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';
  // markdown 渲染
  const rawHtml = marked.parse(turn.text || '', { breaks: true, gfm: true });
  const safeHtml = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
  // 工具块
  const toolHtml = (turn.toolCalls || []).map((tc, i) => renderToolCall(turn.id || '', i, tc)).join('');
  return `<div class="${cls}" data-turn-id="${escapeHtmlText(turn.id || '')}">
    <div class="turn-head">
      <span class="turn-who">${escapeHtmlText(who)}</span>
      <span class="turn-meta">${escapeHtmlText(ts)}</span>
    </div>
    <div class="turn-body">${safeHtml}${toolHtml}</div>
  </div>`;
}
window._renderTurnCard = renderTurnCard;
```

(把 task 5 的 `_origRenderTurnCard` 包装删除,合并到这里)

- [ ] **Step 3: 加 prismjs 高亮 + Copy 按钮 post-process**

renderer.js 加:

```javascript
let _codeFoldThreshold = 30;
const _foldedCodesState = new Map();

function postProcessCardCodeBlocks(cardEl) {
  if (!cardEl) return;
  const blocks = cardEl.querySelectorAll('pre > code');
  blocks.forEach((code, idx) => {
    const pre = code.parentElement;
    // 推断语言: marked 会加 class="language-xx",拿首个 class
    const lang = (code.className.match(/language-(\w+)/) || [, ''])[1];
    // prism 高亮
    if (lang && window.Prism && Prism.languages[lang]) {
      try { code.innerHTML = Prism.highlight(code.textContent, Prism.languages[lang], lang); }
      catch {}
    }
    // 长代码块折叠
    const lines = code.textContent.split('\n').length;
    const turnId = cardEl.dataset.turnId || '';
    const codeKey = `${turnId}:code:${idx}`;
    const expanded = _foldedCodesState.has(codeKey) ? _foldedCodesState.get(codeKey) : (lines <= _codeFoldThreshold);
    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    wrap.dataset.codeKey = codeKey;
    wrap.dataset.lang = lang || 'text';
    wrap.dataset.lines = lines;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    // copy 按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.dataset.action = 'code-copy';
    wrap.appendChild(copyBtn);
    // 折叠
    if (lines > _codeFoldThreshold && !expanded) {
      pre.style.display = 'none';
      const toggle = document.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-expand';
      toggle.textContent = `▸ 展开 ${_codeFoldThreshold} of ${lines} 行 · ${lang || 'text'}`;
      wrap.appendChild(toggle);
    } else if (lines > _codeFoldThreshold) {
      const toggle = document.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-collapse';
      toggle.textContent = `▾ 折叠 (${lines} 行)`;
      wrap.appendChild(toggle);
    }
  });
}

// 渲染后调用 — 改 _renderTurnCard 包装让 cardEl 挂上后做 post-process
// 提供 mountTurnCard 帮手
function mountTurnCard(container, turn) {
  const tmp = document.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const cardEl = tmp.firstElementChild;
  postProcessCardCodeBlocks(cardEl);
  container.appendChild(cardEl);
  return cardEl;
}
window._mountTurnCard = mountTurnCard;
```

- [ ] **Step 4: 加 click handler — copy + 长代码块 expand/collapse**

renderer.js 加(可以与 task 5 的 click handler 合并,但分开写更清晰):

```javascript
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-action="code-copy"]');
  if (copyBtn) {
    const code = copyBtn.parentElement.querySelector('pre code');
    if (code) {
      navigator.clipboard.writeText(code.textContent).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 1500);
      });
    }
    return;
  }
  const toggleBtn = e.target.closest('[data-action="code-expand"], [data-action="code-collapse"]');
  if (toggleBtn) {
    const wrap = toggleBtn.closest('.code-block-wrap');
    const key = wrap.dataset.codeKey;
    const want = toggleBtn.dataset.action === 'code-expand';
    _foldedCodesState.set(key, want);
    const pre = wrap.querySelector('pre');
    pre.style.display = want ? '' : 'none';
    if (want) {
      toggleBtn.dataset.action = 'code-collapse';
      toggleBtn.textContent = `▾ 折叠 (${wrap.dataset.lines} 行)`;
    } else {
      toggleBtn.dataset.action = 'code-expand';
      toggleBtn.textContent = `▸ 展开 ${_codeFoldThreshold} of ${wrap.dataset.lines} 行 · ${wrap.dataset.lang}`;
    }
  }
});
```

- [ ] **Step 5: 加 CSS — 代码块 + Copy 按钮 + 紫调 prism override**

styles.css 末尾追加:

```css
/* === Spec 1 v0.9.0 · 代码块 === */
.code-block-wrap {
  position: relative;
  margin: 10px 0;
}
.code-block-wrap pre {
  margin: 0;
  padding: 12px 14px;
  background: var(--tool-call-bg) !important;
  border: 1px solid var(--tool-call-border);
  border-radius: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  overflow-x: auto;
}
.code-copy {
  position: absolute;
  top: 6px; right: 6px;
  background: rgba(139, 92, 246, 0.15);
  border: 1px solid rgba(139, 92, 246, 0.3);
  color: var(--ui-purple-3);
  padding: 3px 9px;
  border-radius: 4px;
  font-size: 10.5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  font-family: inherit;
}
.code-block-wrap:hover .code-copy { opacity: 1; }
.code-copy:hover { background: rgba(139, 92, 246, 0.3); }
.code-toggle {
  background: var(--tool-call-bg);
  border: 1px solid var(--tool-call-border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  padding: 6px 10px;
  color: var(--ui-purple-2);
  cursor: pointer;
  font-size: 10.5px;
  font-family: ui-monospace, monospace;
  user-select: none;
}
.code-toggle:hover { background: rgba(167, 139, 250, 0.05); }

/* prism-tomorrow 紫调 override */
.token.keyword { color: var(--ui-purple-3) !important; }
.token.function { color: #fbbf24 !important; }
.token.string { color: #34d399 !important; }
.token.comment { color: #6b7280 !important; font-style: italic; }
.token.operator { color: #c4b5fd !important; }
```

- [ ] **Step 6: console 验证 — 短代码块**

启动隔离 Hub(端口 9345),DevTools console:
```javascript
_mountTurnCard(document.getElementById('msg-overlay'), {
  id: 'tc1', role: 'assistant', ts: Date.now(),
  text: '看这段代码:\n```javascript\nfunction hi() {\n  return "world";\n}\n```\n用法...'
});
```
Expected: 卡片里有紫色高亮代码块,hover 出 `📋 Copy`,点击复制后变 `✓ Copied`。

- [ ] **Step 7: console 验证 — 长代码块折叠**

```javascript
const longCode = Array.from({length:50}, (_,i)=>`const line${i} = ${i};`).join('\n');
_mountTurnCard(document.getElementById('msg-overlay'), {
  id: 'tc2', role: 'assistant', ts: Date.now(),
  text: '看这段:\n```javascript\n' + longCode + '\n```'
});
```
Expected: 代码块被折叠,显示 `▸ 展开 30 of 51 行 · javascript`,点开 → 展开 + 显示 `▾ 折叠 (51 行)`。

- [ ] **Step 8: Commit**

```powershell
git add renderer/index.html renderer/renderer.js renderer/styles.css
git commit -m "feat(ui-redesign/D2): markdown 渲染 + prismjs 高亮 + Copy 按钮 + 长代码块折叠"
```

---

## Task 7: 卡片内 path-link 识别(共享 path-link.js,接通 openPreviewPanel)

**Files:**
- Create: `renderer/path-link.js`
- Create: `tests/unit-path-link.test.js`
- Modify: `renderer/renderer.js`(postProcessCardCodeBlocks 后加 postProcessCardPathLinks)
- Modify: `renderer/meeting-room.js`(改 require 共享函数,删本地实现)
- Modify: `renderer/index.html`(引入 path-link.js)

- [ ] **Step 1: 写 path-link 识别单测(失败优先)**

Create `tests/unit-path-link.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert');
const { extractPathLinks } = require('../renderer/path-link.js');

test('finds .md path', () => {
  const found = extractPathLinks('参考 docs/foo.md 看一下');
  assert.deepStrictEqual(found.map(f => f.path), ['docs/foo.md']);
});

test('finds .html absolute path', () => {
  const found = extractPathLinks('打开 C:\\\\Users\\\\me\\\\report.html');
  assert.strictEqual(found.length, 1);
  assert.match(found[0].path, /\.html$/);
});

test('finds URL', () => {
  const found = extractPathLinks('访问 http://localhost:3000/api');
  assert.strictEqual(found.length, 1);
  assert.match(found[0].path, /^http/);
});

test('does not match prose words', () => {
  const found = extractPathLinks('this is just text without paths');
  assert.strictEqual(found.length, 0);
});
```

- [ ] **Step 2: 跑测试看失败**

```powershell
node --test tests/unit-path-link.test.js
```
Expected: FAIL

- [ ] **Step 3: 实现 path-link.js**

Create `renderer/path-link.js`:
```javascript
// 识别正文里的文件路径 / URL,返回 [{ path, start, end }]
// 支持: .html .htm .md .markdown .json .py .js .ts .css .png .jpg .pdf 等常见后缀
// 支持: 相对路径(docs/foo.md), Windows 绝对(C:\..), POSIX 绝对(/usr/..), URL(http(s)://)
const FILE_EXT_RE = /\b[\w./\\\-]+\.(html?|markdown|md|json|py|jsx?|tsx?|css|scss|png|jpg|jpeg|gif|svg|pdf|txt|log|yaml|yml|toml|sh|ps1|bat)\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>'"]+/gi;

function extractPathLinks(text) {
  if (!text) return [];
  const out = [];
  let m;
  // URL 优先(避免 URL 里的 .html 被当文件路径)
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    out.push({ path: m[0], start: m.index, end: m.index + m[0].length, kind: 'url' });
  }
  // file paths
  FILE_EXT_RE.lastIndex = 0;
  while ((m = FILE_EXT_RE.exec(text)) !== null) {
    // 排除已落在 URL 范围的
    const overlap = out.some(o => m.index >= o.start && m.index < o.end);
    if (!overlap) out.push({ path: m[0], start: m.index, end: m.index + m[0].length, kind: 'file' });
  }
  // 按 start 排序
  out.sort((a, b) => a.start - b.start);
  return out;
}

// DOM 后处理: 给元素内文本里的路径包 <a class="rt-file-link"> 让 click 路由到 openPreviewPanel
function wrapPathLinksInElement(rootEl) {
  if (!rootEl) return 0;
  let wrapped = 0;
  // 只处理 text node,不处理已有 a / pre / code 内
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.tagName === 'A' || p.tagName === 'PRE' || p.tagName === 'CODE') return NodeFilter.FILTER_REJECT;
      if (p.closest('.code-block-wrap, .tc, .rt-file-link')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue;
    const links = extractPathLinks(text);
    if (!links.length) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const lk of links) {
      if (lk.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, lk.start)));
      const a = document.createElement('a');
      a.className = 'rt-file-link';
      a.href = '#';
      a.dataset.path = lk.path;
      a.textContent = lk.path;
      frag.appendChild(a);
      wrapped++;
      cursor = lk.end;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(frag, node);
  }
  return wrapped;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractPathLinks, wrapPathLinksInElement };
}
if (typeof window !== 'undefined') {
  window.extractPathLinks = extractPathLinks;
  window.wrapPathLinksInElement = wrapPathLinksInElement;
}
```

- [ ] **Step 4: 跑测试看通过**

```powershell
node --test tests/unit-path-link.test.js
```
Expected: PASS (4 tests)

- [ ] **Step 5: index.html 引入**

在 `<head>` 或 `<body>` 末尾加(在其他 script 之前):
```html
<script src="path-link.js"></script>
```

- [ ] **Step 6: renderer.js 在 mountTurnCard 后接 path-link 包装 + click 路由**

renderer.js mountTurnCard 改为:
```javascript
function mountTurnCard(container, turn) {
  const tmp = document.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const cardEl = tmp.firstElementChild;
  postProcessCardCodeBlocks(cardEl);
  // 路径识别
  const bodyEl = cardEl.querySelector('.turn-body');
  if (bodyEl && window.wrapPathLinksInElement) wrapPathLinksInElement(bodyEl);
  container.appendChild(cardEl);
  return cardEl;
}
```

加 click handler 路由 `.rt-file-link`(沿用 meeting-room.js 模式):
```javascript
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.rt-file-link');
  if (!a) return;
  // 不要拦截已有 meeting-room 的 handler — 先 check 是否 turn-card 内
  if (!a.closest('.msg-overlay')) return;
  e.preventDefault();
  e.stopPropagation();
  const path = a.dataset.path;
  if (path && typeof openPreviewPanel === 'function') openPreviewPanel(path);
}, true);
```

- [ ] **Step 7: meeting-room.js 改用共享函数(删除本地正则)**

找到 meeting-room.js:102 附近的本地路径识别实现,改:
```javascript
// 用共享 path-link 模块替代本地实现
const { wrapPathLinksInElement } = require('./path-link.js');
// 后续凡是后处理 markdown 的地方,call wrapPathLinksInElement(rendered_dom)
```

(具体替换行需要依据实际 meeting-room.js 现状,实施时按 grep 出的位置改)

- [ ] **Step 8: console 验证 — 卡片内的 .md / URL 都识别成 link 并触发预览**

启动隔离 Hub(端口 9346),console:
```javascript
_mountTurnCard(document.getElementById('msg-overlay'), {
  id: 'tp1', role: 'assistant', ts: Date.now(),
  text: '看下 README.md 和 docs/superpowers/specs/2026-05-04-hub-ui-redesign-spec1-design.md\n\n参考 https://www.packyapi.com/console'
});
```
Expected: 三个路径都成蓝紫色下划线,点 spec md 触发 openPreviewPanel(右侧 split panel 显示 markdown 渲染)。点 URL 触发 webview 预览。

- [ ] **Step 9: 验证 meeting-room.js 圆桌 rt-file-link 不破**

启动 Hub,创建一个圆桌会话(任意),点圆桌历史回答里包含的文件路径,Expected: 仍能 openPreviewPanel 预览。

- [ ] **Step 10: Commit**

```powershell
git add renderer/path-link.js tests/unit-path-link.test.js renderer/index.html renderer/renderer.js renderer/meeting-room.js
git commit -m "feat(ui-redesign/risk): 卡片内 path-link 识别 + 共享 path-link.js (复用到 meeting-room)"
```

---

## Task 8: D4 头像 — 单 session ai-logos + 圆桌 slot 精灵

**Files:**
- Modify: `renderer/renderer.js`(renderTurnCard 加头像渲染分支)
- Modify: `renderer/styles.css`(.turn-avatar 样式)

- [ ] **Step 1: 加 ai-logos 路径映射函数**

renderer.js(renderTurnCard 上方)加:
```javascript
function aiLogoSrc(kind) {
  // 已有: claude.svg / codex.svg ...
  const known = ['claude','codex','gemini','deepseek','glm','gpt','kimi','qwen'];
  const k = (kind || '').toLowerCase();
  if (known.includes(k)) return `assets/ai-logos/${k}.svg`;
  return null;
}
function aiLetterFallback(kind) {
  const k = (kind || '?').toUpperCase();
  return k.length >= 2 ? k.slice(0, 2) : k + '?';
}
```

- [ ] **Step 2: renderTurnCard 加头像分支**

修改 renderTurnCard 头部:
```javascript
function renderTurnCard(turn) {
  const isUser = turn.role === 'user';
  const cls = isUser ? 'turn-card user' : 'turn-card';
  const who = isUser ? '你' : (turn.model || turn.kind || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';

  // 头像
  let avatarHtml;
  if (isUser) {
    avatarHtml = `<span class="turn-avatar av-user">👤</span>`;
  } else if (turn.slotPokemon) {
    // 圆桌 slot 体系: turn 数据带 slotPokemon = 'pikachu' | 'charmander' | 'squirtle'
    avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/${turn.slotPokemon}.png" alt="${turn.slotPokemon}"></span>`;
  } else {
    const logo = aiLogoSrc(turn.kind);
    avatarHtml = logo
      ? `<span class="turn-avatar av-logo"><img src="${logo}" alt="${escapeHtmlText(turn.kind || 'AI')}"></span>`
      : `<span class="turn-avatar av-letter">${escapeHtmlText(aiLetterFallback(turn.kind))}</span>`;
  }

  const rawHtml = marked.parse(turn.text || '', { breaks: true, gfm: true });
  const safeHtml = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
  const toolHtml = (turn.toolCalls || []).map((tc, i) => renderToolCall(turn.id || '', i, tc)).join('');

  return `<div class="${cls}" data-turn-id="${escapeHtmlText(turn.id || '')}">
    ${avatarHtml}
    <div class="turn-content">
      <div class="turn-head">
        <span class="turn-who">${escapeHtmlText(who)}</span>
        <span class="turn-meta">${escapeHtmlText(ts)}</span>
      </div>
      <div class="turn-body">${safeHtml}${toolHtml}</div>
    </div>
  </div>`;
}
window._renderTurnCard = renderTurnCard;
```

- [ ] **Step 3: 加 CSS**

styles.css 末尾追加:
```css
/* === Spec 1 v0.9.0 · 头像 === */
.turn-card {
  display: flex;
  gap: 10px;
}
.turn-avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.turn-avatar.av-user { background: var(--ui-purple-tint-bg); }
.turn-avatar.av-logo img,
.turn-avatar.av-poke img {
  width: 100%; height: 100%;
  object-fit: contain;
}
.turn-avatar.av-poke { background: #fef3c7; padding: 2px; }
.turn-avatar.av-letter {
  font-size: 11px;
  font-weight: 700;
  color: white;
  background: linear-gradient(135deg, var(--ui-purple-1), var(--ui-purple-2));
}
.turn-content { flex: 1; min-width: 0; }
```

- [ ] **Step 4: 准备 pokemon 图(若不存在)**

```powershell
Test-Path "C:\Users\lintian\hub-feat-ui-redesign-spec1\renderer\assets\pokemon\"
```
若不存在,从 Hub 现有空状态页找精灵图源:
```powershell
Get-ChildItem -Recurse "C:\Users\lintian\hub-feat-ui-redesign-spec1\renderer\assets" | Where-Object Name -match 'pikachu|charmander|squirtle'
```
找到后 copy 或 mkdir + copy:
```powershell
$dst = "C:\Users\lintian\hub-feat-ui-redesign-spec1\renderer\assets\pokemon"
if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null }
# Copy from existing source path (按 Get-ChildItem 找出的实际位置)
```

- [ ] **Step 5: console 验证 4 种头像**

启动隔离 Hub(端口 9347),console:
```javascript
const overlay = document.getElementById('msg-overlay');
overlay.innerHTML = '';
_mountTurnCard(overlay, {id:'a1', role:'user', text:'问题', ts: Date.now()});
_mountTurnCard(overlay, {id:'a2', role:'assistant', kind:'claude', text:'回答', ts: Date.now()});
_mountTurnCard(overlay, {id:'a3', role:'assistant', kind:'codex', text:'回答', ts: Date.now()});
_mountTurnCard(overlay, {id:'a4', role:'assistant', slotPokemon:'pikachu', text:'圆桌 turn', ts: Date.now()});
_mountTurnCard(overlay, {id:'a5', role:'assistant', kind:'unknown-ai', text:'回答', ts: Date.now()});
```
Expected: 5 张卡片,头像分别为 👤 / claude.svg / codex.svg / pikachu.png / 字母 "UN"。

- [ ] **Step 6: Commit**

```powershell
git add renderer/renderer.js renderer/styles.css renderer/assets/pokemon/
git commit -m "feat(ui-redesign/D4): 头像分支 — ai-logos / 圆桌 slot 精灵 / 字母 fallback"
```

---

## Task 9: D5 hover 操作按钮(复制 + user 重发/编辑重发 + Claude 重新生成)

**Files:**
- Modify: `renderer/renderer.js`(renderTurnCard 加 actions + click handler)
- Modify: `renderer/styles.css`(.turn-actions 样式)

- [ ] **Step 1: renderTurnCard 在 turn-content 末尾加 actions**

修改 renderTurnCard return:
```javascript
return `<div class="${cls}" data-turn-id="${escapeHtmlText(turn.id || '')}">
  ${avatarHtml}
  <div class="turn-content">
    <div class="turn-head">
      <span class="turn-who">${escapeHtmlText(who)}</span>
      <span class="turn-meta">${escapeHtmlText(ts)}</span>
      <div class="turn-actions">
        <button class="ta-btn" data-action="copy" title="复制">📋</button>
        ${isUser
          ? `<button class="ta-btn" data-action="resend" title="重发">↻</button>
             <button class="ta-btn" data-action="edit-resend" title="编辑重发">✏</button>`
          : `<button class="ta-btn" data-action="regen" title="重新生成">⏪</button>`}
      </div>
    </div>
    <div class="turn-body">${safeHtml}${toolHtml}</div>
  </div>
</div>`;
```

- [ ] **Step 2: 加 CSS**

styles.css 末尾追加:
```css
.turn-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.turn-card:hover .turn-actions { opacity: 1; }
.ta-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
.ta-btn:hover {
  border-color: var(--ui-purple-1);
  background: rgba(139, 92, 246, 0.1);
  color: var(--ui-purple-3);
}
```

- [ ] **Step 3: click handler — 复制**

renderer.js 加:
```javascript
function getTurnFromCard(cardEl) {
  // window._sessionTurns 是 Task 5 留的 hook,后续 task 11 会接通真实数据
  if (!window._sessionTurns) return null;
  return window._sessionTurns.get(cardEl.dataset.turnId);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ta-btn');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  const turn = getTurnFromCard(card);
  if (!turn) return;
  const action = btn.dataset.action;
  if (action === 'copy') {
    let md = turn.text || '';
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        md += `\n\n\`\`\`\n${tc.name} ${tc.cmd || ''}\n${tc.stdout || ''}\n\`\`\``;
      }
    }
    navigator.clipboard.writeText(md).then(() => {
      btn.textContent = '✓';
      setTimeout(() => btn.textContent = '📋', 1500);
    });
  }
});
```

- [ ] **Step 4: click handler — 重发(user only)**

继续上面的 listener:
```javascript
  if (action === 'resend') {
    // 复用 terminal-input IPC 把 prompt 重新发到 PTY
    const sid = card.closest('[data-session-id]')?.dataset.sessionId || currentSessionId;
    ipcRenderer.send('terminal-input', { sessionId: sid, data: turn.text + '\r' });
    btn.textContent = '↺';
    setTimeout(() => btn.textContent = '↻', 1500);
  }
  if (action === 'edit-resend') {
    // 把内容写回输入框,焦点末尾;原 turn 不删(spec 注:UI 层面"删除"复杂,本 task 简化为"填回输入框,用户自己改后发")
    const inputEl = document.getElementById('terminal-input-area') || document.querySelector('.input-area textarea');
    if (inputEl) {
      inputEl.value = turn.text;
      inputEl.focus();
      inputEl.setSelectionRange(turn.text.length, turn.text.length);
    }
  }
  if (action === 'regen') {
    // 找前一条 user prompt,重发
    const cards = [...document.querySelectorAll('.msg-overlay .turn-card')];
    const myIdx = cards.indexOf(card);
    for (let i = myIdx - 1; i >= 0; i--) {
      if (cards[i].classList.contains('user')) {
        const userTurn = getTurnFromCard(cards[i]);
        if (userTurn) {
          const sid = card.closest('[data-session-id]')?.dataset.sessionId || currentSessionId;
          ipcRenderer.send('terminal-input', { sessionId: sid, data: userTurn.text + '\r' });
          btn.textContent = '↺';
          setTimeout(() => btn.textContent = '⏪', 1500);
        }
        break;
      }
    }
  }
});
```

- [ ] **Step 5: console 验证操作按钮显示 + 复制工作**

启动隔离 Hub(端口 9348),console:
```javascript
window._sessionTurns = new Map([
  ['op1', {id:'op1', role:'user', text:'看下 main.js', ts: Date.now()}],
  ['op2', {id:'op2', role:'assistant', kind:'claude', text:'好,正在查...', ts: Date.now()}],
]);
const overlay = document.getElementById('msg-overlay'); overlay.innerHTML = '';
_mountTurnCard(overlay, window._sessionTurns.get('op1'));
_mountTurnCard(overlay, window._sessionTurns.get('op2'));
```
Hover user 卡片 → 看到 📋 / ↻ / ✏ 三按钮;hover assistant → 📋 / ⏪ 两按钮。点 user 的 📋,验证剪贴板:
```javascript
navigator.clipboard.readText().then(t => console.log('clipboard:', t));
```
Expected: 看到 `看下 main.js`。

- [ ] **Step 6: Commit**

```powershell
git add renderer/renderer.js renderer/styles.css
git commit -m "feat(ui-redesign/D5): hover 操作按钮 — 复制 / 重发 / 编辑重发 / 重新生成"
```

---

## Task 10: 接通真实数据源(session.turns) + 持久化折叠状态

**Files:**
- Modify: `renderer/renderer.js`(showTerminal / hook-event 处理处接入卡片渲染)
- Modify: `renderer/renderer.js`(uiState 折叠状态写入 session 持久化)
- Modify: `core/state-manager.js` 或 `main.js` 持久化段(uiState 字段)

- [ ] **Step 1: 拉通 session.turns → mountTurnCard**

找到 renderer.js `showTerminal(sessionId)` 函数(grep `function showTerminal`),在它末尾加:
```javascript
// Spec 1 v0.9.0: 同步把 turn 数据渲染成卡片
const overlay = document.getElementById('msg-overlay');
if (overlay && currentView === 'card') {
  overlay.innerHTML = '';
  const session = sessions.get(sessionId);
  if (session && session.turns) {
    if (!window._sessionTurns) window._sessionTurns = new Map();
    window._sessionTurns.clear();
    for (const turn of session.turns) {
      window._sessionTurns.set(turn.id, turn);
      mountTurnCard(overlay, turn);
    }
  }
}
```

- [ ] **Step 2: 在 hook-event 'stop' 处理处增量追加新 turn**

找到 `ipcRenderer.on('hook-event', ...)` 段,在 `if (event === 'stop')` 内 onReplyCompleteFromHook 之后加:
```javascript
// Spec 1: 增量挂卡片
const session = sessions.get(sessionId);
if (session && session.turns && session.turns.length) {
  const lastTurn = session.turns[session.turns.length - 1];
  if (!window._sessionTurns) window._sessionTurns = new Map();
  if (!window._sessionTurns.has(lastTurn.id)) {
    window._sessionTurns.set(lastTurn.id, lastTurn);
    const overlay = document.getElementById('msg-overlay');
    if (overlay && sessionId === currentSessionId && currentView === 'card') {
      mountTurnCard(overlay, lastTurn);
      overlay.scrollTop = overlay.scrollHeight;
    }
  }
}
```

注意: 上面假设 `session.turns[]` 已经在 hook 处理流程中维护;若不存在,在本 task step 3 补。

- [ ] **Step 3: 检查 session.turns 是否已存在数据结构**

```powershell
cd C:\Users\lintian\hub-feat-ui-redesign-spec1
grep -n "\.turns" renderer/renderer.js core/*.js main.js | Select-String -Pattern "session\.turns|\.turns\." | Select-Object -First 20
```
若结果为空,需要在 hook 处理处构造 turn 数据:
- UserPromptSubmit hook → push `{id, role:'user', text:latestUserMessage, ts:Date.now()}`
- Stop hook → push `{id, role:'assistant', text:从 transcript 拿, ts:Date.now(), toolCalls:从 transcript 拿}`

具体构造由 worktree 实施时按现状实现。**若 session.turns 不存在,本 task 实施变长 → 拆出 Task 10b 单独做 turns[] 数据维护**。

- [ ] **Step 4: 折叠状态持久化 — 写入 state.json**

renderer.js 加:
```javascript
function persistUiState(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.uiState) session.uiState = {};
  session.uiState.foldedTools = Array.from(_foldedToolsState.entries())
    .filter(([k]) => k.startsWith(sessionId + ':'))
    .map(([k, v]) => [k, v]);
  session.uiState.foldedCodes = Array.from(_foldedCodesState.entries())
    .filter(([k]) => k.startsWith(sessionId + ':'))
    .map(([k, v]) => [k, v]);
  schedulePersist(); // 现有 debounce 持久化
}
```

修改 setFoldedTool / `_foldedCodesState.set` 调用处加 `persistUiState(currentSessionId)`。

- [ ] **Step 5: 加载 — showTerminal 时把 uiState 灌回**

showTerminal 内 mountTurnCard 之前:
```javascript
if (session && session.uiState) {
  if (Array.isArray(session.uiState.foldedTools)) {
    for (const [k, v] of session.uiState.foldedTools) _foldedToolsState.set(k, v);
  }
  if (Array.isArray(session.uiState.foldedCodes)) {
    for (const [k, v] of session.uiState.foldedCodes) _foldedCodesState.set(k, v);
  }
}
```

- [ ] **Step 6: 启动 Hub 真实测试 — 创建 Claude session 跑短命令**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-t10"
& "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" "C:\Users\lintian\hub-feat-ui-redesign-spec1" --remote-debugging-port=9350
```

手动操作: 新建一个 Claude session,让 Claude 跑 `ls`,看主区出现卡片,工具调用块展示。Stop-Process。

- [ ] **Step 7: Commit**

```powershell
git add renderer/renderer.js core/*.js main.js
git commit -m "feat(ui-redesign/D): 接通 session.turns → 卡片渲染 + 折叠状态持久化到 state.json"
```

---

## Task 11: CDP E2E 13 场景验证脚本 + 手动验证清单

**Files:**
- Create: `tests/e2e-ui-spec1.js`

- [ ] **Step 1: 写 E2E 脚本骨架(基于之前 hub-packy-fix verify 模式)**

Create `tests/e2e-ui-spec1.js`:
```javascript
// E2E 验证 Spec 1 的 13 场景。
// 用法: node tests/e2e-ui-spec1.js
// 前置: 启动隔离 Hub 在 9351 端口 + CLAUDE_HUB_DATA_DIR=...
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9351;
const OUT_DIR = 'C:/Users/lintian/.claude-session-hub/images';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(JSON.parse(b))); }).on('error', reject);
  });
}
class CDP {
  constructor(wsUrl){ this.ws=new WebSocket(wsUrl); this.id=0; this.pending=new Map();
    this.ws.on('message',raw=>{const m=JSON.parse(raw); if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id); this.pending.delete(m.id); m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}}); }
  ready(){ return new Promise(r=>this.ws.once('open',r)); }
  send(method,params={}){const id=++this.id; return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject}); this.ws.send(JSON.stringify({id,method,params}));});}
  close(){this.ws.close();}
}
async function evalExpr(c,e){const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;}
async function shot(c,name){const r=await c.send('Page.captureScreenshot',{format:'png'}); const ts=new Date().toISOString().replace(/[:.]/g,'').slice(0,15); const out=path.join(OUT_DIR,`${ts}-${name}.png`); fs.writeFileSync(out,Buffer.from(r.data,'base64')); return out;}

const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }
const PASS = []; const FAIL = [];

// 1. 短工具调用展开
scenario('S1 短工具调用直接展开', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s1', role:'assistant', kind:'claude', text:'看', ts: Date.now(),
      toolCalls: [{name:'Bash', cmd:'ls', stdout:'a\\nb\\nc', ok:true, durationMs:200}]};
    if (!window._sessionTurns) window._sessionTurns = new Map();
    window._sessionTurns.set('s1', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const html = await evalExpr(cdp, `document.querySelector('.tc .tc-out')?.textContent`);
  if (html && html.includes('a')) return true;
  throw new Error('S1: tc-out not visible');
});

// 2. 长工具调用折叠
scenario('S2 >15 行工具调用折叠', async (cdp) => {
  await evalExpr(cdp, `(() => {
    const long = Array.from({length:20},(_,i)=>'l'+i).join('\\n');
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s2', role:'assistant', kind:'claude', text:'', ts: Date.now(),
      toolCalls: [{name:'Bash', cmd:'ls', stdout:long, ok:true, durationMs:200}]};
    window._sessionTurns.set('s2', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const toggleText = await evalExpr(cdp, `document.querySelector('.tc-toggle')?.textContent`);
  if (toggleText && /展开\s+20\s+行/.test(toggleText)) return true;
  throw new Error('S2: toggle not found, got ' + toggleText);
});

// 3. 失败工具调用始终展开
scenario('S3 失败工具调用始终展开', async (cdp) => {
  await evalExpr(cdp, `(() => {
    const long = Array.from({length:50},(_,i)=>'err'+i).join('\\n');
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s3', role:'assistant', kind:'claude', text:'', ts: Date.now(),
      toolCalls: [{name:'Bash', cmd:'bad', stdout:long, ok:false, exitCode:1, durationMs:50}]};
    window._sessionTurns.set('s3', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const out = await evalExpr(cdp, `document.querySelector('.tc-out')?.textContent`);
  const failBadge = await evalExpr(cdp, `document.querySelector('.tc-fail')?.textContent`);
  if (out && out.includes('err1') && failBadge === '✗') return true;
  throw new Error('S3: failed turn not visible / no fail badge');
});

// 4. D2 代码块 + Copy 按钮
scenario('S4 markdown 代码块 prism 高亮 + Copy 按钮', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s4', role:'assistant', kind:'claude', ts: Date.now(),
      text:'\`\`\`javascript\\nfunction f(){return 1}\\n\`\`\`'};
    window._sessionTurns.set('s4', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const hasToken = await evalExpr(cdp, `!!document.querySelector('.code-block-wrap pre code .token')`);
  const hasCopy = await evalExpr(cdp, `!!document.querySelector('.code-copy')`);
  if (hasToken && hasCopy) return true;
  throw new Error(`S4: token=${hasToken} copy=${hasCopy}`);
});

// 5. D1 跨日时间戳
scenario('S5 跨日绝对时间戳显示 5月3日 14:22', async (cdp) => {
  // formatAbsoluteTime 由 renderer 用 new Date() 比较,我们模拟一个昨天的 ts
  const yesterdayTs = await evalExpr(cdp, `(() => {
    const d = new Date(); d.setDate(d.getDate()-1); d.setHours(14, 22, 0, 0);
    return d.getTime();
  })()`);
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s5', role:'user', text:'问题', ts: ${yesterdayTs}};
    window._sessionTurns.set('s5', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const meta = await evalExpr(cdp, `document.querySelector('.turn-meta')?.textContent`);
  if (meta && /月.*日.*14:22/.test(meta)) return true;
  throw new Error('S5: meta = ' + meta);
});

// 6. D4 头像 — ai-logos
scenario('S6 单 session 头像用 ai-logos', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s6', role:'assistant', kind:'codex', text:'回答', ts: Date.now()};
    window._sessionTurns.set('s6', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const src = await evalExpr(cdp, `document.querySelector('.av-logo img')?.getAttribute('src')`);
  if (src && /codex\.svg$/.test(src)) return true;
  throw new Error('S6: src = ' + src);
});

// 7. D4 圆桌精灵
scenario('S7 圆桌 turn 用 slot 精灵', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s7', role:'assistant', slotPokemon:'pikachu', text:'圆桌发言', ts: Date.now()};
    window._sessionTurns.set('s7', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const src = await evalExpr(cdp, `document.querySelector('.av-poke img')?.getAttribute('src')`);
  if (src && /pikachu/.test(src)) return true;
  throw new Error('S7: src = ' + src);
});

// 8. D5 hover 操作按钮
scenario('S8 hover 出操作按钮', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s8', role:'user', text:'msg', ts: Date.now()};
    window._sessionTurns.set('s8', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const btnCount = await evalExpr(cdp, `document.querySelectorAll('.turn-card .ta-btn').length`);
  if (btnCount === 3) return true; // copy + resend + edit-resend
  throw new Error('S8: btn count = ' + btnCount);
});

// 9. 视图切换
scenario('S9 视图切换 PTY/卡片', async (cdp) => {
  await evalExpr(cdp, `applyViewMode('pty')`);
  const hidden = await evalExpr(cdp, `document.getElementById('msg-overlay').classList.contains('hidden')`);
  if (!hidden) throw new Error('S9: overlay should be hidden in pty mode');
  await evalExpr(cdp, `applyViewMode('card')`);
  return true;
});

// 10. .md path-link 识别
scenario('S10 卡片内 .md 路径识别成 link', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s10', role:'assistant', kind:'claude', ts: Date.now(),
      text:'看下 docs/foo.md 这个文件'};
    window._sessionTurns.set('s10', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const path = await evalExpr(cdp, `document.querySelector('.turn-body a.rt-file-link')?.dataset.path`);
  if (path === 'docs/foo.md') return true;
  throw new Error('S10: path = ' + path);
});

// 11. URL link 识别
scenario('S11 URL 识别成 link', async (cdp) => {
  await evalExpr(cdp, `(() => {
    document.getElementById('msg-overlay').innerHTML = '';
    const t = {id:'s11', role:'assistant', kind:'claude', ts: Date.now(),
      text:'访问 http://localhost:3000/api 看效果'};
    window._sessionTurns.set('s11', t);
    _mountTurnCard(document.getElementById('msg-overlay'), t);
  })()`);
  const path = await evalExpr(cdp, `document.querySelector('.turn-body a.rt-file-link')?.dataset.path`);
  if (path && path.startsWith('http')) return true;
  throw new Error('S11: path = ' + path);
});

// 12. 紫色滚动条 (computed style 检查)
scenario('S12 自定义紫色滚动条 thumb hover 颜色', async (cdp) => {
  // 直接用 evaluate 拿伪类不可行(浏览器限制),改为检查 stylesheet 是否包含 ui-purple-glow
  const has = await evalExpr(cdp, `[...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => /ui-purple-glow|webkit-scrollbar/.test(r.cssText)); }
    catch { return false; }
  })`);
  if (has) return true;
  throw new Error('S12: scrollbar CSS not loaded');
});

// 13. xterm 不被卡片层 hidden 时(PTY 视图)仍能交互(simple smoke)
scenario('S13 PTY 视图下 xterm 容器可见', async (cdp) => {
  await evalExpr(cdp, `applyViewMode('pty')`);
  const xterm = await evalExpr(cdp, `!!document.querySelector('.xterm')`);
  await evalExpr(cdp, `applyViewMode('card')`);
  if (xterm) return true;
  throw new Error('S13: xterm not present');
});

(async () => {
  const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find(p => p.type === 'page' && p.title === '圆桌');
  if (!page) { console.error('no main page on port ' + PORT); process.exit(1); }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 3000));
  for (const s of scenarios) {
    try { await s.fn(cdp); PASS.push(s.name); console.log('PASS:', s.name); }
    catch (e) { FAIL.push({name: s.name, err: e.message}); console.error('FAIL:', s.name, '—', e.message); }
  }
  await shot(cdp, 'spec1-final-state');
  cdp.close();
  console.log(`\n${PASS.length}/${scenarios.length} passed`);
  if (FAIL.length) { console.error('Failures:', JSON.stringify(FAIL, null, 2)); process.exit(1); }
})();
```

- [ ] **Step 2: 启动隔离 Hub(端口 9351)**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-e2e"
Start-Process -FilePath "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" -ArgumentList "C:\Users\lintian\hub-feat-ui-redesign-spec1","--remote-debugging-port=9351"
Start-Sleep 8
```

- [ ] **Step 3: 跑 E2E 脚本**

```powershell
node "C:\Users\lintian\hub-feat-ui-redesign-spec1\tests\e2e-ui-spec1.js"
```
Expected: `13/13 passed`,无 FAIL。

- [ ] **Step 4: 关闭隔离 Hub**

```powershell
Get-Process electron | Where-Object { (Get-NetTCPConnection -OwningProcess $_.Id -State Listen -ErrorAction SilentlyContinue).LocalPort -contains 9351 } | Stop-Process -Force
```

- [ ] **Step 5: 手动验证清单(把结果填进 commit message)**

打开桌面快捷方式 Hub(用户的生产 Hub PID 47592 必须仍正常 — **绝不 kill**),手动:
- 在用户生产 Hub 里看右上角"📇 卡片 / ⌨ PTY"按钮存在(版本号 v0.9.0 — 需要用户重启才生效,本步只验证不破坏)
- 切换不报错

(注意:本步只确认快捷方式启动不崩,生产 Hub 真正升级需要用户重启)

- [ ] **Step 6: Commit**

```powershell
git add tests/e2e-ui-spec1.js
git commit -m "test(ui-redesign): 13 场景 CDP E2E 脚本 + 验证全过"
```

---

## Task 12: 版本号同步 + 文档 + finishing

**Files:**
- Modify: `renderer/index.html`(launcher-version 改 v0.9.0)
- Modify: `CLAUDE.md`(spec 1 v0.9.0 完成 + 改动摘要)

- [ ] **Step 1: index.html 版本号**

```powershell
cd C:\Users\lintian\hub-feat-ui-redesign-spec1
```
找 `launcher-version` 改 v0.8.5 → v0.9.0:
```html
<span class="launcher-version">v0.9.0</span>
```

(package.json 在 task 1 已改)

- [ ] **Step 2: 启动隔离 Hub 验证 OS 标题栏显示 v0.9.0**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-spec1-final"
Start-Process -FilePath "C:\Users\lintian\hub-feat-ui-redesign-spec1\node_modules\electron\dist\electron.exe" -ArgumentList "C:\Users\lintian\hub-feat-ui-redesign-spec1","--remote-debugging-port=9352"
Start-Sleep 6
(Invoke-WebRequest http://127.0.0.1:9352/json/version).Content
```
Expected: `User-Agent` 含 `roundtable/0.9.0`。Stop-Process。

- [ ] **Step 3: CLAUDE.md 加一节简短改动摘要(可选)**

(若 Hub 项目 CLAUDE.md 有 changelog 段,加;无则跳过)

- [ ] **Step 4: Commit 收尾**

```powershell
git add renderer/index.html CLAUDE.md
git commit -m "chore(ui-redesign): bump version v0.8.5 -> v0.9.0 + Spec 1 完成标记"
```

- [ ] **Step 5: 调用 finishing-a-development-branch skill 决定下一步**

call superpowers:finishing-a-development-branch (合并到 master / 开 PR / 等用户拉)

---

## Self-Review (writing-plans 内置)

**1. Spec coverage**:
- ✅ G 视觉方向 B → Task 2 + Task 3 + Task 4 CSS
- ✅ G 颜色 P → Task 2
- ✅ G3 滚动条 → Task 2
- ✅ D 工具折叠 → Task 5
- ✅ D1 时间戳 → Task 4(+ unit test)
- ✅ D2 代码块 → Task 6
- ✅ D4 头像 → Task 8
- ✅ D5 操作按钮 → Task 9
- ✅ openPreviewPanel 不破坏 → Task 7(+ unit test) + Task 11 S10/S11
- ✅ session.uiState 持久化 → Task 10
- ✅ E2E 13 场景 → Task 11
- ✅ 版本号 v0.9.0 → Task 1 + Task 12

**2. Placeholder scan**:
- Task 10 step 3 提到"若 session.turns 不存在拆 Task 10b" — 这是条件分支不是 placeholder
- 无其他 TBD/TODO

**3. Type consistency**:
- `_foldedToolsState` / `_foldedCodesState` 一致使用
- `mountTurnCard` / `renderTurnCard` 命名一致
- `extractPathLinks` / `wrapPathLinksInElement` 一致
- `applyViewMode` 一致

---

## Execution Handoff

**Plan complete and saved to:**
`C:\Users\lintian\hub-feat-ui-redesign-spec1\docs\superpowers\plans\2026-05-04-hub-ui-redesign-spec1.md`

(待提交到 worktree branch)

**两种执行模式:**

1. **Subagent-Driven (推荐)** — 每个 task 派 fresh subagent 实现,我两阶段 review,迭代快
2. **Inline 执行** — 在本 session 串行做 task,checkpoint 给你 review

按 Hub 项目 CLAUDE.md 的"测试必须真实执行"铁律 + 每 task 末尾 commit + worktree 隔离,**Subagent-Driven 更稳**(单 task 失败可单独修)。

**选哪个?**
