# 新建圆桌：自选 AI + 模型选择 · 设计文档

> 2026-05-01 · 立花道雪
>
> **关联资源**
> - Plan：`docs/superpowers/plans/2026-05-01-meeting-create-modal.md`
> - 前置依赖（建议但非强制）：`2026-05-01-roundtable-card-optimization.md`（提供 partial.blocks 流式 + slot 索引架构准备）
> - 不冲突可并行：input-fixes / card-redesign 系列

---

## 1. 目标

当前 Hub 创建"通用圆桌"时硬编码 3 家为 Claude+Gemini+Codex（`renderer.js:1626` 一行循环），模型也写死。本期升级：
- 点新建后弹出 **Modal 横排 3 slot**，用户从 5 家 AI（claude / gemini / codex / deepseek / glm）任意挑 3 个，并为每家挑 model
- **允许 kind 重复**（如 3 个 slot 都选 Claude / Opus 4.7）
- **3 个位置的 Pokemon 头像按 slot 固定**：slot 1=皮卡丘、slot 2=小火龙、slot 3=杰尼龟（与 kind 解绑）
- **圆桌主界面 UI 几乎不变**（仅 shell 终端按 kind 渲染会有差异）
- **绝不影响现有功能**：现有圆桌（state.json 里的旧 meeting）打开后行为完全一致

预期收益：用户可以做"3 Opus 自我对话"、"Gemini 2.5 Pro × DeepSeek-v4-pro × GLM-4.6 跨家对照"、"投研专用 Codex × DeepSeek × Claude 组合"等多种用例。

非目标（Out of Scope）：
- 不引入第 4+ slot（仍固定 3）
- 不实现"运行中切换某 slot 的 AI"（需重启 meeting）
- 不改 `summary-engine.js`（仍仅支持 Gemini 的深度摘要管线）
- DeepSeek 的 MCP 工具集成（main.js:507-513 仅 claude/glm）保持现状

---

## 2. 关键调研结论

### 2.1 DeepSeek/GLM "天然跑在 Claude Code 上" 验证

**用户假设成立**。`session-manager.js:171-210, 442-512` 已实现完整 spawn 链路：

