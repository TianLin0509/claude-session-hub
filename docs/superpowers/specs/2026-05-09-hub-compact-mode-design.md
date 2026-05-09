# Hub 简洁模式 + 主区 Pinch Zoom · Design

- **Date**: 2026-05-09
- **Author**: 立花道雪 + Claude
- **Status**: Implemented (差异详见末尾"实施回顾"章节)

---

## 1. 背景

立花道雪日常用手机远程桌面到电脑操作 Hub。Hub UI 按桌面分辨率设计、元素密度高、字号偏小，远程到 6 寸手机屏后元素难戳、信息冗杂。

本 spec 解决两件事：

1. 一键切换的**简洁模式**，把桌面态 UI 压缩为移动友好态（7 项 CSS 简化）
2. 主区**双指 pinch zoom**（类比 Chrome 整页 zoom），让主区字号可在手机端按需放大/缩小

**v1 不在范围**：圆桌界面（`#meeting-room-panel`）、长按代替右键、输入栏贴底浮动、侧栏 60px 图标条、预览覆盖式、zen 全屏。这些是更激进的方案，单独 ticket 推进。

## 2. 方案概览

两个独立特性，共用同一份持久化（`state.json` 新增 `uiPrefs` 字段）：

| 特性 | 控制 | 作用域 | 实现层 |
|---|---|---|---|
| 简洁模式 | `body.compact-mode` class | 全局 UI | 纯 CSS rule |
| 主区 zoom | CSS `--main-zoom` 变量 + xterm `fontSize` 联动 | 仅 `#terminal-panel` | JS event + CSS calc |

## 3. 简洁模式

### 3.1 触发

- `renderer/index.html` 的 `.view-toggle` 容器加第三颗按钮：
  ```html
  <button class="view-toggle-btn compact-toggle-btn" title="简洁模式（手机远程友好）">📱 简洁</button>
  ```
  **注意**：现有 view-toggle 用 `data-view="card|pty"` 互斥切换，简洁模式是**叠加** toggle（可与卡片/PTY 并存），不复用 `applyViewMode` 互斥语义，加独立 handler。

- `renderer/renderer.js` 加 `toggleCompactMode(enabled)`：
  - body 加/移 `.compact-mode` class
  - 按钮加/移 `.active` class
  - 调 `persistUiPref('compactMode', enabled)`

### 3.2 持久化

- `core/state-store.js` `defaultState()` 加：
  ```js
  uiPrefs: { compactMode: false, mainZoom: 1.0 }
  ```
- `_normalizeState` 加 default 兜底（兼容老 state.json）
- `main.js` 加 IPC 通道 `set-ui-prefs` 接收 renderer 写入请求（参考现有 IPC 风格）
- Hub 启动时 renderer 初始化阶段读 `uiPrefs` → 应用 compactMode + mainZoom

### 3.3 7 项简化（纯 CSS · `body.compact-mode` 选择器）

| # | 简化项 | 关键规则 |
|---|---|---|
| 1 | usage 三栏折叠 | `.compact-mode #account-usage .usage-item { display: none }` + 加 `.usage-collapsed` 单行芯片，点击 toggle `.account-usage-expanded` 类还原显示 |
| 2 | 会话行 compact | `.compact-mode .session-cwd, .compact-mode .session-preview, .compact-mode .session-meta:not(.ctx-pct) { display: none }` + 行 padding 从 ~10px 压到 ~5px |
| 3 | 侧栏头部按钮收纳 | `.compact-mode .btn-roundtable, .compact-mode .resume-picker-wrapper, .compact-mode .options-wrapper { display: none }` + 显示新增 `.sidebar-overflow-btn`（⋯）→ 浮层菜单包含原 3 项 |
| 4 | session footer 元数据藏 | 第 2 条覆盖（model+tokens 在 `.session-meta` 内） |
| 5 | 启动器降级 | `.compact-mode .launcher-trio, .compact-mode .launcher-subtitle { display: none }` + `.launcher-title { font-size: 17px }` |
| 6 | 快捷键提示行藏 | `.compact-mode .launcher-kbd-row { display: none }` |
| 7 | 预览 zoom 按钮藏 | `.compact-mode #preview-zoom-out, .compact-mode #preview-zoom-in, .compact-mode #preview-zoom-reset, .compact-mode .preview-zoom-label { display: none }` |

