# 圆桌卡片改造设计文档

**日期**: 2026-05-01
**作者**: Claude (brainstorming)
**状态**: spec · 待用户验收
**关联文件**:
- 效果图 HTML: `docs/roundtable-card-redesign-2026-05-01.html`
- 上游协调: `docs/superpowers/plans/2026-04-30-roundtable-resilience.md`、`docs/superpowers/plans/2026-04-30-roundtable-latency.md`

---

## 1. 背景与现状问题

会议室面板（`renderer/meeting-room.js + meeting-room.css`）的"融合卡片-tab"在 streaming 时存在三个问题：

| # | 问题 | 触发场景 | 视觉表现 |
|---|------|---------|---------|
| **P1** | 横向乱跳 | streaming snippet 越来越长 | 该列宽度被撑大、其他列被挤压 |
| **P2** | 纵向乱跳 | row3 在 thinking/streaming/idle 切换时出现/消失 | 整个 strip 高度抖动 |
| **P3** | 信息不足 + 视觉同质 | 三张卡都长一样、缺少核心统计 | 看不出哪个 AI 跑了多久、烧了多少 token |

### 1.1 根因（CSS 层面）

**横向：**
```css
.mr-ft-strip { grid-template-columns: repeat(3, 1fr); }
```
`1fr` 不带 `minmax(0, ...)` 时，flex/grid 子项会"贪婪"扩展——长内容能撑大该列，挤占其他列宽度。

**纵向：**
```css
.mr-ft { min-height: 72px; }   /* 只有下限，无上限 */
.mr-ft-preview { max-height: 54px; overflow: hidden; }   /* 内部限了，但卡片本身没限 */
```
当某张卡有 streaming preview、其他没有时，grid row 高度被最高的卡撑起，三张卡视觉上"挤压"。

### 1.2 根因（数据展示层面）

当前 `_ftHtml` 仅展示：名字、状态、模型、Ctx%、本轮 elapsed 秒数。
没展示：**累计思考时间**、**本轮/累计 token 用量**——这两个对长会话的资源感知很关键，目前完全缺失。

---

## 2. 设计目标

| 目标 | 验收标准 |
|------|---------|
| **G1：布局零抖动** | 三个 AI 同时 streaming 时，三张卡片高度严格相等，宽度严格三等分，无任何视觉跳动 |
| **G2：纵向高度可视化拉大** | 卡片高度从当前 ~72-130px 拉到 ≈220px（≈ 会议室主区 1/3 高度），让 preview 区有更多空间 |
| **G3：宝可梦头像增加趣味感** | 每张卡片左侧 64×64 圆形头像（皮卡丘=Claude / 小火龙=Gemini / 杰尼龟=Codex），思考/输出时柔和上下浮动 |
| **G4：双重统计可见** | 每张卡片展示 ⏱ 本轮+累计思考时间、🪙 本轮+累计 token 用量 |

**非目标（明确不做）：**

- ❌ 不做 token 拆分 input/output（用户选了简洁版的 total）
- ❌ 不做卡片可拖拽换位
- ❌ 不做头像点击的彩蛋动画
- ❌ 不做响应式降级到单列布局（窗口宽度 < 480px 的情况现在不存在，YAGNI）

---

## 3. 设计原则

### 3.1 CSS 防抖三件套

任何"zero-jump"的多列网格布局都需要这三条同时满足：

1. **横向**: `grid-template-columns: repeat(N, minmax(0, 1fr))` — `minmax(0, 1fr)` 比裸 `1fr` 多了"列宽不被内容撑大"的硬约束
2. **纵向**: 容器 `height: <fixed>` 而非 `min-height`，子元素 `flex: 1` 撑满，长内容 `overflow: hidden` 截尾
3. **内部子结构**: row3/row4/preview 这种"有时有有时无"的元素，要么始终保留占位（哪怕空内容），要么用 `min-height` 锁定槽位

### 3.2 数据累加器的位置

累计数据需要持久化（不能页面刷新就清零）。已有的 `_saveState` 机制（`core/roundtable-orchestrator.js:62`）写入 `state.json`，按现有模式扩展即可：