| 维度 | DeepSeek | GLM |
|---|---|---|
| 启动命令 | `claude --model deepseek-v4-pro --permission-mode bypassPermissions` | `claude --model glm-5.1 --permission-mode bypassPermissions` |
| API 端点 | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` | `ANTHROPIC_BASE_URL=<config.glmBaseUrl>` |
| 认证 token | `ANTHROPIC_AUTH_TOKEN=DEEPSEEK_API_KEY` | `ANTHROPIC_AUTH_TOKEN=GLM_API_KEY` |
| 配置隔离 | `CLAUDE_CONFIG_DIR=~/.claude-deepseek` | `CLAUDE_CONFIG_DIR=~/.claude-glm` |
| Transcript 落盘 | `~/.claude-deepseek/projects/<slug>/<sid>.jsonl`（Claude Code CLI 原生写） | `~/.claude-glm/projects/<slug>/<sid>.jsonl` |
| Stop hook | 100% 复用同套 `session-hub-hook.py` | 同上 |

约 **90% 后端逻辑可复用 Claude 路径**。

### 2.2 唯一阻塞点：`transcript-tap.js:_backendFor()` 缺 deepseek/glm 路由

```js
// 当前实现 (core/transcript-tap.js:922-927)
_backendFor(kind) {
  if (kind === 'claude' || kind === 'claude-resume') return this._claude;
  if (kind === 'codex') return this._codex;
  if (kind === 'gemini') return this._gemini;
  return null;  // ← deepseek/glm 走这条，圆桌 timeline 无法自动追踪
}
```

**1 行 fix**（详见 §5.4）即可让 DeepSeek/GLM 走 ClaudeTap 路径。

### 2.3 硬编码"3 AI 必为 claude+gemini+codex"的 8 处必须全改

| # | 文件 | 行号 | 内容 | 改造方向 |
|---|---|---|---|---|
| 1 | `renderer/renderer.js` | 1626 | `for (const kind of ['claude','gemini','codex'])` 创建循环 | 改成遍历 modal 提交的 slots 数组 |
| 2 | `renderer/meeting-room.js` | 140 | `const subs = { claude: null, gemini: null, codex: null }` | 改成 `const slots = [null, null, null]` |
| 3 | `renderer/meeting-room.js` | 145-147 | `if (s.kind === 'claude' && !subs.claude) subs.claude = ...` | 改成按 subSessions 数组顺序填 slots[i] |
| 4 | `renderer/meeting-room.js` | 197 | 渲染循环 `for (const kind of [...])` | 改成 `for (let i = 0; i < 3; i++) { const slot = slots[i]; ... }` |
| 5 | `core/roundtable-orchestrator.js` | 49-54 | `aiStats: { claude: {...}, gemini: {...}, codex: {...} }` | 改成 `aiStats: {}`（按 sid 索引） |
| 6 | `core/roundtable-orchestrator.js` | 76-80 | `_loadState` 中按 kind 补默认值 | 改成按当前 meeting 的 sid 列表初始化 |
| 7 | `core/roundtable-orchestrator.js` | 257-270 | `completeTurn` 累加按 kind | 改成按 sid 累加 |
| 8 | `core/general-roundtable-private-store.js` | 27, 37, 42, 61 | `if (!['claude','gemini','codex'].includes(kind)) throw` 白名单 | 改成 `if (!kind) throw` |
| 9 | `main.js` | 948-949 | `thinkSecByKind = { claude: 0, gemini: 0, codex: 0 }` | 改成按 sid 索引的 dict |
| 10 | `main.js` | 1488, 1499 | 投票/互评 API 返回 `{ claude: [], gemini: [], codex: [] }` | 改成按 sid 索引 |

### 2.4 辅助 fix

| # | 文件 | 行号 | 现状 | 改造 |
|---|---|---|---|---|
| 11 | `main.js` | 564-569 | `_RT_READY_MARKERS` 表无 deepseek 条目（undefined） | 新增 `deepseek: []`（与 claude 同策略） |
| 12 | `core/session-manager.js` | 587-606 | `relaunchCli` 不支持 deepseek/glm | 新增 deepseek/glm 分支 |
| 13 | `core/session-manager.js` | 407 | Codex 模型写死 `gpt-5.5` | 改成 `opts.model \|\| 'gpt-5.5'` |
| 14 | `core/session-manager.js` | 321 | Claude 模型写死 `claude-opus-4-7[1m]` | 改成 `opts.model \|\| 'claude-opus-4-7[1m]'` |

### 2.5 位置 vs kind 的核心架构转变

**当前**：头像按 kind 决定（`_avatarFor(sub.kind)` 在 `renderer/meeting-room.js`）。
**新设计**：圆桌卡片头像按 **slot index** 决定（`_avatarBySlot(0|1|2)`）。`_avatarFor(kind)` 函数**保留**——侧边栏单 session 列表仍按 kind 显示头像。

---

## 3. UI 设计 — Modal 横排 3 slot

### 3.1 触发

侧边栏 + → "新建圆桌" → **不再立即创建**，改为弹出 Modal（覆盖整个 Hub 主区，背景半透明遮罩）。

### 3.2 Modal 布局（720×460px，居中）

```
┌──────────────────── 新建通用圆桌 ────────────────────╳─┐
│                                                          │
│   ┌── Slot 1 ──┐    ┌── Slot 2 ──┐    ┌── Slot 3 ──┐    │
│   │ [⚡皮卡丘] │    │ [🔥小火龙] │    │ [💎杰尼龟] │    │
│   │            │    │            │    │            │    │
│   │ AI:        │    │ AI:        │    │ AI:        │    │
│   │ ▼ Claude   │    │ ▼ Gemini   │    │ ▼ Codex    │    │
│   │            │    │            │    │            │    │
│   │ Model:     │    │ Model:     │    │ Model:     │    │
│   │ ▼ Opus 4.7 │    │ ▼ 2.5 Flash│    │ ▼ gpt-5.5  │    │
│   └────────────┘    └────────────┘    └────────────┘    │
│                                                          │
│   场景: ◉ 通用  ○ 投研                                   │
│                                                          │
│  ────────────────────────────────────────────────────    │
│                  [ 取消 ]   [ 创建圆桌 ]                 │
└──────────────────────────────────────────────────────────┘
```

### 3.3 交互细节

| 行为 | 描述 |
|---|---|
| Modal 弹出 | 默认值预填：Slot1=Claude/Opus 4.7、Slot2=Gemini/2.5 Flash、Slot3=Codex/gpt-5.5（保持现状）。场景按 mode 参数（general/research）默认选中。 |
| AI dropdown 改变 | model dropdown 自动刷新为该 kind 的可用 model 列表，并选中该 kind 的默认 model。 |
| Model dropdown 改变 | 仅本地 state 更新，不触发任何 IPC。 |
| 点 [创建圆桌] | 校验所有 slot 都有 kind+model → 调 `'create-meeting'` IPC（带 slots 数组）→ 关闭 modal → 进会议室 |
| 点 [取消] / 遮罩 / Esc | 关闭 modal，不创建任何东西，主界面恢复 |
| Pokemon 头像 | 静态显示在 slot 上方，不随 AI 选择变化 |
| 重复 kind | 允许（不做去重校验），如 3 个 slot 都 Claude/Opus 也合法 |

### 3.4 Model 列表（按 kind）

| Kind | 默认 | 全部可选 |
|---|---|---|
| claude | `claude-opus-4-7[1m]` | `claude-opus-4-7[1m]`, `claude-opus-4-6`, `claude-sonnet-4-5` |
| gemini | `gemini-2.5-flash` | `gemini-2.5-flash`, `gemini-2.5-pro` |
| codex | `gpt-5.5` | `gpt-5.5`, `gpt-5.4` |
| deepseek | `deepseek-v4-pro` | `deepseek-v4-pro`, `deepseek-v4-flash` |
| glm | `glm-5.1` | `glm-5.1`, `glm-4.6`, `glm-4-plus`, `glm-4-air` |

模型清单在 `renderer/meeting-create-modal.js` 内以常量表维护，无需后端 IPC 拉取（足够稳定，CLI 升级时手动更新）。

---

## 4. 数据契约

### 4.1 IPC `'create-meeting'` 升级（向后兼容）

```ts
// 旧 payload（保留兼容）
ipcMain.handle('create-meeting', async (_e, { mode, scene }) => { ... })