### 3.4 ctx 占比小标签（仅简洁模式显示）

每个会话在标题右侧显示 `42%` 小标签，颜色按阈值变。**仅简洁模式下显示**——简洁模式 OFF 时与现有 UI 完全一致，无新增视觉元素，避免污染常规态。

- HTML 结构（renderer.js 的会话渲染函数追加，DOM 节点常驻但默认 hidden）：
  ```html
  <span class="session-ctx-pct" data-pct="42">42%</span>
  ```
- 显隐控制：
  ```css
  .session-ctx-pct { display: none; }
  body.compact-mode .session-ctx-pct { display: inline-block; }
  ```
- 数据来源：每个 session 有 `tokens` + `model`，需 model → context window size 映射。
  - **plan 阶段确认**：Hub 是否已有 `contextWindow` / `tokenLimit` 映射（grep）；若无需新加常量表（claude-opus-4-7 = 200000、gpt-5.5 = 128000、gemini-2.5 = 1000000 等）
- 颜色阈值（渲染时打 class）：
  - `pct < 60`：默认灰 `#6c7686`
  - `60 ≤ pct < 85`：黄 `#f0b132`（加 `.pct-warn`）
  - `pct ≥ 85`：红 `#ec5959`（加 `.pct-danger`）

## 4. 主区 Pinch Zoom

### 4.1 作用域

- **作用**：`#terminal-panel` 子树（卡片视图、PTY 终端、empty-state 启动器）
- **不作用**：`#session-sidebar`、`.view-toggle`、`.preview-panel`、`.memo-panel`、所有 `.modal-overlay`、`#meeting-room-panel`

### 4.2 触发

- 双指 pinch（Chromium 内核把 pinch 派发为 `wheel + ctrlKey=true` 事件）
- `Ctrl+滚轮`（与 pinch 等价）
- `Ctrl+0` 重置 1.0x
- `Ctrl+=` / `Ctrl+-` 步进 ±0.1

监听挂在 `#terminal-panel` 上（不是 `document`），避免 sidebar 滚动误触；keydown 因键盘事件不冒泡到具体元素，挂 `document` 但只在主区有 active session 时生效。

### 4.3 实现

**全局状态**：`renderer.js` 加变量 `mainZoom`（默认 1.0）+ 函数 `setMainZoom(value)`：

```js
function setMainZoom(value) {
  mainZoom = Math.max(0.5, Math.min(2.5, Math.round(value * 10) / 10));
  document.getElementById('terminal-panel').style.setProperty('--main-zoom', mainZoom);
  // xterm 字体联动：复用现有 currentFontSize cascade 机制
  applyXtermFontSize();  // 内部对每个 cached terminal 改 fontSize + fitAddon.fit()
  persistUiPref('mainZoom', mainZoom);
}
```

**xterm 集成**：renderer.js ~411 行已有"批量改 cached terminal fontSize + fit"的循环模式，`currentFontSize` 是字号唯一来源。集成方案：

- 新增 `effectiveFontSize = baseFontSize * mainZoom`
- 把现有 `currentFontSize` 重命名为 `baseFontSize`（默认 14），mainZoom 作为乘数
- `applyXtermFontSize()` 用 `effectiveFontSize` 写入 `terminal.options.fontSize`
- **plan 阶段对齐**：现有 `currentFontSize` 的所有调用点（grep），改为读 `effectiveFontSize`

**CSS 联动**（卡片视图、启动器等非 xterm 文本）：
```css
#terminal-panel { --main-zoom: 1; }
#msg-overlay .msg-card-text { font-size: calc(13px * var(--main-zoom)); }
.empty-state .launcher-title { font-size: calc(22px * var(--main-zoom)); }
.empty-state .launcher-subtitle { font-size: calc(13px * var(--main-zoom)); }
.empty-state .launcher-cta { font-size: calc(14px * var(--main-zoom)); }
```
**plan 阶段补全**：枚举 `#terminal-panel` 子树所有有显式 font-size 的元素，统一改 `calc(... * var(--main-zoom))`。

