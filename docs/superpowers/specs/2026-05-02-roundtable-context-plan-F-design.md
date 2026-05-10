# 圆桌上下文 · 方案 F 设计文档

**Date**: 2026-05-02
**Author**: 立花道雪 + Claude
**Status**: Draft → 待用户批准
**Ref**: `docs/2026-05-02-roundtable-context-plan-F-final.html`

---

## 1. Goal

把圆桌 AI 上下文构成从「PTY 依赖 + 隐性调度」演进到 **四层显式分层架构**，实现以下三点：

1. **角色感知显性化** — pilot / observer / all 三种调度模式都明示给 AI（当前完全不显式，AI 靠猜）
2. **长会议稳定** — token 用量恒定，不随轮数膨胀（当前 summary 重度依赖 PTY 上下文，长会议会断崖）
3. **高效协作** — 「主驾深聊 → 切副驾审查」「跨轮引用」「五元组摘要」等典型工作流原生支持

---

## 2. Background — 当前实现的 5 个具体问题

| # | 问题 | 触发 | 影响 |
|---|---|---|---|
| P1 | fanout prompt 永远写「你看不到另两家观点」 | observer 模式下副驾 | 副驾被告知"独立赛跑"，但实际上是"代主驾发言"，语义错位 |
| P2 | pilot 模式主驾不知自己被点名独说 | dispatchMode='pilot' + mode='fanout' | 主驾可能"等下我看看其他两位"，但其他两位本轮根本不会说话 |
| P3 | debate 只回放最近一轮 | 第 5 轮 debate 想引用第 3 轮 | 不支持，写死取 lastTurn |
| P4 | summary 重度依赖 PTY 上下文 | 长会议（>15 轮） | summarizer PTY context 满 / reset 时 → 仅看到「最近一轮 + 任务说明」，效果断崖 |
| P5 | 跨 mode 衔接无桥接 prompt | fanout → debate 切换 | AI 不被告知「现在进入辩论环节，请明示引用」 |

---

## 3. Non-Goals (YAGNI)

以下功能在本方案不实现，明确推迟：

- **L2 房间公约 hot reload** — 用户明确表示「暂不考虑使用」。改公约后下次该子 session 重启才生效，UI 给提示即可。
- **跨 meeting 知识传承** — cat-cafe @global 蒸馏不实现
- **标签式知识图谱** — `[结论][数据]` 标签筛选不实现
- **结构化协作五段式** — Cross-cat Handoff What/Why/Tradeoff 不实现
- **AI 主动维护 timeline.md** — 由系统侧自动维护，AI 只读不写
- **timeline 滚动后的归档查询** — 滚动出窗口的轮次仅写日志，不提供查询 UI
- **摘要按钮的智能调度** — 不自动判断"该不该摘要"，完全由用户手动触发

---

## 4. Architecture · 四层上下文

```
┌──────────────────────────────────────────────────────────────────┐
│ L1 · 核心 System Prompt                                           │
│   - 启动 PTY 时一次性注入                                          │
│   - 内容：你是谁 / 怎么开口 / 三原则 / 怎么找历史                   │
│   - 篇幅：约 200 字（极简）                                        │
│   - 所有圆桌共用，不可改                                            │
└────────────────────────┬─────────────────────────────────────────┘
                         │ 与 L2 拼接成单个 system prompt 文件
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ L2 · 房间公约（详细协作手册）                                       │
│   - 启动 PTY 时一次性注入（与 L1 拼接）                             │
│   - 内容：timeline 用法 / 摘要按钮 / 五元组 / 切模式工作流 / 礼仪    │
│   - 按 scene 提供默认模板（general / research），用户可在 UI 编辑  │
└──────────────────────────────────────────────────────────────────┘

═════════════════════ Per-Turn 通道（每轮独立注入） ══════════════════

┌──────────────────────────────────────────────────────────────────┐
│ L3 · Per-Turn Prompt                                              │
│   - 每轮触发时通过 PTY stdin 注入                                  │
│   - 内容：调度上下文 + 上一轮内容（按矩阵） + 任务 + timeline 路径  │
│   - 篇幅：简明，不重复 L1/L2 内容                                   │
└──────────────────────────────────────────────────────────────────┘

═════════════════════ 外置文件通道（AI 主动 Read） ═══════════════════

┌──────────────────────────────────────────────────────────────────┐
│ L4 · Timeline.md                                                  │
│   - 系统侧自动写，AI 主动 Read                                      │
│   - 位置：<project_cwd>/.arena/timeline-<meetingId>.md             │
│   - 内容：近 10 个非摘要轮 + 全部摘要轮（永久保留）                  │
│   - 路径在每轮 prompt 末尾附                                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. L1 · 核心 System Prompt

### 5.1 完整文本草案（替换当前 `BASE_RULES`）

```
# 圆桌讨论 · 核心规则