// 新 payload
ipcMain.handle('create-meeting', async (_e, { mode, scene, slots }) => { ... })

interface SlotSpec {
  index: 0 | 1 | 2;
  kind: 'claude' | 'gemini' | 'codex' | 'deepseek' | 'glm';
  model: string;  // 例如 'claude-opus-4-7[1m]'
}
```

**后端逻辑**：
```js
ipcMain.handle('create-meeting', async (_e, opts) => {
  const meeting = await meetingManager.createMeeting(opts);  // 既有
  if (Array.isArray(opts.slots) && opts.slots.length > 0) {
    // 新路径
    for (const slot of opts.slots) {
      await addSubInternal(meeting.id, slot.kind, { model: slot.model });
    }
    meetingManager.setSlotSpecs(meeting.id, opts.slots);  // 持久化
  }
  // 不传 slots 时不再走默认 3 家创建（renderer 永远会传，老调用方需走 modal 路径）
  return meeting;
});
```

### 4.2 IPC `'add-meeting-sub'` 升级

```ts
// 旧
ipcMain.handle('add-meeting-sub', async (_e, { meetingId, kind }) => { ... })

// 新
ipcMain.handle('add-meeting-sub', async (_e, { meetingId, kind, model }) => { ... })
//   → sessionManager.createSession(kind, { model, ... })
//   → meetingManager.addSubSession(meetingId, sessionId)
```

`sessionManager.createSession(kind, opts)` 已经接受 `opts.model`（`session-manager.js:321/358/407/452/487`），仅需确认链路无截断 + 给 Claude/Codex 加 fallback 默认值。

### 4.3 Meeting 数据结构升级（state.json）

```ts
interface Meeting {
  // ... 既有字段不变
  subSessions: string[];  // 既有 — 数组顺序即 slot 顺序

