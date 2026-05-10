# 主驾模式 + 按需查询历史 · 设计文档

> 2026-05-01 · 立花道雪
>
> **关联资源**
> - HTML mockup：`docs/roundtable-pilot-mode-final-2026-05-01.html`
> - Plan：`docs/superpowers/plans/2026-05-01-roundtable-pilot-mode.md`
> - **前置依赖**：`docs/superpowers/plans/2026-05-01-meeting-create-modal.md`（slot index 重构必须先合）
> - 不冲突可并行：card-optimization / card-redesign / input-fixes 系列

---

## 1. 目标

### 1.1 解决的问题

当前圆桌只能 3 家 AI 一起回答，简单问题想跟单家 AI 深聊每次都要打 `@kind` 前缀，用户体验断裂。同时既有"私聊"机制（`core/general-roundtable-private-store.js`）对其他 AI 完全黑箱——切回多人讨论时其他 AI 不知道独享期间发生了什么，需要重建上下文。

### 1.2 本期目标

1. toolbar 加 [🚗 主驾] toggle，开启后只跟某 1 个 slot 交流，其他 2 家变"副驾"
2. 切回多人讨论时，副驾通过"摘要 + 按需查询历史"机制快速接上下文
3. 段落切分支持双模：F5-A 主驾智能切（默认） / F5-B Hub 按轮算法切（0 token）
4. 用户可在 [主驾回顾] 卡片上一键切换 A/B 模式

### 1.3 非目标（Out of Scope）

- 不做 F6（用户主动按按钮强制喂完整历史 UI）
- 不做"切回时弹上下文范围选择器"
- 不实现"运行中切换主驾 slot"——切换需先关再开
- 不改 summary-engine 的"深度摘要"功能（独立工程）
- 不做主驾期间的 mention 重定向（`@gemini` 在主驾时灰显，强制用户先关主驾）

---

## 2. 关键调研结论

### 2.1 已有资产（80% 复用）

- **`core/general-roundtable-private-store.js`** 已实现私聊隔离存储（`<arena>/<meetingId>-roundtable-private.json`）。本期主驾期间消息直接复用此通道。
- **`_immersiveByMeeting`** 模式（per-meetingId toggle 持久化、IPC、UI active class）已成熟。本期主驾按钮完全照搬此模式。
- **`meeting._timeline`** + **`_cursors`** 增量同步机制。本期 recap 进 timeline 后副驾自动可见。
- **`mr-immersive-toggle`** CSS 类。本期 toggle 按钮基础样式复用。
- **既有 RT_MENTION_ITEMS 解析**。主驾期间灰显 mention 菜单，关闭后恢复。

### 2.2 必须新建的能力

- **`core/pilot-recap-builder.js`**（新文件）：负责生成 markdown 镜像 + segments 切分（A/B 双模） + md 重写
- **`summary-engine.js` 扩展**：从仅 Gemini 扩展到 5 家（Claude / Gemini / Codex / DeepSeek / GLM）
- **2 个新 IPC**：`roundtable:pilot-toggle` / `roundtable:pilot-segment-mode`
- **renderer 新组件**：toolbar 按钮、卡片 dim/locked 视觉、timeline [主驾回顾] 折叠卡片

### 2.3 关键约束

- **每家 AI 的 PTY 各自独立**：Hub 不主动喂消息给被排除的 AI。主驾切回时**必须**Hub 主动构造上下文给副驾。
- **slot index 优先于 kind**：本期"按 slot 排除"必须按 slot index 工作（用户 3 家都选 Claude 时按 kind 会全锁），所以依赖 meeting-create-modal plan 先合入。

---

## 3. UI 设计

### 3.1 Toolbar 按钮

位置：总结人 dropdown 与状态徽章之间。

**主驾 OFF（关闭态）**：
```
[🤝 群策群力] [📝 总结发言] | 总结人:[Claude▾] [🚗 主驾:关] 已 N 轮 · 等待提问
```

**主驾 ON（锁定 Slot 1）**：
```
[🤝 群策群力] [📝 总结发言] | 总结人:[Claude▾] [🚗 主驾:⚡皮卡丘 ▾] 主驾中·仅 Slot 1 接收
   ↓灰显         ↓灰显              ↓灰显         ↑高亮红
```