## 你是谁
你是用户的 AI 智囊之一，与另外 N-1 位 AI 同事共处一个圆桌。本色发挥，不需要扮演。

## 怎么开口
每轮 prompt 头部会标明本轮的「调度上下文」—— 告诉你：
- 本轮属于 fanout / debate / summary / 摘要 哪一类
- 本轮是 all 群策群力 / pilot 主驾发言 / observer 副驾发言 哪种模式
- 你是主驾还是副驾、谁与你同台

## 三个原则
1. 引用要明示（"Gemini 在第 3 轮提到的 X"）
2. 分歧别抹平（summary 时显式列出未消解分歧，不要伪共识）
3. 不知就说不知（信息不足时主动说"我需要 X 数据"，不硬猜）

## 怎么找历史
- 系统会推给你「上一轮」相关内容（按规则有时跳过 —— 比如你刚刚以同样身份说过话）
- 完整历史在 timeline.md（路径见每轮 prompt 末尾），需要时主动 Read

详细约定见房间公约（如用户配置了的话）。
```

### 5.2 关键设计决策
- **去掉**当前 BASE_RULES 里的「四种用户语法详解」（已移到 L2）
- **去掉**「协作礼仪」章节（移到 L2）
- **去掉**「工具与资源」章节（移到 L2）
- **新增**「调度上下文」预告（告诉 AI 每轮 prompt 头部会标明）
- **新增**「同组跳过」预告（不必看到「跳过」段时困惑）

---

## 6. L2 · 房间公约（默认模板 + scene 扩展）

### 6.1 通用公约 `COVENANT_GENERAL`（新增常量，所有 scene 共用基础）

```
# 房间公约 · 圆桌协作手册

## 关于 timeline.md
路径：每轮 prompt 末尾会附绝对路径
内容结构：
  ## 第 N 轮 · 模式 · 参与者
  ### <AI 名>  <全文>
  ...
滚动策略：保留近 10 个非摘要轮 + 全部摘要轮（摘要永久保留）

### 何时该 Read 它
- 用户问「对方第 K 轮说了什么」
- debate 时引用某轮具体观点需确认细节
- summary 时浏览全部历史做完整 fan-in
- 上一轮注入感觉不够时

### 何时不必查
- 短问答 / 闲聊 / 首轮
- 上一轮注入已经足够

## 关于摘要按钮
用户可在 UI 点「摘要」按钮触发摘要轮。机制：
- 系统选定「上一轮发言者」作为摘要人（可能多家并发）
- 摘要人按下面「五元组」格式浓缩自己最近一段
- 摘要写入 timeline.md（永久标记 ## 第 N 轮 · 摘要 by <who>）
- 下一轮通过「上一轮注入」机制天然把摘要喂给后续发言者

### 五元组格式（摘要人输出时严格按此）
1. **目标**：本段聚焦什么任务/问题（一句话，20-50 字）
2. **关键事实**：你确认的事实/数据（项目化，最多 5 条）
3. **关键分歧**：与他人核心分歧 / 自己的不确定（项目化）
4. **当前结论**：倾向判断 + 信心度 0-100%（30-80 字）
5. **下一步**：建议下一轮聚焦什么 / 想问对方什么（30-80 字）

约束：不超过 500 字，第一人称，不展开论证。

## 关于 dispatchMode 切换
典型工作流：「主驾深聊 → 切副驾审查」
- 主驾 pilot 模式聊一段后，用户点摘要 → 主驾输出五元组
- 用户切到 observer 模式 → 副驾们收到摘要作为本轮「上一轮注入」
- 副驾基于摘要做审查（必要时 Read timeline.md 看主驾原文）

## 协作礼仪
- 该坚持就坚持，被对方观点强势不等于自己错
- 改主意要说明为什么
- 工具该用就用（联网/读文件/跑代码/MCP），但每次评估必要性
- 不要无意义探查 / 重复求证已确认事实