  // 新增（可选，向后兼容）
  slotSpecs?: SlotSpec[];  // 显式记录每个 slot 的 kind+model，方便复盘和"再来一次"
}
```

老 meeting 没有 `slotSpecs` 时：
- 渲染按 `subSessions` 数组顺序 + 按 slot index 派 Pokemon 头像
- 模型从 `session.currentModel.id` 反查（已存）

### 4.4 Roundtable Orchestrator 状态升级

```ts
// 旧：按 kind 索引
state.aiStats = {
  claude: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
  gemini: { ... },
  codex: { ... }
};

// 新：按 sid 索引（sid 即 sub session id，唯一稳定）
state.aiStats = {
  '<sid1>': { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [], kind: 'claude', model: 'claude-opus-4-7[1m]' },
  '<sid2>': { ... },
  '<sid3>': { ... }
};
```

**老格式迁移**（`_loadState` 内）：

```js
if (loaded.aiStats && (loaded.aiStats.claude || loaded.aiStats.gemini || loaded.aiStats.codex)) {
  // 老格式：按当前 meeting subSessions 的 kind 匹配
  const migrated = {};
  for (const sid of (this._currentMeeting?.subSessions || [])) {
    const session = this._sessionsBySid?.get(sid);
    const oldStat = loaded.aiStats[session?.kind];
    if (oldStat) migrated[sid] = { ...oldStat, kind: session.kind, model: session.currentModel?.id };
  }
  loaded.aiStats = migrated;  // 失败则丢弃旧累计统计，不影响功能
}
```

---

## 5. 后端改造范围

### 5.1 Renderer 卡片渲染按 slot index（核心重构）

`renderer/meeting-room.js:140` 周边：

```js
// 旧
const subs = { claude: null, gemini: null, codex: null };
sessionsAll.forEach(s => {
  if (s.kind === 'claude' && !subs.claude) subs.claude = { sid: s.id, label: s.title };
  else if (s.kind === 'gemini' && !subs.gemini) subs.gemini = { sid: s.id, label: s.title };
  else if (s.kind === 'codex' && !subs.codex) subs.codex = { sid: s.id, label: s.title };
});

// 新
const slots = [null, null, null];
const subSids = meeting.subSessions || [];
for (let i = 0; i < subSids.length && i < 3; i++) {
  const s = sessionsAll.find(x => x.id === subSids[i]);
  if (s) slots[i] = {
    sid: s.id,
    label: s.title,
    kind: s.kind,
    model: s.currentModel?.id || s.currentModel?.displayName,
  };
}
```

`renderer/meeting-room.js:197` 渲染循环：

```js
// 旧
for (const kind of ['claude', 'gemini', 'codex']) {
  const sub = subs[kind];
  if (!sub) continue;
  tabs.push(_ftHtml(sub, partial, status, sub.kind, ...));
}

// 新
for (let i = 0; i < 3; i++) {
  const slot = slots[i];
  if (!slot) continue;
  tabs.push(_ftHtml(slot, partial, status, slot.model, ctxPct, isInitializing, lastTurnByMap, /* slotIndex */ i));
}
```

### 5.2 头像按 slot 派发

新增工具函数：

```js
function _avatarBySlot(i) {
  const arr = [
    'assets/pokemon/pikachu.png',
    'assets/pokemon/charmander.png',
    'assets/pokemon/squirtle.png',
  ];
  return arr[i] || 'assets/pokemon/default.png';
}
```

`_ftHtml` 签名加 `slotIndex` 参数，内部用 `_avatarBySlot(slotIndex)` 替代 `_avatarFor(slot.kind)`。

`_avatarFor(kind)` 函数**保留**（侧边栏单 session 列表仍按 kind 用）。

### 5.3 Mention 列表 (`RT_MENTION_ITEMS`) 改 slot

`renderer/meeting-room.js:1716-1719`：

```js
// 旧
const RT_MENTION_ITEMS = [
  { kind: 'claude', label: '@claude' },
  { kind: 'gemini', label: '@gemini' },
  { kind: 'codex', label: '@codex' },
];

