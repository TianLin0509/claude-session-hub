# 圆桌卡片二期优化 · 设计文档

> 2026-05-01 · 立花道雪
>
> **关联资源**
> - HTML mockup：`docs/roundtable-card-optimization-2026-05-01.html`
> - 前置依赖（必须已合入 master）：
>   - `docs/superpowers/plans/2026-05-01-roundtable-card-redesign.md`（一期：Pokemon 头像、stats 数据通道）
>   - `docs/superpowers/plans/2026-05-01-roundtable-input-fixes.md`（输入框修复 + cli-ready-status IPC）
> - 不冲突可并行：latency / resilience plan

---

## 1. 目标

4 个优化点合一交付：

1. **行 1/2 信息密度提升** — 把 row3/row4 的⏱时间统计、🪙token 统计合并到 row1/row2 行末（push to right），preview 区从 ~96px 提到 ~140px（约 4 行）
2. **流式预览净化（方案 B 升级版）** — 三家 CLI 全部改走 JSONL transcript 实时 tail，PTY 仅作启动头几秒兜底；Claude 独家支持 thinking / tool_use 块的结构化渲染
3. **沉浸 / 调试模式切换** — header 右侧加切换按钮，沉浸模式下 shell 完全隐藏、cards-tab 占满上半部；底部 toolbar + 输入框布局占比恒定不变
4. **动态重排兜底** — `ResizeObserver` + `xterm.fit()` + CSS 防溢出三件套，杜绝模块重叠与过期布局

非目标（Out of Scope）：
- 不改 toolbar 按钮顺序（input-fixes 已做）
- 不动头像样式（card-redesign 一期已做）
- 不改 turn 完成判定逻辑（仍按 `_rtWaitTurnComplete` + transcript-tap 的 `turn-complete` 事件）

---

## 2. 优化 1 — 行 1/2 信息密度提升

### 2.1 现状

`renderer/meeting-room.js:_ftHtml`（约 224-239 行）当前结构：

```
row1: [Avatar] [Name] [StatusBadge]
row2: [ModelTag] [CtxTag]
row3: ⏱ 本轮 Ns · 累计 Nm
row4: 🪙 本轮 Nk · 累计 Nk
divider
preview (max-height ≈ 96px)
```

`renderer/meeting-room.css:.mr-ft-preview`（约 566-569 行）`max-height: 54px`。

### 2.2 目标布局

```
row1: [Avatar] [Name] [StatusBadge] ......................... [⏱ 本轮 Ns · 累计 Nm]
row2: [ModelTag] [CtxTag] ................................... [🪙 本轮 Nk · 累计 Nk]
divider
preview (flex: 1, 占满 row1/row2 之外的全部空间，约 140px)
```

stats 用 `margin-left: auto` push 到右端。卡片整体高度仍为固定 220px（与 card-redesign 一期 align），preview 区因为去掉了 row3/row4 多出 ~44px 给 markdown 内容。

### 2.3 改造范围

| 文件 | 改动 |
|---|---|
| `renderer/meeting-room.js` | `_ftHtml` 的 row1/row2 模板插入 stats span；删除 row3/row4 的 HTML 生成 |
| `renderer/meeting-room.css` | 删 `.mr-ft-elapsed` / `.mr-ft-tokens-row` 样式；新增 `.mr-ft-stat-inline`；调整 `.mr-ft-preview` `max-height` → `flex:1` |

### 2.4 数据契约

复用 card-redesign 一期已落地的 stats 字段（`partial.thinkSec` / `partial.tokens`）。本期不引入新 IPC 字段，仅做 UI 布局重排。

### 2.5 响应式降级

当卡片 `containerWidth < 280px`（4 卡极窄场景）时，stats 自动换行回单独一行，避免与状态徽章挤压：

```css
@container (max-width: 280px) {
  .mr-ft-stat-inline { flex-basis: 100%; margin-left: 0; }
}
```

需 `.mr-ft` 设 `container-type: inline-size`。

---

## 3. 优化 2 — 流式预览净化（方案 B 升级版）

