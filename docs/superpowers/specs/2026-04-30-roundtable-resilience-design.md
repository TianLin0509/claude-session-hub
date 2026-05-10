# 圆桌讨论容错机制升级 — 三层信号 + 软提醒 + 手动提取

**日期**: 2026-04-30
**状态**: 已确认（用户立花道雪 brainstorm 通过）
**可视化参考**: `docs/roundtable-resilience-2026-04-30.html`

---

## 背景

通用圆桌（Roundtable）实测出现卡死场景：

- Claude / Codex 已答 ✓
- Gemini 终端面板里能看到完整文本（"下午好！很高兴加入今天的圆桌讨论…"）
- Gemini CLI 已回到输入提示符状态
- 但 UI 永远显示 Gemini "思考中"
- `@debate` / `@summary` / 群策群力 全部 disabled
- 整个圆桌锁死 10 分钟（直到 watchdog timeout 返回空文本）

用户预期：单家 AI 慢响应或异常时，圆桌仍可推进，并提供逃生通道。

## 根因（已查证）

三家 AI 在 Hub 中的 turn-complete 检测机制可靠性差异显著：

| CLI | 触发机制 | 语义层级 | 可靠性 |
|---|---|---|---|
| Claude | HTTP Hook `/api/hook/stop` 主动通知 | 协议事件 | ★★★★★ |
| Codex | rollout JSONL 的 `event_msg.payload.type=="task_complete"` | 协议事件（多 turn 时可能误判） | ★★★★ |
| Gemini | session JSONL 行携带 `tokens.total != null` | 启发式字段（实现细节） | ★★ |

**根因**: Gemini 的 `tokens.total` 是 Gemini CLI 的实现细节，慢响应、限流降级、多 turn 工具调用等场景下可能滞后或永不写入。`turn-complete` 事件不发，watchdog 默认 600000ms（10 min），其间 `Promise.all` pending，orchestrator 不退出 inProgress，所有推进按钮被 `(turns.length < 1 || inProgress)` 条件锁死。

**关键发现**: Gemini CLI Headless 模式（`--output-format stream-json`）有官方的 `type:"result"` 事件，是文档化的 final outcome 标记，等价于 Codex 的 `task_complete` 和 Claude 的 hook。当前 Hub 没用上是因为 spawn 方式不是 headless。

## 设计原则

1. **语义事件 (L1) > 传输完成 (L2) > 启发式 (L3)** — 三层完成信号优先级永不颠倒
2. **L3 永不强制终结** — 任何"沉默推断"（N 秒空闲 / token 计数）只触发软提醒，不掐断 AI
3. **任何家失败不阻塞整体推进** — Promise.all → Promise.allSettled，单家 timeout 不影响其他家继续
4. **逃生通道始终可用** — 用户可在任何时刻手动提取 / 跳过 / 重发，不必等 watchdog
5. **手动提取从 transcript 直读** — 共用自动检测的数据源，不抓 PTY 不让用户粘贴

## 设计

### 1. 三层完成信号模型

#### L1（协议级语义事件）

每家 AI 至少有一个 L1 信号，触发后立即 emit `turn-complete`：

| AI | L1 信号 | 实现状态 |
|---|---|---|
| Claude | `/api/hook/stop` 路由收到 stop hook | 已实现 ✓ |
| Codex | rollout JSONL 出现 `event_msg.task_complete` | 已实现 ✓（P2 加固多 turn） |
| Gemini | session JSONL 出现 `type:"result"` 行 | **P0 新增** |
| Gemini | session JSONL 出现 `message_update` 终结行 | **P0 新增 fallback** |

#### L2（传输/进程完成）

PTY 子进程退出事件，作为 L1 的补充：

- 正常退出（exit code 0）→ 视为 completed（如尚未触发 L1 则补一个 turn-complete）
- 异常退出（非 0 退出码 / SIGKILL）→ 视为 errored
- PTY 通道断开但进程仍在 → 视为 transport_lost

#### L3（启发式 / 软提醒）