**交互**：
- 点 [🚗 主驾:关] → 展开 dropdown：[Slot 1 ⚡] / [Slot 2 🔥] / [Slot 3 💎]
- 选中后按钮变 [🚗 主驾:⚡皮卡丘 ▾] 高亮红
- 再点同一选项 → 关闭流程（触发摘要生成 + UI 恢复）
- dropdown 也可在不关闭主驾的情况下切换锁定的 slot

### 3.2 卡片视觉

- **锁定的 slot 卡片**：红边框 + "🔒 主驾"徽章
- **副驾 2 家**：半透明 (opacity: 0.35) + grayscale 60% + "🛋 副驾"徽章 + preview 区显示"（主驾期间不接收消息）"
- **输入框 placeholder**：`🚗 主驾中（仅 Slot 1 = Claude 接收）...`

### 3.3 主驾期间 timeline 占位

```
┌─────────────────────────────────────┐
│ 📒 主驾对话进行中（已 3 轮）...     │  ← 实时更新轮次
└─────────────────────────────────────┘
```

不入持久化。主驾关闭后被正式 [主驾回顾] 卡片替换。

### 3.4 [主驾回顾] 卡片（timeline 持久化）

**折叠态**：
```
┌─────────────────────────────────────────────────────┐
│ 📒 [主驾回顾 · Claude · 5 轮]   [展开 ▾] [切段:智能▾] │
└─────────────────────────────────────────────────────┘
```

**展开态**：
```
┌─────────────────────────────────────────────────────┐
│ 📒 [主驾回顾 · Claude · 5 轮]   [收起 ▴] [切段:智能▾] │
│                                                       │
│ <主驾不限字数摘要全文>                                 │
│                                                       │
│ 📂 完整历史: <abs path>.md (5 段)                     │
│    段落 1 [行 5-32]    AI/半导体板块整体              │
│    段落 2 [行 33-78]   AMD 估值                       │
│    段落 3 [行 79-110]  NVDA 风险评估                  │
│    段落 4 [行 111-145] AVGO 与博通收购                │
│    段落 5 [行 146-180] 仓位建议                       │
└─────────────────────────────────────────────────────┘
```

**[切段:XXX ▾] 按钮**：dropdown 提供两选项：
- 智能（F5-A · 主驾按主题切）
- 按轮（F5-B · Hub 按对话轮切）

切换后 Hub 立即重新生成 segments + 更新 md anchors，UI 重渲染。

---

## 4. F5-A & F5-B 双模设计

### 4.1 F5-A · 智能切（默认）

主驾在生成摘要时同时输出按主题切的段落目录。Prompt：

```
请总结你和我刚才的对话要点（多少字合适都由你决定，不需要简短）。

最后请用 1 行附段落目录（按主题切，1-10 段，每段一行格式：`段落 N: <主题>`）。

对话历史:
<主驾期间所有 turns>
```

主驾输出示例：

```
我们围绕 AI/半导体板块讨论了三个核心标的：NVDA 是 AI infra 龙头...
（中略，不限字数）
...回调时分批建仓。还讨论了 NVDA 的 H100/B200 出货节奏对 Q4 业绩的影响。

---
段落目录:
段落 1: AI/半导体板块整体
段落 2: AMD 估值（PE 28x vs 历史 25x）
段落 3: NVDA 风险评估
段落 4: AVGO 与博通收购影响
段落 5: 仓位建议
```

Hub 解析"段落目录"行后，按主题对应到对话轮次区间（启发式：每段对应 N 轮，按主驾输出顺序映射），生成 segments 数组。

**Token 增量**：~150-300 output tokens（一次 LLM 调用多产出段落目录）。

### 4.2 F5-B · 按轮切（0 token）

Hub 算法直接按对话轮次切，每轮一段：

```js
function splitByTurn(turns) {
  return turns.map((t, i) => {
    const userInput = (t.userInput || '').replace(/\s+/g, ' ').trim();
    let title = `Q: ${userInput.slice(0, 30)}`;
    if (userInput.length < 5) {
      // 短问题 fallback：附 AI 回答首 15 字
      const aiAns = (t.response || '').replace(/\s+/g, ' ').trim().slice(0, 15);
      title = `Q: ${userInput} · A: ${aiAns}`;
    }
    return { idx: i + 1, mode: 'turn', title };
  });
}
```