### 3.1 现状

`main.js:_rtExtractStreamingText(sid)`（约 649-674 行）每 1500ms 抽 PTY ringBuffer 尾部 500 字符 → 4 轮 ANSI 正则剥离 → 反向扫掉 PowerShell 提示符 / 圆桌标记 / `##用户问题` / `quota` → 通过 `roundtable-partial-update` IPC 推到 renderer。

三家 CLI 共用此 PTY 路径。结果：Claude TUI 的 `thinking more with xhigh effort` 等 throbbing 状态行直接进入 preview，体验糟糕。

### 3.2 调研结论（已实测）

| AI | 原生流式数据源 | 粒度 | 当前是否用上 |
|---|---|---|---|
| **Claude** | `~/.claude/projects/<slug>/<sid>.jsonl` | 块级（thinking / text / tool_use 各一行 JSONL） | ✗ 仅 Stop hook 时读尾部，未做 tail |
| **Gemini** | `~/.gemini/tmp/<hash>/chats/session-*.jsonl` | chunk 级（每行 `type:"gemini"`） | ⚠ 已 tail 但仅用于 token 计数 + 完成判定，content 未对外暴露 |
| **Codex** | `~/.codex/sessions/<date>/rollout-*.jsonl` | delta 级（`event_msg.payload.type=agent_message_delta`） | ✗ 协议存在但项目未监听 |

**关键事实**：Claude transcript 是<strong>块级实时追加</strong>（同一 message_id 的 thinking/text/tool_use 块按时序异步落盘，间隔 100-2000ms），不是 Stop 后整块写。所以三家全部可以做 JSONL tail 流式。

### 3.3 新数据流

```
[Claude TUI session]
  ↓ 块级追加
~/.claude/projects/.../sid.jsonl
  → ClaudeTap.JsonlTail.onLine()  ← 新增
  → 缓存 thinking/text/tool_use 块到 _streamingBuf[sid]
                                ↓
[Gemini TUI session]
  ↓ chunk 追加
~/.gemini/tmp/.../session-*.jsonl
  → GeminiTap.onLine()（既有）+ 累积 content 到 _streamingBuf[sid]  ← 新增累积
                                ↓
[Codex TUI session]
  ↓ delta 追加
~/.codex/sessions/.../rollout-*.jsonl
  → CodexTap.onLine() + 新增 agent_message_delta 分支  ← 新增
  → 缓存 delta 到 _streamingBuf[sid]
                                ↓
       ┌──────────────────────────────────────┐
       │ transcriptTap.getStreamingText(sid)  │  ← 新接口
       └──────────────────────────────────────┘
                                ↓
main.js _rtExtractStreamingText(sid, kind)
  if (tap.getStreamingText(sid)) → 直接用（纯净）
  else → 走 PTY + 简化过滤器（兜底，仅启动头几秒）
                                ↓
IPC 'roundtable-partial-update' → renderer mc-preview
```

### 3.4 三家 CLI 改造

#### 3.4.1 ClaudeTap（`core/transcript-tap.js`）

参考 `CodexTap._scanOnce` 已有模式，新增 watcher：

```js
// ClaudeTap 新增字段
this._pending = new Map();  // hubSessionId → { cwd, spawnTime }
this._bound = new Map();    // hubSessionId → { jsonlPath, tail, _streamingBuf, lastText }
this._pollTimer = null;
this._scanning = false;

registerSession(hubSessionId, { cwd } = {}) {
  this._pending.set(hubSessionId, {
    cwd: normalizePathForCompare(cwd || process.cwd()),
    spawnTime: Date.now(),
  });
  this._ensureWatcher();
}
```

`_scanOnce` 扫 `~/.claude/projects/<slug>/`（slug = cwd → URL-safe slug，参考 Claude Code CLI 规则：`/` → `-`，windows 盘符冒号去掉），找 mtime ≥ spawnTime - 2s 且未 seen 的最新 `.jsonl`，绑定到 hubSessionId。

JsonlTail.onLine 处理：