## 留白
本圆桌的灵魂是三家不同视角的真实碰撞，不是齐声合唱。
```

### 6.2 投研公约（在 `COVENANT_GENERAL` 后追加投研专属内容）

完整保留当前 `COVENANT_RESEARCH` 内容（投资风格 / 红线 / 输出习惯 / 数据获取指引），追加在通用公约之后。

### 6.3 拼接顺序

`buildSystemPrompt(sceneKey, covenantText)` 输出：

```
L1 BASE_RULES
---
L2 scene.preset（数据获取指引等）
---
L2 covenant（通用公约 + scene 专属公约 + 用户自定义覆盖）
```

---

## 7. L3 · Per-Turn Prompt 模板

### 7.1 通用模板（fanout / debate / summary）

```
[圆桌 · 第 N 轮 · <mode> · <dispatchMode>]

## 调度上下文
- 模式：<人类可读说明>
- 你的位置：主驾 / 副驾
- 同台：<其他活跃 AI 列表>

## 上一轮  ← 按 §8 矩阵决定是否注入；跳过时整段省略
> 提示：本段是 <X> 上一轮内容。需要更早历史请 Read <timeline 绝对路径>

<内容>

## 用户问题 / 任务
<userInput / 任务描述>

---
完整历史：<timeline.md 绝对路径>
```

### 7.2 摘要轮模板

```
[圆桌 · 第 N 轮 · 摘要轮 · by <你>]

## 任务
请按「五元组」格式浓缩你最近一段连续发言（第 K - N-1 轮）。
五元组格式见房间公约 §五元组格式。

约束：不超过 500 字 · 第一人称 · 不展开论证。

---
你的发言历史：<timeline.md 绝对路径>
```

### 7.3 调度上下文段的具体文案

| dispatchMode | 文案模板 |
|---|---|
| all | 群策群力（三家同台独立回答） |
| pilot | 主驾发言（你被点名独说，副驾们本轮静音） *仅当当前 AI 是主驾* |
| pilot | 主驾发言（主驾 <name> 本轮独说，你本轮静音） *不应该出现 — observer 才是副驾* |
| observer | 副驾发言（主驾 <name> 本轮静音，用户希望听副驾视角） |

---

## 8. 上一轮注入矩阵 · 核心算法

### 8.1 完整规则表

| 上一轮发言者集合 | 当前发言者集合 | 注入策略 | 备注 |
|---|---|---|---|
| 无（首轮） | 任意 | 不注入 | 自然降级 |
| `all` 全员 | `all` 全员 | 给每个 AI 注入除自己外另两家 | 三家个性化注入 |
| `all` 全员 | `pilot` 主驾 | 给主驾注入另两家 | 主驾参考全员观点深挖 |
| `all` 全员 | `observer` 副驾 | 给每个副驾注入「主驾 + 另一副驾」 | 副驾各自能看到全员上一轮 |
| `pilot` 主驾 | `pilot` 同一主驾 | **跳过** | 主驾自己 PTY 上下文里有 |
| `pilot` 主驾 | `observer` 副驾 | 给每个副驾注入主驾全文 | 典型场景：副驾审查 |
| `pilot` 主驾 | `all` 全员 | 给每个 AI 注入主驾全文（主驾自己跳过） | 切回协同后大家对齐 |
| `observer` 副驾 | `observer` 同两位副驾 | **跳过** | 副驾保持各自自主观点 |
| `observer` 副驾 | `pilot` 主驾 | 给主驾注入副驾两家全文 | 主驾参考副驾审查后回应 |
| `observer` 副驾 | `all` 全员 | 主驾收到副驾两家；每副驾收到「另一副驾 + 主驾上一轮（如有）」 | 注：上一轮主驾没说话，所以副驾本轮收到的是对方副驾 |
| 摘要轮 | 任意 | 给所有当前发言者注入摘要全文 | 典型场景：切模式后 |

### 8.2 算法伪代码

```
function computeLastTurnInjection(lastTurn, currentTargets, currentDispatchMode):
    if lastTurn is None:
        return {}  # 首轮无注入

    if lastTurn.mode == 'summary-brief':  # 摘要轮特殊处理
        return { sid: lastTurn.byMap for sid in currentTargets.sids }

    lastSpeakers = set(lastTurn.byMap.keys())
    currentSpeakers = set(currentTargets.sids)

    # 同组跳过：当前发言者集合 = 上一轮发言者集合
    if lastSpeakers == currentSpeakers:
        return {}  # 跳过整体注入

    # 个性化注入：每个当前发言者收到「上一轮发言者中除自己外」的内容
    result = {}
    for sid in currentTargets.sids:
        otherSpeakers = lastSpeakers - {sid}
        if not otherSpeakers:
            continue  # 上一轮只有自己说话，跳过
        result[sid] = { speaker_sid: lastTurn.byMap[speaker_sid]
                        for speaker_sid in otherSpeakers }
    return result