输出示例：
```
段落 1 [行 5-22]    Q: 如何看美股科技股
段落 2 [行 23-58]   Q: 我重点关注 AI/半导体
段落 3 [行 59-95]   Q: AMD 估值合理吗
段落 4 [行 96-128]  Q: NVDA 当前 PE 多少
段落 5 [行 129-180] Q: 仓位怎么配
```

短问题示例（轮 4 用户问"嗯"）：
```
段落 4 [行 96-128]  Q: 嗯 · A: 关于 AMD 的 MI300 出货
```

**Token 增量**：0（纯算法，不调 LLM）。

### 4.3 A↔B 切换流程

用户点 [切段:智能 ▾] 选"按轮" → 触发 IPC `roundtable:pilot-segment-mode({ meetingId, recapIdx, mode: 'turn' })`：

1. main.js 取出 recap 对应的 private turns
2. 调 `pilot-recap-builder.splitByTurn(turns)` → 新 segments（0 token）
3. 调 `pilot-recap-builder.rebuildMd(recapMdPath, turns, segments)` → 重写 md，更新 anchor 行号
4. recap.segments = newSegments；recap.segmentMode = 'turn'
5. 推 `timeline-update` IPC 给 renderer
6. UI 按钮文本变 [切段:按轮 ▾]，段落目录重渲染

切换 debounce 2s 防抖，期间按钮显示"切换中..."禁用。

---

## 5. 数据契约

### 5.1 state 字段

```ts
interface Meeting {
  // ... 既有字段
  pilotSlot?: 0 | 1 | 2 | null;  // 当前主驾 slot；null = 多人模式
}

interface State {
  // ... 既有
  pilotSlotByMeeting: { [meetingId: string]: number | null };  // per-meetingId 持久化
}
```

参考既有 `_immersiveByMeeting` 模式。

### 5.2 Timeline 条目（新增 tag）

```ts
interface TimelineRecapEntry {
  idx: number;
  sid: 'system';
  tag: 'pilot-recap';
  text: string;          // 主驾摘要全文（不限字数）
  recapMdPath: string;   // 绝对路径 Windows 风格
  segments: Array<{
    idx: number;
    mode: 'smart' | 'turn';
    title: string;
    mdLineStart: number;
    mdLineEnd: number;
  }>;
  segmentMode: 'smart' | 'turn';
  pilotSlot: number;     // 主驾的 slot index
  pilotKind: string;     // 主驾的 AI kind
  turnCount: number;     // 主驾期间轮次
  ts: number;
}
```

### 5.3 IPC 协议

#### `roundtable:pilot-toggle`
```ts
// Payload
{ meetingId: string, slotIndex: 0 | 1 | 2 | null }

// 行为
if (slotIndex === null):
  await _generatePilotRecap(meetingId)  // 触发摘要 + md 镜像 + timeline 写入
else:
  meeting.pilotSlot = slotIndex
  state.pilotSlotByMeeting[meetingId] = slotIndex
  saveState()

// 返回
{ ok: true, recapIdx?: number }  // 关闭时返回新 recap 在 timeline 的 idx
```

#### `roundtable:pilot-segment-mode`
```ts
// Payload
{ meetingId: string, recapIdx: number, mode: 'smart' | 'turn' }

// 行为
recap = meeting._timeline[recapIdx]
turns = privateStore.getRoundtablePrivateTurns(...)
if (mode === 'turn'):
  segments = splitByTurn(turns)  // 0 token
else:
  segments = await splitBySmart(pilotKind, turns)  // 走主驾 LLM 调用
rebuildMd(recap.recapMdPath, turns, segments)  // 更新 md anchor
recap.segments = segments
recap.segmentMode = mode
emit timeline-update IPC

// 返回
{ ok: true, segments, segmentMode }
```

### 5.4 markdown 镜像格式

`<arena>/<meetingId>-pilot-recap-<timestamp>.md`：

```markdown
# 主驾期会话历史 · Slot 1 (Claude / Opus 4.7)
> 2026-05-01 14:32 ~ 14:58 · 5 轮 · 主驾 Claude

<!-- segment 1 start -->
## 段落 1 · AI/半导体板块整体

### 第 1 轮 (14:32:15)
**用户**: 如何看美股科技股
**Claude**: 当前美股科技股呈现分化...

### 第 2 轮 (14:38:42)
**用户**: 我重点关注 AI/半导体
**Claude**: 建议 NVDA + AVGO + AMD...
<!-- segment 1 end -->

<!-- segment 2 start -->
## 段落 2 · AMD 估值
...
<!-- segment 2 end -->

...
```