```js
const onLine = (obj) => {
  const entry = this._bound.get(hubSessionId);
  if (!entry) return;
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
      entry._streamingBuf.push({ type: 'tool_use', name: block.name, input: block.input });
    }
  }
  // Stop 信号检测：obj.message.stop_reason === 'end_turn'
  if (obj.message.stop_reason === 'end_turn') {
    // 不在这里 emit turn-complete（Stop hook 已处理）；此处仅作为缓存终点提示
  }
};
```

新增方法：

```js
getStreamingText(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (!entry || !entry._streamingBuf || entry._streamingBuf.length === 0) return null;
  return [...entry._streamingBuf];  // 返回结构化数组，不是字符串
}

clearStreamingBuf(hubSessionId) {
  const entry = this._bound.get(hubSessionId);
  if (entry) entry._streamingBuf = [];
}
```

#### 3.4.2 GeminiTap（`core/transcript-tap.js`）

复用既有 `onLine` 已经看到的 chunks，新增累积逻辑：

```js
// _bindSession 末尾的 onLine 内，type:"gemini" 分支补一行：
if (obj?.type === 'gemini' && typeof obj.content === 'string') {
  if (!boundEntry._streamingBuf) boundEntry._streamingBuf = [];
  boundEntry._streamingBuf.push({ type: 'text', text: obj.content });
  // 既有 _recordTokens / emitIfComplete 逻辑保持不变
}
```

新增同名 `getStreamingText(hubSessionId)` / `clearStreamingBuf(hubSessionId)`。

#### 3.4.3 CodexTap（`core/transcript-tap.js`）

##### Spike 验证（立项前 30 分钟）

启动 Hub 跑一次 Codex turn，tail `~/.codex/sessions/<today>/rollout-*.jsonl`，记录所有 `event_msg` 的 `payload.type` 列表，确认：

1. `agent_message_delta` 事件存在
2. `payload.delta` 字段是字符串（拼接出完整 last_agent_message）
3. delta 事件落盘频率（每个 token 一行 vs 每几个 token 一行 vs 每句一行）

Spike 结果分流：

| 结果 | 落地策略 |
|---|---|
| delta 协议确认有效 | 按下方代码加 onLine 分支 |
| delta 不存在 / 字段不符 | Codex 仍走 PTY + 简化过滤；plan 中 Task 2.3 改为标注 "spike 失败，跳过" |

##### onLine 改动

```js
// CodexTap _tryBind 内 onLine，agent_message_delta 分支：
if (eventType === 'agent_message_delta' && typeof obj.payload.delta === 'string') {
  if (!entry._streamingBuf) entry._streamingBuf = [];
  entry._streamingBuf.push({ type: 'text', text: obj.payload.delta });
}
// task_started 时清空 _streamingBuf（开新 task）
if (eventType === 'task_started') {
  entry._streamingBuf = [];
  // 既有 pending emit 取消逻辑保持
}
// task_complete 既有 debounce 逻辑保持，3s 后 emit turn-complete 时同时 clear
```

新增同名 `getStreamingText` / `clearStreamingBuf`。

#### 3.4.4 TranscriptTap 顶层代理（`core/transcript-tap.js`）

```js
class TranscriptTap {
  // 新增三个公开方法（对外只暴露这三个）
  getStreamingText(hubSessionId) {
    return (
      this._claude.getStreamingText(hubSessionId) ||
      this._gemini.getStreamingText(hubSessionId) ||
      this._codex.getStreamingText(hubSessionId) ||
      null
    );
  }
  clearStreamingBuf(hubSessionId) {
    for (const b of [this._claude, this._gemini, this._codex]) {
      try { b.clearStreamingBuf?.(hubSessionId); } catch {}
    }
  }
}
```

### 3.5 main.js 数据源分流

`main.js:_rtExtractStreamingText` 改造：

