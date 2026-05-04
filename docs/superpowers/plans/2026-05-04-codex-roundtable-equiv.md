# Codex 圆桌等价适配 · TDD Plan

**对应 Spec**：`docs/superpowers/specs/2026-05-04-codex-roundtable-equiv-design.md`
**日期**：2026-05-04
**作者**：⚡ Pikachu（圆桌综合）

---

## 一、总体策略

Phase 0 fixture → Phase 1/2 unit 层并行 + UI 层串行（Phase 2.5）→ Phase 3/4 串行 → Phase 5 按证据决定。

**SDD 范式约定**：
- 连续 dispatch，不中途确认（`feedback_sdd_no_midbatch_confirm`）
- E2E 必须真实 Hub + CDP + PID 白名单 before/after diff（`feedback_e2e_pid_whitelist`）
- 全 Claude 串行；A/B 双链可由 Codex/GLM/DeepSeek 跑（避免 Claude 并发约束）
- 完成前跑 `/post-refactor-verify`

**回退策略**：直接重构现有 codex 链路（不引入 feature flag）。理由：现状 codex 链路本就未跑通（Spec 自承），保留双路径 6-7d 实操成本高于 git revert，且 flag 化会让 fixture 与回归测试矩阵翻倍。出大事走 `git revert <commit-range>` 即可。

---

## 二、Phase 0 · Fixture + 真实样本采集（1d）

**不改业务代码。fixture 是主产物，文档是副产物。**（吸收 Squirtle）

### 任务

- **B0.1** 启动隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR=C:\temp\hub-codex-fixture`），新建 codex 单家圆桌
- **B0.2** 跑 3 类真实 prompt（短 / 中 / 长任务），全程录：
  - PTY raw bytes
  - rollout JSONL 实时增量
  - 所有 `roundtable-*` IPC payload
  - UI 状态变迁时间线
- **B0.3** 故意制造 stuck 场景（mid-task 切网/切代理）录"无 ack"信号
- **B0.4** 落盘到 fixture 目录
- **B0.5** 建 fake harness（fake PTY / fake rollout writer / fake IPC harness）
- **B0.6** ~~加 `CODEX_EQUIV_V2` feature flag 脚手架~~ → **v2 删除**（改为直接重构 + git revert 回退，理由见上）

### 产出物清单（必须全部完成才能进 Phase 1/2，吸收 Charmander）

```
tests/fixtures/codex-signals/
  ├── pty-ack-success.bin
  ├── pty-stuck-no-ack.bin
  ├── rollout-with-task-complete.jsonl
  ├── rollout-only-commentary.jsonl
  ├── rollout-no-bind.empty
  └── ipc-timeline.json

tests/helpers/
  ├── fake-codex-pty.js
  ├── fake-codex-rollout.js
  └── fake-codex-ipc-harness.js

