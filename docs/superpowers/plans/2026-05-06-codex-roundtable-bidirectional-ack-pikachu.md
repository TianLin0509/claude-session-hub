# Codex 圆桌双向 ACK 修复 · Pikachu 综合 Plan

**作者**：⚡ Pikachu（综合四轮圆桌讨论：Pikachu / Charmander / Squirtle）
**日期**：2026-05-06
**对应 Spec**：`docs/superpowers/specs/2026-05-04-codex-roundtable-equiv-design.md`
**前置 plan**：`docs/superpowers/plans/2026-05-04-codex-roundtable-equiv.md`（接力 Phase 1）
**复现证据**：`C:\Users\lintian\.claude-session-hub\images\20260506094349-c0251b.png`（5402 chars pasted content 卡输入框 + 答案未自动拉）
**四轮讨论原文**：`C:\Users\lintian\.arena\timeline-7f08e852-a031-49dd-b0f5-4e75659939af.md`

---

## 一、综合根因（四轮圆桌共识）

Hub ↔ Codex 整条链路「双盲」：

- **发送段**：Hub 写 PTY → 等 `lastActivity` 静默 → 写 `\r`。这只是"打字成功"，**不是"提交成功"**。Codex TUI 的 alt-screen 切换 / 弹窗（rate-limit / update / MCP confirm）/ pasted content 折叠都会让 `\r` 失语。
- **拉取段**：watcher 单点依赖 `task_complete` 事件。该事件被 MCP confirm 弹窗（如 `ai-team team_respond`）阻塞时**永不写入** rollout JSONL（`main.js:1957` 注释自承），watcher 永远不知道任务完成。
- **高发触发器**：圆桌 prompt 普遍 ≥1000 字（截图实测 5402 字符），TUI 必折叠成 `[[Pasted Content N chars]]`，命中发送段失败。

## 二、修复目标（一句话）

把"**我打字了所以你应该收到了 / 我等到屏幕安静了所以你应该答完了**"，改成：

> "**我看到你的会话日志真写了本轮 `user_message`，才算发送成功；我看到你真写了 `task_complete`，或超时兜底确认非弹窗阻塞，才算回答完成。**"

## 三、改动清单（按 P 排序）

### P0-1 · 长 prompt 文件化（释源高发触发器）
- 入口：`core/roundtable-watcher.js:53` codex 分支
- 阈值：`prompt.length >= 800`
- 落盘：`<hubData>/codex-prompts/<sid>-<turnNum>.md`
- 输入框只 write 短指令：`请读取 <绝对路径> 并按其中要求回答\r`
- 文件 lifecycle：会话结束清理（避免无限累积）
- 测试：fixture `pty-pasted-content-stuck.bin`（重放本次截图场景）+ unit `tests/unit-codex-prompt-file-mode.test.js`

### P0-2 · 发送 ACK（rollout user_message 双重信号）
- 入口：`core/roundtable-watcher.js:147-178` `sendToPty` codex 分支
- 改判据：写完 `\r` 后开 2s 窗口轮询 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，本轮 `user_message` 事件出现才返 ok
- **失败自动恢复有上限**：补 1 次 `\r` → 仍失败 rewrite_full + `\r` → 仍失败标 stuck 亮 UI（**最多 2 次硬护栏**，避免连发 dismiss 副作用）
- preflight：每次 send 前跑一次 `dismissCodexRateLimitDialog/UpdatePrompt`（幂等化）
- 测试：`tests/unit-codex-send-ack.test.js`

### P0-3 · 拉取 ACK + watchdog 兜底
- 入口：`core/transcript-tap.js` `CodexTap` + `main.js` 调度处
- watchdog：rollout 出现 `agent_message` 后 ≥30s 仍无 `task_complete` →
  - 检测 PTY tail 是否含 confirm 弹窗特征（`[y/n]`、`Allow`、`Approve`、MCP `team_respond`）
  - 命中 → UI 亮「⚠ Codex 等你点 Allow，[🔧 进 shell]」并保持卡片可恢复态
  - 未命中 → 自动触发一次 `manual_codex_rollout_streaming` 等价 patch（**消灭"答完未拉"症状**）
- 测试：`tests/unit-codex-extract-watchdog.test.js`

### P1 · ready 判定双钥匙
- 入口：`core/roundtable-cli-ready-detector.js:22`
- 删 `'send'`、`'gpt-5.4'`（过宽）；保留 `'Context'`（特征明确）
- 加 AND 条件：rollout 文件已存在且含 `session_meta`
- 测试：`tests/unit-cli-ready-detector-codex.test.js`

## 四、SDD 执行流程

1. **Phase 0**：fixture 复用 `tests/fixtures/codex-signals/` 已采集件 + 新增 `pty-pasted-content-stuck.bin`
2. **Phase 1**：P0 三项并行 dispatch（Codex/GLM/DeepSeek 跑 unit 避开 Claude 并发约束；E2E 串行）
3. **Phase 2**：P1 串行
4. 全程跑完 `/post-refactor-verify`

## 五、验收标准（**5 项全过**才算修复，缺一不许说"已完成"）

1. 新增 4 个单测全绿
2. 真实 Hub 隔离实例 E2E：`CLAUDE_HUB_DATA_DIR=C:\temp\hub-codex-fix-verify`，**PID 白名单 before/after diff**
3. E2E 连发 5 轮 5402+ 字符 prompt，全部自动发出 + 自动拉回，**`[[Pasted Content N chars]]` 不再出现**
4. 修复前后截图各一张存档于 `docs/post-refactor-verify-records.md`
5. `/post-refactor-verify` 通过

## 六、铁律红线（违反任一立刻停手汇报）

- 绝不 kill 用户生产 Hub 进程（`feedback_hub_never_kill`）
- 隔离 Hub 用 PowerShell `& exe` 同句 + `run_in_background`（`feedback_hub_isolation_env_pitfall`）
- E2E subagent 启 Hub 必须 PID 白名单 before/after diff（`feedback_e2e_pid_whitelist`）
- node_modules 风险操作后 smoke test 必跑（项目 CLAUDE.md 铁律 1）
- 中文交互、绝对路径、版本号可见化（用户级 CLAUDE.md）

## 七、回退策略

直接重构现有 codex 链路，**不引入 feature flag**（沿用前置 plan 同策略）。出大事 `git revert <commit-range>`。