仅用于触发软提醒 banner，**绝不强制终结**：

- 现有 `tokens.total` 检测保留为 L3 信号（不是终结依据）
- N 秒（90s 主提醒、180s 二次提醒）无 L1/L2 触发 → 闪 banner，等用户操作
- 用户不操作就一直等下去

### 2. Gemini L1 接入策略

| 方案 | 描述 | 评级 |
|---|---|---|
| A. 圆桌专属 spawn 模式：headless `--output-format stream-json` | 失去 TUI 彩色界面，但圆桌本来不需要 | **P0 主路径** |
| B. TUI 模式下监听 `type:"result"` / `message_update` 终结行 | v0.40+ 新格式 | **P0 fallback** |
| C. 接入 Gemini `--acp` 模式（JSON-RPC over stdio） | 重写 spawn + 通信层 | P3 长线 |

P0 同时实施 A + B：圆桌专属 spawner 优先用 headless（A），但 transcript-tap.js 也升级支持新行类型识别（B），两条路径互为冗余。

### 3. 软提醒（替代强制 watchdog）

废除 `TURN_WATCHDOG_MS = 600000` 的强制 timeout 路径。改为：

- **90s 节点**：闪非阻塞 banner — "Gemini 已 90s 未确认结束 — 可能正在深度推理；如已看到完整回答，可手动提取。" + 三按钮 [一键提取] [再等 60s] [跳过本家]
- **180s 节点**：banner 更醒目（红边），文案升级为"Gemini 长时间未应答，建议手动检查 transcript"
- **永不自动 settle**：除非 L1/L2 触发，或用户显式点击「跳过」/「手动提取」

### 4. 手动提取（从 transcript 直读）

按钮入口：每家 AI 卡片底部「逃生工具栏」+ 软提醒 banner 的 [一键提取]。

逻辑：
1. 读 Gemini 当前 session 的 JSONL 文件（路径由 `transcript-tap.js` 已建立的绑定提供）
2. 取从「最近一次主进程发送 prompt 时间戳」之后的所有 `type:"gemini"` 行的 `content` 字段拼接
3. 不要求 `tokens.total`、不要求 `type:"result"` — 只要有 text 就拼接
4. 拼接结果作为本轮回答，状态切 `manual_extracted`，UI 加蓝色「手动」角标
5. emit 同样的 `turn-complete` 事件（带 `source: 'manual'` 标记），下游 Promise.allSettled settle

### 5. Promise.allSettled 改造

`main.js:676-684` 当前：
```js
const results = await Promise.all(sentTargets.map(t =>
  _rtWaitTurnComplete(t.sid, t.label, roundtable.TURN_WATCHDOG_MS, ...)
));
```

改造为 `Promise.allSettled` + 独立 settle 信号源：

```js
// 每家独立等待 L1/L2/manual 信号，互不阻塞
const results = await Promise.allSettled(sentTargets.map(t =>
  _rtWaitTurnCompleteV2(t.sid, t.label, {
    onSoftAlert: (level) => sendToRenderer('roundtable-soft-alert', { sid, level }),
    onManualExtract: (text) => { /* 见 §4 */ },
    onSkip: () => ({ status: 'absent', text: '' }),
  })
));
```

orchestrator 退出 inProgress 的条件：所有 sentTargets 都 settle（含 absent / manual_extracted / completed / errored），不再被任何一家无限拖死。

### 6. 推进按钮 disabled 条件改写

`renderer/meeting-room.js:1243` 当前：

```js
const debateDisabled = (turns < 1 || inProgress) ? 'disabled' : '';
```

改造为：

```js
// inProgress 但有 absent 家或所有家已 settle → 仍可推进
const allSettled = participants.every(p => p.state === 'completed' || p.state === 'manual_extracted' || p.state === 'absent' || p.state === 'errored');
const debateDisabled = (turns < 1 || (inProgress && !allSettled)) ? 'disabled' : '';
```

效果：单家卡死不再阻塞全场，下游模式按钮始终可点。

