# DEPLOY NOTE — 群聊 UI 鲁棒性修复批次（2026-07-12 凌晨）

**会话**：Claude（群聊 UI bug 修复专项）。与同夜 Codex 会话的「卡片视图串线修复」（`docs/bug-report/codex-card-session-crosswire/`）互补，未动其改动。

## 改动范围（不加新功能，只修 bug + 鲁棒性）

### 主进程
- `core/host-shell-detector.js`：新增 `createAuthBannerMonitor`（AUTH_FAILURE_RE 移入）。旧实现对整个 8KB ring buffer 裸测，AI 回答/gh CLI 输出含 "not logged in" 即误杀（截图血泪：PTY 正常回答但 UI「发送失败」）。新判定三重门：stripAnsi 尾部 1200 字符 + 连续 2 次心跳命中 + 期间 PTY 零新活动；activityStamp 缺失不判静默。
- `main/groupchat/dispatcher.js`：auth 检测限定轮次开始 120s 窗口内（`AUTH_DETECT_WINDOW_MS`，真登录横幅必然早期出现）；partial-update payload 透传 `reason`。
- `main/ipc/groupchat-recovery-handlers.js`（手动同步「同步/↻」链路重写）：
  - 轮次窗口从 orchestrator 推导（`u{n}.createdAt` 下界 / `u{n+1}.createdAt` 上界），不再信 renderer 的当前轮时间戳（旧轮重提取张冠李戴 / Hub 重启后为 0 的根因）；
  - 旧轮重提取禁止 settle 活跃 watcher（防旧文本劫持新轮）；settle 前重读 currentTurn（防提取期间被抢占的竞态）；
  - 非 Codex 后端旧轮重提取诚实拒绝（transcript 只能读最新轮）；
  - 假成功根治：orch 不可用 / 目标轮缺失 / 窗口无法建立 → `ok:false` + 中文原因（旧行为 `text_only` 假成功 = 用户看到"已同步"但气泡不动）。
- `core/transcript-tap.js`：CodexTap/facade `extractLatestTurn` 新增 `opts.untilTs` 轮次窗口上界；窗口模式下时间戳非法（NaN）的事件不信任。
- `core/group-chat-orchestrator.js`：
  - `completeTurn`/`patchTurnResult` 空文本（含纯空白）不覆盖已有答案（PTY 干净退出兜底 settle 曾把答案抹成空气泡）；
  - `manual_extracted` 守卫两处对齐（空结果不打回手动救回的状态）；
  - 失败原因持久化 `msg.statusReason`（补全成功后清除；迟到无 reason 的 errored 不抹旧原因）；
  - 空结果不清零 thinkSec/tokens 统计；消息正文统一从合并后 `by[sid]` 取（飞行中手动 patch 不丢）。

### 渲染层（Ctrl+R 重载即生效；main 进程改动需重启 Hub）
- `renderer/meeting-room.js`：
  - errored 优先于 pending（消灭「正在发言」+失败并存 + 光标闪烁矛盾态）；settle 态（errored/absent/superseded）组件内统一排除 pending/「思考中」；
  - 空内容消息按状态渲染占位文案（含 `_gcFailReasonLabel` 失败原因中文标签）替代"空气泡+裸图标排"；
  - completed 但空内容仍显示「同步」逃生入口；superseded/absent 有明确状态标签；
  - 同步按钮失败短文案「失败」→「同步失败」，复制失败→「复制失败」（防和 AI 回答失败混淆）。
- `renderer/styles/meeting-room-chat-flow.css`：`.mr-gc-empty-placeholder` 占位样式。

### 测试
- 新增：`tests/unit-auth-banner-monitor.test.js`、`tests/unit-codex-extract-turn-window.test.js`、`tests/unit-gc-message-state-render-contract.test.js`、`tests/e2e-gc-message-states-cdp.js`（隔离 Hub + CDP 真机渲染验证，截图在 artifacts/）。
- 扩展：orchestrator / recovery-ipc 契约测试（+12 用例）；dispatcher 契约更新为 authBannerMonitor；manual-sync 契约修正存量字符串漂移（`disableHardTimeout: !(Number(turnTimeoutMs) > 0)` 语义不变）。
- 多方审查：Codex + DeepSeek 通过 MCP 交叉审查，8 处二轮加固已并入。**Gemini CLI 免费档被 Google 弃用（IneligibleTierError），该通道已死**。

## ⚠️ 本次事故与修复：node_modules 被 `git worktree remove --force` 穿透损坏
A/B 验证时创建了 junction 复用 node_modules 的 worktree，清理时先跑了 `git worktree remove --force` —— 它在报 "Invalid argument" 失败前已**穿透 junction 按字母序删掉真 node_modules 的 @* 至 d* 共 136 个顶层包**（electron 因被生产 Hub 锁住幸存，挡下后续删除）。已按 package-lock 通过 staging `npm ci` + 缺包回拷完成修复，renderer 加载零异常、E2E 全过。CLAUDE.md worktree 清理规则已更新为硬禁 `git worktree remove`。
**生产 Hub 重启安全**（node_modules 已对齐 lock）；桌面快捷方式启动已验证等效路径（隔离实例 smoke 通过）。

## 已知存量问题（非本批次引入，未越界处理）
- `tests/unit-session-list-renderer-mini-ctx.test.js` 失败（侧栏群聊父项摘要 chip 断言）——属 6-29 loop-workflow 会话的未提交 WIP 范围。
- `tests/e2e-meeting-room-renderer-smoke.js`（untracked WIP 测试）turn-lane 断言失败——卡片+tab 模式初始渲染路径，与本批次改动无交集（该路径不执行本批次任何改动行）。

## 未 commit
工作树在本任务开始前已有大量未提交修改（loop-workflow 等 + Codex 会话的串线修复），为避免夹带，本批次同样不做整树提交。建议后续由用户统一验收后分批 commit。