// 新（动态构建）
function buildRtMentionItems(meeting) {
  const items = [];
  for (let i = 0; i < (meeting.subSessions || []).length; i++) {
    const sid = meeting.subSessions[i];
    items.push({ sid, slotIndex: i, label: `@slot${i + 1}` });
  }
  // 兼容层：当 meeting 内 kinds 唯一时，也注册 @kind 别名
  const kindCount = {};
  for (const item of items) {
    const session = sessionsAll.find(s => s.id === item.sid);
    if (session?.kind) kindCount[session.kind] = (kindCount[session.kind] || 0) + 1;
  }
  for (const item of items) {
    const session = sessionsAll.find(s => s.id === item.sid);
    if (session?.kind && kindCount[session.kind] === 1) {
      items.push({ sid: item.sid, kind: session.kind, label: `@${session.kind}` });
    }
  }
  return items;
}
```

### 5.4 transcript-tap 加 deepseek/glm 路由

`core/transcript-tap.js:922-927`：

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

`ClaudeTap.notifyStop(sid, transcriptPath)` 已经接受任意 path，DeepSeek/GLM 的 `~/.claude-deepseek/projects/...` / `~/.claude-glm/projects/...` 直接复用。

### 5.5 Roundtable Orchestrator 改 sid 索引

详见 §4.4 数据契约。`completeTurn` 在 `core/roundtable-orchestrator.js:257-270`：

```js
// 旧
for (const kind of ['claude', 'gemini', 'codex']) {
  const s = this.state.aiStats[kind];
  s.totalThinkSec += (thinkSecBy[kind] || 0);
  s.totalTokens += (tokensBy[kind] || 0);
  s.perTurnHistory.push({ turn: turnNum, ... });
}

// 新
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
  s.totalThinkSec += (thinkSecBySid[sid] || 0);
  s.totalTokens += (tokensBySid[sid] || 0);
  s.perTurnHistory.push({ turn: turnNum, thinkSec: thinkSecBySid[sid], tokens: tokensBySid[sid] });
}
```

调用方 `main.js:946-960` 区域同步把 `thinkSecByKind` / `tokensByKind` 改名为 `thinkSecBySid` / `tokensBySid`。

### 5.6 投票/互评 API（main.js:1488, 1499）

```js
// 旧
return kind ? [] : { claude: [], gemini: [], codex: [] };

// 新
return kind ? [] : Object.fromEntries(
  (meeting.subSessions || []).map(sid => [sid, []])
);
```

renderer 收到后通过 sid → label/kind 反查（既有 sessionsAll 已有此能力）。

### 5.7 _RT_READY_MARKERS 加 deepseek

`main.js:564-569`：

```js
const _RT_READY_MARKERS = {
  claude: [],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  codex: ['gpt-5.5', 'gpt-5.4', 'Context 100%', 'send'],
  glm: [],
  deepseek: [],  // 新增 — 与 claude 同策略，buffer ≥ 1500 字符兜底
};
```

### 5.8 relaunchCli 加 deepseek/glm

`core/session-manager.js:587-606`：

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

### 5.9 sessionManager 默认 model fallback

`core/session-manager.js:321` Claude 分支：

```js
// 旧
cmd = ` claude --model claude-opus-4-7[1m]`;
// 新
cmd = ` claude --model ${opts.model || 'claude-opus-4-7[1m]'}`;
```

`core/session-manager.js:407` Codex 分支：

```js
// 旧
cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5`;
// 新
cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${opts.model || 'gpt-5.5'}`;
```

Gemini/DeepSeek/GLM 已经使用 `opts.model || <default>`，无需改动。

### 5.10 General Roundtable Private Store 去白名单

`core/general-roundtable-private-store.js:27, 37, 42, 61`：

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

### 5.11 meeting-store 持久化 slotSpecs

`core/meeting-store.js:21-34`：序列化字段加 `slotSpecs`（如果 meeting 对象有）；反序列化时读回。

---

## 6. UI 实现（renderer/meeting-create-modal.{js,css}）

### 6.1 公开 API

```js
// 暴露到 window
window.openMeetingCreateModal = function(mode = 'general') {
  // 显示 modal，预填默认值
  // 用户提交时 invoke 'create-meeting' IPC（带 slots）+ 关闭
};
```

### 6.2 Modal DOM 结构

```html
<div id="meeting-create-modal" class="mcm-overlay" style="display: none;">
  <div class="mcm-dialog">
    <div class="mcm-header">
      <span class="mcm-title">新建<span id="mcm-mode-label">通用</span>圆桌</span>
      <button class="mcm-close" aria-label="关闭">×</button>
    </div>
    <div class="mcm-body">
      <div class="mcm-slots">
        <!-- 3 slot 通过 JS 动态生成 -->
      </div>
      <div class="mcm-scene">
        场景: <label><input type="radio" name="mcm-scene" value="general" checked> 通用</label>
              <label><input type="radio" name="mcm-scene" value="research"> 投研</label>
      </div>
    </div>
    <div class="mcm-footer">
      <button class="mcm-cancel">取消</button>
      <button class="mcm-create mcm-primary">创建圆桌</button>
    </div>
  </div>