副驾 Read 时按 `<!-- segment N start -->` / `<!-- segment N end -->` anchor 行号区间切片。

---

## 6. 后端改造范围

### 6.1 summary-engine 扩展（Task 0 spike）

**当前**：`core/summary-engine.js` 仅 `_callGeminiPipe(system, prompt) → text`。

**改造**：新增 `summarizeWithKind(kind, system, prompt) → text`，按 kind 分流：

```js
async function summarizeWithKind(kind, system, prompt) {
  switch (kind) {
    case 'claude':
    case 'deepseek':
    case 'glm':
      return _callClaudeHeadless(kind, system, prompt);
    case 'codex':
      return _callCodexHeadless(system, prompt);
    case 'gemini':
      return _callGeminiPipe(system, prompt);  // 既有
    default:
      throw new Error(`Unsupported kind: ${kind}`);
  }
}

async function _callClaudeHeadless(kind, system, prompt) {
  // headless: claude -p --append-system-prompt-file <tmp> < prompt
  // DeepSeek/GLM 通过 ANTHROPIC_BASE_URL + CLAUDE_CONFIG_DIR 隔离环境变量
  const env = buildEnvForKind(kind);  // 复用 session-manager.js 的 env 构造逻辑
  return spawnAndCollect('claude', ['-p', '--append-system-prompt-file', sysFile], { env, stdin: prompt });
}

async function _callCodexHeadless(system, prompt) {
  // codex exec - --skip-git-repo-check --json --full-auto -c "model_instructions_file=..."
  return spawnAndCollect('codex', ['exec', '-', '--skip-git-repo-check', '--json', '--full-auto', '-c', `model_instructions_file=${sysFile}`], { stdin: prompt });
}
```

每家用各自的子进程独立 spawn（不污染圆桌内的 PTY）。

**Spike 验证**（Task 0）：每家跑一次 summarize 测试通过率。

### 6.2 dispatchRoundtableTurn 加 excludedSlots 过滤

`main.js dispatchRoundtableTurn` 内：

```js
const subSids = meeting.subSessions;
const pilotSlot = meeting.pilotSlot;

for (let i = 0; i < subSids.length; i++) {
  if (pilotSlot !== null && pilotSlot !== undefined && i !== pilotSlot) {
    continue;  // 跳过副驾
  }
  await _rtSendToPty(subSids[i], finalPrompt, kind);
}
```

主驾期间消息存进 private store（既有）：
```js
if (pilotSlot !== null) {
  privateStore.appendRoundtablePrivateTurn(meetingId, subSids[pilotSlot], userInput, response);
}
```

### 6.3 _generatePilotRecap 新增

`main.js`：

```js
async function _generatePilotRecap(meetingId) {
  const meeting = meetingManager.getMeeting(meetingId);
  const pilotSlot = meeting.pilotSlot;
  if (pilotSlot === null) return;

  const pilotSid = meeting.subSessions[pilotSlot];
  const pilotSession = sessionManager.getSession(pilotSid);
  const pilotKind = pilotSession.kind;

  // 1. 取 private store 本次主驾期间的 turns
  const turns = privateStore.getRoundtablePrivateTurnsForSession(meetingId, pilotSid);

  // 2. 短主驾兜底
  if (turns.length <= 1) {
    const userInput = turns[0]?.userInput || '';
    appendTimelineRecap(meeting, {
      text: `用户私下问了 Slot${pilotSlot + 1}（${pilotKind}）："${userInput}"`,
      segments: [],
      segmentMode: 'turn',
      pilotSlot, pilotKind, turnCount: turns.length,
    });
    meeting.pilotSlot = null;
    return;
  }

  // 3. F5-A 智能切：调主驾生成摘要 + 段落目录
  let summaryText, segmentTitles;
  try {
    const result = await summaryEngine.summarizeWithKind(pilotKind,
      'You are summarizing your conversation with the user. Use as many words as needed.',
      buildSummaryPrompt(turns)
    );
    ({ summaryText, segmentTitles } = parseSummaryWithSegments(result));
  } catch (e) {
    // 4. 摘要失败降级到 F5-B
    console.warn('[pilot-recap] summary failed, falling back to F5-B:', e);
    summaryText = '（摘要生成失败，已降级为按轮切分；可点击切段重试）';
    segmentTitles = null;
  }

  // 5. 生成 md 镜像
  const segments = segmentTitles
    ? recapBuilder.splitBySmart(turns, segmentTitles)  // F5-A
    : recapBuilder.splitByTurn(turns);                 // F5-B fallback
  const mdPath = path.join(arenaDir, `${meetingId}-pilot-recap-${Date.now()}.md`);
  await recapBuilder.build(mdPath, turns, segments, { pilotKind, pilotSlot });

  // 6. 写 timeline
  meeting.pilotSlot = null;
  state.pilotSlotByMeeting[meetingId] = null;
  appendTimelineRecap(meeting, {
    text: summaryText,
    recapMdPath: mdPath,
    segments,
    segmentMode: segmentTitles ? 'smart' : 'turn',
    pilotSlot, pilotKind, turnCount: turns.length,
  });
  saveState();

  // 7. 推 IPC 给 renderer
  webContents.send('timeline-append', { meetingId, entry: latestEntry });
}
```