### 4.4 防 Electron 整页 zoom 兜底

Electron BrowserWindow 默认 Ctrl+wheel 触发 `webFrame` 整页 zoom（连 sidebar 都会缩）。两道防线：

1. `main.js` 启动时锁死 visual zoom：`mainWindow.webContents.setVisualZoomLevelLimits(1, 1)`
2. 主区 wheel handler 里 `e.preventDefault()`，只让自己的 zoom 逻辑生效

## 5. 文件改动清单

| 文件 | 改动 |
|---|---|
| `renderer/index.html` | view-toggle 加第三颗"简洁"按钮；sidebar-header 加 `.sidebar-overflow-btn`（默认 hidden）；usage 加单行 collapsed chip 占位 |
| `renderer/styles.css` | 加 `body.compact-mode` 下 7 类简化规则；加 `#terminal-panel { --main-zoom: 1 }` + 主区文本 `calc(... * var(--main-zoom))`；加 `.session-ctx-pct` + `.pct-warn` / `.pct-danger` 颜色 |
| `renderer/renderer.js` | `toggleCompactMode`、`setMainZoom`、wheel/keydown handler、ctx 占比渲染（含 model→context window 映射）、启动恢复 `uiPrefs`；重命名 `currentFontSize` → `baseFontSize` 并接入 mainZoom |
| `core/state-store.js` | `defaultState` 加 `uiPrefs`；`_normalizeState` 加 default 兜底 |
| `main.js` | `setVisualZoomLevelLimits(1, 1)` 锁整页 zoom；加 IPC `set-ui-prefs` 通道写入 state.json |

## 6. 测试

### 单元
- `state-store`：`uiPrefs` 字段读写、merge 不破坏现有字段、缺字段时 default 兜底
- ctx 占比阈值边界：59/60/84/85 四个临界点 class 切换正确

### E2E（CDP 驱动隔离 Hub，参照 `tests/e2e-multi-hub-stress.test.js` 模式）
1. 启动 Hub，点"简洁"按钮 → DOM 验证 7 类元素 visibility 切换正确
2. 重启隔离 Hub → `uiPrefs.compactMode === true` 恢复，按钮显示 active 状态
3. 触发 `wheel + ctrlKey` → `--main-zoom` CSS 变量变化、xterm 实例 `fontSize` 同步、sidebar 计算样式 font-size 不变
4. `Ctrl+0` → mainZoom 重置回 1.0
5. 边界：连续 wheel 试图 < 0.5 / > 2.5 → 卡在 [0.5, 2.5] 不再变化
6. ctx 占比：构造 model='claude-opus-4-7' + tokens=170000（85%）→ session 行有 `.pct-danger` class 且文字红色

### 人工验证（不能 E2E）
- 真机用手机远程桌面（ToDesk / 微软 Remote Desktop）连接电脑 Hub，双指 pinch 是否正确触发主区 zoom 不连带 sidebar 缩放

## 7. 风险 & 待确认

| 项 | 风险 | 兜底 |
|---|---|---|
| xterm `currentFontSize` 调用点散落 | 重命名 + 接入 mainZoom 时漏改导致字号双源不一致 | plan 阶段全 grep `currentFontSize`，每个调用点改成 `effectiveFontSize` 或 `baseFontSize` 看语义 |
| ~~ctx 占比常驻 vs 仅简洁模式显示~~ | 已确认：仅简洁模式显示（spec 3.4 节定稿） | — |
| 多 Hub 同改 uiPrefs | state-store 是 per-field LWW，但 uiPrefs 是顶层对象，多 Hub 同时改字号会整 uiPrefs LWW | 可接受 —— uiPrefs 是用户级偏好，跨 Hub 共享同一份合理 |
| Electron 整页 zoom 残留 | `setVisualZoomLevelLimits(1,1)` 设了之后某些 Chromium 版本仍可能有边缘 case | E2E 测试覆盖 + 手动远程桌面真机验证 |
| pinch 手势经远程桌面客户端转发 | 不同远程桌面客户端对多点触控转发支持不一致 | 不在 Hub 控制范围；若失败提供 Ctrl+wheel + Ctrl+/- 键盘 fallback |