</div>
```

每个 slot 模板：

```html
<div class="mcm-slot" data-slot="0">
  <img class="mcm-avatar" src="assets/pokemon/pikachu.png">
  <div class="mcm-slot-label">Slot 1 · 皮卡丘位</div>
  <label>AI:
    <select class="mcm-ai-select">
      <option value="claude" selected>Claude</option>
      <option value="gemini">Gemini</option>
      <option value="codex">Codex</option>
      <option value="deepseek">DeepSeek</option>
      <option value="glm">GLM</option>
    </select>
  </label>
  <label>Model:
    <select class="mcm-model-select">
      <!-- 动态填充 -->
    </select>
  </label>
</div>
```

### 6.3 关键 CSS

```css
.mcm-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 9999;
  display: flex; align-items: center; justify-content: center;
}
.mcm-dialog {
  width: 720px; max-height: 90vh;
  background: var(--bg-card, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 10px;
  display: flex; flex-direction: column;
}
.mcm-slots {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.mcm-slot {
  background: var(--bg-card-2, #1c232c);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  padding: 12px;
  display: flex; flex-direction: column; gap: 8px; align-items: center;
}
.mcm-avatar { width: 56px; height: 56px; border-radius: 50%; }
.mcm-primary {
  background: var(--accent, #58a6ff); color: #000;
  border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;
}
```

### 6.4 关键 JS 逻辑

```js
const MODELS_BY_KIND = {
  claude: ['claude-opus-4-7[1m]', 'claude-opus-4-6', 'claude-sonnet-4-5'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  codex: ['gpt-5.5', 'gpt-5.4'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  glm: ['glm-5.1', 'glm-4.6', 'glm-4-plus', 'glm-4-air'],
};

const DEFAULTS = [
  { kind: 'claude', model: 'claude-opus-4-7[1m]' },
  { kind: 'gemini', model: 'gemini-2.5-flash' },
  { kind: 'codex', model: 'gpt-5.5' },
];

function refreshModelOptions(slotEl) {
  const kind = slotEl.querySelector('.mcm-ai-select').value;
  const modelSel = slotEl.querySelector('.mcm-model-select');
  modelSel.innerHTML = MODELS_BY_KIND[kind].map(m => `<option value="${m}">${m}</option>`).join('');
}

async function onCreate() {
  const slots = [];
  document.querySelectorAll('.mcm-slot').forEach((el, i) => {
    slots.push({
      index: i,
      kind: el.querySelector('.mcm-ai-select').value,
      model: el.querySelector('.mcm-model-select').value,
    });
  });
  const scene = document.querySelector('input[name="mcm-scene"]:checked').value;
  const mode = scene === 'research' ? 'research' : 'general';

  try {
    const meeting = await window.electronAPI.invoke('create-meeting', { mode, scene, slots });
    closeModal();
    openMeeting(meeting);
  } catch (e) {
    showToast('创建失败：' + e.message);
  }
}
```

---

## 7. 兼容性与降级

| 场景 | 行为 |
|---|---|
| 旧 meeting 打开（state.json 无 slotSpecs） | 兼容：subSessions 数组顺序 = slot 顺序，`slots[i]` 由 `subSessions[i]` 反查 session 信息得到 |
| 旧 IPC `'create-meeting'` 不带 slots（理论上 renderer 永远会带，仅老 e2e 脚本可能漏） | main.js 检测到 `!opts.slots` 时报错并提示"请通过新 modal 创建"；不再 silently 走默认 3 家 |
| 旧 aiStats 按 kind 索引 | `_loadState` 老格式自动迁移到 sid 索引；迁移失败仅丢累计统计，不影响功能 |
| 老 prompt 中有 `@claude` mention | 兼容层（§5.3）：当 meeting 内 kind 唯一时，仍注册 `@kind` 别名；当 kind 重复时，仅 `@slot1/2/3` 有效 |
| DeepSeek/GLM 进圆桌 | 通过 ClaudeTap 复用 transcript 流（§5.4）；首次需 30 分钟 spike 验证 Stop hook 在 `CLAUDE_CONFIG_DIR` 隔离时仍触发 |
| 单 session（侧边栏非圆桌） | 完全不动 |
| 投研圆桌（scene='research'） | 走同一 modal，仅场景 radio 默认值不同 |
| Pokemon 头像（侧边栏） | `_avatarFor(kind)` 保留，仅圆桌卡片改 `_avatarBySlot(i)` |
| Hook 系统 / MCP 系统 | 不动 |

---

## 8. 测试 / 验证

### 8.1 单元测试

| 测试文件 | 验证 |
|---|---|
| `tests/meeting-create-modal-models.test.js` | `MODELS_BY_KIND` / `DEFAULTS` 常量完整性；`refreshModelOptions` 切换行为 |
| `tests/transcript-tap-deepseek-glm.test.js` | `_backendFor('deepseek')` 返回 ClaudeTap；`_backendFor('glm')` 同 |
| `tests/orchestrator-aistats-migration.test.js` | 老格式 `aiStats:{claude,gemini,codex}` → 新格式按 sid；迁移失败不抛 |
| `tests/private-store-no-whitelist.test.js` | 接受任意 kind（如 'deepseek' / 'glm'）不抛 |

### 8.2 E2E 测试（CDP 真测）

`tests/_e2e-meeting-create-modal-verify.js` 流程：

1. 启动隔离 Hub（`CLAUDE_HUB_DATA_DIR=C:\temp\hub-meeting-create`，端口 9251）
2. **Case A · 默认创建**：点 + → 新建圆桌 → assert Modal 弹出 → 直接点 [创建圆桌] → 进会议室 → assert 3 卡顺序 = Claude/Gemini/Codex，头像 = 皮卡丘/小火龙/杰尼龟 → 截图 `01-default.png`
3. **Case B · 自定义创建**：再点 + → 新建 → 改 Slot 1 = DeepSeek/deepseek-v4-pro，Slot 2 = Claude/Sonnet 4.5，Slot 3 = GLM/glm-4.6 → 创建 → assert 头像顺序仍是皮卡丘/小火龙/杰尼龟（按位置不变），但 model 显示是 deepseek-v4-pro/Sonnet 4.5/glm-4.6 → 截图 `02-custom.png`
4. **流式验证**：发"群策群力"prompt → 等 30s → assert 3 家都流式响应 → 特别检查 DeepSeek 的 transcript-tap 走 ClaudeTap 路径，preview 区有内容（非空）→ 截图 `03-streaming.png`
5. **Case C · kind 重复**：再创建一个圆桌，3 个 slot 都选 Claude/Opus 4.7 → assert 3 个独立 PTY 启动 + UI 不互相干扰 + 各 Stop hook 路由到正确 sid → 截图 `04-three-claude.png`
6. **持久化**：关 Hub → 重启 Hub → 打开 Case B 的 meeting → assert 仍正常显示（slotSpecs 恢复）→ 截图 `05-restored.png`
7. **老 meeting 兼容**：模拟一个无 slotSpecs 的旧 meeting JSON 注入 state.json → 重启 Hub → 打开 → assert 正常渲染（subSessions 数组顺序 → slot index）→ 截图 `06-legacy.png`
8. 截图归档到 `tests/screenshots/meeting-create-modal/`

E2E 必须真按钮点击（不许后端 IPC 假装），按 `CLAUDE.md` 测试铁律。

---

## 9. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | DeepSeek 用 ClaudeTap 后 Stop hook 在 `CLAUDE_CONFIG_DIR=~/.claude-deepseek` 时不触发 | 高 | 立项前 30min spike：跑一次 DeepSeek session，监控 `notifyClaudeStop` 是否被调用。spike 失败则需让 ClaudeTap `_scanOnce` 也扫 `~/.claude-deepseek/projects/` |
| R2 | 旧 meeting 的 aiStats 老格式（kind 索引）迁移失败 | 中 | `_loadState` try/catch + 兜底丢弃旧累计；测试覆盖（§8.1） |
| R3 | 同 kind 重复（如 3 Claude）时 PTY hook 互相干扰 | 中 | 每个 sub 有独立 sid + 独立 PTY + 独立 `CLAUDE_HUB_SESSION_ID`，hook 已经按 sid 路由；E2E Case C 验证 |
| R4 | RT_MENTION_ITEMS 改 slot 后老 prompt 中的 `@claude` 失效 | 中 | 兼容层（§5.3）：kind 唯一时仍注册 `@kind` 别名 |
| R5 | Modal 提交后 IPC 失败（如 model 不存在）卡死用户 | 低 | Modal try/catch + 错误 toast；IPC 端校验 model 在 `MODELS_BY_KIND[kind]` 内 |
| R6 | Codex 加 `opts.model` fallback 后向后兼容 | 低 | 默认值不变，旧调用路径无 opts.model 时仍是 gpt-5.5 |
| R7 | renderer slot 索引重构后某 lookup（如 partialBy）误用 kind 而不是 sid | 中 | 严格 grep 所有 `partialBy[<...>]` 用法，确认全部用 sid；E2E 流式验证 |
| R8 | 三家 Claude 共享 `~/.claude/` 配置目录冲突 | 低 | 既有架构已经支持多 Claude 并发（同目录但 sid 隔离），实测无冲突 |

---

## 10. 版本

修改 `package.json` `version` 从前一版本 `+0.1`（如 `0.4.0` → `0.5.0`）。UI 上版本显示同步。

---

## 11. 文件改造一览

| 文件 | 类型 | 主要改动 |
|---|---|---|
| `renderer/meeting-create-modal.js` | 新增 | Modal 实现（DOM + 交互 + 提交逻辑） |
| `renderer/meeting-create-modal.css` | 新增 | Modal 样式 |
| `renderer/index.html` | 修改 | 引用新 css/js；末尾 modal 容器 |
| `renderer/renderer.js` | 修改 | `createMeetingByMode` 改为 `openMeetingCreateModal` |
| `renderer/meeting-room.js` | 修改 | `subs` → `slots` 数组；`_avatarBySlot` 新增；`RT_MENTION_ITEMS` 动态构建 |
| `main.js` | 修改 | `'create-meeting'` 接受 slots；`'add-meeting-sub'` 接受 model；`_RT_READY_MARKERS` 加 deepseek；投票/互评返回按 sid |
| `core/session-manager.js` | 修改 | Claude/Codex 加 `opts.model` fallback；`relaunchCli` 加 deepseek/glm |
| `core/transcript-tap.js` | 修改 | `_backendFor` 加 deepseek/glm → ClaudeTap |
| `core/roundtable-orchestrator.js` | 修改 | `aiStats` 改 sid 索引 + 老格式迁移 |
| `core/general-roundtable-private-store.js` | 修改 | 去白名单 |
| `core/meeting-store.js` | 修改 | 持久化 `slotSpecs` |
| `package.json` | 修改 | version +0.1 |
| `tests/meeting-create-modal-models.test.js` | 新增 | Modal 常量单测 |
| `tests/transcript-tap-deepseek-glm.test.js` | 新增 | _backendFor 单测 |
| `tests/orchestrator-aistats-migration.test.js` | 新增 | 迁移单测 |
| `tests/private-store-no-whitelist.test.js` | 新增 | 去白名单单测 |
| `tests/_e2e-meeting-create-modal-verify.js` | 新增 | E2E 7 步流程 |

---

## 12. Open Questions / Out of Scope

### 已决策（向 user 确认完）

- UI 形式 = Modal 横排 3 slot
- kind 重复策略 = 允许任意重复
- 默认值 = Claude/Gemini/Codex（保持现状）
- 头像与 slot 绑定（与 kind 解绑）

### Out of Scope（本期不做）

- 第 4+ slot
- 运行中切换某 slot 的 AI（需重启 meeting）
- summary-engine.js 多家 AI 摘要（仍仅 Gemini）
- DeepSeek 的 MCP 工具集成
- "记住上次选择"作为默认值（首版仍用 Claude/Gemini/Codex 默认）