### 7. 状态机扩展

从 4 态（idle/thinking/completed/timeout）扩展为 8 态：

| 状态 | 触发 | UI 表现 |
|---|---|---|
| `idle` | 未发送 | 「待命」灰 |
| `submitted` | 已发送，未见首 token | 「思考中」+ 进度条 |
| `streaming` | 正在产出 token | 「输出中」+ 实时预览 |
| `tool_running` | 调用工具中 | 「调用工具」+ 工具名 |
| `soft_alert` | L3 兜底触发 | 「等待中 (90s+)」黄字 + banner |
| `completed` | L1/L2 触发 | 「已答 ✓」绿 |
| `manual_extracted` | 用户手动提取成功 | 「已答 ✓ · 手动」蓝角标 |
| `absent` | 用户跳过本轮 | 「本轮缺席」灰角标 |
| `errored` | 子进程报错或限流 | 「错误」红字 |
| `interrupted` | Ctrl+C / 取消 | 「已中断」灰 |
| `transport_lost` | PTY 断开但无语义结束 | 「连接断开」红字 + 重发按钮 |

`renderer/meeting-room.js:194` 的 `statusLabel` 字典需要扩展。

### 8. Codex 多 turn 加固（P2）

Codex 自己确认（见参考文献 #4）：`task_complete` 是 turn-complete 不是 task-complete，多 turn agent loop 时第一个 turn 完就触发会误判。

加固逻辑（`transcript-tap.js:388-401` 附近）：

```js
if (obj.payload.type === 'task_complete') {
  const text = obj.payload.last_agent_message?.trim();
  if (!text) {
    // issue #13769: last_agent_message:null 视为 errored
    this.emit('turn-error', { hubSessionId, reason: 'empty_completion' });
    return;
  }
  // 暂存，等 3s 看是否有新 turn 起始
  scheduleConfirm(hubSessionId, text, 3000);
}
```

3 秒内如果没有新 `event_msg` 行（特别是 `turn_start`），才确认 turn-complete。

### 9. UI 改动汇总

#### 每家 AI 卡片（`renderer/meeting-room.js:220-235`）

新增 row4「逃生工具栏」（仅在 `submitted` / `streaming` / `tool_running` / `soft_alert` 状态显示）：

```
┌────────────────────────────────────────┐
│ Gemini  [等待中 92s · L3]              │
│ Gemini 3.1 Pro                          │
│ ▓▓▓▓▓▓▓░░░░░ (progress)                │
│ [📋 手动提取] [📄 transcript] [⏭跳过] [🔄 重发] │
└────────────────────────────────────────┘
```

#### 圆桌主区域顶部（首次进入 soft_alert 时）

非阻塞 banner（可关闭）：
```
⏱ Gemini 已 92s 未确认结束 — 可能正在深度推理；如已看到完整回答，可手动提取。
                                              [一键提取] [再等 60s] [跳过本家]
```

#### 推进按钮区（`renderer/meeting-room.js:1243-1269`）

按钮永远可点（除非真的没有任何 turn）；旁边加「⚠ Gemini 缺席」小字提醒。

#### 历史轮次面板（`renderer/meeting-room.js:237-255`）

每轮显示三家最终状态角标：`[Claude ✓][Gemini 手动][Codex ✓]` 或 `[Claude ✓][Gemini 缺席][Codex ✓]`。

## 实施分期

**P0** — 根因修复 + 用户逃生（2-3 天，本次 plan 主体）：
- §2-A/B Gemini L1 接入
- §3 软提醒（废除 600s watchdog）
- §4 手动提取
- §5 Promise.allSettled 改造
- §6 推进按钮判定改写
- §9 UI 改动（逃生工具栏 + banner + 缺席角标）

**P1** — 状态机重构 + L2 信号补充（1-2 天）：
- §7 8 态完整模型
- L2 信号：监听 PTY 进程退出
- 历史轮次面板状态展示

**P2** — Codex 多 turn 加固（1 天）：
- §8

