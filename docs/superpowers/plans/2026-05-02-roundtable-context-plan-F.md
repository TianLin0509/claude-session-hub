# Plan · 圆桌上下文方案 F 实现

> **For agentic workers:** 本 plan 按 4 个 milestone 渐进实施。每个 milestone 之间用户可暂停审查。Steps 用 checkbox `- [ ]` 跟踪。
>
> **Goal**：实现方案 F——四层上下文架构（L1 极简 system / L2 房间公约 / L3 per-turn / L4 timeline.md）+ 上一轮恒定注入（含同组跳过） + 摘要按钮（五元组） + 切模式 toast
>
> **Architecture**：复用现有 `core/roundtable-scenes.js` 和 `core/roundtable-orchestrator.js` 框架，新增 `core/roundtable-timeline.js` 和 `core/roundtable-injection.js` 两个独立模块；UI 增加摘要按钮 + toast 组件
>
> **Tech Stack**：Electron + Node + xterm + 既有 IPC/状态管理框架（无新依赖）
>
> **Spec**：`docs/superpowers/specs/2026-05-02-roundtable-context-plan-F-design.md`

---

## File Structure

### 新增文件
- `core/roundtable-timeline.js` — Timeline.md 写入、滚动、归档管理
- `core/roundtable-injection.js` — 上一轮注入矩阵算法
- `tests/unit-roundtable-injection-matrix.test.js`
- `tests/unit-roundtable-timeline.test.js`
- `tests/unit-roundtable-summary-brief.test.js`
- `tests/integration-roundtable-context-flow.test.js`
- `tests/integration-roundtable-summary-flow.test.js`
- `tests/_e2e-roundtable-summary-mode-switch.js`

### 修改文件
- `core/roundtable-scenes.js` — `BASE_RULES` 简化 / 新增 `COVENANT_GENERAL` / `buildSystemPrompt` 拼接顺序调整
- `core/roundtable-orchestrator.js` — 三个 `buildXxxPrompt` 重构、新增 `buildBriefSummaryPrompt`、`mode` 字段新增 `'summary-brief'` 取值
- `main.js` — `dispatchRoundtableTurn` 接入注入算法 / timeline 写入；新增 IPC `roundtable:summary-trigger`
- `renderer/meeting-room.js` — 工具栏新增摘要按钮 + 切模式 toast 组件 + dispatchMode 监听
- `renderer/meeting-room.css` — 摘要按钮样式 + toast 样式
- `package.json` — version bump 0.8.x → 0.9.0

---

## Milestone 1 · L1 简化 + L2 公约模板（0.5 天）

### Task 1.1 重写 `BASE_RULES` 为 L1 极简版

**File**: `core/roundtable-scenes.js`

- [ ] **Step 1**：把 `BASE_RULES` 常量整体替换为 spec §5.1 的极简文本（约 200 字）
- [ ] **Step 2**：`node --check core/roundtable-scenes.js` 通过
- [ ] **Step 3**：commit `refactor(roundtable): simplify BASE_RULES to L1 core (200 chars)`

### Task 1.2 新增通用公约模板 `COVENANT_GENERAL`

**File**: `core/roundtable-scenes.js`

- [ ] **Step 1**：在 `COVENANT_RESEARCH` 之前新增 `COVENANT_GENERAL` 常量（spec §6.1 完整文本）
- [ ] **Step 2**：导出 `COVENANT_GENERAL`（追加到 module.exports）
- [ ] **Step 3**：commit `feat(roundtable): add COVENANT_GENERAL collaboration manual`

### Task 1.3 调整 scene `defaultCovenant`

**File**: `core/roundtable-scenes.js` · `SCENE_REGISTRY`

- [ ] **Step 1**：`general.defaultCovenant` 改为 `COVENANT_GENERAL`
- [ ] **Step 2**：`research.defaultCovenant` 改为 `COVENANT_GENERAL + '\n\n---\n\n' + COVENANT_RESEARCH`
- [ ] **Step 3**：commit `refactor(roundtable): scene.defaultCovenant include COVENANT_GENERAL`

