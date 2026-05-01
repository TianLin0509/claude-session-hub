# 圆桌架构重构（阶段 1）：Shell/卡片分离 + 树形侧边栏 — 设计文档

**日期**：2026-05-02
**作者**：立花道雪
**关联 plan**：`C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-02-hub-roundtable-arch-refactor.md`
**HTML mockup**：`C:\Users\lintian\claude-session-hub\docs\hub-roundtable-arch-refactor-2026-05-02.html`
**用户决策**：Q1=A 单 viewer 严格切换 / Q2=A 极简模式 / Q3=B 分两阶段交付

---

## 1. 目标

把当前圆桌界面里"卡片摘要（产品视图）"和"shell PTY 流（调试视图）"两套相互争抢空间的结构**彻底拆分**，根治 6 个用户实际报告的 UI/渲染 bug：

| # | 用户报告 | 根因 |
|---|---|---|
| 1 | shell 压住底部按钮 | flex 高度计算 + z-index 在混合架构里争抢 |
| 2 | Gemini shell 渲染异常 | 父布局抖动触发 xterm.fit() 失稳 |
| 5 | 卡死 3min 才出逃生按钮 | 逃生按钮被沉浸 visibility 控制 + 时延门槛 |
| 6 | 模式切换渲染重复 | 普通发言/群策群力切换 → DOM 重建 → xterm 重 fit |
| 7 | 摘要截断保尾去头 | `slice(-2000)` 错向 |
| 8 | 普通→群策群力切换后终端被压缩 | 同 #6 根因 |

**剩余 #3 #4 与架构正交，分阶段 2 单独修。**

---

## 2. 设计核心

### 2.1 关注点分离原则

| 关注点 | 位置 | 视图 |
|---|---|---|
| **产品视图（卡片摘要 / 状态 / 逃生按钮）** | 圆桌 panel `#meeting-room-panel` | 永远纯卡片，无 shell |
| **调试视图（PTY 真实流 / 完整对话）** | 主区 `#shell-view-panel` | 子 session shell view |
| **关联关系** | sidebar 树形（圆桌 entry + 缩进子 session） | 一目了然 |

### 2.2 xterm 容器单 viewer 严格切换

`terminalCache.get(sessionId)` 已经返回单例 `{ terminal, fitAddon, container, opened }`。本次设计：

- xterm DOM 容器**同一时刻只挂在一处**（圆桌界面、shell view、或不挂载）
- PTY 进程从未中断；ringBuffer 持续承接输出；xterm 实例从未销毁
- 切换 = `container.remove()` + `targetMount.appendChild(container)` + `fitAddon.fit()`
- 圆桌界面**完全不挂 xterm**（mr-terminals 元素物理删除）

### 2.3 模式收敛

| 改前 | 改后 |
|---|---|
| 沉浸模式 / 调试模式（视图模式） | **删除** — 圆桌只有一种视图（纯卡片） |
| 普通发言 / 群策群力 / 总结（输入策略 + UI 切换混在一起） | **解耦** — 输入策略保留（@all / @debate / @summary 触发），UI 永不重排 |

---

## 3. UI 设计规范

### 3.1 sidebar 树形（关键样式）

```css
/* 圆桌 entry：48px 高，彩色边框，醒目 */
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
.session-item.meeting .expand-arrow {
  display: inline-block; width: 14px;
  transition: transform 200ms;
  color: var(--text2);
}
.session-item.meeting.expanded .expand-arrow {
  transform: rotate(90deg);
}

/* 子 session：32px 高，缩进 16px，灰边 */
.session-item.child {
  padding: 6px 10px 6px 28px;
  margin: 1px 0 1px 8px;
  border-left: 2px solid var(--color-border);
  background: rgba(255,255,255,0.02);
  font-size: 12.5px;
}
.session-item.child:hover {
  background: rgba(88,166,255,0.06);
  border-left-color: var(--accent-blue);
}
.session-item.child.selected {
  background: rgba(88,166,255,0.12);
  border-left-color: var(--accent-blue);
}

/* AI logo mini：14x14 圆角 */
.ai-logo-mini {
  display: inline-block;
  width: 14px; height: 14px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 6px;
}
```