```

### 8.3 注入内容格式（嵌 timeline 索引）

每段注入内容上方加索引提示：

```
## 上一轮（第 N-1 轮 · <mode> · <dispatchMode>）
> 提示：本段是 <X> 上一轮内容。如需更早历史请 Read <timeline 绝对路径>

### <AI 名>（主驾 / 副驾）
<全文，不截断 — 由 timeline 滚动控制总量>
```

> 全文不截断的依据：上一轮恒定注入，单家通常 2-4KB，最多 8-12KB（三家），仍在 PTY context 安全范围内。

---

## 9. L4 · Timeline.md 详细设计

### 9.1 文件位置

`<project_cwd>/.arena/timeline-<meetingId>.md`

- `project_cwd` = 主驾子 session 的 cwd（多家 AI 时取主驾，无主驾时取第一家）
- 创建文件时如果 `.arena/` 目录不存在自动 `mkdir -p`
- 同 cwd 多个 meeting 各自独立文件

### 9.2 文件结构

```markdown
# Roundtable Timeline · <meetingId>

- 创建时间：<ISO datetime>
- 当前轮数：<N> 轮（含 <K> 个摘要轮）
- 滚动策略：保留近 10 个非摘要轮 + 全部摘要轮

---

## 第 1 轮 · fanout · all
- 时间：<ISO datetime>
- 用户输入：<userInput>

### Claude (slot 1, 主驾)
<Claude 第 1 轮全文>

### Gemini (slot 2)
<Gemini 第 1 轮全文>

### Codex (slot 3)
<Codex 第 1 轮全文>

## 第 2 轮 · debate · all
...

## 第 4 轮 · 摘要 by Claude（五元组）
- 时间：<ISO datetime>
- 触发：用户点「摘要」按钮
- 浓缩范围：第 N-K - N-1 轮（共 K 轮）

### Claude · 五元组摘要
1. **目标**：...
2. **关键事实**：...
3. **关键分歧**：...
4. **当前结论**：...
5. **下一步**：...

## 第 5 轮 · observer · 副驾审查
...
```

### 9.3 滚动策略实现

每次写入新轮后检查：
- 统计「非摘要轮」数量
- 如果 > 10，把最早的非摘要轮移到 archive 文件 `<project_cwd>/.arena/timeline-<meetingId>-archive.md`（追加模式）
- 摘要轮永远保留，不滚动

### 9.4 写入触发

- 每次 `turn-complete` 后系统侧调用 `roundtable-timeline.writeTurn(meetingId, turnRecord)`
- 写入失败仅 console.warn，不阻塞主流程

### 9.5 写入内容来源

- 直接用 `turnRecord.byMap`（即 orchestrator 已存的 by[sid] 文本）
- 不调 AI 二次提炼（保持原汁原味）

---

## 10. 摘要按钮设计

### 10.1 触发流程

```
用户在 UI 点「摘要」按钮
   ↓
renderer 发 IPC roundtable:summary-trigger { meetingId }
   ↓
main.js 后端：
   - 取 meeting.subSessions 和 lastTurn
   - 识别 lastTurn 的发言者集合（lastSpeakers）
   - 检查 lastTurn.mode == 'summary-brief' → 拒绝（已是摘要，不能套娃）
   - 检查 lastTurn 不存在 → 拒绝（无可摘要）
   - 对每个 lastSpeaker sid，构造摘要 prompt（按 §7.2 模板）
   - 并行通过 PTY stdin 发给每个 lastSpeaker
   ↓
等所有 lastSpeaker turn-complete
   ↓
orchestrator.completeTurn(... mode='summary-brief')  ← 新增 mode 值
   ↓
timeline.writeTurn(... 标记为「摘要轮」)
   ↓
