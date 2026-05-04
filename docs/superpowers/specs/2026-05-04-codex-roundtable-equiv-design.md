# Codex 圆桌等价适配 · Design Spec

**日期**：2026-05-04
**作者**：⚡ Pikachu（圆桌综合）
**圆桌历史**：`C:\Users\lintian\.arena\timeline-3a6133e9-cdb4-4559-9f31-f1157d1db668.md`

---

## 一、背景

圆桌功能起初一次性支持 Claude / Gemini / Codex 三家 CLI，因差异过大踩坑严重，退守先做好 Claude 适配。Claude 链路目前已稳定（含逃生按钮、resend、manual-extract 三态等机制）。本轮目标：**让 Codex 作为稳定 AI 角色加入圆桌**，与 Claude 等价。

本轮**不考虑** Gemini CLI。

---

## 二、目标

**圆桌卡片的核心交互能力与异常恢复体验，Codex 与 Claude 无可感知差异。**

> 说明：原表述"用户体感无可感知差异"已收紧（吸收 Squirtle）。标题刷新频率、CLI 内部术语、loading 节奏等细微差异不强制追平，但**核心交互（创建/发送/拉取/恢复/逃生）和异常恢复体验**必须等价。

代码可分叉（codex 可独立写一套），UI/交互不可。

---

## 三、原则

1. Spec 写**用户可见行为**，不写实现偏好
2. **测试先于修复，fixture 先于测试**
3. Codex 允许分叉实现，**卡片语义必须统一**
4. 未验证的优化项不得抢在核心闭环前落地

---

## 四、BDD Specs

### S1 · 发送可确认 + 逃生反馈闭环

**Given** 已创建 codex 圆桌
**When** 圆桌向该会话发送 prompt
**Then** 卡片依次进入 `sending` → `ok` / `auto_recovered`（≤ T0 录到的 P95 + 50% margin）/ `stuck`（超时）
**And** `stuck` 时 UI 暴露逃生工具栏（具体按钮见现状清单）
**And** 用户点击任一按钮后，**卡片必须进入新的可观察状态**（如 `resending` / `extracting`），不允许仅触发后台动作而无 UI 反馈（吸收 Squirtle）

> **命名约束**：`sendStatus` 沿用现有命名空间 `{ok, auto_recovered, stuck}`（2026-05-03 Resend & Auto-Recovery batch 已落地），本轮**新增进态 `sending`** 作为发出后等 echo 期间的过渡值。Spec 中"ack"语义即现状的 `ok`/`auto_recovered`。
>
> **逃生工具栏现状（截至本 Spec）**：底部 `🔄 重新拉起 / 📤 发送 / 一键提取 / 跳过` 四按钮 + 卡片头部 `🔧 进 shell`。本轮**不重新设计 UI**，仅按 S1 要求**给现有按钮补可观察反馈状态**。
>
> 数值阈值（≤2s）来自 T0 fixture 实测，Phase 0 完成后写入。

---

### S2 · 拉取可区分阶段

**Given** 用户点击一键拉取
**When** codex transcript 处于不同阶段
**Then** 返回必含 `extractMode` ∈ `{final_answer, partial_commentary, no_task_complete_yet, no_rollout_bound}`
**And** UI 按 extractMode 显示分级 hint，不再笼统报"提取失败"

| extractMode | UI hint | 现状判据（实施时按此映射）|
|---|---|---|
| `final_answer` | （正常显示内容） | 现 `source = manual_codex_rollout`（rollout 末尾命中 `task_complete.last_agent_message`） |
| `partial_commentary` | "这是中间答复，等几秒重试可拿最终版" | 现 `source = manual_codex_rollout_streaming`（无 task_complete，降级拼 agent_message） |
| `no_task_complete_yet` | "Codex 仍在思考中，task_complete 未到达" | rollout 已绑定但 agent_message 全为空（罕见，think-only 阶段） |
| `no_rollout_bound` | "会话还没绑定 sid，请稍候（一般 2-5s）" | `_bound.get(hubSessionId).rolloutPath` 不存在 |

> **命名约束**：现有 `roundtable-manual-extract` IPC 已使用 `mode ∈ {watcher_settle, patch_last_turn, text_only}` 表示 IPC 应用上下文（卡片接下来怎么处理）。本 Spec 引入的内容分级语义**必须用新字段名 `extractMode`**，禁止复用 `mode`，避免 renderer 现有引用（`renderer/meeting-room.js:927` 起的 `r.mode/r.source` 链）被语义覆盖。
>
> **既有 `source` 字段保留不动**：现已有 `manual_codex_rollout`（task_complete）/ `manual_codex_rollout_streaming`（streaming）两值，作为 `extractMode` 的内部判据来源；UI 展示走 `extractMode`，调试 / 日志走 `source`。

---

### S3 · 拉取幂等

**Given** 自动拉取 / 手动拉取 / 结束态补拉可能同时发生
**When** 它们针对同一 turn 多次执行
**Then** 不重复追加消息
**And** 不把 `partial_commentary` 覆盖错 `final_answer`
**And** `final_answer` 到达后正确收口

