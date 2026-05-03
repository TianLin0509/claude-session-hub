# 圆桌自由模式（Free Mode）设计

**日期**：2026-05-04
**作者**：立花道雪 · Claude (Opus 4.7)
**状态**：design draft，待 review
**目标版本**：v3.x

---

## 1. 目标

在现有圆桌「主驾模式」（pilot mode）基础上**新增并存**一种「自由模式」（free mode），用 **参与者勾选** 取代 主驾/副驾 概念，让用户更直观地决定本轮谁开口。两种模式可在同一会议内随时切换，pilot 模式代码与数据完全保留。

**不是**：替换 pilot 模式 / 重构 dispatch 路径 / 修改注入算法。

## 2. 设计原则

1. **隔离风格**：free 模式逻辑集中到独立模块 `core/roundtable-free.js`，pilot 路径零改动
2. **零破坏迁移**：老 meeting `mode` 字段缺失时视为 `'pilot'`，行为完全不变；SCHEMA_VERSION 不动
3. **派生 dispatchMode**：free 模式 turn record 写派生值（数量映射 all/pilot/observer），让现有 `roundtable-injection.js` 同组跳过算法零修改
4. **双模式状态保留**：切换不擦除任何数据，pilotSlot/dispatchMode 字段在 free 模式下休眠但仍持久化，切回 pilot 状态完整恢复

## 3. 用户故事

### 3.1 默认体验

- 新建圆桌会议 → 默认 `mode='free'`，三个头像默认全选
- 用户键入文本回车 → 三人都收到 prompt 独立回答（等价 pilot 模式"群策群力"）

### 3.2 灵活勾选

- 用户取消勾选 Squirtle → 状态行更新："发言人: ⚡Pikachu, 🔥Charmander"
- 回车 → 仅这两位收到 prompt
- @debate 触发辩论 → 这两位互辩

### 3.3 模式切换

- 用户点头部 `[🎯 主驾模式]` toggle → 分发区切回三按钮 + 主驾红框 UI，状态恢复（pilotSlot/dispatchMode 都还在）
- 切回 `[🆓 自由模式]` → 头像勾选状态保持上次（per-meeting 记忆）

### 3.4 兼容老 meeting

- 老 meeting 文件 `mode` 字段不存在 → 直接以 `'pilot'` 模式打开，UI 完全等同当前体验
- 用户可手动 toggle 到 free 模式探索，pilotSlot/dispatchMode 状态被冻结保留

## 4. 数据模型

### 4.1 meeting 对象新增字段

```js
meeting.mode         : 'pilot' | 'free'
meeting.participants : number[] | null
```

| 字段 | 含义 | 缺失/默认值 |
|---|---|---|
| `mode` | 当前会议运行模式 | 缺失 → `'pilot'`（兼容老 meeting）<br>新建 → `'free'` |
| `participants` | free 模式下勾选的 slot 索引数组 | 缺失/null：load 时仍为 null；后端首次进 free 模式（`meeting.participants===null`）时初始化为 `[0,1,2]` |

### 4.2 已有字段保留不动

| 字段 | 用途 |
|---|---|
| `pilotSlot` | pilot 模式主驾 slot（free 模式忽略，保留作回退保险） |
| `dispatchMode` | pilot 模式分发选择（free 模式忽略） |
| `summarizerSlot` | 两模式共用，跨模式保留（Q10=A） |
| `slotSpecs` | 三 slot 配置（不变） |

### 4.3 持久化（meeting-store.js）

```js
// loadMeetingFile 兜底
mode: ['pilot','free'].includes(data.mode) ? data.mode : 'pilot',
participants: Array.isArray(data.participants) ? data.participants : null,
```

`saveMeetingFile` payload 增加 `mode`、`participants` 两个字段写盘。SCHEMA_VERSION 仍为 1。

### 4.4 Turn record（核心兼容设计）

每轮 turn record 仍写 `dispatchMode` 字段，但 free 模式下其值是 **派生**：

```
participants.length === 3 → 'all'
participants.length === 1 → 'pilot'
participants.length === 2 → 'observer'
```

派生收益：
- `roundtable-injection.js` 同组跳过算法（依赖 `lastTurn.dispatchMode`）零修改
- `unit-roundtable-injection-matrix.test.js` 零修改
- 后续若把 dispatchMode 字段重命名为 injectionKind 也不需联动

## 5. 架构总览

### 5.1 模块拆分