### Task 1.4 验证 `buildSystemPrompt` 拼接顺序

**File**: `tests/unit-roundtable-scenes.test.js`（既有，扩展）

- [ ] **Step 1**：写新测试 `buildSystemPrompt('general', null)` → 验证输出包含 BASE_RULES + GENERAL_PRESET + COVENANT_GENERAL
- [ ] **Step 2**：写新测试 `buildSystemPrompt('research', null)` → 验证输出包含 BASE_RULES + RESEARCH_PRESET + COVENANT_GENERAL + COVENANT_RESEARCH
- [ ] **Step 3**：写新测试 `buildSystemPrompt('general', '<custom covenant>')` → 验证用户自定义覆盖默认
- [ ] **Step 4**：`node tests/unit-roundtable-scenes.test.js` 通过
- [ ] **Step 5**：commit `test(roundtable): cover L1+L2 system prompt assembly`

### M1 验证关卡

- 跑既有 unit 测试套件全过（无回归）
- 隔离 Hub 启动 → 创建一个 general 圆桌 → 检查 `<hubDataDir>/arena-prompts/<meetingId>-prompt.md` 内容含 BASE_RULES + COVENANT_GENERAL
- ✅ 通过后进入 M2；❌ 修复后再继续

---

## Milestone 2 · L3 模板 + 上一轮注入矩阵 + Timeline.md（1.5 - 2 天）

### Task 2.1 实现 timeline 模块

**File**: `core/roundtable-timeline.js`（新建）

接口设计：
```
module.exports = {
  getTimelinePath(meetingId, projectCwd, hubDataDir),  // 返回绝对路径
  ensureFile(meetingId, projectCwd, hubDataDir),       // 确保文件存在 + 头部
  writeTurn(meetingId, turnRecord, sceneName, projectCwd, hubDataDir),
  readFull(meetingId, projectCwd, hubDataDir),         // 用于 e2e 验证
};
```

- [ ] **Step 1**：实现 `getTimelinePath`：优先 `<projectCwd>/.arena/timeline-<meetingId>.md`，无 cwd 时退到 `<hubDataDir>/timelines/`
- [ ] **Step 2**：实现 `ensureFile`：mkdir + 写文件头（spec §9.2 顶部 6 行）
- [ ] **Step 3**：实现 `writeTurn`：append 一个二级标题块（按 spec §9.2 格式），区分摘要轮 vs 普通轮
- [ ] **Step 4**：实现滚动逻辑：扫描全文按 `## 第 N 轮` 切块 → 计数非摘要轮 → >10 时把最早非摘要轮 append 到 archive 并从主文件删
- [ ] **Step 5**：写 unit test `tests/unit-roundtable-timeline.test.js`：
  - 首次写入创建文件 + 头部
  - 多轮写入按顺序追加
  - 12 个普通轮 + 2 个摘要轮 → 主文件保留 10 普通 + 2 摘要，archive 有 2 普通
  - 路径 fallback（无 cwd 走 hubDataDir）
- [ ] **Step 6**：commit `feat(roundtable): timeline.md auto-maintenance module`

### Task 2.2 实现注入矩阵算法

**File**: `core/roundtable-injection.js`（新建）

接口设计：
```
module.exports = {
  computeLastTurnInjection(lastTurn, currentTargetSids, currentDispatchMode, sidLabelFn),
  // 返回 { sid: { speakers: { speakerSid: {label, role, text} } } } 或 {}（跳过/首轮）
};
```

