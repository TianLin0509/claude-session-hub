# Phase 2b 设计 · 循环工作流「后端下沉 + 断点续跑」

> 状态：**已实现 + 验证**（2026-06-29）。本 spec 描述的「完整 main 驱动下沉」**已落地并通过真实 main 驱动 E2E**：
> - `main/groupchat/loop-engine.js`（main 进程直驱 dispatcher，复用 loop-workflow.js 纯逻辑 UMD）+ `main/ipc/loop-handlers.js`（loop:start/stop/status）+ main.js 创建 loopEngine/注册 IPC/boot `resumePending` 自动续跑 + `meeting-room.js` 发送钩子改发 `loop:start`（交 main 驱动，renderer 崩不中断）+ `resumeState` + 成员 wake（dormant→createSession 复用）。
> - 验证：5 loop-engine 单测（mock dispatcher：驱动/gate/回灌/续跑/防并发）+ 5 CDP（续跑逻辑）+ smoke（不破坏启动）+ **真实 main 驱动 E2E**（双 Codex：开发→评审→达标→打磨→stopped_max + 晨报）。
> - **崩溃续跑端到端已真测**（tests/loop-resume-crash-e2e.js）：持久化/检测/resume 链路全 ✓（loopState 正确落盘 running/round1/driver=main，boot 自动扫描触发）；**实证一个缺口**：重启后成员 dormant，简化 wake（createSession 复用 + 轮询 status）不足以让续跑的 builder turn 真跑起来 → Phase B 续跑未推进。**修复方向**：`ensureMemberReady` 改用 Hub 完整 session resume（createSession 复用 + 等 `transcriptTap 'cli-ready'` 事件，非轮询 status）。建议单独修 + 生产验证。
>
> 下面是原设计（实现依此；实际用"main 直驱 dispatcher"而非另写 core，因 loop-workflow.js 已是 UMD 可被 main require）。

## 为什么需要后端下沉

当前 `runLoopWorkflow` 的 while 循环跑在 **renderer 前端**。Phase 2a 已每轮持久化 `serialWorkflow.loopState`（进度数据可见、可恢复）。但：

- **窗口崩 / 预览面板锁死 / 休眠** → renderer 的 while 中断，正在等的那个 AI turn 丢失，循环停。
- 重启后虽有持久化的 loopState，但循环驱动（while）在前端，**不会自动续**；且成员 session 可能 dormant。

要做到"彻夜无人值守、崩溃可续"，必须把**循环驱动搬到 main 进程**（main 不随 renderer 崩溃而停）。

## 目标

1. 循环驱动（while + 派发 + 解析 + gate + 推进）运行在 main 进程。
2. 每轮 loopState 落盘（文件级，非仅内存）。
3. Hub 重启 → 检测未完成循环 → 恢复成员 session → 自动从断点续跑。
4. renderer 退化为"观察 + 干预"（看进度、暂停/停止）。

## 架构

```
renderer（配置/观看/干预） ──IPC── main 循环引擎（新）
                                     │ 状态机 + 终止判定 + 合并裁决解析
                                     │ loopState 落盘（<dataDir>/loops/<meetingId>.json）
                                     ├── dispatcher（现成）runGroupChatTurn 直接调
                                     ├── session-manager（现成）成员 spawn/resume
                                     └── group-chat-orchestrator（现成）delta 上下文
```

## 关键改动点（最小集）

| 文件 | 改动 |
|------|------|
| `main/groupchat/loop-engine.js`（新） | 把 renderer `runLoopWorkflow` 的循环逻辑搬来，改成直接调 `dispatchGroupChatTurn`（不经 IPC）；复用 `renderer/loop-workflow.js` 的纯逻辑（抽成共享模块 `core/loop-core.js` 供 main+renderer 共用）。每轮 `fs` 落盘 loopState。 |
| `core/loop-core.js`（新，从 loop-workflow.js 抽） | 纯逻辑（parseVerdict/mergeVerdicts/advanceLoopState/PROMPTS/buildReportHtml）下沉为 core 模块，main 与 renderer 都 require（renderer 的 loop-workflow.js 改成 re-export）。 |
| `main/ipc/loop-handlers.js`（新） | IPC：`loop:start` / `loop:stop` / `loop:status`；renderer 发起/查询/停止。 |
| `main.js` 启动钩子 | boot 时扫 `<dataDir>/loops/*.json`，status==='running' 且未过 deadline → 恢复成员 session（session-manager resume）→ `loopEngine.resume(meetingId, loopState)`。 |
| `renderer/meeting-room.js` | `runLoopWorkflow` 改为发 `loop:start` IPC（驱动移交 main）；订阅 `loop:progress` 事件刷新 UI。 |

## 续跑要点（正确性）

- loopState 落盘需含：`goal / phase / round / consecutiveGreen / suggestionPool / history / _lastBlockerSig / _noProgress`（Phase 2a 已存大部分，需补 `goal` + 内部字段）。
- 续跑恢复 `prevMerge`：从 `history` 最后一条（含 blockers）重建，供 builderTaskText 回灌。
- 成员恢复：续跑前确保 builder/reviewer session 活着（dormant → resume；resume 失败 → 标记 stopped_error + 报告）。
- 幂等：同一 meeting 不并发起两个循环（main 端加锁）。

## 验证（实现时）

- 单测：loop-core 纯逻辑（已有 26 条迁移）+ 落盘/读盘 round-trip + 续跑恢复 prevMerge。
- CDP E2E：起循环 → 跑 1 轮 → **kill renderer 窗口**（模拟崩）→ 重启 Hub → 断言自动从 round N 续跑。
- 真实多 AI：同 Phase 1 的 loop-real-multiai-e2e，额外中途崩溃 + 续跑。

## 风险

- 动 main 进程 + dispatcher 直调 + 启动恢复，是核心链路改动；务必在隔离 Hub 充分 E2E，且 commit 前走 `/post-refactor-verify`。
- 与现有大量 WIP（committee 等）共存，建议先整合/提交 WIP，再在干净基线上做 Phase 2b。