```
state.aiStats = {
  claude: { totalThinkSec, totalTokens, perTurnHistory: [{ n, thinkSec, tokens }] },
  gemini: { ... },
  codex:  { ... }
}
```

每轮 turn-complete 时累加。重启 Hub 后读回，渲染时直接用。

### 3.3 头像资源

**位置**: `renderer/assets/pokemon/{pikachu,charmander,squirtle}.png`
**大小**: 64×64 实际渲染（源图任意尺寸，CSS object-fit 处理）
**加载**: 直接 `<img src>` 引用相对路径（meeting-room 是 file:// 协议下的页面，可直接相对路径加载）
**fallback**: `onerror` 处理器把 src 切换到 emoji 占位（🟡 / 🟠 / 🔵）

---

## 4. 详细设计

### 4.1 HTML 结构改造（`_ftHtml` 函数）

**当前结构**（`renderer/meeting-room.js:224`）：
```html
<div class="mr-ft claude active">
  <button class="mr-ft-expand">↗</button>
  <div class="mr-ft-row1">name + status + new + elapsed</div>
  <div class="mr-ft-row2">model + ctx</div>
  {row3: progress | preview | empty}
</div>
```

**新结构**：
```html
<div class="mr-ft claude active streaming-card">
  <button class="mr-ft-expand">↗</button>

  <!-- 头部：左大头像 + 右信息列 -->
  <div class="mr-ft-head">
    <div class="mr-ft-avatar">
      <img src="assets/pokemon/pikachu.png" alt="Pikachu" onerror="this.replaceWith(...)">
    </div>
    <div class="mr-ft-info">
      <div class="mr-ft-row1">name + status + new</div>
      <div class="mr-ft-row2">model + ctx</div>
      <div class="mr-ft-row3">⏱ 本轮 Xs · 累计 Ys</div>
      <div class="mr-ft-row4">🪙 本轮 Xk · 累计 Yk</div>
    </div>
  </div>

  <!-- 底部：preview / progress 区域 -->
  <div class="mr-ft-bottom">
    {streaming snippet | thinking progress bar | completed preview | empty}
  </div>
</div>
```

**关键变化**：
- 卡片整体改 `display: flex; flex-direction: column`，head 自然高度，bottom `flex: 1` 撑满
- 原 row1/row2 不变，但被包进 `.mr-ft-info` 列
- 原 elapsed 从 row1 移到 row3 的"本轮"位置（避免重复）
- 新增 row3 (⏱) 和 row4 (🪙)

### 4.2 CSS 改造

**修改的现有规则**：
```css
.mr-ft-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));   /* 改 */
  gap: 0;
  border-bottom: 1px solid #1f2735;
}
.mr-ft {
  padding: 14px 16px;            /* 改 */
  height: 220px;                 /* 改：从 min-height: 72px */
  border-bottom: 3px solid transparent;
  position: relative;
  cursor: pointer;
  display: flex;                 /* 新 */
  flex-direction: column;        /* 新 */
}
.mr-ft-row1 {
  /* 移除 elapsed 相关的 margin-left: auto */
}
.mr-ft-elapsed {
  /* 删除该规则（信息已搬到 row3） */
}
.mr-ft-preview {
  /* 改：去掉 max-height: 54px，由 .mr-ft-bottom 的 flex: 1 接管 */
  font-size: 12px; color: #8b949e; line-height: 1.5;
  overflow: hidden;
  flex: 1;
}
```

