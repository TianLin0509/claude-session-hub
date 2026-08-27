# Codex 夜间保护 MVP

## 目标

在不重启 AI Hub、不影响其他 session、也不盲目重放原 prompt 的前提下，自动处理 Codex 最终网络断流：

1. 仅保护用户手动开启的 Codex session；`/goal` 自动开启。
2. `Reconnecting 1/5…5/5` 只作观察，不触发动作。
3. 只接受最终 `stream disconnected before completion`（PTY 或 rollout `task_complete.error`）作为事故证据。
4. 网络连续稳定后，在同一 Codex thread 内只提交一次受控续跑指令。
5. 成功、取消、阻塞或人工接管后自动收口，杜绝重复任务。

## 状态机

`armed → grace → waiting-network → waiting-runtime → resuming → recovering → completed`

终止分支：

- 同一 turn 迟到成功：直接 `completed`，不续跑。
- 用户输入可打印文字：取消当前事故，人工接管优先。
- 等待权限确认、运行态长期不明确、恢复无 `task_started`、30 分钟网络未稳定：`blocked`。
- 6 小时内最多自动恢复 2 次；超过即熔断。

## 网络健康门槛

- 使用当前 Hub 代理，而不是只检查本地端口。
- 每轮经代理访问 `chatgpt.com` 与 `api.openai.com/v1/models`。
- 200–499（排除代理认证 407）视为传输成功；401/403/429均可证明服务端已响应。
- 连续 3 轮成功，间隔 10 秒；任一失败计数清零并按 30/60/120/300 秒退避。
- 事故发生后至少静默 30 秒才允许续跑。

## 恢复路径

1. Codex TUI 已回到输入框：向原 PTY 注入一次恢复指令。
2. Codex 已退出到宿主 PowerShell：在原 PTY执行 `codex resume <SID> [PROMPT]`，保留模型、effort、速度、上下文和 MCP 隔离。
3. PTY 已不存在：按原 Hub metadata 重建同一卡片、精确 resume 原 SID，并用 CLI 的初始 `PROMPT` 参数立即续跑。

恢复指令要求先核对工作区实际状态，不得重复已成功的写入、提交、上传或删除。恢复后必须观察到新的 `task_started`；25 秒内没有确认即熔断，不重复发送。

## UI 与持久化

- 当前 Codex session 顶栏显示“夜间保护”按钮。
- 可见状态：`守护关 / 守护开 / 目标守护 / 等网络 / 等输入框 / 续跑中 / 已完成 / 需处理`。
- 每个 session 独立持久化；Hub 重启后保留开关和频控历史，但不会盲目重放旧事故。
- 审计日志：`<CLAUDE_HUB_DATA_DIR>/diagnostics/night-guard.jsonl`。

## 明确边界

- MVP 不自动重启 Clash/Mihomo。7890 存活但唯一上游节点超时时，重启本地核心不能保证修复，系统只等待并验证真实网络恢复。
- 当前仅支持 Codex/新 DeepSeek Codex runtime；Claude/Gemini/Kimi不自动续跑。
- `blocked` 状态不会自行越权或循环重试，需用户查看会话后重新开启。

## 验证

```powershell
node --test tests\unit-night-guard-*.test.js
node tests\e2e-night-guard-cdp.js
$env:HUB_NIGHT_GUARD_E2E_GOAL='1'; node tests\e2e-night-guard-cdp.js
node tests\e2e-codex-resume-card-history-cdp.js
node tests\e2e-session-restart-native-resume-cdp.js
```

所有 GUI 测试必须通过独立 `CLAUDE_HUB_DATA_DIR`、独立 CDP 端口和伪 Codex CLI运行，禁止连接或关闭生产 Hub。