- [ ] **Step 1**：实现首轮跳过（lastTurn null）
- [ ] **Step 2**：实现摘要轮特殊处理（mode === 'summary-brief' → 全员注入摘要）
- [ ] **Step 3**：实现同组跳过（lastSpeakers === currentSpeakers）
- [ ] **Step 4**：实现个性化注入（每个 target 收到 lastSpeakers - {self}）
- [ ] **Step 5**：写 unit test `tests/unit-roundtable-injection-matrix.test.js`：spec §8.1 表的 11 行规则各一个 case，含同组跳过两种 + 个性化三家 + 摘要轮注入
- [ ] **Step 6**：commit `feat(roundtable): last-turn injection matrix algorithm`

### Task 2.3 重构 `buildFanoutPrompt` / `buildDebatePrompt` / `buildSummaryPrompt`

**File**: `core/roundtable-orchestrator.js`

新签名设计：
```
buildFanoutPrompt(turnNum, userInput, dataPack, dispatchSpec, injectionForSid, timelinePath)
buildDebatePrompt(turnNum, userInput, dispatchSpec, injectionForSid, timelinePath)
buildSummaryPrompt(turnNum, summarizerSid, sidLabelFn, dispatchSpec, injectionForSid, timelinePath)

// dispatchSpec = { mode: 'all'|'pilot'|'observer', selfRole: 'pilot'|'observer'|'co-pilot', sameStageLabels: [...] }
// injectionForSid = { speakers: {speakerSid: {label, role, text}} } 或 null（跳过时）
```

- [ ] **Step 1**：在文件顶部加注释明确新签名 + 修改三个方法签名
- [ ] **Step 2**：实现「调度上下文」段拼装（spec §7.3 文案表）
- [ ] **Step 3**：实现「上一轮」段拼装（按 injectionForSid 注入或省略，含 timeline 索引提示）
- [ ] **Step 4**：实现「timeline 路径」段（每轮 prompt 末尾 `---\n完整历史：<path>\n`）
- [ ] **Step 5**：删除 fanout 模板里「你看不到另两家观点」原文，替换为更精确的「调度上下文」说明
- [ ] **Step 6**：删除 debate 模板里「## 另两家上一轮观点」段（被「上一轮」段替代）
- [ ] **Step 7**：删除 summary 模板里「## 最近一轮（第 N-1 轮）参考」段（被「上一轮」段替代）
- [ ] **Step 8**：commit `refactor(roundtable): orchestrator prompt builders use unified injection model`

### Task 2.4 新增 `buildBriefSummaryPrompt`（摘要轮专用）

**File**: `core/roundtable-orchestrator.js`

- [ ] **Step 1**：实现 `buildBriefSummaryPrompt(turnNum, summarizerSid, sidLabelFn, summarizeRange, timelinePath)`，模板见 spec §7.2
- [ ] **Step 2**：导出该方法
- [ ] **Step 3**：commit `feat(roundtable): buildBriefSummaryPrompt for summary button`

### Task 2.5 `dispatchRoundtableTurn` 接入注入算法

**File**: `main.js · dispatchRoundtableTurn`

- [ ] **Step 1**：require `roundtable-injection` 和 `roundtable-timeline`
- [ ] **Step 2**：在 `targetSubs` 计算后，调 `computeLastTurnInjection(orch.getLastTurn(), targetSubs.map(t=>t.sid), effectiveDispatchMode, sidLabelFn)` 取得 injectMap
- [ ] **Step 3**：在每个 target 的 prompt 拼装位置传入 `injectMap[sid]` 和 `dispatchSpec`
- [ ] **Step 4**：在 `orch.completeTurn` 之后追加 `roundtable-timeline.writeTurn(meetingId, record, scene.name, projectCwd, getHubDataDir())`
- [ ] **Step 5**：`projectCwd` 从主驾 sid 的 `sessionManager.getSession(sid).cwd` 取，无主驾退到第一个活跃 sub 的 cwd
- [ ] **Step 6**：写 integration test `tests/integration-roundtable-context-flow.test.js`：mock orchestrator + 跑两轮 dispatch + 验证 timeline.md 内容
- [ ] **Step 7**：commit `feat(roundtable): dispatch wires injection matrix + timeline write`