**新增规则**：
```css
.mr-ft-head { display: flex; gap: 12px; align-items: flex-start; }

.mr-ft-avatar {
  width: 64px; height: 64px; border-radius: 50%;
  overflow: hidden; flex-shrink: 0;
  background: rgba(255,255,255,0.04);
  border: 2px solid transparent;
  transition: transform .2s, border-color .2s;
}
.mr-ft.claude .mr-ft-avatar { border-color: rgba(var(--c-claude-rgb), 0.4); }
.mr-ft.gemini .mr-ft-avatar { border-color: rgba(var(--c-gemini-rgb), 0.4); }
.mr-ft.codex  .mr-ft-avatar { border-color: rgba(var(--c-codex-rgb), 0.4); }
.mr-ft.thinking-card .mr-ft-avatar,
.mr-ft.streaming-card .mr-ft-avatar {
  animation: avatar-bounce 1.6s ease-in-out infinite;
}
@keyframes avatar-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
.mr-ft-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }

.mr-ft-info {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  gap: 4px;
}

.mr-ft-row3, .mr-ft-row4 {
  display: flex; align-items: center;
  font-size: 11px; color: #8b949e;
  font-variant-numeric: tabular-nums;
  gap: 6px;
}
.mr-ft-row3 .icon, .mr-ft-row4 .icon { opacity: 0.7; }
.mr-ft-stat-current { color: #fde68a; font-weight: 600; }
.mr-ft-stat-total { color: #8b949e; }
.mr-ft-stat-divider { color: rgba(255,255,255,0.15); margin: 0 2px; }

.mr-ft-bottom {
  margin-top: 10px;
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  border-top: 1px solid rgba(255,255,255,0.04);
  padding-top: 8px;
}
```

### 4.3 渲染层（`_renderFusedTabs` + `_ftHtml`）改造

**`_ftHtml` 签名扩展**（保持向后兼容的渐进改造）：
```js
function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls,
                 ctxPct, ctxCls, bottomHtml,
                 thinkCurrent, thinkTotal,    /* 新 */
                 tokensCurrent, tokensTotal,  /* 新 */
                 newBadge) { ... }
```

`row3` 参数被拆成 `bottomHtml`（用于 preview/progress）+ 单独的 thinkCurrent/total + tokens 字段（直接由 `_ftHtml` 内部组装）。

**`_renderFusedTabs` 调用侧**（`renderer/meeting-room.js:150-222`）：

每次 render 时计算四个统计字段：

```js
// per-AI stats from meeting state
const aiStats = (state.aiStats && state.aiStats[kind]) || {};
const totalThinkSec = aiStats.totalThinkSec || 0;
const totalTokens   = aiStats.totalTokens || 0;

// current-turn from existing partial / lastTurn
let thinkCurrent = '-';
if (status === 'thinking' || status === 'streaming') {
  thinkCurrent = `${elapsed}s`;
} else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
  thinkCurrent = `${lastTurn.thinkSecBy[sub.sid]}s`;
}

let tokensCurrent = '-';
if (partial && partial.tokens && partial.tokens.total != null) {
  tokensCurrent = formatTokens(partial.tokens.total);
} else if (lastTurn && lastTurn.tokensBy && lastTurn.tokensBy[sub.sid] != null) {
  tokensCurrent = formatTokens(lastTurn.tokensBy[sub.sid]);
}

// pass to _ftHtml...
```

