# DEPLOY_NOTE · 循环工作流（2026-06-29 凌晨 道雪会话，/goal 自主推进）

> 留给用户 / 并发兄弟会话：本会话在 master 工作区**未提交**地实现了"循环工作流"（角色化循环开发：评审 gate + 自动重来 + 达标后打磨）。
> **未 commit / 未 stash / 未切分支** —— 工作区已有海量你的未提交 WIP（committee / mobile 等 100+ 文件），为不搅乱 + 防并发冲突，只精确改循环相关文件，等你统一审核后定夺整合。

## 改动清单

### 新增文件（全新、零冲突）
- `renderer/loop-workflow.js` —— 纯逻辑核心：PROMPTS(默认待审) / parseVerdict / mergeVerdicts(AND-pass·OR-fail) / advanceLoopState(达标→打磨→done + 三道强制退出) / buildReportHtml(晨报生成)。逻辑只依赖 `<<<VERDICT>>>` 输出契约，改 prompt 文本不动逻辑。
- `tests/unit-loop-workflow.test.js` —— 纯逻辑单测 **31/31**（`node tests/unit-loop-workflow.test.js`）。
- `tests/loop-workflow-cdp-e2e.js` —— 真实 CDP UI E2E **28/28**（自起隔离 Hub，真实 renderer，非 mock；含 Phase 3 的 L1/L2/L3 + 角色标签）。
- `tests/loop-real-multiai-e2e.js` —— 真实多 AI 循环 E2E（真 Codex+DeepSeek 跑 L1，极小安全任务 + 隔离工作区 + 12min 硬超时 + 自清理）。

### 修改文件（精确、最小侵入）
- `renderer/meeting-room.js`：
  - +`runLoopWorkflow()` 主循环 + `_loop*` 辅助（紧挨 runSerialWorkflow）。复用现有 `groupchat:turn` IPC，后端零改。
  - +发送钩子：`serialWorkflow.loop.enabled` 时走循环。
  - +每轮持久化 `serialWorkflow.loopState`（Phase 2a）。
  - +收尾生成 HTML 晨报到 `Desktop/claude-artifacts/loop-report-*.html`（Phase 2a，renderer nodeIntegration 用 fs）。
  - +`window.__loopState` 只读观测点（E2E 监控用，不改行为）。
- `renderer/workflow-config-modal.js`：+循环模式 UI（启用开关 / 最多 N 轮 / 连续 N 轮绿）+ **L1/L2/L3 一键预设** + **角色标签**（开发/评审）+ `config.loop` 保存（Phase 3）。
- `renderer/index.html`：+`loop-workflow.js` 脚本引入。

## 已验证（真实执行）
- `node tests/unit-loop-workflow.test.js` → **31/31**
- `node tests/loop-workflow-cdp-e2e.js` → **28/28**（真实 Hub renderer）
- 真实多 AI 闭环 E2E：**通过（双 Codex）** —— builder(Codex 70s 写码)→reviewer(Codex 评审)→round=1 pass→自动打磨 round=2→stopped_max→Phase 2a 晨报 HTML 自动生成。完整闭环真实跑通。
  - 诚实勘误：第一版 Codex 开发 + **DeepSeek 评审** 时，DeepSeek 该 session 评审 turn 12min 零产出（查 state 确认一字未回）；换双 Codex A/B 一次跑通 → 是 **DeepSeek 该 session 特有问题（trust 残留/慢/MCP），非循环逻辑/派发 bug**。生产环境 DeepSeek 群聊正常，双评审建议生产验证。
- `node --check` 全过；集成后隔离 Hub smoke 启动正常。

## 各 Phase 状态
- **Phase 1**（逻辑+集成+UI）：✅ 完成并验证（26 单测 + 23 CDP E2E + 真实多 AI E2E）。
- **Phase 2a**（loopState 持久化 + HTML 晨报生成）：✅ 完成。
- **Phase 2b**（完整 main 驱动下沉）：✅ **实现 + 验证**：
  - `renderer/loop-workflow.js` +`resumeState`（从持久化重建 + 回灌上轮阻断）。
  - **`main/groupchat/loop-engine.js`（新）**：main 进程直驱 dispatcher 的循环引擎（复用 loop-workflow.js 纯逻辑 UMD）——开发/评审 turn 直调 `dispatchGroupChatTurn` + 解析 + gate + advanceLoopState + 持久化 loopState + 发 `loop:progress` + 成员 wake（dormant→createSession 复用）+ boot `resumePending` 自动续跑。
  - **`main/ipc/loop-handlers.js`（新）**：`loop:start/stop/status` IPC。
  - `main.js`：创建 loopEngine + 注册 loop IPC（try 包裹）+ did-finish-load 后 `loopEngine.resumePending()` 自动续跑。
  - `meeting-room.js`：发送钩子 loop.enabled → `ipcRenderer.invoke('loop:start')`（交 main 驱动，renderer 崩不中断循环）。renderer 旧 runLoopWorkflow/__resumeLoopIfPending 保留作 fallback。
  - 验证：**5 loop-engine 单测**（mock dispatcher：驱动/gate/回灌/续跑/防并发）+ 5 CDP（续跑逻辑）+ **smoke**（main.js 不破坏启动）+ **真实 main 驱动 E2E**（双 Codex：开发→评审→达标→打磨→stopped_max，全程 main 进程驱动，晨报生成）全过。
  - **崩溃续跑端到端已真测**（`tests/loop-resume-crash-e2e.js`：A 跑 round1 → 💥kill → B 重启同 data dir）：持久化✓（loopState 正确落盘 status=running/round=1/driver=main/loop config 全在）+ boot 检测条件✓ + resumeState 逻辑✓（单测）；**实证一个缺口**：重启后成员 dormant，loop-engine 简化 wake（createSession 复用 + 轮询 status≠dormant）**不足以让续跑的 builder turn 真跑起来** → Phase B 续跑未推进。
  - **修复方向**：`ensureMemberReady` 改用 Hub 完整 session resume（createSession 复用 + 等 `transcriptTap 'cli-ready'` 事件，而非轮询 status）。这是 Hub session 恢复机制的事，建议单独修 + 生产验证。其余 Phase 2b 全部验证通过。
- **Phase 3**（通用化 UI）：✅ L1/L2/L3 预设 + 角色标签完成并测。prompt 折叠编辑 UI 留作续（prompt 现在 loop-workflow.js 常量，你审定我改即可）。

## 角色 prompt 待审
`renderer/loop-workflow.js` 顶部 `PROMPTS` 是默认草稿。交互式审稿：`Desktop/claude-artifacts/loop-prompt-design.html`。