### Task 2.6 调度上下文计算辅助函数

**File**: `main.js`（dispatchRoundtableTurn 附近）

- [ ] **Step 1**：抽函数 `_computeDispatchSpec(meeting, sub, effectiveDispatchMode, allSubs)` → 返回 `{ mode, selfRole, sameStageLabels }`
- [ ] **Step 2**：在每个 target 拼 prompt 时调用，得到该 sub 视角的调度上下文
- [ ] **Step 3**：commit `refactor(roundtable): extract dispatch spec computation helper`

### M2 验证关卡

- 全部新 unit + integration 测试通过
- 隔离 Hub E2E 跑 3 轮（fanout → debate → fanout），验证：
  - 第 1 轮无「上一轮」段
  - 第 2 轮有「上一轮」段含另两家全文 + timeline 索引提示
  - 第 3 轮同上
  - `<project_cwd>/.arena/timeline-<meetingId>.md` 文件存在且含 3 轮
- ✅ 通过后进入 M3

---

## Milestone 3 · 摘要按钮 + 五元组（1 - 1.5 天）

### Task 3.1 后端 IPC `roundtable:summary-trigger`

**File**: `main.js`

- [ ] **Step 1**：注册 IPC handler，参数 `{ meetingId }`
- [ ] **Step 2**：复用 `_roundtableInProgress` 锁
- [ ] **Step 3**：取 `lastTurn`，校验：non-null + mode !== 'summary-brief'，否则 throw
- [ ] **Step 4**：识别 `lastSpeakerSids = Object.keys(lastTurn.byMap)`，过滤已 dormant 的
- [ ] **Step 5**：计算每个 lastSpeaker 的浓缩范围 = 「自上次摘要轮 / 会议起始 之后到现在的所有该 AI 参与的发言轮号」
- [ ] **Step 6**：调 `orch.beginTurn('summary-brief')`，构造每个 lastSpeaker 的 brief summary prompt
- [ ] **Step 7**：并发 `_rtSendToPty` + `_rtWaitTurnComplete`（复用既有机制）
- [ ] **Step 8**：`orch.completeTurn(turnNum, 'summary-brief', '', byMap, { isSummary: true }, byStatus, stats)`
- [ ] **Step 9**：`timeline.writeTurn` 自动识别 `mode === 'summary-brief'` → 写摘要标题
- [ ] **Step 10**：commit `feat(roundtable): summary-trigger IPC + brief summary dispatch`

### Task 3.2 orchestrator 支持 `summary-brief` mode

**File**: `core/roundtable-orchestrator.js`

- [ ] **Step 1**：在 `beginTurn` 接受 `'summary-brief'` mode
- [ ] **Step 2**：`completeTurn` 接受新 meta 字段 `isSummary` / `summarizers`
- [ ] **Step 3**：注入算法 `computeLastTurnInjection` 已支持 `lastTurn.mode === 'summary-brief'`（M2 已实现）
- [ ] **Step 4**：commit `feat(roundtable): orchestrator supports summary-brief turn mode`

### Task 3.3 timeline.md 摘要轮格式

**File**: `core/roundtable-timeline.js`

- [ ] **Step 1**：`writeTurn` 检测 `turnRecord.mode === 'summary-brief'` → 用「## 第 N 轮 · 摘要 by <names>（五元组）」标题
- [ ] **Step 2**：摘要轮在滚动统计中标记不淘汰
- [ ] **Step 3**：扩展 unit test 覆盖摘要轮写入 + 不淘汰
- [ ] **Step 4**：commit `feat(roundtable-timeline): summary-brief turn formatting + retention`

### Task 3.4 renderer 摘要按钮 UI

**File**: `renderer/meeting-room.js` / `renderer/meeting-room.css`