### 3.2 expand state 持久化

```js
const _expandedMeetings = new Set(
  JSON.parse(localStorage.getItem('hubExpandedMeetings') || '[]')
);

function toggleExpand(meetingId) {
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  localStorage.setItem('hubExpandedMeetings',
    JSON.stringify([..._expandedMeetings]));
  renderSessionList();
}
```

新建圆桌时默认展开（首次写入 set）。

### 3.3 主区 view 切换

`#meeting-room-panel` 与 `#shell-view-panel` 互斥，通过 CSS `display:none/block` 切换：

```js
function showMainView(viewName, sessionId) {
  // viewName: 'meeting' | 'shell' | 'normal-session' | 'welcome'
  meetingRoomPanel.style.display = (viewName === 'meeting') ? 'flex' : 'none';
  shellViewPanel.style.display = (viewName === 'shell' || viewName === 'normal-session') ? 'flex' : 'none';
  if (viewName === 'shell' || viewName === 'normal-session') {
    mountTerminalToMainShell(sessionId);
  } else {
    unmountFromMainShell();
  }
}
```

---

## 4. 数据契约

**state.json schema 零改动**。复用：

| 字段 | 用途 |
|---|---|
| `sessions[].id` | session UUID |
| `sessions[].kind` | claude/gemini/codex/deepseek/glm/powershell |
| `sessions[].meetingId` | 反向指针 → meeting，过滤 regularSessions |
| `meetings[].id` | meeting UUID |
| `meetings[].subSessions[]` | 子 session id 数组（≤3） |
| `meetings[].slotSpecs[]` | 创建时的 kind+model 配置 |

**localStorage 新增**：

| Key | 类型 | 用途 |
|---|---|---|
| `hubExpandedMeetings` | JSON string array | 折叠展开状态 |

---

## 5. 后端改动

**几乎零** — session-manager.js / meeting-room.js (core) / state-store.js 完全不动。仅 main.js 一处兼容性收尾：

```js
// main.js: save-immersive-mode handler 改 no-op
// 老 state.json 可能写过，但不再生效
ipcMain.handle('save-immersive-mode', (_e, { meetingId, immersive }) => {
  // DEPRECATED 2026-05-02: 沉浸/调试模式切换已删除，圆桌只有一种视图
  return { ok: true };
});
```

---

## 6. 兼容性

| 维度 | 兼容性 |
|---|---|
| 老 state.json | ✅ 兼容（meetingId / subSessions schema 不变） |
| 老 immersiveByMeeting 字段 | ✅ 读但忽略，no-op handler |
| 创建圆桌 IPC（create-meeting + slots[]） | ✅ 不动 |
| 圆桌发言 IPC（roundtable:turn） | ✅ 不动 |
| 圆桌内部 Gemini/Codex resume | ✅ 不动（sub-session 内部机制） |
| 普通 session shell 视图 | ✅ 改为复用 cache，体验不变 |
| Pilot mode（meetings[].pilotSlot） | ✅ 不动（用户未提及） |
| Meeting timeline / cursors | ✅ 不动 |

---

## 7. 测试

### 7.1 E2E（CDP 真测）

新建 `C:\Users\lintian\claude-session-hub\tests\_e2e-arch-refactor-verify.js`，12 步覆盖：

1. 启动隔离 Hub `CLAUDE_HUB_DATA_DIR=C:\temp\hub-arch-refactor`
2. 创建圆桌（gemini+codex+deepseek） → assert sidebar 树形
3-4. expand 折叠/展开测试
5-6. 子 session 点击 ↔ 圆桌切换，xterm attach/detach
7. assert 圆桌界面 DOM **不存在** mr-terminals
8. 圆桌发言"@all 你好" → 三家卡片渲染
9. assert 卡片"等待中"立即出 [提取/跳过/进 shell]，无 3min 等待
10. 点"进 shell" → 切子 session shell view
11. 超 2000 字回答 → 截尾保头 + 截断提示
12. 截断提示 click → 进 shell

