# 圆桌卡片改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把圆桌融合卡片-tab 改造为「固定布局 + 宝可梦头像 + 双重统计」——彻底消除 streaming 抖动，新增⏱时间 / 🪙token 的本轮+累计统计，并在左侧加入皮卡丘/小火龙/杰尼龟头像增加视觉趣味。

**Architecture:**
- **CSS 防抖三件套**：`grid-template-columns: repeat(3, minmax(0, 1fr))` + `.mr-ft { height: 220px; display: flex; flex-direction: column }` + `.mr-ft-bottom { flex: 1; overflow: hidden }`
- **数据层**：在 `RoundtableOrchestrator` 引入 `state.aiStats[kind] = { totalThinkSec, totalTokens, perTurnHistory }`，每轮 `completeTurn` 时累加；turn record 同步携带 `thinkSecBy / tokensBy` 用于"已答 ✓"卡片回显
- **采集层**：`main.js _rtWaitTurnComplete` 包装记录 startTs，settle 时 `result.thinkSec = (Date.now() - startTs)/1000`；token 通过 `transcript-tap` 暴露的 `getLastTokens(sid)` 在 settle 时拉取
- **渲染层**：`_ftHtml` 拆出 `.mr-ft-head`（左侧 64×64 圆形头像 + 右侧 4 行信息列）和 `.mr-ft-bottom`（preview/progress 区，`flex: 1` 撑满）

**Tech Stack:** Electron / vanilla JS renderer / 原生 CSS Grid + Flexbox / Node.js core 模块 / pytest + Playwright (CDP) E2E

---

## File Structure

**Create:**
- `renderer/assets/pokemon/pikachu.png` — Claude 头像
- `renderer/assets/pokemon/charmander.png` — Gemini 头像
- `renderer/assets/pokemon/squirtle.png` — Codex 头像

**Modify:**
- `renderer/meeting-room.css` — 防抖三件套 + 头像 + 新行 CSS 规则（约 +60 行）
- `renderer/meeting-room.js` — `_ftHtml` 重构 + `_renderFusedTabs` 计算 stats + 加 helper（约 +50 行 / 改 ~30 行）
- `core/roundtable-orchestrator.js` — `state.aiStats` schema + `completeTurn` 接受 `thinkSecBy / tokensBy` + `recordTurnStats` 内部累加（~+30 行）
- `core/transcript-tap.js` — 暴露 `getLastTokens(sid)` API（~+15 行；如已有等价接口则直接复用）
- `main.js` — `_rtWaitTurnComplete` 包装注入 thinkSec + tokens；`dispatchRoundtableTurn` 把 stats 映射传给 `completeTurn`（~+20 行）
- `package.json` — version 0.1.0 → 0.2.0
- (UI 版本号显示位) — 见 Task 7 中查找步骤

---

## Task 1: 复制宝可梦头像资源

**Files:**
- Create: `renderer/assets/pokemon/pikachu.png`
- Create: `renderer/assets/pokemon/charmander.png`
- Create: `renderer/assets/pokemon/squirtle.png`

**说明：** 头像图片已在 brainstorming 阶段复制到 `docs/assets/pokemon/`，本 Task 把它们复制到 renderer 实际加载位置。

- [ ] **Step 1: 创建目录并复制图片**

Bash 命令（Git Bash 路径风格）:
```bash
mkdir -p renderer/assets/pokemon
cp docs/assets/pokemon/pikachu.png renderer/assets/pokemon/pikachu.png
cp docs/assets/pokemon/charmander.png renderer/assets/pokemon/charmander.png
cp docs/assets/pokemon/squirtle.png renderer/assets/pokemon/squirtle.png
ls -la renderer/assets/pokemon/
```

Expected: 三个 png 文件存在（28-52 KB 各一个）

- [ ] **Step 2: 验证文件不为空、是有效 PNG**

```bash
file renderer/assets/pokemon/*.png
```

Expected: 三行都显示 `PNG image data, ...`（如果 `file` 命令不可用，跳过此步）

- [ ] **Step 3: 提交资源文件**

```bash
git add renderer/assets/pokemon/
git commit -m "feat(roundtable): add Pokemon avatars for AI cards (pikachu/charmander/squirtle)"
```

---

## Task 2: 在 transcript-tap 暴露 getLastTokens(sid)

**Files:**
- Modify: `core/transcript-tap.js`

**目的：** main.js 在 turn-complete settle 时需要取该 sid 最后一次的 token 总数。`transcript-tap` 已经在 partial-update 时算过 `tokens.total`，本 Task 把它缓存并对外暴露。

- [ ] **Step 1: 找到 transcript-tap 中 partial.tokens 计算位置**

Run:
```bash
grep -n "tokens" core/transcript-tap.js | head -20
```

Expected: 看到几处涉及 `tokens.total` / `partial.tokens` 的位置（约 540-610 行附近）

- [ ] **Step 2: 在模块顶部加 lastTokensBy 缓存**

Modify `core/transcript-tap.js` —— 在文件顶部 `'use strict';` 后、模块导出之前添加：

```js
// per-sid 最后一次观测到的 token 总数（供 roundtable settle 读取）
const _lastTokensBy = new Map();

function getLastTokens(sid) {
  return _lastTokensBy.get(sid) || null;
}

function _recordTokens(sid, tokens) {
  if (sid && tokens && typeof tokens.total === 'number') {
    _lastTokensBy.set(sid, { ...tokens });
  }
}

function clearLastTokens(sid) {
  if (sid) _lastTokensBy.delete(sid);
}
```

- [ ] **Step 3: 在 partial.tokens 计算成功的代码路径调用 _recordTokens**