通知 renderer：摘要轮完成 + 下一轮按钮恢复可用
```

### 10.2 摘要 prompt 完整模板（系统侧给 lastSpeaker 的）

见 §7.2。

### 10.3 浓缩范围 = 「自上次摘要轮 / 会议起始 之后到现在的所有该 AI 参与的发言」

如果 AI X 在第 3, 4, 5, 7 轮发言（其中第 6 轮是上一次摘要轮），现在第 8 轮触发摘要：
- AI X 浓缩范围 = 第 7 轮（仅最近一次摘要后的发言）
- 如果 AI X 在第 6 轮也参与了摘要，浓缩从第 7 轮开始

### 10.4 多家并发还是单家

- **lastTurn 是 fanout/debate（all 模式）**：lastSpeakers = 三家，三家**并发摘要**（输出 3 段五元组写入同一个摘要轮）
- **lastTurn 是 pilot**：lastSpeakers = 主驾一家，仅主驾摘要
- **lastTurn 是 observer**：lastSpeakers = 副驾两家，两家并发摘要

### 10.5 UI disable 规则

摘要按钮在以下情况 disable：
- `lastTurn === null`（首轮，无可摘要）
- `lastTurn.mode === 'summary-brief'`（已是摘要轮，不允许套娃）
- 圆桌正在 dispatch（_roundtableInProgress.has(meetingId)）

---

## 11. 切模式 Toast 设计

### 11.1 触发条件

用户在 UI 切换 dispatchMode 时检测：

```
触发劝摘要 toast 条件：
  1. 上一轮存在
  2. 上一轮 mode 不是 summary-brief
  3. dispatchMode 切换是「pilot ↔ observer」或「pilot/observer → all」
  4. 用户未 dismiss 永久
```

### 11.2 Toast 文案

```
[标题] 建议先点「摘要」再切换
[正文] 这样副驾收到的是浓缩的五元组而非主驾全部历史，协作更聚焦。
[按钮 1] 我去摘要（关闭 toast，dispatchMode 切换暂不执行 — 用户去点摘要按钮）
[按钮 2] 直接切换（继续切换 dispatchMode）
[按钮 3] 不再提醒（持久化 dismiss + 直接切换）
```

### 11.3 Dismiss 持久化

- 写入 `localStorage.setItem('hub.roundtable.toast.summarize-on-mode-switch', 'dismissed')`
- 加载时检查，已 dismiss 则跳过 toast 直接切

---

## 12. 场景适配

| Scene | L1 | L2 公约 |
|---|---|---|
| `general` | 极简 BASE_RULES | `COVENANT_GENERAL`（用户可在 UI 编辑） |
| `research` | 极简 BASE_RULES | `COVENANT_GENERAL` + `COVENANT_RESEARCH`（投资风格 / 红线 / 数据获取） |

`COVENANT_RESEARCH` 内容不变，仍是当前的投资公约文本。

---

## 13. Data Flow

### 13.1 创建会议室时

```
用户在 UI 创建会议室 → 选 scene → 选 3 家 AI
   ↓
main.js 调 buildSystemPrompt(sceneKey, covenantText)  ← 拼 L1 + L2
   ↓
写入 <hubDataDir>/arena-prompts/<meetingId>-prompt.md
   ↓
启动每个子 session → 通过 system prompt 通道注入上述文件路径
   - Claude/DeepSeek/GLM: --append-system-prompt-file
   - Codex: -c model_instructions_file
   - Gemini: GEMINI_SYSTEM_MD env
```

### 13.2 每轮发送

```
用户在圆桌发言 / 点击命令
   ↓
renderer 发 IPC roundtable:dispatch-turn { mode, userInput, dispatchMode }
   ↓
main.js dispatchRoundtableTurn:
   - 获取 lastTurn
   - 计算 targetSubs（按 dispatchMode 过滤）
   - 调 computeLastTurnInjection(lastTurn, targetSubs, dispatchMode) → injectMap
   - 调 buildXxxPrompt(turnNum, userInput, sceneObj, dispatchSpec, injectMap[sid], timelinePath)
     × 每个 target 一个 prompt
   - 并行通过 PTY stdin 发送
   ↓
等所有 target turn-complete
   ↓
orchestrator.completeTurn(...)
   ↓
roundtable-timeline.writeTurn(meetingId, turnRecord, projectCwd)
   - 写入 / 滚动
   ↓