**P3** — 协议级 IPC（5-7 天，长线）：
- Gemini `--acp` 模式
- Codex `app-server` JSON-RPC
- 抽象 `ProviderTransport` 接口

## 风险与回退

| 风险 | 影响面 | 缓解 | 回退 |
|---|---|---|---|
| Gemini headless 不支持当前 spawn 参数 | P0 §2-A 接入失败 | 用 §2-B fallback 兜底；分两批 PR | 仅保留 §2-B |
| Promise.allSettled 影响其他流程 | 所有圆桌模式 | 引入 `orchestrator-v2` 新文件 + feature flag | flag 关掉走老逻辑 |
| 手动提取拼到上一轮残留 | 用户看到错答案 | 必须以「最近一次主进程发送 prompt 时间戳」为分界 + 单元测试 | 提取后弹二次确认 |
| 跳过家在下游 prompt 中产生空引用 | debate / summary 输出错乱 | 统一在 prompt builder 过滤 absent 家 + E2E 测试 | 禁止跳过最后一家 |
| node_modules 半坏（项目铁律） | Hub 启动失败 | 遵循 `CLAUDE.md`：dist 走独立 worktree、改完 smoke test | `npm install` 重对齐 |

## 测试要求

E2E 测试必须通过真实 Hub 实例 + CDP 驱动，覆盖以下场景：

1. **正常路径**：三家正常返回，全部 completed
2. **Gemini 慢响应（30s）**：在 90s 节点之前自然完成（通过 §2 新增 L1 信号），不触发 banner
3. **Gemini 假死（mock 不返回 result）**：90s 触发 banner，用户点「一键提取」后状态切 manual_extracted，下游推进按钮可点
4. **Gemini 跳过**：用户点「跳过本家」，状态切 absent，debate prompt 不引用 Gemini 内容
5. **Codex 多 turn**：模拟 Codex 在第一个 turn 后立即写 `task_complete`，3s 内又起新 turn，验证 turn-complete 不被误触
6. **三家全错**：所有家 errored，圆桌进入 errored-all 兜底（让用户重新发送整轮）

E2E 测试 fixture 严格遵循 `CLAUDE.md` 的「并行测试 Hub 实例」规则：`CLAUDE_HUB_DATA_DIR` env 隔离 + junction 复用 node_modules，禁止 `npm install` 副本。

## 参考文献

1. [Gemini CLI Headless Mode docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) — `stream-json` 输出格式与 `type:"result"` 事件
2. [Gemini CLI ACP Mode docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) — JSON-RPC 协议接入
3. [Gemini CLI Issue #15292](https://github.com/google-gemini/gemini-cli/issues/15292) — JSONL session storage 实现讨论
4. [Codex protocol_v1.md](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md) — TurnComplete / task_complete 别名与多 turn 模型
5. [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — JSON-RPC 接入方式
6. [Codex Issue #13769](https://github.com/openai/codex/issues/13769) — `last_agent_message:null` 边界情况
7. [Codex Issue #17487](https://github.com/openai/codex/issues/17487) — replay/resume 时陈旧 final-message 状态 bug

## 本项目关键文件锚点

- `core/transcript-tap.js:520-606` — Gemini JSONL tail 与 turn-complete 触发
- `core/transcript-tap.js:388-401` — Codex task_complete 监听
- `core/transcript-tap.js:141-157` — Claude hook stop 处理
- `core/roundtable-orchestrator.js:21` — `TURN_WATCHDOG_MS` 配置（待废除）
- `main.js:564-589` — `_rtWaitTurnComplete` 状态转换（待重构为 v2）
- `main.js:676-684` — `Promise.all` 阻塞点（核心改造点）
- `main.js:1444` — Claude hook stop 路由
- `renderer/meeting-room.js:160-218` — AI 卡片渲染（加逃生工具栏）
- `renderer/meeting-room.js:194` — `statusLabel` 字典（扩展为 8 态）
- `renderer/meeting-room.js:1243-1269` — 推进按钮 disabled 判定（核心改造点）