### 6.4 副驾的 prompt 注入 recap 前缀

`core/roundtable-orchestrator.js buildFanoutPrompt`：

```js
function buildFanoutPrompt(turnNum, userInput, ctx) {
  const recap = findLatestPilotRecap(ctx.meeting._timeline);
  const isWasPilot = (recap?.pilotSlot === ctx.targetSlotIndex);
  const cursor = ctx.meeting._cursors[ctx.targetSid] || 0;
  const hasInjectedBefore = recap && cursor > recap.idx;

  if (recap && !isWasPilot && !hasInjectedBefore) {
    const segLines = recap.segments.map((s, i) =>
      `   段落 ${i + 1} [行 ${s.mdLineStart}-${s.mdLineEnd}]   ${s.title}`
    ).join('\n');
    return `## 你刚才暂时离场（用户和 Slot${recap.pilotSlot + 1}（${recap.pilotKind}）通过 ${recap.turnCount} 轮深聊）

${recap.text}

📂 完整历史: ${recap.recapMdPath} (${recap.segments.length} 段)
${segLines}

若摘要够则直接答；不够可用 Read 工具读对应段落（offset+limit）。

## 现在用户问大家:
${userInput}`;
  }

  // 主驾自己 / 没有 recap → 走原 prompt 路径
  return originalBuildFanoutPrompt(turnNum, userInput, ctx);
}
```

**关键**：注入只做一次（recap 后第一轮），靠 `cursor[sid] > recap.idx` 判断。注入后 `cursor[sid] = recap.idx + 1`。

`buildDebatePrompt` 同理。

### 6.5 pilot-recap-builder.js 实现

新文件 `core/pilot-recap-builder.js`：

```js
'use strict';
const fs = require('fs');

function splitByTurn(turns) {
  return turns.map((t, i) => {
    const userInput = (t.userInput || '').replace(/\s+/g, ' ').trim();
    let title = `Q: ${userInput.slice(0, 30)}`;
    if (userInput.length < 5) {
      const aiAns = (t.response || '').replace(/\s+/g, ' ').trim().slice(0, 15);
      title = `Q: ${userInput} · A: ${aiAns}`;
    }
    return { idx: i + 1, mode: 'turn', title, mdLineStart: 0, mdLineEnd: 0 };
  });
}

function splitBySmart(turns, segmentTitles) {
  // 启发式：按 turn 数量均分给段落标题
  // segmentTitles 是 ["AI/半导体", "AMD 估值", ...] 主驾给的
  const N = segmentTitles.length;
  const turnsPerSeg = Math.ceil(turns.length / N);
  return segmentTitles.map((title, i) => ({
    idx: i + 1,
    mode: 'smart',
    title,
    mdLineStart: 0, mdLineEnd: 0,
    turnRange: [i * turnsPerSeg, Math.min((i + 1) * turnsPerSeg, turns.length)],
  }));
}

async function build(mdPath, turns, segments, meta) {
  let lines = [];
  lines.push(`# 主驾期会话历史 · Slot ${meta.pilotSlot + 1} (${meta.pilotKind})`);
  lines.push(`> ${formatDateRange(turns)} · ${turns.length} 轮 · 主驾 ${meta.pilotKind}`);
  lines.push('');

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startLine = lines.length + 1;
    lines.push(`<!-- segment ${i + 1} start -->`);
    lines.push(`## 段落 ${i + 1} · ${seg.title}`);
    lines.push('');

    const turnsInSeg = seg.mode === 'turn'
      ? [turns[i]]
      : turns.slice(seg.turnRange[0], seg.turnRange[1]);
    for (const t of turnsInSeg) {
      lines.push(`### 第 ${turns.indexOf(t) + 1} 轮 (${formatTime(t.ts)})`);
      lines.push(`**用户**: ${t.userInput}`);
      lines.push(`**${meta.pilotKind}**: ${t.response}`);
      lines.push('');
    }
    lines.push(`<!-- segment ${i + 1} end -->`);
    lines.push('');
    seg.mdLineStart = startLine;
    seg.mdLineEnd = lines.length;
  }

  await fs.promises.writeFile(mdPath, lines.join('\n'), 'utf8');
  return segments;  // 已填充行号
}