```js
function _rtExtractStreamingText(sid, kind) {
  // 优先取 transcript-tap 的结构化流式块
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
    if (/^(PS |>|\$|❊|·|·|·)/.test(trim)) continue;
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

`onPartial` 推 IPC 时改 payload：

```js
// 旧: { sid, label, status, text, tokens? }
// 新: { sid, label, status, blocks, tokens?, source? }  // source: 'tap' | 'pty'
```

renderer 端必须同时支持两种 payload（向后兼容）：拿 `blocks` 就用结构化渲染，否则把 `text` 包成 `[{type:'text', text}]`。

### 3.6 renderer 结构化渲染

`renderer/meeting-room.js:_renderFusedTabs` 中 preview 部分改：

```js
// 旧: 直接渲染 partial.text 为 markdown
// 新: 遍历 partial.blocks，按 type 分别渲染
function renderPreviewBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  const html = [];
  for (const block of blocks) {
    if (block.type === 'thinking') {
      html.push(`<div class="mr-ft-think">${escapeHtml(block.text).slice(-400)}</div>`);
    } else if (block.type === 'tool_use') {
      const summary = formatToolUse(block);  // Web Search → "🔍 搜索: \"query\""
      html.push(`<div class="mr-ft-tool">${escapeHtml(summary)}</div>`);
    } else if (block.type === 'text') {
      html.push(renderMarkdown(block.text).slice(-2000));
    }
  }
  return html.join('');
}