## 8. 不在 v1 范围

明确排除（来自 brainstorming 阶段 B/C 包及更激进项），单独 ticket 推进：
- 侧栏 60px 图标条（B8）
- 长按代替右键菜单（C9）
- 圆桌输入栏贴底浮动（C10）
- 预览覆盖式而非分栏（D11）
- zen 全屏（D12）
- 圆桌 (`#meeting-room-panel`) 任何改动

---

**验收标准**：
1. 简洁模式 ON 时 sidebar / 主区按 7 项简化压缩，OFF 时恢复完整态
2. 主区 pinch / Ctrl+wheel 仅缩放主区文本（含 xterm + 卡片视图），sidebar 不变
3. Hub 重启后 uiPrefs 完整恢复（compactMode + mainZoom）
4. 多 Hub 实例下 uiPrefs 不破坏现有 sessions/meetings 持久化

---

## 9. 实施回顾（2026-05-09 落地实际差异）

### 9.1 Hub 已有实现，本 spec 简化的部分

勘探后发现 Hub 已经实现了 spec 设计的部分功能，无需重新建：

| spec 设计 | Hub 现状 | 实际实施 |
|---|---|---|
| 全新 `mainZoom` 状态 + wheel/keydown handler | `setFontSize()` 已绑 Ctrl+wheel/=/-/0 + xterm cascade | 复用现有 setFontSize，不新建变量；不重命名 currentFontSize |
| `state.json` 持久化 `uiPrefs` | 已用 localStorage 持久化字号/zoom 等 UI 偏好 | 简洁模式也走 localStorage（`claude-hub-compact-mode`），不动 state.json |
| 新增 ctx 占比 `.session-ctx-pct` 元素 + 颜色阈值 | 已有 `s.contextPct` + `pctClass()` + `.ctx-badge` 全套 | 不新建元素，简洁模式下藏 `.model-badge`/`.burn-badge` 保留 `.ctx-badge` |
| model→contextWindow 映射表 | `s.contextPct` 已预先算好 | 不需要 |
| `setVisualZoomLevelLimits(1,1)` 防整页 zoom | renderer.js:1077 注释明确说 non-text areas 整页 zoom 已禁用 | 不需要新加 |

### 9.2 本轮新增功能（超出原 spec）

| # | 功能 | 文件 | 备注 |
|---|---|---|---|
| 8 | 简洁模式下 sidebar 默认折叠 + ❯/❮ 切换箭头 | `renderer.js`/`styles.css` | 复用现有 `applySidebarCollapsed`；箭头方向按 `sidebar-collapsed` class 切换；简洁模式按钮美化（圆形 32px、半透明边框、紫色 hover）；展开态按钮位置 `left: 288px`（sidebar 右边缘） |
| 9 | 圆桌右上角加简洁按钮 | `meeting-room.js` `renderHeader` 模板 | inline 进 mr-header-right 工具栏（不浮空 absolute），与并列/Tab/+ 添加同行同 size；click handler 改用 `.compact-toggle-btn` class selector 兼容多按钮 |
| 10 | 圆桌简洁模式下点卡片 = 单卡 fullscreen 阅读 | `meeting-room.js` click handler + `meeting-room.css` | 复用 `mr-card-focus-on`，CSS 加 `body.compact-mode.mr-card-focus-on` 选择器升级为 fullscreen；隐藏 `mr-header` / `mr-toolbar`，**保留 `mr-input-row`** 方便阅读后立刻输入；非主卡 `display:none`；同卡再点也退出（手机 tap 语义） |
| 11 | 输入框写入保护（用户原则） | `renderer.js` / `meeting-room.js` | "除发送 / 手动编辑外不应改 input"。3 处自动覆盖加 input 非空保护：edit-resend (renderer.js:2551)、ob-card click (meeting-room.js:2003)、quote menu (meeting-room.js:4374) |