通知 renderer 状态更新
```

### 13.3 摘要按钮触发

见 §10.1。

### 13.4 切 dispatchMode

```
用户在 UI 切 dispatchMode
   ↓
renderer 检查 toast 触发条件 → 弹 toast / 直接切
   ↓
若直接切：发 IPC roundtable:dispatch-mode-set { meetingId, dispatchMode }（既有 IPC，无改动）
   ↓
main.js 持久化 dispatchMode → 通知 renderer
```

---

## 14. Error Handling / Degradation

| 故障 | 行为 |
|---|---|
| `timeline.md` 写入失败（磁盘满 / 权限） | console.warn，不阻塞主流程；下一轮仍尝试写 |
| `<project_cwd>` 解析不到（无主驾且无活跃 session） | 退到 `<hubDataDir>/timelines/<meetingId>-timeline.md` |
| AI 不主动 Read timeline | 暂时无补救，依赖 prompt 内嵌索引 nudge；上线观察 1-2 周决定是否加强 |
| 摘要 AI 输出格式不符五元组 | 仍当 plain text 写入 timeline，不强制再生 |
| L2 公约文件缺失 | 仅 L1 注入（buildSystemPrompt 现有兜底） |
| `lastTurn` 为 null 但用户点摘要按钮 | UI 已 disable，后端再校验拒绝（防绕过） |
| 上一轮发言者全部 dormant（已被关闭） | 摘要 trigger 跳过该 sid，仅活跃的 sid 摘要 |

---

## 15. Testing 策略

### 15.1 Unit Tests

| 测试套 | 覆盖 |
|---|---|
| `unit-roundtable-injection-matrix.test.js` | §8.1 矩阵 11 行规则各一个 case |
| `unit-roundtable-timeline.test.js` | 写入 / 滚动 / archive |
| `unit-roundtable-summary-brief.test.js` | 摘要 prompt 拼装 / 浓缩范围识别 |
| `unit-roundtable-scenes.test.js`（既有，需扩展） | L1 + L2 拼接顺序 / `COVENANT_GENERAL` 与 `COVENANT_RESEARCH` 拼接 |

### 15.2 Integration Tests

| 测试套 | 覆盖 |
|---|---|
| `integration-roundtable-context-flow.test.js` | 完整一轮 dispatch → timeline 写入 → 下一轮注入读 timeline |
| `integration-roundtable-summary-flow.test.js` | 触发摘要 → AI 输出 → timeline 标记摘要 → 下一轮注入摘要 |

### 15.3 E2E Tests（隔离 Hub 实例 + 真实 PTY）

| 场景 | 步骤 |
|---|---|
| E1 主驾深聊→摘要→切副驾审查 | 用 Gemini/Codex 替代 Claude（节约配额）跑完整工作流，验证副驾收到摘要 |
| E2 同组跳过 | pilot 模式连续两轮主驾发言，验证 prompt 没有「上一轮」段 |
| E3 timeline 滚动 | 跑 12 轮非摘要 + 2 轮摘要，验证 timeline 留近 10 非摘要 + 全部摘要 |

---

## 16. Milestones

| M# | 范围 | 估时 |
|---|---|---|
| **M1** | L1 简化 + L2 默认模板 + buildSystemPrompt 调整 | 0.5 天 |
| **M2** | L3 模板重构 + 上一轮注入矩阵 + timeline.md 自动维护 | 1.5 - 2 天 |
| **M3** | 摘要按钮 + 五元组 prompt + UI | 1 - 1.5 天 |
| **M4** | 切模式 toast + 上线观察 nudge 调优 | 0.5 天 + 持续观察 |

总计 **3.5 - 4.5 工作日**。

每个 milestone 之间允许暂停，用户审批后再进入下一 milestone。

---

## 17. References

- 方案 F 终稿：`docs/2026-05-02-roundtable-context-plan-F-final.html`
- 方案 F 评审版：`docs/2026-05-02-roundtable-context-plan-F.html`
- 5 个备选方案对比：`docs/2026-05-02-roundtable-prompt-context-design.html`
- 当前实现关键文件：`core/roundtable-orchestrator.js` / `core/roundtable-scenes.js` / `main.js dispatchRoundtableTurn`
- 设计灵感：clowder-ai (cat-cafe) LSM Compaction · AI Town reflection · cat-cafe Cross-cat Handoff（部分借鉴）