- [ ] **Step 1**：在工具栏（与 dispatchMode segmented control 同行）加「摘要」按钮
- [ ] **Step 2**：监听 IPC `roundtable-state-update` 取 `lastTurn`，按 spec §10.5 决定 disable/enable
- [ ] **Step 3**：点击 → `ipcRenderer.invoke('roundtable:summary-trigger', { meetingId })`
- [ ] **Step 4**：触发后 UI 显示进度（复用既有 dispatch progress 机制）
- [ ] **Step 5**：commit `feat(renderer): summary button + state binding`

### Task 3.5 摘要轮卡片视觉

**File**: `renderer/meeting-room.js` / `renderer/meeting-room.css`

- [ ] **Step 1**：摘要轮在 timeline 抽屉里用专属图标（如 ✦ 或 📋 — 但禁用 emoji 时用文字标签「摘要」）
- [ ] **Step 2**：摘要轮卡片显示「五元组」结构化预览（前 3 项截断）
- [ ] **Step 3**：commit `feat(renderer): summary-brief turn visual treatment`

### Task 3.6 集成测试

**File**: `tests/integration-roundtable-summary-flow.test.js`

- [ ] **Step 1**：mock 圆桌 → 跑 3 轮 fanout → 触发摘要 → 验证摘要轮写入 + lastTurn 更新
- [ ] **Step 2**：跑摘要后再触发摘要 → 验证 IPC 拒绝
- [ ] **Step 3**：commit `test(roundtable): integration summary-brief flow`

### M3 验证关卡

- 全部新 unit + integration 测试通过
- 隔离 Hub E2E：
  - 创建圆桌 → 主驾 pilot 模式跑 3 轮 → 点摘要按钮 → 主驾输出五元组 → timeline.md 含摘要轮
  - 副驾 observer 模式发问 → 副驾收到的「上一轮」段是摘要全文（带索引提示）
- ✅ 通过后进入 M4

---

## Milestone 4 · 切模式 Toast + 上线观察（0.5 天 + 持续）

### Task 4.1 renderer dispatchMode 切换检测

**File**: `renderer/meeting-room.js`

- [ ] **Step 1**：在 dispatchMode segmented control 的 click handler 之前插入检测
- [ ] **Step 2**：实现 `_shouldShowSummarizeToast(meeting, oldMode, newMode)` 按 spec §11.1 条件返回 bool
- [ ] **Step 3**：localStorage key `hub.roundtable.toast.summarize-on-mode-switch` 检查 dismissed
- [ ] **Step 4**：commit `feat(renderer): detect mode switch summarize-suggest condition`

### Task 4.2 Toast 组件

**File**: `renderer/meeting-room.js` / `renderer/meeting-room.css`

- [ ] **Step 1**：实现 `_showSummarizeToast(onSummarize, onProceed, onDismiss)` 弹模态 toast
- [ ] **Step 2**：spec §11.2 三个按钮文案
- [ ] **Step 3**：CSS：屏幕中央 + 半透明背景 + 配色与 Hub 主题一致
- [ ] **Step 4**：commit `feat(renderer): summarize-suggest toast component`

### Task 4.3 持久化 dismiss

**File**: `renderer/meeting-room.js`

- [ ] **Step 1**：「不再提醒」按钮 → `localStorage.setItem('hub.roundtable.toast.summarize-on-mode-switch', 'dismissed')`
- [ ] **Step 2**：commit `feat(renderer): persist toast dismiss preference`

### Task 4.4 E2E 验证

**File**: `tests/_e2e-roundtable-summary-mode-switch.js`（新建）

- [ ] **Step 1**：用 Playwright + CDP 连隔离 Hub
- [ ] **Step 2**：创建圆桌 → pilot 模式跑 1 轮 → 切到 observer → 验证 toast 弹出
- [ ] **Step 3**：点「我去摘要」→ 验证 toast 关闭、dispatchMode 没切
- [ ] **Step 4**：再切 + 点「不再提醒」→ 验证 localStorage 写入
- [ ] **Step 5**：再切 → 验证 toast 不弹
- [ ] **Step 6**：commit `test(e2e): summarize-suggest toast on mode switch`