```
新增：
  core/roundtable-free.js           ~250 行，集中所有 free 模式逻辑

修改：
  core/meeting-store.js             加 mode/participants 字段持久化
  main.js                           入口分支 + 两个 IPC handler + 新建默认 mode='free'
  renderer/meeting-room.js          mode toggle UI + 头像勾选区 + 状态行/输入框/辩论按钮分支
  renderer/meeting-room.css         样式

零改动：
  core/roundtable-injection.js      ← 派生 dispatchMode 的核心收益
  core/roundtable-orchestrator.js   ← 仅 dispatchRoundtableTurn 入口加 if 分支
  core/roundtable-watcher.js
  core/roundtable-scenes.js         ← pilot prompt 模板
```

### 5.2 `core/roundtable-free.js` 接口

```js
// === Dispatch ===
deriveTargetSids(meeting, mode, summarizerSlot) → string[]
  // mode === 'summary' → [summarizerSub.sid]（不受 participants 影响）
  // mode === 'fanout' / 'debate' → participants 对应 sub.sid，过滤 active
  // 边界：participants 为空 → 返回 []

derivePilotCompatDispatchMode(participants) → 'all' | 'pilot' | 'observer'
  // length === 3 → 'all'
  // length === 1 → 'pilot'
  // length === 2 → 'observer'
  // 其它（0 或 >3） → 'all'（兜底）

// === Prompt 模板 ===
buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum })
buildFreeDebatePrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum })
buildFreeSummaryPrompt({ meeting, summarizerSlot, userInput, lastTurnInjection, turnNum })

// === 内部 helper ===
formatParticipantList(participants) → string
  // → "⚡ Pikachu, 🔥 Charmander, 💎 Squirtle"
```

### 5.3 `dispatchRoundtableTurn` 入口分支（main.js / orchestrator）

```js
async function dispatchRoundtableTurn(meetingId, { mode, userInput, summarizerSlot }) {
  const meeting = getMeeting(meetingId);

  if (meeting.mode === 'free') {
    const free = require('./core/roundtable-free');
    const targetSids = free.deriveTargetSids(meeting, mode, summarizerSlot);
    const compatDM   = free.derivePilotCompatDispatchMode(meeting.participants || []);
    // 后续走原 fanout/debate/summary 流程
    // - turn record 写 dispatchMode = compatDM
    // - prompt 用 buildFreeXxxPrompt（替换 buildXxxPrompt）
  } else {
    // pilot 路径完全不动
  }
}
```

## 6. UI 设计

### 6.1 模式切换 segmented control（头部）

位置：会议头部进度条下方、分发区上方

```
[🆓 自由模式] [🎯 主驾模式]
```

- 当前模式高亮（深底亮字）
- 另一模式 inactive（暗底）
- `inProgress=true` 时整个 toggle disabled（Q9=A，避免半轮发言后改语义）
- 点击立即切，无确认弹窗

### 6.2 Free 模式分发区

```
┌──── 本轮发言人 ────────────────────────────┬── 总结人 ──┐
│  [☑] [⚡ pic] Pikachu  ⚡                     │            │
│  [☑] [🔥 pic] Charmander 🔥                   │  ▼ 未选    │
│  [☐] [💎 pic] Squirtle 💎                     │            │
└────────────────────────────────────────────┴───────────┘
```

- 头像图片：`renderer/assets/pokemon/{slotId}.png`（36×36 圆角）
- 整个 slot 行可点击切换勾选
- 已勾：边框高亮 + 完全不透明
- 未勾：opacity 0.4 + 灰底
- 不显示主驾红框（free 模式无主驾）

### 6.3 状态行格式

| 勾选数 | 状态行 |
|---|---|
| 3 人 | `分发: 自由 · 发言人: ⚡Pikachu, 🔥Charmander, 💎Squirtle · ⏳处理中` |
| 2 人 | `分发: 自由 · 发言人: ⚡Pikachu, 🔥Charmander · ⏳处理中` |
| 1 人 | `分发: 自由 · 发言人: ⚡Pikachu · ⏳处理中` |
| 0 人 | `分发: 自由 · ⚠ 请勾选至少一位发言人` |

3 人时**仍逐个列出**，不简化为"全员"（Q4 你选 B）。

### 6.4 辩论按钮（沿用现有按钮位置）

| 条件 | 状态 | title |
|---|---|---|
| `inProgress` | disabled | 辩论中无法重启 |
| `participants.length < 2` | disabled | 勾选至少 2 位才能辩论 |
| `participants.length >= 2` | enabled | （正常） |

### 6.5 0 人勾选保护（双重）

- **输入框**：灰底 + readonly + placeholder 改为 `请先勾选至少一位发言人`
- **发送按钮**：disabled
- 用户尝试粘贴/键入：被 readonly 拦截