---

### S4 · sid 异步绑定可见 + 等待期交互策略

**Given** 会话已 spawn 但 rollout 未绑定
**When** 用户发送或拉取
**Then** UI 显示"等待绑定"角标，不报笼统失败
**And** 绑定完成后状态自动切换
**And** 超时（默认 15s，可配）抛 `BindTimeout`

**等待绑定期间允许的用户动作**（吸收 Squirtle）：
- ✅ 取消会话
- ✅ 重试 bind（重新 scan rollout 目录）
- ❌ 发送 prompt（必须等 bind 完成或 timeout 后再决策）
- ❌ 一键拉取（无 rollout 路径，必失败）

`BindTimeout` 后允许的动作：fresh pull（重启 codex spawn）/ 取消会话。

---

### S5 · 恢复链路三档降级

**Given** 用户恢复 codex 角色
**When** 精确 sid 恢复失败
**Then** 自动降级链：
1. `codex resume <sid>`
2. `codex resume --last`
3. **fresh session + 注入最近 N=3 轮 summary 文本**作为 context

**And** 卡片角标显示当前用了哪档（`from_sid` / `from_last` / `from_fresh+ctx`）

> 第 3 档"context"明确定义为：从 meeting 历史读最近 3 轮 summary（若不足 3 轮则全部），拼接成一段引导文本，spawn 后通过首次 prompt 注入。不是历史 turn 全文回灌，避免 token 爆炸。
>
> **⚠ Phase 3 前必须确认 codex CLI 注入方式**：现状未确认 codex 是否支持 `--initial-prompt` 类参数；若不支持，回退方案是 PTY paste（需评估超长文本是否触发 OSC 闪屏 / 自动换行截断）。两种路径在 Phase 3 的 fixture 阶段（B3.0，新增）实测后再决定 B3.6 的实现。

---

### S6 · 多轮一致性（拆四条）

#### S6a · fanout
**Given** fanout 模式
**When** codex 输出 commentary、tool 调用、中间态、final
**Then** 只有满足完成条件（task_complete + 3s debounce）才标 turn complete
**And** Claude+codex 混合 fanout 时，**任一方慢/快不阻塞另一方卡片本地状态更新**（吸收 Squirtle）

#### S6b · summary
**Given** summary 模式
**Then** summary 提取使用 `final_answer`，不使用 `partial_commentary`
**And** 摘要五元组解析能从 codex final agent_message 正确切分

#### S6c · observer
**Given** observer 模式
**Then** 静音 codex 不接收 prompt，但 transcript 仍正常落盘可被后续轮 resume

#### S6d · pilot
**Given** pilot 模式
**Then** codex 作为副驾时，主驾完成后注入主驾五元组作为本轮上下文

---

### S7 · 非回归

**Given** 现有 Claude / DeepSeek / GLM / Gemini 圆桌链路
**When** 本次改造完成后跑既有 E2E
**Then** 全部保持绿色，无回归

---

## 五、Out of Scope

| 项 | 决策 | 理由 |
|---|---|---|
| Stop hook | 不做 | codex CLI 无对等机制；UI 占位 `—` |
| statusline | 不做 | 同上 |
| 动态 debounce env var | 不做 | 过度设计 |
| paste-delay 默认值 | 暂不做 | T0 fixture 未证明丢字符前不加 |
| OSC title | 暂不纳入 P0/P1 | T0 采样后若证据充分可补做（吸收 Squirtle） |

---

## 六、量化验收指标（吸收 Charmander）

| 指标 | 目标 |
|---|---|
| sendStatus 转换延迟（sending→ack/stuck） | ≤ T0 P95 + 50% margin（数值待 Phase 0 填） |
| manual-extract IPC 响应延迟 | ≤ 500ms |
| resume 降级成功率 | 100%（三档必有一档成功）|
| E2E 单场景通过率 | 100%（5 场景全绿） |
| 混合 fanout 卡片状态序列一致率 | 100% |
| codex 回归 Claude/DeepSeek/GLM E2E | 100% 全绿 |

---

## 七、完成定义（4 维）

1. **单元测试**：S1-S7 对应测试全绿
2. **集成测试**：发送 / 拉取 / 恢复三大链路全绿
3. **真实 E2E**：5 场景在隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR`）+ Playwright CDP + PID 白名单 before/after diff 下全绿
4. **用户体感验收**：用户在隔离 Hub 跑指定脚本，按 checklist 逐项打勾，差异点全部归零或被显式接受

---

## 八、引用

- 圆桌历史：`C:\Users\lintian\.arena\timeline-3a6133e9-cdb4-4559-9f31-f1157d1db668.md`
- 项目铁律：`C:\Users\lintian\claude-session-hub\CLAUDE.md`
- SDD 范式：`feedback_subagent_sdd_flow.md` / `feedback_sdd_no_midbatch_confirm.md`
- E2E 真实性：`feedback_e2e_real_user.md` / `feedback_e2e_pid_whitelist.md`
- Hub 隔离：`feedback_hub_rules.md` / `feedback_hub_isolation_env_pitfall.md`