docs/codex-signals.md  # 人类速查表（副产物）
```

### Fixture 元数据

每个 fixture 文件头部记录：
- codex CLI 版本号
- 录制日期
- 场景描述

便于 codex 升级后用 `npm run refresh-codex-fixtures` 脚本重录。

---

## 三、Phase 1 · 拉取闭环（1.5d，与 Phase 2 unit 层可并行）

**对应 Spec**：S2 + S3
**实现可并行 Phase 2，验收顺序建议先 Phase 1 后 Phase 2**（吸收 Squirtle：拉取链路是当前最直接的用户止损手段）

### 现状盘点（v2 新增）

- `core/transcript-tap.js:506-544` 现 `CodexTap.extractLatestTurn` **已返回 `{text, source}`**：
  - `source = manual_codex_rollout` ← rollout 末尾命中 `task_complete.last_agent_message`
  - `source = manual_codex_rollout_streaming` ← 降级拼 `agent_message`（无 task_complete）
- `main.js:1773` 现 `roundtable-manual-extract` IPC **已用 `mode` 字段**承载 IPC 上下文：`{watcher_settle, patch_last_turn, text_only}`
- `renderer/meeting-room.js:927` **已读 `r.mode/r.source`**

### v2 命名约束

- 内容分级字段必须叫 **`extractMode`**，禁止复用 IPC 上下文 `mode`
- `extractMode → source` 映射（实施时按此判据）：

| extractMode | source 现状 | 判据 |
|---|---|---|
| `final_answer` | `manual_codex_rollout` | task_complete 命中 |
| `partial_commentary` | `manual_codex_rollout_streaming` | streaming 拼接 |
| `no_task_complete_yet` | `null`（新增分支）| rollout 已绑定但 agent_message 全空 |
| `no_rollout_bound` | `null`（新增分支）| `_bound.get(...).rolloutPath` 不存在 |

### Batch

| ID | 类型 | 文件 | 内容 |
|---|---|---|---|
| B1.1 | 🔴 RED | `tests/unit-codex-extract-tristate.test.js` | 喂 4 种 rollout fixture → 期望 `extractMode` 正确（4 值全覆盖） |
| B1.2 | 🟢 GREEN | `core/transcript-tap.js` | **追加** `extractMode` 字段到 `CodexTap.extractLatestTurn` 返回值；`source` 保留不动；新增 `no_task_complete_yet` / `no_rollout_bound` 两条提前 return 分支 |
| B1.3 | 🟢 GREEN | `main.js` | `roundtable-manual-extract` IPC 透传 `extractMode`（**不动现有 `mode` 字段**） |
| B1.4 | 🔴 RED | `tests/unit-codex-extract-idempotent.test.js` | 自动+手动+结束态多次拉取 → 不重复 |
| B1.5 | 🔴 RED | `tests/unit-codex-extract-concurrent-race.test.js` | 自动+手动同时触发 → 只执行一次（吸收 Charmander） |
| B1.6 | 🔴 RED | `tests/unit-codex-extract-partial-then-final.test.js` | 先拉 partial，task_complete 后再拉 → final 正确覆盖 partial（吸收 Charmander） |
| B1.7 | 🟢 GREEN | `core/turn-completion-watcher.js` | turn 唯一键 `${meetingId}:${turnNum}:${sid}` + partial/final 分层存储 |

---

## 四、Phase 2 · 发送闭环（1.5d）

**对应 Spec**：S1
**前置依赖**：Phase 0 必须录到 ack/stuck 信号 fixture，否则 B2.1/B2.2 无依据

### 现状盘点（v2 新增）

- `main.js:1438-1460, 1864` 现 `sendStatus` **已落地** ∈ `{ok, auto_recovered, stuck}`（2026-05-03 Resend & Auto-Recovery batch）
- 当 `sendStatus === 'stuck'` 时已推 `roundtable-send-stuck` IPC，renderer 卡片已亮 `📤 发送`/`🔄 重新拉起`
- `roundtable-resend-prompt` IPC（main.js:1838）**已按 promptHeader 指纹**判 `enter_only / rewrite_full`，但**未确认是否已走 codex 分支**（B2.4 即此 contract test）

### v2 命名约束

- `sendStatus` 沿用现有 `{ok, auto_recovered, stuck}` 命名空间
- **新增进态 `sending`**（发出后等 echo 期间过渡值），最终态保持不变
- Spec S1"ack"语义 = 现状 `ok`/`auto_recovered`，**不引入新词 ack**

### Batch

| ID | 类型 | 文件 | 内容 |
|---|---|---|---|
| B2.1 | 🔴 RED | `tests/unit-codex-send-ack.test.js` | 喂 T0 PTY ack fixture → 期望 sendStatus 从 `sending` 转 `ok` 或 `auto_recovered` |
| B2.2 | 🔴 RED | `tests/unit-codex-send-stuck.test.js` | 喂 stuck fixture → 期望 `stuck` |
| B2.3 | 🟢 GREEN | `core/cli-send-adapter.js`（新建） | `detectCodexAck` / `detectCodexStuck`（基于 T0 实测信号）；新增 `sending` 进态发射点 |
| B2.4 | 🔴 RED | `tests/unit-codex-resend-no-duplicate.test.js` | **contract test**：codex 分支走通用 `resendCurrentPrompt` 路径 → echo 已现 → `enter_only`；未现 → `rewrite_full` |
| B2.5 | 🔴 RED | `tests/unit-codex-send-while-binding.test.js` | sid 未绑定时发送 → 等待绑定或抛 BindTimeout（吸收 Charmander） |
| B2.6 | 🔴 RED | `tests/unit-codex-resend-after-extract.test.js` | 手动拉取后重发 → 正确判 enter_only/rewrite_full（吸收 Charmander） |
| B2.7 | 🟢 GREEN | `core/cli-send-adapter.js` 或 `core/roundtable-watcher.js` | 视 B2.4 contract test 结果决定：若 codex 已走通用路径，`parseEcho` 仅需补 codex prompt header 形态识别；若没走，需补 codex 分支 |

---

## 五、Phase 2.5 · UI 卡片层（0.5d，串行执行）

**为什么独立成 Phase**：原 plan B1.5/B2.5 都改 UI 卡片状态，并行必撞冲突。合并为单 batch 串行做。

### 现状盘点（v2 新增）

- `renderer/meeting-room.js:626-635` 底部 escape bar **已有 4 按钮**：`一键提取` / `跳过` / `📤 发送` / `🔄 重新拉起`
- 卡片头部另有 `🔧 进 shell` 入口（meeting-room.js:242 注释、L946 起 `enter-shell` 分支）
- 现状文案与 plan v1 写的 `[📤 重发] [📥 拉取] [🔧 进 shell]` **不一致 → v2 不重新设计 UI，仅补反馈状态**

| ID | 类型 | 内容 |
|---|---|---|
| B2.5.1 | 🟢 GREEN | UI 卡片按 `extractMode` 路由 hint 文案（S2 表格）；不动现有 IPC `mode` 字段消费链 |
| B2.5.2 | 🟢 GREEN | **不重命名按钮**，仅给现有 `📤 发送`/`🔄 重新拉起`/`一键提取`/`🔧 进 shell` 4 按钮按 `sendStatus`/`extractMode` 显隐与变灰；新增 `sending` 状态时的视觉反馈（如标题旁 ●） |
| B2.5.3 | 🟢 GREEN | 逃生按钮点击后的反馈状态（`resending` / `extracting`）—— S1 强制要求 |
| B2.5.4 | 🔵 REFACTOR | 抽 `cli-card-state.js` 通用 mapper |

---

## 六、Phase 3 · 绑定 + 恢复（1d）

**对应 Spec**：S4 + S5

### 现状盘点（v2 新增）

- `core/session-manager.js:265-645` 已有 codex resume **前两档**：
  - 精确 sid → `codex resume <sid> --dangerously-bypass-approvals-and-sandbox`
  - 无 sid 兜底 → `codex resume --last --dangerously-bypass-approvals-and-sandbox`
- **第三档 fresh+ctx 是真新增**，前两档复用现有路径仅加 telemetry
- `awaitSessionBound` / `bindStatus` IPC **不存在 → 新建**

### v2 新增前置 batch

| ID | 类型 | 内容 |
|---|---|---|
| B3.0 | 🔬 SPIKE | **Phase 3 必做前置**：实测 codex CLI 是否支持 `--initial-prompt` 类首句注入参数；若支持，B3.6 走 CLI 参数路径；若不支持，回退方案是 PTY paste（实测超长 ctx 是否触发 OSC 闪屏 / 自动换行截断）。**无 SPIKE 结论不进 B3.6**。 |

| ID | 类型 | 文件 | 内容 |
|---|---|---|---|
| B3.1 | 🔴 RED | `tests/unit-codex-bind-pending-visible.test.js` | bind 未完成时 IPC 返回 `pending` 状态 |
| B3.2 | 🟢 GREEN | `main.js` | 新增 `roundtable-codex-bind-status` IPC + `awaitSessionBound(sid, 15s)` |
| B3.3 | 🟢 GREEN | UI | bind pending 角标 + 等待期按钮策略（S4 表格） |
| B3.4 | 🔴 RED | `tests/unit-codex-resume-fallback-chain.test.js` | sid 失效 → `--last` 失效 → fresh+ctx；前两档断言走现有 session-manager 路径，第三档断言走 B3.6 新代码 |
| B3.5 | 🟢 GREEN | `core/session-manager.js` | **复用前两档 + 追加第三档** fresh+ctx 路径 + `from_sid/from_last/from_fresh+ctx` telemetry |
| B3.6 | 🟢 GREEN | `core/roundtable-orchestrator.js` | fresh+ctx 注入"最近 N=3 轮 summary"作为首次 prompt context（**实现路径由 B3.0 结论决定**） |

---

## 七、Phase 4 · 多轮一致性 + E2E（1.5d）

**对应 Spec**：S6 + S7

### 单元/集成

| ID | 类型 | 文件 | 内容 |
|---|---|---|---|
| B4.1 | 🔴 RED | `tests/unit-codex-commentary-not-final.test.js` | S6a 完成判定 |
| B4.2 | 🔴 RED | `tests/unit-codex-summary-uses-final.test.js` | S6b summary 取 final |
| B4.3 | 🔴 RED | `tests/unit-codex-fanout-non-blocking.test.js` | S6a 任一方不阻塞另一方 |
| B4.4 | 🟢 GREEN | 修完成判定 + summary 解析 + fanout 状态独立 |

### E2E（隔离 Hub + CDP + PID 白名单）

| ID | 类型 | 文件 | 内容 |
|---|---|---|---|
| B4.5 | 🔴 RED | `tests/e2e-codex-fanout-single.test.js` | codex 单家 5 场景：创建/发送/拉取/逃生/恢复 |
| B4.6 | 🔴 RED | `tests/e2e-mixed-roundtable.test.js` | Claude + codex 混合 fanout |
| B4.7 | 🔴 RED | `tests/e2e-regression-claude-untouched.test.js` | S7 非回归：Claude/DeepSeek/GLM 既有 E2E 全绿 |
| B4.8 | 🟢 GREEN | 修跨家集成 + 修非回归 fail |

---

## 八、Phase 5 · 高级特性（按证据决定，0-1d）

### 决策点（Phase 4 完成后开 30min mini-review）

仅做 **T0 采样证明有价值且成本合理** 的项。

**删项硬原则**（吸收 Squirtle）：**若高级特性无法提升 Spec S1-S7 的验收结果，则不进入本轮。**

### 候选项

| 项 | 触发条件 | 默认 |
|---|---|---|
| MCP 注入验证（投研圆桌） | 投研场景必做 | ✅ 做（已有代码，验证可用即可） |
| OSC title | T0 录到稳定标题信号 | 待决策 |
| Stop hook / statusline | — | ❌ 不做 |

---

## 九、回滚策略（吸收 Charmander）

| 触发 | 动作 |
|---|---|
| Phase 1 卡住 >4h | 先做 Phase 2，回头补 |
| Phase 2 卡住 >4h | 暂用 Claude sendStatus 通用逻辑，标记 codex `stuck` 检测为"实验性" |
| Phase 3 SPIKE B3.0 失败 | 第三档 fresh+ctx 暂缓，仅交付前两档（与现状打平 + telemetry 升级） |
| Phase 3 卡住 >2h | 只做 sid → `--last` 两档，fresh+ctx 暂缓 |
| 任一 Phase 出大 bug | `git revert` 该 Phase 的 commit range；不依赖运行时 flag |
| codex CLI 升级导致 fixture 全 fail | 跑 `npm run refresh-codex-fixtures` 重录，更新 fixture 头部版本号 |

---

## 十、工作量

| Phase | 工作量 |
|---|---|
| Phase 0 | 1d |
| Phase 1 | 1.5d |
| Phase 2 | 1.5d |
| Phase 2.5 | 0.5d |
| Phase 3 | 1d |
| Phase 4 | 1.5d |
| Phase 5 | 0-1d |
| **总计** | **6-7d**（Phase 1/2 unit 层并行可压到 5-6d）|

> 估算依据：按 Sonnet 4.6 SDD batch 速度，单 batch 平均 30-60min；总 ~25 batch ≈ 1.5-2 个工作日纯 dispatch + 1d Phase 0 + 1.5d 验证调试。

---

## 十一、SDD 执行顺序（推荐）

```
Day 1:    Phase 0（fixture + flag 脚手架）
Day 2:    Phase 1 (B1.1-B1.7) 由 Codex/GLM 跑
Day 3:    Phase 2 (B2.1-B2.7) 由 DeepSeek 跑
Day 4 上: Phase 2.5（UI 串行，Claude 跑）
Day 4 下: Phase 3（绑定 + 恢复）
Day 5:    Phase 4（多轮一致性 + E2E）
Day 6:    Phase 5 mini-review + 按需补
Day 7:    /post-refactor-verify + 用户体感验收
```

每 Phase 验收：
- 所有 🔴 RED 测试变 🟢 GREEN
- 代码 review（四路审查）
- E2E 真实跑通

---

## 十二、引用

- Spec：`docs/superpowers/specs/2026-05-04-codex-roundtable-equiv-design.md`
- 圆桌历史：`C:\Users\lintian\.arena\timeline-3a6133e9-cdb4-4559-9f31-f1157d1db668.md`
- 项目铁律：`C:\Users\lintian\claude-session-hub\CLAUDE.md`

---

## 十三、v2 修订记录（2026-05-04）

**审视维度**：plan v1 假设 vs 现有代码盘点（`core/transcript-tap.js` / `main.js` / `core/session-manager.js` / `renderer/meeting-room.js` 实测）

| # | v1 漏洞 | 现状证据 | v2 修补 |
|---|---|---|---|
| 1 | mode 字段命名冲突（IPC 上下文 mode vs 内容分级 mode）| `main.js:1773` 现 `roundtable-manual-extract` 已用 `mode ∈ {watcher_settle, patch_last_turn, text_only}`；`renderer/meeting-room.js:927` 已读 `r.mode` | 内容分级字段改名 `extractMode`；Spec S2 表头 / Plan B1.1-1.3 全部更名 |
| 2 | sendStatus 命名 `sending → ack/stuck` 不存在于现有代码 | `main.js:1438-1460` 已有 `sendStatus ∈ {ok, auto_recovered, stuck}`（2026-05-03 落地）| Spec S1 改"ack"映射到现状 `ok`/`auto_recovered`；保留命名空间，仅新增进态 `sending` |
| 3 | 逃生按钮文案 `[📤 重发] [📥 拉取] [🔧 进 shell]` 与现状不符 | `meeting-room.js:626-635` 已有 `一键提取 / 跳过 / 📤 发送 / 🔄 重新拉起` + 头部 `🔧 进 shell` | Phase 2.5 不重命名按钮，仅补反馈状态（resending/extracting）与按 sendStatus/extractMode 显隐 |
| 4 | B1.2 写"扩展返回 `{text, mode, source}`"暗示从零做 | `transcript-tap.js:506-544` 已返回 `{text, source}`，含两值 source | B1.2 改"追加 extractMode 字段，source 保留不动" |
| 5 | B0.6 `CODEX_EQUIV_V2` flag 双路径成本超过收益 | 现状 codex 链路本就未跑通，flag 化双路径 6-7d；fixture 矩阵翻倍 | 删 flag；回退靠 git revert |
| 6 | Spec S5 第三档 fresh+ctx 注入路径未确认 | 未知 codex CLI 是否支持 `--initial-prompt`；PTY paste 长 ctx 风险（OSC/换行截断）| 新增 Phase 3 前置 SPIKE B3.0 实测注入路径；无结论不进 B3.6 |

**未改动**：Phase 0 fixture 录制方法 / Phase 4 E2E 矩阵 / Phase 5 决策点 / 总工作量估算（仍 6-7d）。