### Task 4.5 Version bump + 文档

- [ ] **Step 1**：`package.json` version 0.8.x → 0.9.0
- [ ] **Step 2**：在 `CLAUDE.md` 项目「圆桌项目规范」追加方案 F 关键约束（如 timeline.md 路径约定、摘要轮处理铁律）
- [ ] **Step 3**：commit `chore: bump 0.9.0 + doc roundtable context plan F invariants`

### Task 4.6 上线观察 1-2 周

**非代码任务**，记入 followup todo：

- 观察 AI 实际是否主动 Read timeline.md
- 如观察到 < 30% 主动率，触发 nudge 调优 followup（如在每轮 prompt 末尾加更强提示）

---

## Self-Review Checklist

实施前自检：

### Spec coverage
- [x] L1 简化 → M1.1
- [x] L2 公约模板 → M1.2 / M1.3
- [x] L3 通用模板 → M2.3
- [x] L3 摘要轮模板 → M2.4
- [x] L4 timeline.md 写入 → M2.1 / M2.5
- [x] L4 timeline.md 滚动 → M2.1
- [x] 上一轮注入矩阵 → M2.2
- [x] 同组跳过规则 → M2.2
- [x] 注入嵌 timeline 索引 → M2.3
- [x] 摘要按钮 → M3.1 / M3.4
- [x] 五元组格式 → M3.1（prompt 模板）+ M2.4（buildBriefSummaryPrompt）
- [x] 切模式 toast → M4.1 / M4.2 / M4.3

### Placeholder scan
- 每个 Task 都列出具体改动文件 + 接口签名 + 提交节奏 — 无 TBD / TODO
- 五元组、注入矩阵、timeline 路径等细节均在 spec 给定具体文本，plan 仅引用 spec section

### Type consistency
- `dispatchSpec = { mode, selfRole, sameStageLabels }` 在 Task 2.3 / 2.6 保持一致
- `injectionForSid = { speakers: {speakerSid: {label, role, text}} }` 在 Task 2.2 / 2.3 保持一致
- `mode` 取值 `'fanout'|'debate'|'summary'|'summary-brief'` 在 Task 2.4 / 3.1 / 3.2 一致

---

## Risk & Mitigation（执行期）

| 风险 | 缓解 |
|---|---|
| AI 不主动 Read timeline.md | M4.6 上线观察后触发 nudge 调优 followup |
| 注入算法回归 fanout/debate/summary 既有行为 | M2 verification gate + 既有 unit 套件全过 |
| 摘要 IPC 与既有 dispatch IPC 冲突（同时操作 meeting） | M3.1 复用 `_roundtableInProgress` 锁 |
| timeline.md 路径在 Windows 出错（路径含空格 / 中文） | Task 2.1 用 `path.join` 不手拼，单测覆盖中文 cwd |

---

## Execution Handoff

完工策略：

- **每个 Milestone 完成后强制 verification gate**（人工跑隔离 Hub + 看新行为）
- **M2 完成后允许向用户演示验收**，再决定是否进入 M3（摘要按钮可推后）
- **M4 上线后启动 followup**：`/schedule` 一个 2 周后的 agent 检查 AI 主动 Read timeline 比率

按 spec §16 总估时 **3.5 - 4.5 工作日**。

---

## References

- Spec：`docs/superpowers/specs/2026-05-02-roundtable-context-plan-F-design.md`
- 方案 F 终稿 HTML：`docs/2026-05-02-roundtable-context-plan-F-final.html`
- 既有相关 plans：`docs/superpowers/plans/2026-05-01-roundtable-pilot-mode.md`（dispatchMode 引入）