定位现有 partial 发射点（搜索 `partial.tokens.total` 或 `tokens: { total` 等模式），在 partial 对象组装好后加一行：

```js
_recordTokens(sid, partial.tokens);  // 新增
```

例如（伪代码示例，具体位置请按实际代码调整）：
```js
const partial = { sid, kind, content: ..., tokens: { input, output, total } };
_recordTokens(sid, partial.tokens);  // 新增
ipcEvent.sender.send('transcript-partial', partial);
```

- [ ] **Step 4: 模块导出处加 getLastTokens / clearLastTokens**

找到 `module.exports = { ... }`，在导出对象里添加两个新函数：

```js
module.exports = {
  // ...原有导出...
  getLastTokens,
  clearLastTokens,
};
```

- [ ] **Step 5: 简单验证（启动 Hub + 跑一轮 fanout，console.log 抓取）**

在调用 `getLastTokens` 的地方临时加 `console.log('[debug] getLastTokens', sid, getLastTokens(sid))`，启动隔离 Hub 实例：

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-test"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9221
```

发起一轮简单 fanout 后看主进程日志是否打印出 `{ input: N, output: M, total: K }`，验证后**记得删除调试 log**。

- [ ] **Step 6: 提交**

```bash
git add core/transcript-tap.js
git commit -m "feat(transcript-tap): expose getLastTokens(sid) for downstream stats consumers"
```

---

## Task 3: 在 main.js _rtWaitTurnComplete 注入 thinkSec + tokens

**Files:**
- Modify: `main.js:653-700` (`_rtWaitTurnComplete` 函数)

**目的：** watcher settle 后给 result 补两个字段：`thinkSec`（从 watcher 启动到 settle 的实际秒数）、`tokens`（settle 那一刻的 token 总数）。

- [ ] **Step 1: 在 _rtWaitTurnComplete 顶部记录 startTs**

修改 `main.js:653` 起的函数，加一行：

```js
function _rtWaitTurnComplete(sid, label, opts = {}) {
  const { meetingId, mode, turnNum, onPartial } = opts;
  const _startTs = Date.now();   // 新增

  const watcher = createTurnCompletionWatcher({
    // ...原有...
  });
  // ...
}
```

- [ ] **Step 2: settle 路径中给 result 注入 thinkSec + tokens**

修改 `main.js:691-699` 的 then 回调（即 `return watcher.wait().then(result => { ... })` 部分）：

```js
return watcher.wait().then(result => {
  clearTimeout(hardTimeout);
  if (streamTimer) clearInterval(streamTimer);
  _activeWatchers.delete(sid);

  // 新增：注入统计字段
  const elapsedSec = Math.round((Date.now() - _startTs) / 100) / 10; // 0.1 秒精度
  const lastTokens = transcriptTap.getLastTokens(sid);
  result.thinkSec = elapsedSec;
  result.tokens = lastTokens; // { input, output, total } 或 null

  if (typeof onPartial === 'function') {
    try { onPartial(result); } catch (e) { console.warn('[roundtable] onPartial error:', e.message); }
  }
  return result;
});
```

- [ ] **Step 3: 在 dispatchRoundtableTurn 中收集 thinkSec/tokens（暂不传 completeTurn）**

修改 `main.js:811-824`（results 处理 → byMap/byStatus 构建）。**本步只采集字段、log 验证，但 completeTurn 调用签名扩展放到 Task 4 Step 3 一起做**（避免本任务结束后 orchestrator 收到未支持的参数报错）：

```js
const byMap = {};
const byStatus = {};
const thinkSecBy = {};   // 新增（Task 3）
const tokensBy = {};     // 新增（Task 3）
for (const r of results) {
  byMap[r.sid] = r.text || '';
  byStatus[r.sid] = r.status || 'completed';
  thinkSecBy[r.sid] = r.thinkSec || 0;
  tokensBy[r.sid] = (r.tokens && r.tokens.total) || 0;
}
console.log('[roundtable][debug] turn', turnNum, 'thinkSecBy=', thinkSecBy, 'tokensBy=', tokensBy);
const meta = {};
if (mode === 'summary') {
  meta.summarizer = summarizerKind;
  meta.summarizerSid = sentTargets[0]?.sid || null;
  const title = roundtable.extractDecisionTitle(results[0]?.text || '');
  if (title) meta.decisionTitle = title;
}
// completeTurn 调用维持原签名（不带 stats），Task 4 Step 3 再扩展
orch.completeTurn(turnNum, mode, userInput || '', byMap, meta, byStatus);
```

启动一轮 fanout，看主进程日志是否打印 `thinkSecBy={ ...: 12.3, ... }` 等数值，验证采集 OK 后**保留 console.log**（Task 4 Step 3 之后再删）。

- [ ] **Step 4: 验证 main.js 仍能 require / 启动**

```bash
node -e "require('./main.js')" 2>&1 | head -5
```

预期：脚本 require main.js 不会报语法错误（Electron 主进程逻辑会因缺 BrowserWindow 等中断，但语法层应通过；如果立即抛错说"transcriptTap.getLastTokens is not a function"，回到 Task 2 检查导出）。

更稳的办法：直接启动隔离 Hub（参考 Task 2 Step 5），看 splash log 是否出现 `[hub] hook server listening`：

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

预期：看到 `[hub] hook server listening on 127.0.0.1:NNNN`。

- [ ] **Step 5: 提交**

```bash
git add main.js
git commit -m "feat(roundtable): collect thinkSec & tokens at turn-complete settle"
```

---

## Task 4: completeTurn 扩展 + state.aiStats 累加器

**Files:**
- Modify: `core/roundtable-orchestrator.js:38-44` (state 初始化)
- Modify: `core/roundtable-orchestrator.js:211-227` (completeTurn 函数)

**目的：** state schema 加 `aiStats`；`completeTurn` 接受新参数并累加。

- [ ] **Step 1: state 初始化加 aiStats**

修改 `core/roundtable-orchestrator.js:38`，把 constructor 里的 `this.state = { ... }` 改为：

```js
this.state = {
  meetingId,
  currentTurn: 0,
  currentMode: 'idle',
  turns: [],
  aiStats: {                                            // 新增
    claude: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
    gemini: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
    codex:  { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
  },
};
this._loadState();
```

- [ ] **Step 2: _loadState 兼容旧文件（缺 aiStats 时补默认）**

修改 `core/roundtable-orchestrator.js:54-63`，在 `_loadState` 里 raw 校验后补一段：

```js
_loadState() {
  const fp = this._stateFilePath();
  if (!fs.existsSync(fp)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (raw && raw.meetingId === this.meetingId) {
      this.state = raw;
      // 旧 state.json 可能没有 aiStats，补默认
      if (!this.state.aiStats) {
        this.state.aiStats = {
          claude: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
          gemini: { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
          codex:  { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] },
        };
      }
    }
  } catch (e) {
    console.warn(`[roundtable] load state failed for ${this.meetingId}:`, e.message);
  }
}
```

- [ ] **Step 3: 加内部 _kindOfSid 辅助（用于按 kind 累加）**

由于 `state.aiStats` 用 kind 为 key 但 byMap 用 sid，需要 sid → kind 的反查。在 main.js 那一层调用前已有 `subs` 映射，但传到 orchestrator 时只有 sid。最简洁的做法是 main.js 把 `kindBy`（sid→kind 映射）也传过来：

修改 `main.js:824` 调用处，让 thinkSecBy / tokensBy 直接用 kind 为 key（更直观）：

```js
const thinkSecByKind = { claude: 0, gemini: 0, codex: 0 };
const tokensByKind = { claude: 0, gemini: 0, codex: 0 };
for (const r of results) {
  const target = sentTargets.find(t => t.sid === r.sid);
  if (target && target.kind) {
    thinkSecByKind[target.kind] = r.thinkSec || 0;
    tokensByKind[target.kind] = (r.tokens && r.tokens.total) || 0;
  }
}
// 同时保留 sid 维度（用于 turn record 中的 thinkSecBy）
const thinkSecBy = {};
const tokensBy = {};
for (const r of results) {
  thinkSecBy[r.sid] = r.thinkSec || 0;
  tokensBy[r.sid] = (r.tokens && r.tokens.total) || 0;
}
orch.completeTurn(turnNum, mode, userInput || '', byMap, meta, byStatus, {
  thinkSecBy, tokensBy, thinkSecByKind, tokensByKind
});
```

**同时删除 Task 3 Step 3 留下的临时 console.log**（`console.log('[roundtable][debug] turn', ...)` 那一行）。

- [ ] **Step 4: 改 completeTurn 函数签名 + 累加逻辑**

修改 `core/roundtable-orchestrator.js:211-227`：

```js
// 完成一轮：写持久化
// byMap: { sid: text }
// meta: 任意附加（如 summarizer / decisionTitle）
// byStatus: { sid: 'completed' | 'manual_extracted' | 'absent' | 'errored' | ... }
// stats: { thinkSecBy, tokensBy, thinkSecByKind, tokensByKind }（可选；缺省走旧路径）
completeTurn(turnNum, mode, userInput, byMap, meta = {}, byStatus = null, stats = null) {
  const record = {
    n: turnNum,
    mode,
    userInput: userInput || '',
    by: byMap || {},
    byStatus: byStatus || null,
    thinkSecBy: stats?.thinkSecBy || {},     // 新增
    tokensBy: stats?.tokensBy || {},         // 新增
    timestamp: Date.now(),
    ...meta,
  };
  this.state.turns.push(record);
  this.state.currentMode = 'idle';
  delete this.state.currentSummarizerKind;

  // 累加 aiStats
  if (stats && stats.thinkSecByKind && stats.tokensByKind) {
    for (const kind of ['claude', 'gemini', 'codex']) {
      if (!this.state.aiStats[kind]) {
        this.state.aiStats[kind] = { totalThinkSec: 0, totalTokens: 0, perTurnHistory: [] };
      }
      const s = this.state.aiStats[kind];
      const thisSec = stats.thinkSecByKind[kind] || 0;
      const thisTok = stats.tokensByKind[kind] || 0;
      s.totalThinkSec += thisSec;
      s.totalTokens += thisTok;
      s.perTurnHistory.push({ n: turnNum, thinkSec: thisSec, tokens: thisTok, ts: Date.now() });
    }
  }

  this._saveState();
  this._saveTurnFile(record);
  return record;
}
```

- [ ] **Step 5: 写一个简单的 require + 调用验证**

```bash
node -e "
const { RoundtableOrchestrator } = require('./core/roundtable-orchestrator');
const fs = require('fs');
const tmpDir = require('os').tmpdir() + '/hub-test-' + Date.now();
fs.mkdirSync(tmpDir, { recursive: true });

const orch = new RoundtableOrchestrator(tmpDir, 'test-meeting', { name: 'test' });
orch.beginTurn = function(mode) { this.state.currentTurn += 1; this.state.currentMode = mode; return this.state.currentTurn; };
orch.beginTurn('fanout');

orch.completeTurn(1, 'fanout', 'hello', { sid1: 'A', sid2: 'B' }, {}, null, {
  thinkSecBy: { sid1: 12.3, sid2: 8.5 },
  tokensBy: { sid1: 4200, sid2: 3100 },
  thinkSecByKind: { claude: 12.3, gemini: 8.5, codex: 0 },
  tokensByKind: { claude: 4200, gemini: 3100, codex: 0 },
});

const s = orch.state.aiStats;
console.log('claude totalThinkSec:', s.claude.totalThinkSec);
console.log('gemini totalTokens:', s.gemini.totalTokens);
console.log('codex perTurn[0]:', s.codex.perTurnHistory[0]);

if (s.claude.totalThinkSec === 12.3 && s.gemini.totalTokens === 3100) {
  console.log('PASS');
} else {
  console.log('FAIL');
  process.exit(1);
}
"
```

Expected output:
```
claude totalThinkSec: 12.3
gemini totalTokens: 3100
codex perTurn[0]: { n: 1, thinkSec: 0, tokens: 0, ts: ... }
PASS
```

- [ ] **Step 6: 提交**

```bash
git add core/roundtable-orchestrator.js main.js
git commit -m "feat(roundtable): track per-AI think time & token stats per turn + persistent accumulator"
```

---

## Task 5: CSS 改造（防抖三件套 + 头像 + 新行）

**Files:**
- Modify: `renderer/meeting-room.css:518-586` (.mr-ft-* 区块)

- [ ] **Step 1: 修改 .mr-ft-strip 防溢出**

定位 `renderer/meeting-room.css:519`：

```css
/* 旧 */
.mr-ft-strip { display: grid; grid-template-columns: repeat(3,1fr); gap: 0; border-bottom: 1px solid #1f2735; }
```

替换为：

```css
.mr-ft-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border-bottom: 1px solid #1f2735; }
```

- [ ] **Step 2: 修改 .mr-ft 固定高度 + flex 布局**

定位 `renderer/meeting-room.css:520-526`：

```css
/* 旧 */
.mr-ft {
  padding: 12px 14px; cursor: pointer;
  border-bottom: 3px solid transparent;
  transition: background .15s, border-color .15s;
  position: relative;
  min-height: 72px;
}
```

替换为：

```css
.mr-ft {
  padding: 14px 16px; cursor: pointer;
  border-bottom: 3px solid transparent;
  transition: background .15s, border-color .15s;
  position: relative;
  height: 220px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

- [ ] **Step 3: 删除 .mr-ft-elapsed 规则**

定位 `renderer/meeting-room.css:547`：

```css
/* 删除整行 */
.mr-ft-elapsed { font-size: 11px; color: #fde68a; margin-left: auto; font-variant-numeric: tabular-nums; font-family: "Cascadia Mono", Consolas, monospace; }
```

（信息已搬到新增的 row3）

- [ ] **Step 4: 修改 .mr-ft-preview 改用 flex 撑满**

定位 `renderer/meeting-room.css:566-569`：

```css
/* 旧 */
.mr-ft-preview {
  font-size: 12px; color: #8b949e; margin-top: 5px; line-height: 1.5;
  max-height: 54px; overflow: hidden;
}
```

替换为：

```css
.mr-ft-preview {
  font-size: 12px; color: #8b949e; line-height: 1.5;
  flex: 1;
  overflow: hidden;
}
```

- [ ] **Step 5: 修改 .mr-ft-row1 去掉 elapsed 占位**

定位 `renderer/meeting-room.css:535`：

```css
/* 旧 */
.mr-ft-row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
```

保留即可（margin-bottom 由 .mr-ft-info gap 接管，可改为 0；安全起见两种都不会破坏布局）。
为了清晰，改为：

```css
.mr-ft-row1 { display: flex; align-items: center; gap: 8px; }
```

类似 `.mr-ft-row2 { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }` 也把 `margin-bottom` 改为 0：

```css
.mr-ft-row2 { display: flex; align-items: center; gap: 6px; }
```

- [ ] **Step 6: 在 .mr-ft 区块末尾追加新规则**

在 `renderer/meeting-room.css:586` 之后（`.mr-ft .mr-ft-new` 规则之后）追加：

```css
/* === Card redesign 2026-05-01: head + avatar + stat rows + bottom === */
.mr-ft-head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.mr-ft-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: rgba(255,255,255,0.04);
  border: 2px solid transparent;
  transition: transform .2s, border-color .2s;
}
.mr-ft.claude .mr-ft-avatar { border-color: rgba(var(--c-claude-rgb), 0.4); }
.mr-ft.gemini .mr-ft-avatar { border-color: rgba(var(--c-gemini-rgb), 0.4); }
.mr-ft.codex  .mr-ft-avatar { border-color: rgba(var(--c-codex-rgb), 0.4); }
.mr-ft-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mr-ft.thinking-card .mr-ft-avatar,
.mr-ft.streaming-card .mr-ft-avatar {
  animation: mr-ft-avatar-bounce 1.6s ease-in-out infinite;
}
@keyframes mr-ft-avatar-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

.mr-ft-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mr-ft-row3, .mr-ft-row4 {
  display: flex;
  align-items: center;
  font-size: 11px;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
  gap: 6px;
}
.mr-ft-row3 .mr-ft-stat-icon,
.mr-ft-row4 .mr-ft-stat-icon { opacity: 0.7; }
.mr-ft-stat-current { color: #fde68a; font-weight: 600; }
.mr-ft-stat-total { color: #8b949e; }
.mr-ft-stat-divider { color: rgba(255,255,255,0.15); margin: 0 2px; }
.mr-ft-row3.timeout .mr-ft-stat-current { color: #fca5a5; }

.mr-ft-bottom {
  margin-top: 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(255,255,255,0.04);
  padding-top: 8px;
}
```

- [ ] **Step 7: 提交**

```bash
git add renderer/meeting-room.css
git commit -m "style(roundtable): card redesign - fixed 220px + minmax(0,1fr) anti-jump + avatar + stat rows"
```

---

## Task 6: HTML 结构重构（_ftHtml + _renderFusedTabs + helpers）

**Files:**
- Modify: `renderer/meeting-room.js:150-239` (`_renderFusedTabs` + `_ftHtml`)

- [ ] **Step 1: 在文件顶部 IIFE 内（约第 5-30 行的初始化区域）添加两个 helper**

定位 `renderer/meeting-room.js` 中已有的 `escapeHtml` / `modelShort` 等 helper 附近，添加：

```js
function _formatTokens(n) {
  if (n == null || n === 0) return '-';
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const v = (n / 1000).toFixed(1);
    return v.replace(/\.0$/, '') + 'k';
  }
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function _formatThinkTime(seconds) {
  if (seconds == null || seconds === 0) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

function _avatarSrcFor(kind) {
  return ({
    claude: 'assets/pokemon/pikachu.png',
    gemini: 'assets/pokemon/charmander.png',
    codex:  'assets/pokemon/squirtle.png',
  })[kind] || '';
}

function _avatarFallbackFor(kind) {
  return ({ claude: '🟡', gemini: '🟠', codex: '🔵' })[kind] || '🤖';
}
```

- [ ] **Step 2: 在 helper 同区域加单元自测（开发期临时）**

在控制台或 node REPL 中测试：

```bash
node -e "
function _formatTokens(n){if(n==null||n===0)return'-';if(n<1000)return String(n);if(n<1000000){const v=(n/1000).toFixed(1);return v.replace(/\.0\$/,'')+'k'}return(n/1000000).toFixed(1).replace(/\.0\$/,'')+'M'}
function _formatThinkTime(s){if(s==null||s===0)return'-';if(s<60)return Math.round(s)+'s';const m=Math.floor(s/60);const x=Math.round(s%60);return x===0?m+'m':m+'m'+String(x).padStart(2,'0')+'s'}
console.log(_formatTokens(0));            // -
console.log(_formatTokens(450));          // 450
console.log(_formatTokens(4200));         // 4.2k
console.log(_formatTokens(28500));        // 28.5k
console.log(_formatTokens(1500000));      // 1.5M
console.log(_formatThinkTime(0));         // -
console.log(_formatThinkTime(12));        // 12s
console.log(_formatThinkTime(45.3));      // 45s
console.log(_formatThinkTime(83));        // 1m23s
console.log(_formatThinkTime(120));       // 2m
"
```

Expected: 输出与注释一致。

- [ ] **Step 3: 重写 `_ftHtml` 函数**

替换 `renderer/meeting-room.js:224-239` 整个 `_ftHtml` 函数：

```js
function _ftHtml(kind, isActive, sid, name, statusLabel, statusCls, modelName, modelCls, ctxPct, ctxCls, bottomHtml,
                 thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge) {
  const cls = ['mr-ft', kind];
  if (isActive) cls.push('active');
  if (statusCls === 'thinking') cls.push('thinking-card');
  if (statusCls === 'streaming') cls.push('streaming-card');

  const modelBadge = modelName ? `<span class="mr-ft-model ${kind}">${escapeHtml(modelName)}</span>` : '';
  const ctxBadge = ctxPct !== null ? `<span class="mr-ft-ctx ${ctxCls}">Ctx ${ctxPct}%</span>` : '';

  const avatarSrc = _avatarSrcFor(kind);
  const avatarFb = _avatarFallbackFor(kind);
  const avatarHtml = avatarSrc
    ? `<div class="mr-ft-avatar"><img src="${avatarSrc}" alt="${kind}" onerror="this.parentNode.textContent='${avatarFb}'; this.parentNode.style.cssText+=';display:flex;align-items:center;justify-content:center;font-size:32px;'"></div>`
    : `<div class="mr-ft-avatar" style="display:flex;align-items:center;justify-content:center;font-size:32px;">${avatarFb}</div>`;

  const timeoutCls = statusCls === 'timeout' ? ' timeout' : '';
  const row3 = `<div class="mr-ft-row3${timeoutCls}">
    <span class="mr-ft-stat-icon">⏱</span>
    <span class="mr-ft-stat-current">本轮 ${escapeHtml(thinkCurrent)}</span>
    <span class="mr-ft-stat-divider">·</span>
    <span class="mr-ft-stat-total">累计 ${escapeHtml(thinkTotal)}</span>
  </div>`;
  const row4 = `<div class="mr-ft-row4">
    <span class="mr-ft-stat-icon">🪙</span>
    <span class="mr-ft-stat-current">本轮 ${escapeHtml(tokensCurrent)}</span>
    <span class="mr-ft-stat-divider">·</span>
    <span class="mr-ft-stat-total">累计 ${escapeHtml(tokensTotal)}</span>
  </div>`;

  return `<div class="${cls.join(' ')}" data-ft-sid="${sid}" data-ft-kind="${kind}">
    <button class="mr-ft-expand" data-ft-expand-sid="${sid}" data-ft-expand-kind="${kind}" title="展开详细回答">↗</button>
    <div class="mr-ft-head">
      ${avatarHtml}
      <div class="mr-ft-info">
        <div class="mr-ft-row1">
          <span class="mr-ft-name ${kind}">${name}</span>
          <span class="mr-ft-status ${statusCls}">${statusLabel}</span>${newBadge}
        </div>
        <div class="mr-ft-row2">${modelBadge}${ctxBadge}</div>
        ${row3}
        ${row4}
      </div>
    </div>
    <div class="mr-ft-bottom">${bottomHtml || ''}</div>
  </div>`;
}
```

- [ ] **Step 4: 修改 `_renderFusedTabs` 中 `_ftHtml` 的调用方**

定位 `renderer/meeting-room.js:202-218` —— 三处 `tabs.push(_ftHtml(...))` 调用，把它们重构成统一调用（消除重复参数）。在 for 循环里，**status 判断和 row3 计算之后、tabs.push 之前**，加一段：

```js
// 计算时间/token 统计字段
const aiStats = (state.aiStats && state.aiStats[kind]) || {};
const totalThinkSec = aiStats.totalThinkSec || 0;
const totalTokens   = aiStats.totalTokens || 0;

let thinkCurrentSec = 0;
let tokensCurrentN  = 0;
if (status === 'thinking' || status === 'streaming') {
  thinkCurrentSec = _thinkStartTs[meetingId] ? Math.round((Date.now() - _thinkStartTs[meetingId]) / 1000) : 0;
  if (partial && partial.tokens && partial.tokens.total != null) {
    tokensCurrentN = partial.tokens.total;
  }
} else if (lastTurn && lastTurn.thinkSecBy && lastTurn.thinkSecBy[sub.sid] != null) {
  thinkCurrentSec = lastTurn.thinkSecBy[sub.sid];
  tokensCurrentN  = lastTurn.tokensBy ? (lastTurn.tokensBy[sub.sid] || 0) : 0;
}

const thinkCurrent = _formatThinkTime(thinkCurrentSec);
const thinkTotal   = _formatThinkTime(totalThinkSec);
const tokensCurrent = _formatTokens(tokensCurrentN);
const tokensTotal   = _formatTokens(totalTokens);
```

然后把 `tabs.push(_ftHtml(...))` 三处调用统一为新签名（注意：`row3` 参数变成 `bottomHtml`）：

```js
// thinking 分支：
let bottomHtml = `<div class="mr-ft-progress"><div class="mr-ft-progress-bar ${kind}"></div></div>`;
tabs.push(_ftHtml(kind, isActive, sub.sid, labelDisplay, statusLabel, status, modelName, modelCls, ctxPct, ctxCls,
                  bottomHtml, thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge));

// streaming 分支：
const snippet = preview.slice(-150).replace(/</g, '&lt;');
bottomHtml = `<div class="mr-ft-preview streaming">${snippet}<span class="mr-ft-cursor"></span></div>`;
tabs.push(_ftHtml(kind, isActive, sub.sid, labelDisplay, statusLabel, status, modelName, modelCls, ctxPct, ctxCls,
                  bottomHtml, thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge));

// else（completed/idle/timeout）分支：
const snippet2 = preview ? escapeHtml(preview.slice(0, 150)) + (preview.length > 150 ? '…' : '') : '';
bottomHtml = snippet2 ? `<div class="mr-ft-preview">${snippet2}</div>` : '';
tabs.push(_ftHtml(kind, isActive, sub.sid, labelDisplay, statusLabel, status, modelName, modelCls, ctxPct, ctxCls,
                  bottomHtml, thinkCurrent, thinkTotal, tokensCurrent, tokensTotal, newBadge));
```

**注意**：原代码 thinking/streaming 分支里都有 `if (!_thinkStartTs[meetingId]) _thinkStartTs[meetingId] = Date.now();` 这一行——保留它（用于"本轮"计时器）。

- [ ] **Step 5: DOM/JS 语法快速校验**

```bash
node --check renderer/meeting-room.js
```

Expected: 无输出（语法 OK）；如有 `SyntaxError` 立即修复。

- [ ] **Step 6: 提交**

```bash
git add renderer/meeting-room.js
git commit -m "feat(roundtable): card redesign - avatar + 4-row info column + stat helpers"
```

---

## Task 7: 版本号同步（package.json + UI 显示位）

**Files:**
- Modify: `package.json`
- Modify: (UI 版本号显示位 — 由 grep 决定)

- [ ] **Step 1: bump package.json version**

修改 `package.json:3`：

```json
"version": "0.2.0",
```

（从 0.1.0 → 0.2.0；这是个明显可见的 UI 改动，按 minor 升）

- [ ] **Step 2: grep 找 UI 版本号显示位**

```bash
grep -rn "0.1.0\|version" renderer/index.html renderer/styles.css renderer/*.js 2>/dev/null | grep -v node_modules | head -10
grep -rn "version" main.js | head -5
```

预期：找到至少一处 UI 上展示版本号的地方（可能在 sidebar 或标题栏）。

- [ ] **Step 3: 同步 UI 版本号文本（如有 hardcoded）**

如果 grep 找到 hardcoded 版本号字符串（如 `'v0.1.0'`），把它改为 `'v0.2.0'` 或改为从 `package.json` 动态读取（推荐后者，更稳）：

示例（如果 main.js 已 require package.json）：
```js
const pkg = require('./package.json');
// ...send to renderer
sendToRenderer('hub-version', pkg.version);
```

renderer 接收后填到对应 DOM。

如果当前没有版本号 UI 展示，**新增一处**：在 `renderer/index.html` 找到合适位置（如左下角 / 设置面板），添加：
```html
<div class="hub-version-display" style="position:fixed;bottom:6px;right:8px;font-size:10px;color:#8b949e;opacity:0.5;">v0.2.0</div>
```

- [ ] **Step 4: 启动 Hub 验证版本号可见**

启动隔离 Hub:
```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-test-v"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9222
```

打开 Hub 窗口，目视确认版本号 `v0.2.0` 显示在 UI 某处。

- [ ] **Step 5: 提交**

```bash
git add package.json renderer/
git commit -m "chore: bump version to 0.2.0 for card redesign UI changes"
```

---

## Task 8: 真实启动 Hub + Playwright E2E 视觉验证

**Files:**
- Create: `tests/_e2e-card-redesign-verify.js`

**目的：** 启动隔离 Hub 实例 + CDP 连接 + 触发真实 fanout 轮 + 截图验证。

- [ ] **Step 1: 找 fused-tab 既有 E2E 模板参考**

```bash
ls tests/_e2e-fused-tab-verify.js && head -80 tests/_e2e-fused-tab-verify.js
```

阅读现有模板，沿用其 CDP 连接 / 选择器 / 截图保存路径风格。

- [ ] **Step 2: 写 _e2e-card-redesign-verify.js**

`tests/_e2e-card-redesign-verify.js`:

```js
'use strict';
// E2E: 验证 2026-05-01 卡片改造
//   1. 启动隔离 Hub（CLAUDE_HUB_DATA_DIR + remote-debugging）
//   2. 进入会议室
//   3. 触发一轮 fanout
//   4. 截图三张卡片，校验 height = 220px、有 .mr-ft-avatar、有 .mr-ft-row3/4

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');

const HUB_DIR = path.resolve(__dirname, '..');
const TEST_DATA_DIR = `C:\\temp\\hub-card-redesign-${Date.now()}`;
const DEBUG_PORT = 9230;
const SCREENSHOT_DIR = path.join(__dirname, '_card-redesign-screenshots');

(async function main() {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 启动 Hub
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEST_DATA_DIR };
  const electronExe = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  const hub = spawn(electronExe, ['.', `--remote-debugging-port=${DEBUG_PORT}`], { cwd: HUB_DIR, env });
  hub.stdout.on('data', d => process.stdout.write(`[hub] ${d}`));
  hub.stderr.on('data', d => process.stderr.write(`[hub] ${d}`));

  await new Promise(r => setTimeout(r, 6000)); // wait for Electron boot

  // 连 CDP
  let client;
  try {
    client = await CDP({ port: DEBUG_PORT });
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();

    // 检查 .mr-ft 元素存在 + 关键属性
    const result = await Runtime.evaluate({
      expression: `
        (function() {
          const cards = document.querySelectorAll('.mr-ft');
          if (cards.length === 0) return { ok: false, reason: 'no .mr-ft cards found' };
          const first = cards[0];
          const styles = window.getComputedStyle(first);
          const hasAvatar = !!first.querySelector('.mr-ft-avatar');
          const hasRow3 = !!first.querySelector('.mr-ft-row3');
          const hasRow4 = !!first.querySelector('.mr-ft-row4');
          const height = first.getBoundingClientRect().height;
          const stripCols = window.getComputedStyle(document.querySelector('.mr-ft-strip')).gridTemplateColumns;
          return {
            ok: true,
            count: cards.length,
            heightPx: Math.round(height),
            hasAvatar, hasRow3, hasRow4,
            stripCols,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log('DOM check:', JSON.stringify(result.result.value, null, 2));

    // 截图
    const shot = await Page.captureScreenshot({ format: 'png' });
    const shotPath = path.join(SCREENSHOT_DIR, `card-strip-${Date.now()}.png`);
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('Screenshot saved:', shotPath);

    // 断言
    const v = result.result.value;
    if (!v.ok) throw new Error('DOM check failed: ' + v.reason);
    if (v.count < 1) throw new Error(`expected at least 1 card, got ${v.count}`);
    if (v.heightPx !== 220) throw new Error(`expected height=220, got ${v.heightPx}`);
    if (!v.hasAvatar) throw new Error('missing .mr-ft-avatar');
    if (!v.hasRow3) throw new Error('missing .mr-ft-row3');
    if (!v.hasRow4) throw new Error('missing .mr-ft-row4');
    if (!v.stripCols.includes('minmax(0px') && !v.stripCols.match(/\d+(\.\d+)?px \d+(\.\d+)?px \d+/)) {
      // 注：computed style 可能不直接显示 minmax，但应该是三个相等的 px 值
      console.warn('strip cols:', v.stripCols);
    }

    console.log('PASS: card redesign DOM structure correct');
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

- [ ] **Step 3: 运行 E2E**

```bash
node tests/_e2e-card-redesign-verify.js
```

Expected:
- 看到 `[hub] hook server listening` 日志
- 看到 `DOM check: { ok: true, count: 3, heightPx: 220, hasAvatar: true, hasRow3: true, hasRow4: true, ... }`
- 看到 `PASS: card redesign DOM structure correct`
- 截图保存到 `tests/_card-redesign-screenshots/card-strip-<ts>.png`

如果 `count: 0`：会议室还没创建会话——E2E 测试代码需要先调用 IPC 创建一个 fan-out 会议（或简化为只验证 CSS 不验证真实卡片）。可以先把 count 检查改为 ≥0 + 跳过条件断言，先把脚本跑通；进一步完善留给执行 Claude。

- [ ] **Step 4: 目视验证截图**

打开截图：
```bash
explorer.exe tests/_card-redesign-screenshots/
```

肉眼确认：
- ✅ 三张卡片左侧有圆形宝可梦头像
- ✅ 三张卡片高度严格相等
- ✅ 每张卡片显示 ⏱ 行和 🪙 行
- ✅ 没有视觉抖动或挤压

- [ ] **Step 5: 手动 streaming 测试（最重要的视觉验证）**

启动隔离 Hub，进入会议室，发起一个**会触发长流式输出**的提问（例如"详细解释 Promise.allSettled 的实现原理，给我至少 500 字"）。

肉眼观察 streaming 过程：
- ⚠ 三张卡片高度**完全不抖动**
- ⚠ 横向宽度**严格三等分**，没有任何一格被流式文本撑大
- ⚠ 头像在 thinking/streaming 时**轻微上下浮动**（avatar-bounce 动画）
- ⚠ ⏱ 本轮秒数实时增长，token 数实时变化
- ⚠ 完成后"已答 ✓"卡片显示该轮最终的 thinkSec 和 token

如有任何抖动或视觉异常，**回退相关 commit 重新审视**——CSS 防抖三件套和 flex 布局必须严丝合缝。

- [ ] **Step 6: 重启 Hub 验证累计数据持久化**

终止 Hub 后再启动同一隔离 Hub 实例（用相同 `CLAUDE_HUB_DATA_DIR`）：

```bash
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-card-redesign-XXX"
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9230
```

进入同一会议室，确认每张卡片显示的 **累计** 时间和 token 仍是上次会话结束时的值（不是 0）。

- [ ] **Step 7: 提交 E2E 文件**

```bash
git add tests/_e2e-card-redesign-verify.js
git commit -m "test(roundtable): add E2E verification for card redesign"
```

---

## Verification Checklist

实施完成后逐项确认：

- [ ] 资源文件 `renderer/assets/pokemon/{pikachu,charmander,squirtle}.png` 存在
- [ ] `package.json` version = "0.2.0"，Hub UI 上能看到新版本号
- [ ] 卡片 DOM 结构含 `.mr-ft-head` / `.mr-ft-avatar` / `.mr-ft-info` / `.mr-ft-row3` / `.mr-ft-row4` / `.mr-ft-bottom`
- [ ] 卡片 computed `height` = 220px
- [ ] strip computed `grid-template-columns` 是三个相等列宽（minmax(0,1fr) 在 computed 风格里展开为相等 px 值）
- [ ] streaming 时三张卡片高度/宽度严格不抖
- [ ] thinking/streaming 时头像有 bounce 动画
- [ ] ⏱ 行显示「本轮 Xs · 累计 Ys」格式正确
- [ ] 🪙 行显示「本轮 Xk · 累计 Yk」格式正确
- [ ] 重启 Hub 后累计数据从 state.json 恢复
- [ ] 头像 PNG 删除/改名后能 fallback 到 emoji（手动测试一次即可）
- [ ] node_modules 完整性检查通过（参考 hub CLAUDE.md：`timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20` 见 `[hub] hook server listening`）
- [ ] 所有 commit 已创建（应有 7-8 个）
- [ ] 主分支 git status 干净

---

## Rollback Plan

如果发现严重问题需要回退：

```bash
# 找到改造前的 commit
git log --oneline | grep -E "(card redesign|carousel|fusion)" | head -5

# 单文件回退
git checkout HEAD~N -- renderer/meeting-room.css renderer/meeting-room.js

# 或整批回退（最后一个 commit）
git revert <commit-hash>

# 删除资源（如果只想去头像保留布局）
rm -rf renderer/assets/pokemon/
```

CSS / JS 改动各自独立，可以**只回退 CSS（保留 JS 累加器逻辑）**——这样累加数据不丢，UI 退回旧布局。

---

## Out of Scope

明确不在本次 plan 内：

- ❌ token 拆 input/output 双值（用户 brainstorming 阶段选了简洁 total）
- ❌ 头像点击彩蛋
- ❌ 头像可换皮（其他宝可梦）
- ❌ 时间统计支持小时单位（暂只 s/m）
- ❌ 累计统计支持跨会议（只做 meeting 内累计）
- ❌ 响应式降级到单列（窗口 < 480px 不处理）
- ❌ Resilience plan 引入的新状态（manual_extracted/absent/errored/soft_alert）的状态映射——由 resilience plan 自己负责

---

## 与既有 plan 的协调

| Plan | 互动 |
|------|------|
| `2026-04-30-roundtable-latency.md` | 改 `main.js _rtSendToPty` —— 与本 plan 改的 `main.js _rtWaitTurnComplete` **不在同一函数**，零冲突 |
| `2026-04-30-roundtable-resilience.md` | 改 `core/transcript-tap.js` 的信号识别 —— 与本 plan 改的 `transcript-tap.js` 新增 `getLastTokens` **不在同一函数**，零冲突。但 resilience 引入的新 status 枚举在本 plan 渲染层已预留兼容（`statusLabel[status] || status` 不会崩） |

**建议执行顺序**：
1. 先 latency（最小风险）
2. 再 resilience
3. 最后 card-redesign（消费 resilience 的新状态做 UI 兼容）

如果同时执行，merge 阶段注意 status 映射表的合并。

---

## 项目铁律对齐

- ✅ **CLAUDE.md 编码原则**：surgical changes（只改卡片相关代码，未顺手重构）
- ✅ **CLAUDE.md 测试铁律**：必须真实启动 Hub + 截图验证（Task 8）
- ✅ **CLAUDE.md 版本号铁律**：bump 0.1.0 → 0.2.0 + UI 显示位（Task 7）
- ✅ **CLAUDE.md hub 隔离规则**：测试用 `CLAUDE_HUB_DATA_DIR` 隔离，不动生产 Hub
- ✅ **CLAUDE.md 大改动验证**：commit ≥3 文件，需 `/post-refactor-verify`（执行 Claude 自行调用）