**辅助函数 `formatTokens`**：
```js
function formatTokens(n) {
  if (n == null) return '-';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatThinkTime(seconds) {
  if (seconds == null) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${s.toString().padStart(2, '0')}s`;
}
```

### 4.4 累加器改造（`core/roundtable-orchestrator.js`）

**state schema 扩展**：
```js
// state.aiStats 默认初始化
state.aiStats = state.aiStats || {
  claude: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
  gemini: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
  codex:  { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] }
};
```

**累加点：每轮 turn-complete 时**

定位现有 turn-complete 路径（`main.js _rtWaitTurnComplete` 完成后回填到 state.turns 时），插入：

```js
// 当一轮 fan-out 全部完成（或部分完成时各自结算）
function recordTurnStats(state, kind, thinkSec, tokens) {
  if (!state.aiStats[kind]) state.aiStats[kind] = { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] };
  const stats = state.aiStats[kind];
  stats.totalThinkSec += thinkSec || 0;
  stats.totalTokens   += tokens || 0;
  stats.perTurnHistory.push({ n: state.turns.length, thinkSec, tokens, ts: Date.now() });
}
```

`turns[].thinkSecBy[sid]` 和 `turns[].tokensBy[sid]` 也要在此时回填，供"已答 ✓"卡片渲染时读取。

### 4.5 资源文件

**位置约定**：`renderer/assets/pokemon/`
**文件**:
- `pikachu.png` (Claude)
- `charmander.png` (Gemini)
- `squirtle.png` (Codex)

**来源**: 从用户原始消息中提供的图片（已复制到 `docs/assets/pokemon/` 用于 mockup，实施时再 copy 一份到 `renderer/assets/pokemon/`）

**HTML 引用**: `<img src="assets/pokemon/pikachu.png">` —— 注意 `meeting-room.html`（或父级 index.html）的相对路径基准

**onerror fallback**: 加载失败时换 emoji 字符（避免破图）

### 4.6 状态映射的范围说明

**本次改造只维护既有状态枚举：** `idle / initializing / thinking / streaming / completed / timeout`。

resilience plan 会引入新状态（`manual_extracted` / `absent` / `errored` / `soft_alert` 等），这些**不归本次 plan 处理**——由 resilience plan 自己负责扩展 `statusLabel` 和对应的 CSS。本次只确保 `_ftHtml` 对未知 status 有 fallback（`statusLabel[status] || status`），且 CSS 中没有 status 相关的硬编码 class 列表导致新增状态渲染崩溃。

如果 resilience plan 已合并后再做本次改造，实施时直接保留 resilience 已加的新状态映射即可（不要回退）。

---

## 5. 数据流

```
┌─────────────────────────────────────────────────────┐
│ transcript-tap.js                                    │
│  - emits partial.tokens.total during streaming      │
│  - emits final tokens on turn-complete              │
└─────────────┬────────────────────────────────────────┘
              │ IPC
              ▼
┌─────────────────────────────────────────────────────┐
│ main.js / roundtable-orchestrator.js                 │
│  - on turn-complete:                                 │
│    state.turns[n].thinkSecBy[sid] = elapsed         │
│    state.turns[n].tokensBy[sid]   = tokens          │
│    state.aiStats[kind].totalThinkSec += elapsed     │
│    state.aiStats[kind].totalTokens   += tokens      │
│  - _saveState() persists to state.json              │
└─────────────┬────────────────────────────────────────┘
              │ IPC update
              ▼
┌─────────────────────────────────────────────────────┐
│ renderer/meeting-room.js                             │
│  _renderFusedTabs(state, ...) reads:                │
│   - state.aiStats[kind].totalThinkSec/totalTokens   │
│   - lastTurn.thinkSecBy/tokensBy (for completed)    │
│   - partial.tokens.total + _thinkStartTs (live)     │
│  passes them to _ftHtml → renders row3/row4         │
└─────────────────────────────────────────────────────┘
```

---

## 6. 风险与边界条件

| 场景 | 处理 |
|------|------|
| 头像 PNG 加载失败 | `<img onerror>` 替换为 emoji 字符（🟡/🟠/🔵） |
| Gemini 部分场景拿不到 token 数 | 显示 `本轮 -`，不写入累加器（避免错误统计） |
| state.aiStats 在旧版 state.json 缺失 | `_renderFusedTabs` 用 `(state.aiStats?.[kind]) || {}` 软取，缺值显 0 |
| 累计数据持久化时机 | 复用 `_saveState` 现有机制；turn-complete 时写一次 |
| preview 区文本极长（10k 字符） | `flex: 1; overflow: hidden` 自然截尾，不影响布局 |
| 会议室主区窗口被极度压缩 | 220px 固定高度+三列等分仍然成立；窗口 < 480px 由用户接受降级 |
| 头像 bounce 动画性能 | 仅 transform: translateY，GPU 合成，3 元素无压力 |
| Active 卡片视觉强化 | 通过 `border-bottom` 颜色 + 背景色实现（已有），不和头像冲突 |
| 轮次切换时统计字段闪烁 | 渲染时 lastTurn.thinkSecBy / partial.tokens 优先级清晰，不跨态混用 |

---

## 7. 测试要求

### 7.1 视觉回归测试（手动 + Playwright 截图）

| # | 场景 | 验证点 |
|---|------|--------|
| T1 | 三 AI 同时 streaming（10 秒持续输出） | 三张卡高度一致、宽度一致、无视觉抖动 |
| T2 | 三 AI 完成态展示 | 时间/token 累加正确，"本轮"和"累计"都显示 |
| T3 | 一个 timeout + 一个完成 + 一个 idle | 三张卡仍等高，timeout 卡的时间值红色显示 |
| T4 | 头像加载失败模拟（rename 图片文件） | 自动 fallback 到 emoji |
| T5 | 重启 Hub 验证累计数据持久化 | state.json 中 aiStats 已写入；UI 重新渲染时累计值正确恢复 |
| T6 | 轮次连续 5 轮以上 | 累计思考时间、累计 token 持续增长，无重置 |

### 7.2 Playwright 自动化（参考 `tests/test_e2e_critical.py` 模板）

- 启动隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR`）
- 进入会议室，触发一轮辩论
- 截图 strip 区域，对比基线
- 验证 DOM 中 row3/row4 的 textContent 包含 `本轮` 和 `累计`