function formatToolUse(block) {
  if (block.name === 'WebSearch' || block.name === 'web_search') {
    const q = block.input?.query || block.input?.q || '';
    return `🔍 搜索: "${q}"`;
  }
  if (block.name === 'Read' || block.name === 'read_file') {
    return `📄 读: ${block.input?.path || ''}`;
  }
  if (block.name === 'Bash' || block.name === 'shell') {
    const cmd = (block.input?.command || '').slice(0, 60);
    return `⚙ 执行: ${cmd}`;
  }
  return `🔧 ${block.name}`;
}
```

CSS 新增：

```css
.mr-ft-think {
  color: var(--text-dim);
  font-style: italic;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.mr-ft-think::before { content: "💭 "; }
.mr-ft-tool {
  display: inline-block;
  background: rgba(57,208,216,0.12);
  color: #39d0d8;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11.5px;
  margin: 2px 4px 2px 0;
}
```

### 3.7 兜底（PTY fallback 时机）

JSONL 文件可能在 session 启动后 1-3 秒才被 CLI 创建。期间 `tap.getStreamingText(sid)` 返回 null，`_rtExtractStreamingText` 走 PTY 路径。一旦 JSONL 就绪并有 onLine 事件，下一次 1500ms 抽取自动切到 tap 路径。

无显式切换通知，**靠 next-tick 自然替换**。

### 3.8 缓存生命周期

| 时机 | 操作 |
|---|---|
| `dispatchRoundtableTurn` 开始 | `transcriptTap.clearStreamingBuf(sid)` for each AI |
| `_streamingBuf` 长度超过 50KB | 头部截断（保留尾部 50KB） |
| `turn-complete` 事件触发 | 不立即清空（让 partial.text 可显示完整答案）；下一轮开始再 clear |
| `closeMeetingPanel` | 全部 clear |
| `unregisterSession` | `_streamingBuf = null`（释放） |

---

## 4. 优化 3 — 沉浸 / 调试模式切换

### 4.1 模式定义

| 模式 | cards-tab | shell 区 | toolbar + 输入框 |
|---|---|---|---|
| 调试（默认） | 占主区 ~38% 高度 | 占主区 ~62% 高度 | 固定 |
| 沉浸 | 占主区 100% 高度 | `display: none` | 固定 |

### 4.2 切换按钮

位置：`renderer/index.html` 中 `meeting-room-panel` header（包含 `#meeting-room-title` 的那一行）右侧。

形态：图标 + 1 字标签

```html
<button id="meeting-room-mode-toggle" class="mr-mode-btn" title="切换沉浸/调试模式">
  <span id="mr-mode-icon">🖥</span>
  <span id="mr-mode-label">调试</span>
</button>
```

样式：

```css
.mr-mode-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg-card-2); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px 10px; font-size: 12px;
  color: var(--text); cursor: pointer; user-select: none;
}
.mr-mode-btn.immersive {
  background: rgba(88,166,255,0.18);
  border-color: var(--accent);
  color: var(--accent);
}
```

### 4.3 状态管理

renderer 端新增 state：

```js
state.immersiveByMeeting = state.immersiveByMeeting || {};  // meetingId → boolean
```

`openMeeting(meeting)` 末尾根据 `state.immersiveByMeeting[meeting.id]` 应用初始模式。

切换函数：

```js
function toggleMeetingMode() {
  const mid = state.currentMeetingId;
  if (!mid) return;
  const cur = !!state.immersiveByMeeting[mid];
  const next = !cur;
  state.immersiveByMeeting[mid] = next;
  applyMeetingMode(next);
  saveStateDebounced();  // 写入 state.json
}

function applyMeetingMode(immersive) {
  const panel = document.getElementById('meeting-room-panel');
  const shells = document.getElementById('mr-shell-area');
  const btn = document.getElementById('meeting-room-mode-toggle');
  if (immersive) {
    panel.classList.add('immersive');
    shells.style.display = 'none';
    btn.classList.add('immersive');
    document.getElementById('mr-mode-icon').textContent = '🎯';
    document.getElementById('mr-mode-label').textContent = '沉浸';
  } else {
    panel.classList.remove('immersive');
    shells.style.display = '';
    btn.classList.remove('immersive');
    document.getElementById('mr-mode-icon').textContent = '🖥';
    document.getElementById('mr-mode-label').textContent = '调试';
  }
  // 沉浸切回调试时 xterm 必须 fit
  setTimeout(() => _relayoutMeetingRoom(), 250);  // 等动画结束
}
```

### 4.4 持久化

state.json 中新增字段 `immersiveByMeeting`（顶层 state 字典的一个 key）。Hub 启动时 `_loadState` 自动读回，无需新 IPC。

### 4.5 切换动画

CSS:

```css
#mr-shell-area {
  transition: max-height 240ms ease-out, opacity 240ms ease-out;
  overflow: hidden;
}
#meeting-room-panel.immersive #mr-shell-area {
  max-height: 0;
  opacity: 0;
}
.mr-ft-strip {
  transition: flex 240ms ease-out;
}
#meeting-room-panel.immersive .mr-ft-strip {
  flex: 1;  /* 抢占 shell 留出的空间 */
}
```

动画结束后 transitionend 触发 `_relayoutMeetingRoom()`（含 xterm.fit）。

### 4.6 不变项（铁律）

- 底部 toolbar + 输入框布局占比恒定（不参与模式切换）
- 顶部 header 高度不变（只多一个按钮）
- 历史轮次面板（`#mr-history-panel`）展开规则不变

---

## 5. 优化 4 — 动态重排兜底

### 5.1 触发场景

| 场景 | 当前症状 | 修复后 |
|---|---|---|
| 窗口 resize（拖拽边） | xterm 内容裁切，cards 内容溢出 | 实时重排 + xterm.fit() |
| 沉浸 / 调试模式切换 | 新功能 | 240ms 动画 + 完成后 fit() |
| 历史轮次面板展开/收起 | cards 区压缩但 preview 未跟随 | ResizeObserver 重算 |
| preview 区 markdown 长度跳变 | card 高度抖动带动相邻 card | grid `min-height: 0` + 固定 row 高度 |
| session 添加/移除 AI | 列数变化时 fit() 状态错乱 | 列数变化强制重 fit |
| devtools 打开/关闭 | 视口变化未触发 | window resize 同步 fit |

### 5.2 实现栈

```
[meeting-room-panel] (主容器)
  ↓ ResizeObserver 注册
new ResizeObserver(debounce(_relayoutMeetingRoom, 100))
  ↓ 触发
_relayoutMeetingRoom()
  ├─ cards-strip: grid minmax(0, 1fr) 强制重算（document.body offsetHeight）
  ├─ 每个活跃 xterm: fitAddon.fit()（来自 _focusCache.terminal）
  └─ historyPanel: 重算 max-height（如展开）
```

### 5.3 关键 CSS 防溢出三件套

```css
.mr-ft-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));  /* 防 grid item 溢出 */
  gap: 8px;
  min-height: 0;                                      /* 让 grid 在 flex parent 中可缩 */
}
.mr-ft {
  display: flex;
  flex-direction: column;
  overflow: hidden;                                   /* preview 长内容不撑爆卡片 */
  min-height: 220px;                                  /* 调试模式下事实高度（与 card-redesign 一期 align） */
}
.mr-ft-preview {
  flex: 1;                                            /* 抢 row1/row2 之外的空间 */
  overflow-y: hidden;
}

/* 沉浸模式覆盖：让 cards-strip 跟 .mr-ft 一起拉满 */
#meeting-room-panel.immersive .mr-ft-strip {
  flex: 1;
  height: auto;
}
#meeting-room-panel.immersive .mr-ft {
  height: 100%;
}
```

### 5.4 _relayoutMeetingRoom 实现

```js
function _relayoutMeetingRoom() {
  const panel = document.getElementById('meeting-room-panel');
  if (!panel || panel.style.display === 'none') return;

  // 1. 强制 reflow（避免延迟到下次 paint）
  void panel.offsetHeight;

  // 2. xterm fit
  for (const sid of Object.keys(_focusCache || {})) {
    const cached = _focusCache[sid];
    if (cached?.terminal && cached?.fitAddon) {
      try { cached.fitAddon.fit(); } catch {}
    }
  }

  // 3. history panel 高度（如果展开）
  const hp = document.getElementById('mr-history-panel');
  if (hp && hp.classList.contains('expanded')) {
    hp.style.maxHeight = `${hp.scrollHeight}px`;
  }
}

// 注册（在 openMeeting 内）：
let _meetingResizeObserver = null;
function _setupMeetingResizeObserver() {
  if (_meetingResizeObserver) return;
  const panel = document.getElementById('meeting-room-panel');
  if (!panel) return;
  let lastW = 0, lastH = 0;
  _meetingResizeObserver = new ResizeObserver(debounce((entries) => {
    const e = entries[0];
    if (!e) return;
    const { width, height } = e.contentRect;
    if (Math.abs(width - lastW) < 4 && Math.abs(height - lastH) < 4) return;
    lastW = width; lastH = height;
    _relayoutMeetingRoom();
  }, 100));
  _meetingResizeObserver.observe(panel);

  // 顺便监听 window resize（cover devtools 场景）
  window.addEventListener('resize', debounce(_relayoutMeetingRoom, 100));
}
```

debounce 实现复用 lodash 风格的本地小函数（不引第三方依赖）。

---

## 6. 数据契约 / IPC 协议

### 6.1 IPC `roundtable-partial-update`（升级）

**旧 payload**（保留向后兼容）：
```ts
{ sid: string, label: string, status: 'streaming' | 'done', text: string, tokens?: object }
```

**新 payload**：
```ts
{
  sid: string,
  label: string,
  status: 'streaming' | 'done',
  blocks: Array<
    | { type: 'text', text: string }
    | { type: 'thinking', text: string }
    | { type: 'tool_use', name: string, input: object }
  >,
  tokens?: object,
  source?: 'tap' | 'pty',
  // 兼容字段（保留发送，旧 renderer 才能解析）
  text?: string  // = blocks 中所有 type:'text' 拼接，slice(-500)
}
```

renderer 同时收到 `blocks` 与 `text` 时，优先用 `blocks`。

### 6.2 transcript-tap.js 新公开接口

```ts
class TranscriptTap {
  // 既有方法保持不变
  registerSession(sid, kind, ctx?): void;
  unregisterSession(sid): void;
  getLastAssistantText(sid): string | null;
  notifyClaudeStop(sid, transcriptPath): Promise<void>;

  // === 本期新增 ===
  getStreamingText(sid): Array<Block> | null;
  clearStreamingBuf(sid): void;
}

type Block =
  | { type: 'text', text: string }
  | { type: 'thinking', text: string }
  | { type: 'tool_use', name: string, input: object };
```

### 6.3 state.json schema 增量

```ts
state.immersiveByMeeting: { [meetingId: string]: boolean }
```

缺省时按 `false`（调试模式）处理。

---

## 7. 兼容性 / 降级

| 场景 | 行为 |
|---|---|
| Claude transcript 文件路径漂移（CLI 大版本升级） | `_scanOnce` 找不到候选 → `_streamingBuf` 永远空 → `getStreamingText` 返回 null → main.js 走 PTY 兜底（旧体验） |
| Codex spike 失败（`agent_message_delta` 协议不存在） | 不实现 CodexTap onLine 分支，Codex 仍走 PTY 兜底 |
| Gemini 0.38 及以前（无 JSONL） | `isJsonl=false` 分支不累积 _streamingBuf → 走 PTY 兜底 |
| 老 renderer（未升级） | IPC payload 仍含 `text` 字段，老 renderer 渲染单一 markdown 块 |
| 老 main.js（未升级） + 新 renderer | 新 renderer 收到 `text` 无 `blocks`，自动包装为 `[{type:'text', text}]` |
| `mc-preview` 在沉浸模式 vs 调试模式 | 同一组件，仅 cards-tab 容器尺寸变化；CSS `flex:1` 自然适配 |

---

## 8. 测试 / 验证

### 8.1 单元测试（`tests/`）

| 测试文件 | 验证 |
|---|---|
| `transcript-tap-claude-stream.test.js` | ClaudeTap onLine 解析 thinking/text/tool_use 块；`getStreamingText` 返回正确数组 |
| `transcript-tap-gemini-stream.test.js` | GeminiTap onLine 累积 content；`clearStreamingBuf` 生效 |
| `transcript-tap-codex-stream.test.js` | （仅 spike 通过时）CodexTap delta 解析；task_started 清空 |
| `meeting-room-relayout.test.js` | `_relayoutMeetingRoom` 不抛错；ResizeObserver 触发频率限制 |

### 8.2 E2E 测试（CDP 真测）

`tests/_e2e-card-optimization-verify.js` 流程：

1. 启动隔离 Hub（`CLAUDE_HUB_DATA_DIR=C:\temp\hub-cardopt` + `--remote-debugging-port=9233`）
2. 创建圆桌 + 进会议室 → 截图 `01-initial.png` → assert cards-tab 占主区 ≥ 35% 且无重叠
3. 点"群策群力"启动 turn → 等 5s → 截图 `02-streaming.png` → assert preview 区无 `thinking more with` / `Inferring` / `Cogitated` 等 throbbing 字符串
4. 等 turn 完成（`_rtWaitTurnComplete` resolve）→ 截图 `03-done.png` → assert row1 含 `⏱` + Ns + `· `，row2 含 `🪙` + Nk
5. 点 header 沉浸按钮 → 等 300ms → 截图 `04-immersive.png` → assert `mr-shell-area` `display === 'none'`
6. 再点切回调试 → 等 300ms → 截图 `05-debug.png` → assert `mr-shell-area` 显示 + xterm 已 fit
7. 窗口 resize（CDP 改 viewport 1024×600）→ 等 200ms → 截图 `06-resized.png` → assert 无溢出
8. 关闭 Hub → 截图全部归档到 `tests/screenshots/card-optimization/`

E2E 必须通过真 Hub + CDP 操作真按钮（点击/键盘），不许后端 IPC 假装。验证铁律（CLAUDE.md）：测试通过 = 代码真实执行产出正确结果。

### 8.3 多 AI 并发流式压力测试

`tests/_stream-buf-stress.js`：

- 启动 3 路 AI（Claude + Gemini + Codex）
- 同时发 turn → 监控 `_streamingBuf` 内存增长
- assert 每路 buf ≤ 50KB（截断生效）
- assert 所有 AI turn-complete 后 buf clear（下一轮）

---

## 9. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Codex `agent_message_delta` 协议未在项目验证 | 中 | 立项前 30min spike；spike 不通过则 Codex 仍走 PTY+过滤，主线不受阻 |
| R2 | Claude transcript 路径漂移（CLI 升级换 slug 算法） | 中 | `_scanOnce` 用 mtime 排序 + cwd 反查 `.project_root`-style 标记（参考 GeminiTap）；找不到 PTY 兜底 |
| R3 | 多 AI 并发流式 `_streamingBuf` 膨胀 | 中 | 50KB 截断；turn-complete 时清空 |
| R4 | 沉浸模式下 shell session 仍跑 → CPU 浪费 | 低 | shell 仅 DOM 隐藏，PTY 进程照常运行（按用户期望保留对话上下文） |
| R5 | ResizeObserver 触发频率过高 | 低 | debounce 100ms；尺寸 delta < 4px 时跳过 |
| R6 | JSONL onLine 异常导致缓存破损 | 低 | onLine 内 try/catch 静默吞掉单行错误（沿用既有模式）；turn-complete 时无条件清空 |
| R7 | 沉浸切换动画期间用户快速反复点击 | 低 | 按钮在动画期间禁用 250ms（pointer-events:none） |
| R8 | renderer 收到 blocks 数组太大（thinking 块数百条） | 低 | `slice(-400)` thinking、`slice(-2000)` text、tool_use 累计上限 8 个；preview 整体 max-height 控住 |

---

## 10. Open Questions / Out of Scope

### 已决策（向 user 确认完）

- D1-D11（HTML mockup 中决策表）全部默认通过

### Out of Scope（本期不做）

- 历史轮次面板的样式优化
- 卡片之间的拖拽排序
- preview 区的"复制到剪贴板"按钮
- Claude tool_use 的 `Read` / `Bash` 之外的工具（保持现有简易 mapping，遇到未知 tool 显示 `🔧 <name>`）

---

## 11. 版本

修改 `package.json` `version` 字段从 `0.3.0` → `0.4.0`（card-optimization 是独立大改）。

UI 上版本显示（如有）需同步更新。

---

## 文件改造一览

| 文件 | 类型 | 主要改动 |
|---|---|---|
| `core/transcript-tap.js` | 修改 | ClaudeTap 改 tail 模式；GeminiTap/CodexTap 加 streamingBuf；TranscriptTap 暴露 getStreamingText/clearStreamingBuf |
| `main.js` | 修改 | `_rtExtractStreamingText` 按 kind 分流；payload 改为 blocks 数组（含 text 兼容字段）；`dispatchRoundtableTurn` 开始时 clearStreamingBuf |
| `renderer/meeting-room.js` | 修改 | `_ftHtml` row1/row2 加 stats；`_renderFusedTabs` preview 改 blocks 渲染；新增 toggleMeetingMode / applyMeetingMode / `_relayoutMeetingRoom` / `_setupMeetingResizeObserver` |
| `renderer/meeting-room.css` | 修改 | 删 row3/row4 样式；新增 mr-ft-stat-inline / mr-ft-think / mr-ft-tool / mr-mode-btn 样式；防溢出三件套；动画 transition |
| `renderer/index.html` | 修改 | meeting-room-panel header 加 `#meeting-room-mode-toggle` 按钮；shell 区包一层 `#mr-shell-area` |
| `package.json` | 修改 | version 0.3.0 → 0.4.0 |
| `tests/_e2e-card-optimization-verify.js` | 新增 | E2E 7 步流程 |
| `tests/transcript-tap-claude-stream.test.js` | 新增 | ClaudeTap 单测 |
| `tests/transcript-tap-gemini-stream.test.js` | 新增 | GeminiTap 单测 |
| `tests/transcript-tap-codex-stream.test.js` | 新增（条件） | spike 通过才创建 |
| `tests/meeting-room-relayout.test.js` | 新增 | _relayoutMeetingRoom 单测 |