async function rebuildMd(mdPath, turns, segments, meta) {
  // 与 build 相同逻辑，但保留原 ts 等元数据
  return build(mdPath, turns, segments, meta);
}

module.exports = { splitByTurn, splitBySmart, build, rebuildMd };
```

---

## 7. 兼容性与降级

| 场景 | 行为 |
|---|---|
| 主驾 OFF | dispatchRoundtableTurn 走原路径，excludedSlots 为空，所有 slot 收 prompt |
| 旧 meeting 打开（无 pilotSlot 字段） | 缺省 = null → 走原 prompt 路径 |
| 既有 `@kind` mention 私聊 | 仍走 private store（与主驾共享同一存储），不冲突 |
| @debate / @summary 模式 | recap 前缀仅注入"非主驾期间的副驾"；主驾自己的 PTY 已有完整历史不需要 |
| F5-A 摘要失败 | 自动降级到 F5-B（按轮切，0 token），text 字段写"（摘要生成失败，已降级；可点切段重试）" |
| md 文件被删/移动 | 副驾 prompt 注入前 fs.access 检查；找不到则不附 md 路径，仅附摘要 |
| 短主驾（≤1 轮） | 不调 LLM，直接拼"用户私下问了 X" |
| 频繁 A/B 切换 | debounce 2s + 切段按钮显示"切换中..."禁用 |
| 主驾期间锁定 AI 崩溃 | Hub 自己有 private store 备份，绕过 PTY 直接喂"私聊历史"给重启后的 AI 总结 |
| Hook / MCP 系统 | 不动 |

---

## 8. 测试 / 验证

### 8.1 单元测试

| 测试文件 | 验证 |
|---|---|
| `tests/pilot-recap-builder.test.js` | splitByTurn / splitBySmart / build 生成 md / rebuildMd 行号正确 |
| `tests/summary-engine-multi-kind.test.js` | summarizeWithKind 5 家分别能跑通（mock spawn） |
| `tests/orchestrator-recap-injection.test.js` | buildFanoutPrompt 注入 recap 前缀的逻辑正确（仅副驾 + 仅一次） |

### 8.2 E2E 测试（CDP 真测）

`tests/_e2e-pilot-mode-verify.js` 流程：

1. 启动隔离 Hub（`CLAUDE_HUB_DATA_DIR=C:\temp\hub-pilot`，端口 9261）
2. 创建混合圆桌（Claude+Gemini+Codex）→ 进会议室
3. 点 [🚗 主驾] → 选 Slot 1 → assert 卡片 1 红边 + 卡片 2/3 dim
4. 发 3 轮主驾消息 → assert 仅 Slot 1 卡片有 streaming
5. 点 [🚗 主驾] → 取消 → 等摘要生成（最多 30s）→ assert timeline 出现 [主驾回顾] 消息
6. assert md 镜像文件存在 + 含 segment anchors
7. 默认 F5-A 段落目录截图 `01-smart-segments.png`
8. 点 [切段:智能▾] → 切到"按轮" → assert segments 重新生成（每轮一段）→ 截图 `02-turn-segments.png`
9. 发新消息（多人）→ 检查 hook log 中副驾 prompt 含 recap 前缀
10. 截图归档到 `tests/screenshots/pilot-mode/`

E2E 必须真按钮点击（不许后端 IPC 假装），按 `CLAUDE.md` 测试铁律。

---

## 9. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | summary-engine 扩展到 5 家时 spawn 子进程方案不通（如 Codex headless 限制） | 高 | Task 0 spike 30min 验证；失败的家走 PTY 注入兜底（直接发"请总结"prompt 到现有 PTY 等 turn-complete） |
| R2 | F5-A 主驾切段质量差（如返回 1 段或 50 段） | 中 | prompt 限制 1-10 段；解析失败时自动降级 F5-B |
| R3 | md 镜像与 segments 行号不一致（重写 md 后行号漂移） | 中 | rebuildMd 时同步重算所有 segments 行号区间，return 新 segments |
| R4 | 副驾 AI 不去读 md（即使摘要不够） | 低 | 这是 by design 的（AI 自主判断，符合 agent 心智模型） |
| R5 | 频繁 A/B 切换浪费 LLM token | 低 | debounce 2s + 切段按钮显示"切换中..."禁用 |
| R6 | private store 50 条上限被超过 | 低 | 主驾期间消息进 store 时 push 当前 batch；摘要直接读当前 batch 不读历史 store，本期不会触发 50 限 |
| R7 | 主驾期间 sub session 崩溃（Codex 自动更新等） | 中 | private store 已存储 → relaunch 后绕过 PTY 直接喂历史给新 AI 让它总结 |
| R8 | 用户在主驾期间使用 mention `@gemini` | 低 | UI 灰显 mention 菜单 + 输入框 `@kind` 触发提示"先关闭主驾" |

---

## 10. 版本

修改 `package.json` `version` +0.1（如 `0.5.0` → `0.6.0`）。UI 上版本徽章同步。

---

## 11. 文件改造一览

| 文件 | 类型 | 主要改动 |
|---|---|---|
| `core/summary-engine.js` | 修改 | 抽象 summarizeWithKind 支持 5 家（新增 _callClaudeHeadless / _callCodexHeadless） |
| `core/pilot-recap-builder.js` | **新增** | md 镜像生成 + segments 切分（A/B 双模） + rebuildMd |
| `core/meeting-room.js` | 修改 | meeting 加 pilotSlot 字段 + getter/setter |
| `core/meeting-store.js` | 修改 | 序列化 pilotSlot |
| `core/roundtable-orchestrator.js` | 修改 | buildFanoutPrompt / buildDebatePrompt 注入 recap 前缀（仅副驾、仅一次） |
| `main.js` | 修改 | dispatchRoundtableTurn 过滤 excludedSlots；新增 2 个 IPC；_generatePilotRecap |
| `renderer/meeting-room.js` | 修改 | toolbar [🚗 主驾] 按钮 + dropdown；timeline [主驾回顾] 渲染；占位提示；mention 灰显 |
| `renderer/meeting-room.css` | 修改 | 按钮样式 + 卡片 dim/locked 视觉 + recap 折叠卡片样式 |
| `package.json` | 修改 | version +0.1 |
| `tests/_e2e-pilot-mode-verify.js` | **新增** | E2E 9 步流程 |
| `tests/pilot-recap-builder.test.js` | **新增** | builder 单测 |
| `tests/summary-engine-multi-kind.test.js` | **新增** | 5 家 summarize 单测 |
| `tests/orchestrator-recap-injection.test.js` | **新增** | recap 注入逻辑单测 |

---

## 12. Open Questions（已逐项决策，无待定）

- ✅ 命名"主驾 / 副驾"
- ✅ 摘要不限字数 + 主驾自己生成
- ✅ F5-A 默认，UI [切段:智能 ▾] 按钮切到 F5-B
- ✅ md 镜像不含 thinking 块
- ✅ md 镜像生命周期：仅切回时一次性快照，不更新
- ✅ md 路径绝对路径喂 AI
- ✅ recap 前缀注入仅做一次
- ✅ 短问题（≤5 字）F5-B 标题附 AI 回答首句
- ✅ 持久化 pilotSlot per-meetingId
- ✅ 不做 F6 / 不弹切回选择器
- ✅ 主驾期间灰显群策群力/总结发言/总结人/mention
- ✅ summary-engine 扩展支持 5 家
- ✅ 切段 A↔B debounce 2s 防抖