### 6.6 Pilot 模式 UI 完全不变

切回 pilot 模式：原来的"群策/主驾/副驾"三按钮 + 主驾红框 + 状态行格式（"分发: <strong>群策群力</strong> · 主驾: <strong>未选</strong>"）完整恢复。

## 7. Free 模式 Prompt 模板

### 7.1 第一行格式契约（沿用 Resend T2）

所有 free 模式 prompt 第一行格式：

```
# 自由模式 第 N 轮 <mode> — 你是 <slotLabel>
```

例：
- `# 自由模式 第 5 轮 fanout — 你是 ⚡ Pikachu`
- `# 自由模式 第 6 轮 debate — 你是 🔥 Charmander`
- `# 自由模式 第 7 轮 summary — 你是 💎 Squirtle`

满足契约：
- 非空
- 含轮号
- 让 `resendCurrentPrompt` 用首行 30 字作 PTY ring buffer 指纹

### 7.2 buildFreeFanoutPrompt（独立发言）

```
# 自由模式 第 5 轮 fanout — 你是 🔥 Charmander

[本轮上下文]
- 模式：自由模式 · fanout
- 本轮发言人：⚡ Pikachu, 🔥 Charmander
- 你是：🔥 Charmander

[上一轮注入]
（沿用 computeLastTurnInjection payload 渲染，无变化）

[用户输入]
{userInput}

请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）。
```

### 7.3 buildFreeDebatePrompt（辩论）

```
# 自由模式 第 6 轮 debate — 你是 🔥 Charmander

[本轮上下文]
- 模式：自由模式 · 辩论
- 本轮发言人：⚡ Pikachu, 🔥 Charmander
- 你是：🔥 Charmander

[上一轮注入]
...

[用户输入]
{userInput}

请反驳/呼应其他发言人的观点（你们看得到对方本轮言论）。
```

### 7.4 buildFreeSummaryPrompt（总结）

```
# 自由模式 第 7 轮 summary — 你是 💎 Squirtle

[本轮上下文]
- 模式：自由模式 · 总结
- 你被点名担任本轮总结人
- 已发言历史：（沿用现有 summary 历史拼接逻辑）

[用户输入]
{userInput}

请综合上述历史给出总结。
```

注：summary 模式 summarizer 独说，不受 participants 勾选影响（Q8=A）。

### 7.5 与 pilot 模板的差异点

| 元素 | Pilot 模板 | Free 模板 |
|---|---|---|
| 首行格式 | `# 第 N 轮 <mode> — 你是 ...（主驾/副驾）` | `# 自由模式 第 N 轮 <mode> — 你是 ...` |
| 角色字眼 | "主驾"/"副驾"/"observer" | 仅 "发言人" |
| 上下文头 | "你的位置: 主驾/副驾" | "你是: <slotLabel>" |
| 静音说明 | "副驾们本轮静音" / "主驾本轮静音" | （无） |
| 发言人列表 | 不显式列出 | 显式列出 `本轮发言人：A, B, C` |

## 8. IPC 协议

### 8.1 新增 handler（main.js）

```js
ipcMain.handle('roundtable:set-meeting-mode', async (_e, { meetingId, mode } = {}) => {
  // 校验 mode ∈ {'pilot','free'}
  // 校验 meeting 存在 + 当前未在 inProgress（Q9=A）
  // 持久化 meeting.mode
  // 推 meeting-updated 事件
});

ipcMain.handle('roundtable:set-participants', async (_e, { meetingId, participants } = {}) => {
  // 校验 participants 是 number[]，元素为 [0,1,2] 子集，去重
  // 允许空数组（Q11=A，用户故意清）
  // 持久化 meeting.participants
  // 推 meeting-updated 事件
});
```

### 8.2 现有 handler 不动

- `roundtable:dispatch-mode-set`（pilot 模式专用，free 模式不调用）
- `roundtable:set-summarizer`（两模式共用，跨模式保留 Q10=A）

### 8.3 dispatchRoundtableTurn payload 不变

为不动 pilot 路径，renderer 现有 payload 保持原样（仍传 `dispatchMode`，meeting-room.js:1240）：

```js
ipcRenderer.invoke('roundtable:dispatch-turn', {
  meetingId,
  mode: 'fanout' | 'debate' | 'summary',
  userInput,
  summarizerSlot,
  dispatchMode: meeting.dispatchMode || 'all',  // 现状不变
});
```