---

## 8. 与既有改造的协调

| 关联 plan | 冲突点 | 协调策略 |
|----------|--------|---------|
| `2026-04-30-roundtable-latency.md` | 改 `main.js _rtSendToPty` | 完全独立，可并行 |
| `2026-04-30-roundtable-resilience.md` | 改 transcript-tap 的信号识别 + 新增状态 | 本次新增的 `mr-ft-status` 状态映射要覆盖 resilience plan 的 `manual_extracted`/`absent`/`errored`/`soft_alert` |

**建议执行顺序**：
1. 先 `latency`（最小风险，独立）
2. 再 `resilience`（引入新状态字段）
3. 最后 `card-redesign`（消费 resilience 的状态做 UI）

如果 resilience 和 card-redesign 同时执行，要在 PR 阶段合并状态映射表（避免 status 枚举出现两套定义）。

---

## 9. 项目文件锚点

| 文件 | 作用 |
|------|------|
| `renderer/meeting-room.js:150-222` | `_renderFusedTabs` 主渲染函数 |
| `renderer/meeting-room.js:224` | `_ftHtml` 卡片 HTML 构建器（重点改造） |
| `renderer/meeting-room.css:518-586` | `.mr-ft-*` 全部 CSS 规则（重点改造） |
| `core/roundtable-orchestrator.js` | state schema + turn-complete 累加 |
| `core/transcript-tap.js` | partial/final tokens 数据源（不改） |
| `main.js _rtWaitTurnComplete` | turn-complete 触发点（在此处插入累加调用） |
| `renderer/assets/pokemon/` | 新增资源目录 |
| `docs/roundtable-card-redesign-2026-05-01.html` | 本次设计的可视化效果图 |

---

## 10. 改动总览

**新增**：
- `renderer/assets/pokemon/{pikachu,charmander,squirtle}.png` (3 文件)
- `state.aiStats` 字段
- `formatTokens` / `formatThinkTime` 辅助函数
- 几个 CSS 类（`.mr-ft-head` / `.mr-ft-avatar` / `.mr-ft-info` / `.mr-ft-row3/4` / `.mr-ft-bottom`）
- `recordTurnStats` 累加函数

**修改**：
- `_ftHtml` 函数签名 + 模板
- `_renderFusedTabs` 中 stats 字段计算
- `.mr-ft-strip` / `.mr-ft` / `.mr-ft-preview` 等 CSS 规则
- turn-complete 路径加累加调用

**删除**：
- `.mr-ft-elapsed` CSS 规则（信息搬到 row3）
- 原 row1 的 `margin-left: auto` 逻辑

---

## 11. 下一步

1. 用户验收本 spec
2. 进入 `writing-plans` skill 写实施 plan.md
3. plan.md 拆成 5-7 个可独立执行的 Task
4. 提交给执行 Claude 实施

---

**版本号同步提醒（参照 CLAUDE.md 铁律）**：
本次涉及 UI 可见改动（头像、卡片高度、新统计行），实施时必须同步更新 Hub 的 `package.json:version`，并在 UI 上能看到新版本号（具体位置由 Hub 现有版本号显示位决定，主进程已有相关逻辑）。