### 9.3 文件改动最终清单

| 文件 | 改动量 |
|---|---|
| `renderer/index.html` | view-toggle 加第三颗 "📱 简洁" 按钮；btn-expand-sidebar 默认箭头 ▶ → ❯ |
| `renderer/styles.css` | `body.compact-mode` 下 7 项简化规则；`#terminal-panel { --main-zoom: 1 }` + 主区文本 calc；简洁模式下 btn-expand-sidebar 圆形美化（两种状态都显示 + 展开态 left:288px）；`#account-usage` 折叠用 `!important` 覆盖 inline style |
| `renderer/renderer.js` | `setFontSize` 加 `--main-zoom` 联动；`toggleCompactMode` + click handler；`applySidebarCollapsed` 加箭头切换；启动 init 简洁模式兜底折叠 sidebar；`applyViewMode` 跳过非视图按钮；`edit-resend` 加 input 非空保护 |
| `renderer/meeting-room.js` | 卡片 click handler 简洁模式下"同卡再点退出"；`renderHeader` 模板加简洁按钮；ob-card click + quote menu 加 input 非空保护 |
| `renderer/meeting-room.css` | `body.compact-mode.mr-card-focus-on` fullscreen 样式：藏 mr-header / mr-toolbar，留 mr-input-row，主卡撑满 |

### 9.4 多路审查发现 + 修复（2026-05-09）

**审查者**：Claude / Gemini MCP / Codex MCP / DeepSeek v4-pro MCP

**共识高置信度问题**（Codex + DeepSeek 都发现）：
- **`--main-zoom` CSS 变量作用域错误**：原本定义在 `#terminal-panel` 上，但圆桌 `#meeting-room-panel` 是 `#terminal-panel` 的兄弟节点，不会继承到该变量。结果：简洁模式下圆桌 fullscreen 卡片的 `font-size: calc(15px * var(--main-zoom, 1))` 永远 fallback 1，不会随 setFontSize 缩放
- **修复**：`--main-zoom` 提升到 `:root`（`document.documentElement`）。styles.css 改为 `:root { --main-zoom: 1; }`，renderer.js 的 `setFontSize` + 启动 init 都改为写 `document.documentElement.style.setProperty(...)`。CDP 验证：`#meeting-room-panel` 现在能继承到 `--main-zoom: 1.250`（setFontSize(20) 后）

**未采纳**（Codex 单路发现，权衡后保留现状）：
- `_restoreInputDraft()` 和 `setupInput()` 仍 `inputBox.textContent = _inputDraftByMeeting[...]` 自动写入。Codex 认为违反"除发送/手动编辑外不写"原则。**实际这是 per-meeting draft 恢复机制 —— 是用户原话"圆桌输入框完全独立"的实现核心**，加保护反而破坏 per-meeting 独立性（用户在 meeting B 写一半 → 切到 A 看 → 切回 B 时 draft 不恢复）。保持现状

### 9.5 测试覆盖

**已 E2E**（CDP 隔离 Hub）：
- 简洁模式 button toggle、body class、localStorage 持久化、reload 恢复
- 7 项简化项 visibility（usage 三栏、launcher trio/subtitle/kbd-row 等）
- 主区 zoom 联动：`setFontSize(20)` → `--main-zoom=1.250`、launcher-title `21.25px`
- sidebar 自动折叠 + 箭头方向切换 ❯/❮ + 展开态按钮 left:288px
- 简洁模式 OFF 完整恢复（含 sidebar 用户偏好）
- 圆桌右上角简洁按钮存在 + active 同步两个按钮

**未 E2E（依赖真实 meeting 数据）**：
- 圆桌 mr-header inline 简洁按钮的视觉位置（已用手动 inject HTML 验证排版）
- 圆桌单卡 fullscreen 视觉效果（CSS 选择器静态正确，syntax 正常）
- 双指 pinch 手势经远程桌面真机转发是否触发 `wheel + ctrlKey`（依赖远程桌面客户端）

---