**后端处理**：
- `meeting.mode === 'pilot'` → 沿用 payload 中的 `dispatchMode`（pilot 路径完全不动）
- `meeting.mode === 'free'` → 进入 free 分支后**忽略** payload 中的 `dispatchMode`，改用 `derivePilotCompatDispatchMode(meeting.participants)` 计算

收益：renderer 不需感知 mode 分支，pilot/free 共享同一个 IPC 入口。

## 9. 关键不变量

1. **Pilot 路径完全不动**：除 `dispatchRoundtableTurn` 入口加 `if (meeting.mode === 'free')` 分支外
2. **SCHEMA_VERSION=1 不变**：meeting-store 加新字段时全部兜底默认
3. **注入算法零改**：free 模式 turn record 写派生 dispatchMode
4. **Resend T2 第一行契约**：free prompt 第一行同样满足非空 + 含轮号
5. **数据无破坏性变更**：老 meeting 自动识别为 pilot
6. **模式状态隔离**：切换不擦除任何字段，切回原模式状态完整恢复
7. **Summarizer 跨模式**：两模式共用 summarizerSlot 字段（Q10=A）

## 10. 测试矩阵

### 10.1 新增 unit tests

| 测试文件 | 覆盖范围 |
|---|---|
| `tests/unit-roundtable-free-dispatch.test.js` | `deriveTargetSids` × {fanout, debate, summary} × {1,2,3 人勾选} × summary 不受勾选影响 + `derivePilotCompatDispatchMode` 派生表 + 边界（0 人 / >3 人） |
| `tests/unit-roundtable-free-prompt.test.js` | 三个 buildFree*Prompt 内容包含 participants + **第一行格式契约**（沿用 Resend T2） + 不出现"主驾/副驾"字眼 |
| `tests/unit-meeting-mode-toggle.test.js` | `roundtable:set-meeting-mode` IPC 校验 + 持久化往返 + 老 meeting 缺 mode 字段默认 pilot + inProgress 时拒绝切换 |
| `tests/unit-participants-persistence.test.js` | `roundtable:set-participants` IPC 校验（[0,1,2] 子集 / 去重 / 接受空） + 持久化 + 默认全选规则（首次进 free 模式 [0,1,2]） |

### 10.2 零改动（关键收益）

- `tests/unit-roundtable-injection-matrix.test.js`（注入算法零改）
- `tests/unit-pilot-dispatch-mode.test.js`（pilot 路径不动）
- `tests/unit-roundtable-slot-participation.test.js`

### 10.3 E2E（CDP 隔离 hub）

`tests/_e2e-free-mode-verify.js`（gitignored）覆盖 5 场景：

1. **新建会议默认 free + 全选**：建会议 → 状态行显示"全员" → 发言 → 三人都收到 prompt
2. **取消勾选 1 人**：勾掉 Squirtle → 发言 → 仅 2 人收到正确 free prompt
3. **0 人勾选保护**：勾掉所有 → 输入框灰 + 发送 disabled + placeholder 文案正确
4. **辩论 disable / enable**：1 人勾选 → 辩论按钮 disabled；勾选 2 人 → enabled
5. **模式切换状态保留**：先在 pilot 设主驾 + summarizer → 切 free → 切回 pilot → 主驾红框/summarizer/dispatchMode 完整恢复

## 11. 兼容性 + 数据迁移

### 11.1 老 meeting

- meeting JSON 缺 `mode` 字段 → load 时兜底 `'pilot'`，UI 完全等同当前体验（pilot 三按钮 + 主驾红框）
- meeting JSON 缺 `participants` 字段 → load 时兜底 `null`
- 用户切到 free 模式时，若 `meeting.participants===null` 则首次初始化为 `[0,1,2]`；`pilotSlot/dispatchMode` 字段保留不动作为回退保险

### 11.2 老 turn record

- turn record `dispatchMode` 字段沿用（pilot 模式 turn）
- 新 free turn record 写派生 `dispatchMode`（'all' / 'pilot' / 'observer'）
- 注入算法 `computeLastTurnInjection` 不区分 turn 来自哪个模式，只看 dispatchMode 值

### 11.3 SCHEMA_VERSION

- 保持 `1`（无破坏性 schema 变更）
- 不引入 schema 升级路径

## 12. 边界 / 风险评估

| 边界 | 决策 | 备注 |
|---|---|---|
| 模式切换时 inflight turn | Disable toggle（Q9=A） | inProgress=true → toggle disabled |
| 切模式时 summarizerSlot | 跨模式保留（Q10=A） | summarizer 是会议级别，与 mode 解耦 |
| Participants 为空数组 | 持久化 + 发送拦截（Q11=A） | 用户故意清，UI 已防发送 |
| Pilot 模式 turn record 兼容 | 不动 | 老 dispatchMode 字段语义不变 |
| 模式切换中途的 turn 注入 | 沿用 lastTurn.dispatchMode | 上一轮 pilot turn 的 dispatchMode 仍正确指导跳过决策 |