**截图归档**：`C:\Users\lintian\claude-session-hub\tests\screenshots\arch-refactor\`
**AI 用 Gemini + Codex + DeepSeek**，禁动用户 Claude session（CLAUDE.md 铁律）

### 7.2 grep 残留检查

```bash
# 应为 0 命中
grep -rn "mr-terminals\|subTerminals\|_immersiveByMeeting\|_toggleMeetingMode\|_applyMeetingMode\|mr-shell-area\|focus-mode" \
  C:/Users/lintian/claude-session-hub/renderer/
```

### 7.3 四路审查

按 `/cli-caller` skill Part 6 模板，并行：
- Claude 自审（Read + Grep）
- Gemini MCP（mcp__gemini-cli__chat）
- Codex MCP（mcp__codex-cli__codex，sandbox: read-only）
- DeepSeek MCP（mcp__deepseek__chat_completion，model: deepseek-v4-pro）

---

## 8. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | xterm 容器 detach/attach 闪烁 | 中 | rAF + opacity transition；attach 后立即 fitAddon.fit() |
| R2 | PTY 输出 detach 期堆积 | 低 | ringBuffer + xterm 内部 buffer 已支撑，attach 后自动续写 |
| R3 | localStorage race | 低 | 同步写，不引入 IPC |
| R4 | 老 state.json 含 immersiveByMeeting | 低 | no-op handler |
| R5 | 老用户找不到"调试模式" | 中 | 子 session shell 等价，且更鲁棒（直接看真实 PTY） |
| R6 | 圆桌内 codex/gemini resume 未触动 | 中 | E2E Task 8 验证圆桌发言链路 |
| R7 | sidebar 子 session 闪现/重排（创建中） | 低 | 创建顺序已是同步 IPC，重绘只在 session-created 后触发 |

---

## 9. 版本号

`package.json` version `+0.1`（具体由当前版本基础上递增）。

---

## 10. 文件总览

### 改动文件
- `C:\Users\lintian\claude-session-hub\renderer\renderer.js`（~250 行新增 + 改写）
- `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`（~400 行删除 + 改写）
- `C:\Users\lintian\claude-session-hub\renderer\index.html`
- `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`（删除沉浸 CSS）
- `C:\Users\lintian\claude-session-hub\renderer\styles.css`（新增树形 CSS）
- `C:\Users\lintian\claude-session-hub\main.js`（save-immersive-mode handler 改 no-op）
- `C:\Users\lintian\claude-session-hub\package.json`

### 新增文件
- `C:\Users\lintian\claude-session-hub\renderer\assets\ai-logos\{claude,gemini,codex,deepseek,glm}.svg`
- `C:\Users\lintian\claude-session-hub\tests\_e2e-arch-refactor-verify.js`

---

## 11. 开放问题（已逐项决策，无待定）

- ✅ Shell 归属：单 viewer 严格切换（Q1=A）
- ✅ 模式切换：删除沉浸/调试，输入策略保留（Q2=A）
- ✅ 范围：分两阶段，本次只做架构主线（Q3=B）
- ✅ sidebar 树形 UI：圆桌 48px 大边框 + 子 session 32px 缩进
- ✅ AI logo：复用或自画兜底
- ✅ 逃生按钮：常驻三按钮（提取/跳过/进 shell），无 3min 时延
- ✅ 截断方向：截尾保头（slice(0, 2000)）+ 截断提示链接到 shell
- ✅ 老用户调试需求：通过子 session shell view 等价满足

---

## 12. 阶段 2 预告（不在本设计范围）

| Issue | 文件 | 修复方向 |
|---|---|---|
| #3 `@summary @deepseek` 不识别 | `meeting-room.js:38, 2365-2371` | 正则补 `deepseek\|glm`；快捷菜单补 deepseek/glm 选项 |
| #4 cli-ready 状态首次延迟 | `meeting-room.js:1839-1863, openMeeting` | openMeeting 时主动 invoke `cli-ready-status` 一次；修复 roundtableReady 快路径未置真 bug |

预计 1 工作日。