### 12.1 已识别风险

- **低**：Pilot 模式零改动 → 不会破坏现有功能
- **低**：注入算法零改 → 不会破坏 fanout/debate/summary 注入
- **中**：UI 重排（segmented control + 头像勾选区）→ 需要 CDP E2E 兜底
- **中**：模式切换 + summarizer/participants 持久化往返 → 需要单测覆盖
- **低**：Free prompt 模板新增 → 第一行契约测试守住

### 12.2 不在本 spec 范围

- "群策但有主导"这类混合语义（Q1 选 C 路径） → 显式排除
- 总结轮按 participants 过滤 → 显式排除（Q8=A）
- 全选 / 清空快捷按钮 → 显式排除（Q3 不要）
- 老 meeting 强迁 free → 显式排除（Q5=A）

## 13. 实施工作量估算

- ~10-12 commits
- 1.5-2 个 brainstorm-spec-plan-subagent 周期
- ~ Resend 任务（14 commits）的 60-70%

预期 task 切分（写 plan 时细化）：

```
T1  meeting-store mode/participants 字段持久化 + 兜底
T2  core/roundtable-free.js 骨架 + deriveTargetSids + derivePilotCompatDispatchMode
T3  core/roundtable-free.js prompt 三模板 + 第一行契约
T4  main.js IPC handler + dispatchRoundtableTurn 入口分支
T5  renderer mode toggle UI + free 头像勾选区
T6  renderer 状态行 / 输入框 / 辩论按钮分支
T7  CSS 样式
T8  CDP E2E 5 场景
T9  集成验证 + finishing
```

## 14. 后续不在范围（backlog 候选）

- Mobile 端 free 模式 UI（如有移动端）
- Free 模式自定义 slot 顺序（拖拽重排）
- 历史轮次 timeline 视图区分 pilot/free 模式
- "群策但有主导"混合语义

---

## Appendix A：决策记录（11 个 Q）

| Q | 问题 | 决策 |
|---|---|---|
| 1 | 自由模式概念 | A：彻底无主驾，参与者勾选 + 总结人独立 |
| 2 | 辩论规则 | 1人disable / 2-3人enable |
| 3 | 全选快捷按钮 | 不要 |
| 4 | 模式切换 UI | B：头部 segmented control，per-meeting 持久化；3人状态行仍逐个列 |
| 5 | 默认值打包 | 全选 / summarizer 第一轮null+记上次 / 老meeting保pilot |
| 6 | 0人勾选保护 | A：输入框灰+发送disabled |
| 7 | Prompt 模板 | 去主驾化，新写 free 模板 |
| 8 | 总结模式 | A：summarizer独说，勾选不影响 |
| - | 模板隔离 | B：summary 也复制到 free 模块 |
| Q1' | dispatchMode 处理 | A：派生写入 turn record，注入算法零改 |
| Q2' | 模块拆分 | 合一个 `core/roundtable-free.js` |
| 9 | inflight 切模式 | A：disable toggle |
| 10 | 切模式 summarizer | A：跨模式保留 |
| 11 | 空 participants | A：尊重用户清空 |

## Appendix B：关键文件路径

```
新建：
  C:\Users\lintian\claude-session-hub\core\roundtable-free.js
  C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-dispatch.test.js
  C:\Users\lintian\claude-session-hub\tests\unit-roundtable-free-prompt.test.js
  C:\Users\lintian\claude-session-hub\tests\unit-meeting-mode-toggle.test.js
  C:\Users\lintian\claude-session-hub\tests\unit-participants-persistence.test.js
  C:\Users\lintian\claude-session-hub\tests\_e2e-free-mode-verify.js

修改：
  C:\Users\lintian\claude-session-hub\core\meeting-store.js
  C:\Users\lintian\claude-session-hub\main.js
  C:\Users\lintian\claude-session-hub\renderer\meeting-room.js
  C:\Users\lintian\claude-session-hub\renderer\meeting-room.css

零改动（关键收益）：
  C:\Users\lintian\claude-session-hub\core\roundtable-injection.js
  C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js（除入口分支）
  C:\Users\lintian\claude-session-hub\core\roundtable-watcher.js
  C:\Users\lintian\claude-session-hub\core\roundtable-scenes.js
```
